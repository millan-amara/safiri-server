import { Router } from 'express';
import ScheduledMessage from '../models/ScheduledMessage.js';
import { Deal, Pipeline } from '../models/Deal.js';
import { protect, authorize } from '../middleware/auth.js';
import { userCanSeePipeline, getAccessiblePipelineIds } from '../middleware/access.js';

const ADMIN_ROLES = ['owner', 'admin'];
const isAdmin = (user) => ADMIN_ROLES.includes(user.role);

const router = Router();

// Returns the UTC instant for "this calendar date at hour:minute local time
// in the given IANA timezone". Standardizes relative scheduled messages on a
// friendly send hour (e.g. 9am local) instead of midnight UTC.
export function setLocalTimeOfDay(date, hour, minute, timezone) {
  // Calendar date in the target timezone (en-CA gives YYYY-MM-DD).
  const dateStr = date.toLocaleDateString('en-CA', { timeZone: timezone });
  const [year, month, day] = dateStr.split('-').map(Number);

  // Build a candidate UTC instant treating hour:minute as if they were UTC,
  // then offset by the tz delta to land on the real UTC moment.
  const candidateUtc = Date.UTC(year, month - 1, day, hour, minute, 0);
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false,
  }).formatToParts(new Date(candidateUtc)).reduce((a, p) => {
    a[p.type] = p.value;
    return a;
  }, {});
  const displayedAsUtc = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour) === 24 ? 0 : Number(parts.hour),
    Number(parts.minute),
    Number(parts.second),
  );
  const tzOffsetMs = displayedAsUtc - candidateUtc;
  return new Date(candidateUtc - tzOffsetMs);
}

// Resolve a timing spec + a deal into the absolute sendAt date.
// Returns null if the inputs can't produce a valid date (e.g. relative mode
// but the deal has no travel start/end set yet).
//
// Relative modes use the org's configured send-hour and timezone so messages
// land at e.g. 9am local instead of midnight UTC. Absolute mode respects the
// exact date+time the operator picked.
export function computeSendAt(timing, deal, options = {}) {
  if (!timing) return null;
  const { hour = 9, timezone = 'Africa/Nairobi' } = options;
  const { mode, offsetDays = 0, absoluteDate } = timing;
  const days = Math.max(0, Number(offsetDays) || 0);
  const ms = days * 24 * 60 * 60 * 1000;

  if (mode === 'absolute') {
    return absoluteDate ? new Date(absoluteDate) : null;
  }
  if (mode === 'before_travel_start') {
    if (!deal.travelDates?.start) return null;
    const baseDate = new Date(new Date(deal.travelDates.start).getTime() - ms);
    return setLocalTimeOfDay(baseDate, hour, 0, timezone);
  }
  if (mode === 'after_travel_end') {
    if (!deal.travelDates?.end) return null;
    const baseDate = new Date(new Date(deal.travelDates.end).getTime() + ms);
    return setLocalTimeOfDay(baseDate, hour, 0, timezone);
  }
  return null;
}

// Pull send-time options from an organization's preferences with defaults.
function sendTimeOptions(organization) {
  return {
    hour: organization?.preferences?.scheduledMessageHour ?? 9,
    timezone: organization?.preferences?.scheduledMessageTimezone || 'Africa/Nairobi',
  };
}

// Helper: load the deal + verify the current user can see its pipeline.
// Returns { deal } on success or { error: { status, message } } otherwise.
async function loadAccessibleDeal(req, dealId) {
  const deal = await Deal.findOne({ _id: dealId, organization: req.organizationId });
  if (!deal) return { error: { status: 404, message: 'Deal not found' } };
  const pipeline = await Pipeline.findOne({
    _id: deal.pipeline,
    organization: req.organizationId,
  }).lean();
  if (!pipeline || !userCanSeePipeline(req.user, pipeline)) {
    return { error: { status: 403, message: 'No access to this deal' } };
  }
  return { deal, pipeline };
}

