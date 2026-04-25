import { marked } from 'marked';
import ScheduledMessage from '../models/ScheduledMessage.js';
import { Deal } from '../models/Deal.js';
import Organization from '../models/Organization.js';
import { sendEmail } from '../utils/email.js';
import { createNotification } from '../routes/notifications.js';

// Markdown renderer config — `breaks: true` makes a single newline a <br>
// (closer to how operators actually write in a textarea), `gfm: true` enables
// the friendlier list/link/etc syntax. We render once at module load.
marked.use({ breaks: true, gfm: true });

const POLL_INTERVAL_MS = 60 * 1000;
const STARTUP_DELAY_MS = 7000;
const BATCH_LIMIT = 50;

let timer = null;
let running = false;
let stopped = false;

async function pollAndSend() {
  const now = new Date();
  const candidates = await ScheduledMessage.find({
    status: 'scheduled',
    sendAt: { $lte: now },
  }).limit(BATCH_LIMIT);

  if (!candidates.length) return;

  for (const candidate of candidates) {
    try {
      // Atomic claim — only one worker should send each message even if multiple
      // pollers are running (e.g. server restart overlap).
      const claimed = await ScheduledMessage.findOneAndUpdate(
        { _id: candidate._id, status: 'scheduled' },
        { $set: { status: 'sending' } },
        { new: true },
      );
      if (!claimed) continue;

      const deal = await Deal.findById(claimed.deal)
        .populate('contact', 'firstName lastName email')
        .lean();

      if (!deal) {
        await markFailed(claimed, 'Deal no longer exists');
        continue;
      }

      const recipientEmail = deal.contact?.email;
      if (!recipientEmail) {
        await markFailed(claimed, 'Deal has no contact email');
        await notifyFailure(claimed, deal, 'Deal has no contact email');
        continue;
      }

      const org = await Organization.findById(claimed.organization).select('name businessInfo').lean();
      const html = buildHtml(claimed.body, org);
      const subject = claimed.subject?.trim()
        || `Update on your ${deal.destination || 'trip'}`;

      try {
        await sendEmail({ to: recipientEmail, subject, html });
        await ScheduledMessage.findByIdAndUpdate(claimed._id, {
          status: 'sent',
          sentAt: new Date(),
          errorMessage: '',
        });
      } catch (err) {
        console.error(`[SchedMsgPoller] email send failed for ${claimed._id}:`, err.message);
        await markFailed(claimed, err.message);
        await notifyFailure(claimed, deal, err.message);
      }
    } catch (err) {
      console.error(`[SchedMsgPoller] processing failed for ${candidate._id}:`, err);
      // Best-effort recover from a 'sending' lock if we crashed mid-flight.
      await ScheduledMessage.updateOne(
        { _id: candidate._id, status: 'sending' },
        { $set: { status: 'failed', errorMessage: err.message } },
      ).catch(() => {});
    }
  }
}

function buildHtml(body, org) {
  // Operator drafts in Markdown — `marked` handles **bold**, *italic*, lists,
  // links, and paragraph breaks. Source is operator-authored (trusted) so we
  // don't sanitize aggressively, but marked escapes raw < > by default.
  const rendered = marked.parse(body || '');
  const footer = org?.name
    ? `<hr style="border:none;border-top:1px solid #e5e7eb;margin:24px 0 12px"><p style="color:#6b7280;font-size:12px">Sent by ${org.name}</p>`
    : '';
  return `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;max-width:600px;line-height:1.6;color:#1f2937">${rendered}${footer}</div>`;
}

async function markFailed(message, errorMessage) {
  await ScheduledMessage.findByIdAndUpdate(message._id, {
    status: 'failed',
    errorMessage,
  });
}

// Notify the deal owner + creator + the message creator that delivery failed
// so they can intervene. In-app only (avoids email-on-email-failure loops).
async function notifyFailure(message, deal, errorMessage) {
  const recipientIds = new Set();
  if (deal.assignedTo) recipientIds.add(String(deal.assignedTo));
  if (deal.createdBy) recipientIds.add(String(deal.createdBy));
  if (message.createdBy) recipientIds.add(String(message.createdBy));

  for (const userId of recipientIds) {
    try {
      await createNotification({
        organization: message.organization,
        user: userId,
        type: 'system',
        title: 'Scheduled message failed to send',
        message: `Couldn't send "${(message.subject || 'message').slice(0, 60)}" for "${deal.title}": ${errorMessage}`,
        entityType: 'deal',
        entityId: deal._id,
      });
    } catch (e) {
      console.error('[SchedMsgPoller] failure notification failed:', e.message);
    }
  }
}

async function tick() {
  if (stopped || running) return;
  running = true;
  try {
    await pollAndSend();
  } catch (err) {
    console.error('[SchedMsgPoller] tick failed:', err);
  } finally {
    running = false;
    if (!stopped) timer = setTimeout(tick, POLL_INTERVAL_MS);
  }
}

export function startScheduledMessagePoller() {
  if (timer || stopped) return;
  console.log('[SchedMsgPoller] started, polling every 60s');
  timer = setTimeout(tick, STARTUP_DELAY_MS);
}

export function stopScheduledMessagePoller() {
  stopped = true;
  if (timer) clearTimeout(timer);
  timer = null;
}

for (const sig of ['SIGTERM', 'SIGINT']) {
  process.once(sig, stopScheduledMessagePoller);
}