// LIST scheduled messages — either for a single deal (?deal=) or across all
// accessible deals in a date range (?from=&to=) for the calendar view.
router.get('/', protect, async (req, res) => {
  try {
    const { deal: dealId, from, to } = req.query;

    // Per-deal mode (existing behavior)
    if (dealId) {
      const { deal, error } = await loadAccessibleDeal(req, dealId);
      if (error) return res.status(error.status).json({ message: error.message });

      const messages = await ScheduledMessage.find({
        organization: req.organizationId,
        deal: deal._id,
      })
        .populate('createdBy', 'name avatar')
        .sort({ sendAt: 1 });
      return res.json({ messages });
    }

    // Date-range mode (calendar view)
    if (from && to) {
      const fromDate = new Date(from);
      const toDate = new Date(to);
      if (isNaN(fromDate) || isNaN(toDate)) {
        return res.status(400).json({ message: 'from and to must be valid dates' });
      }

      // Filter to messages on deals the user can see (pipeline access).
      const filter = {
        organization: req.organizationId,
        sendAt: { $gte: fromDate, $lte: toDate },
      };
      if (!isAdmin(req.user)) {
        const accessiblePipelines = await getAccessiblePipelineIds(req.user);
        const accessibleDeals = await Deal.find({
          organization: req.organizationId,
          pipeline: { $in: accessiblePipelines },
          isActive: true,
        }).select('_id').lean();
        filter.deal = { $in: accessibleDeals.map(d => d._id) };
      }

      const messages = await ScheduledMessage.find(filter)
        .populate('createdBy', 'name avatar')
        .populate('deal', 'title')
        .sort({ sendAt: 1 });
      return res.json({ messages });
    }

    return res.status(400).json({ message: 'Either ?deal= or ?from=&to= is required' });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// CREATE scheduled message
router.post('/', protect, authorize('owner', 'admin', 'agent'), async (req, res) => {
  try {
    const { deal: dealId, subject, body, timing, channel = 'email' } = req.body;
    if (!dealId) return res.status(400).json({ message: 'deal is required' });
    if (!body?.trim()) return res.status(400).json({ message: 'body is required' });
    if (!timing?.mode) return res.status(400).json({ message: 'timing.mode is required' });

    const { deal, error } = await loadAccessibleDeal(req, dealId);
    if (error) return res.status(error.status).json({ message: error.message });

    const sendAt = computeSendAt(timing, deal, sendTimeOptions(req.organization));
    if (!sendAt) {
      return res.status(400).json({
        message: timing.mode === 'absolute'
          ? 'An absolute date is required for this timing mode.'
          : 'Cannot compute send date — set the deal travel dates first, or pick an absolute date.',
      });
    }

    const status = sendAt < new Date() ? 'overdue' : 'scheduled';

    const message = await ScheduledMessage.create({
      organization: req.organizationId,
      deal: deal._id,
      createdBy: req.user._id,
      channel,
      subject: subject || '',
      body,
      timing,
      sendAt,
      status,
    });

    const populated = await ScheduledMessage.findById(message._id).populate('createdBy', 'name avatar');
    res.status(201).json(populated);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// UPDATE — only while scheduled or overdue (sent/cancelled/failed are immutable)
router.put('/:id', protect, authorize('owner', 'admin', 'agent'), async (req, res) => {
  try {
    const message = await ScheduledMessage.findOne({
      _id: req.params.id,
      organization: req.organizationId,
    });
    if (!message) return res.status(404).json({ message: 'Not found' });
    if (!['scheduled', 'overdue'].includes(message.status)) {
      return res.status(400).json({ message: 'This message has already been sent or cancelled.' });
    }

    const { error } = await loadAccessibleDeal(req, message.deal);
    if (error) return res.status(error.status).json({ message: error.message });

    const { subject, body, timing, channel } = req.body;
    if (subject !== undefined) message.subject = subject;
    if (body !== undefined) message.body = body;
    if (channel) message.channel = channel;

    if (timing) {
      message.timing = timing;
      const deal = await Deal.findById(message.deal);
      const newSendAt = computeSendAt(timing, deal, sendTimeOptions(req.organization));
      if (!newSendAt) {
        return res.status(400).json({ message: 'Cannot compute send date with the new timing.' });
      }
      message.sendAt = newSendAt;
      message.status = newSendAt < new Date() ? 'overdue' : 'scheduled';
    }

    await message.save();
    const populated = await ScheduledMessage.findById(message._id).populate('createdBy', 'name avatar');
    res.json(populated);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// DELETE — hard delete unless the message has already been sent (then we keep
// the record for audit). Cancelled/failed/scheduled/overdue can all be removed.
router.delete('/:id', protect, authorize('owner', 'admin', 'agent'), async (req, res) => {
  try {
    const message = await ScheduledMessage.findOne({
      _id: req.params.id,
      organization: req.organizationId,
    });
    if (!message) return res.status(404).json({ message: 'Not found' });
    if (message.status === 'sent') {
      return res.status(400).json({ message: 'Cannot delete a sent message.' });
    }

    const { error } = await loadAccessibleDeal(req, message.deal);
    if (error) return res.status(error.status).json({ message: error.message });

    await ScheduledMessage.findByIdAndDelete(message._id);
    res.json({ message: 'Deleted' });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

export default router;
