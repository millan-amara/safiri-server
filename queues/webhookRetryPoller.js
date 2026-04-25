import WebhookDelivery from '../models/WebhookDelivery.js';
import { processDelivery } from '../services/invoiceWebhook.js';

const POLL_INTERVAL_MS = 60 * 1000;
const STARTUP_DELAY_MS = 9000;
const BATCH_LIMIT = 25;            // hard cap on total deliveries processed per tick
const MAX_PER_ORG_PER_TICK = 5;    // per-org throttle so one bad receiver doesn't get hammered
const CANDIDATE_POOL_LIMIT = 100;  // pool we sample from before grouping/throttling

let timer = null;
let running = false;
let stopped = false;

async function pollAndRetry() {
  const now = new Date();
  // Pull a larger pool than BATCH_LIMIT so we have room to throttle per-org
  // without starving smaller orgs. Sort oldest-due first so deliveries that
  // have been waiting longest get priority.
  const pool = await WebhookDelivery.find({
    status: 'pending',
    nextAttemptAt: { $lte: now },
  })
    .sort({ nextAttemptAt: 1 })
    .limit(CANDIDATE_POOL_LIMIT);

  if (!pool.length) return;

  // Group by org and take at most MAX_PER_ORG_PER_TICK each, then cap the total
  // at BATCH_LIMIT. A single org with 50 failing deliveries will only see 5 of
  // them retry per minute — protects rate-limited receivers from a thundering herd.
  const perOrgCount = new Map();
  const toProcess = [];
  for (const d of pool) {
    const key = String(d.organization);
    const count = perOrgCount.get(key) || 0;
    if (count >= MAX_PER_ORG_PER_TICK) continue;
    perOrgCount.set(key, count + 1);
    toProcess.push(d);
    if (toProcess.length >= BATCH_LIMIT) break;
  }

  for (const delivery of toProcess) {
    try {
      // Atomic claim — guard against two pollers racing on the same delivery.
      const claimed = await WebhookDelivery.findOneAndUpdate(
        { _id: delivery._id, status: 'pending', nextAttemptAt: { $lte: now } },
        { $set: { nextAttemptAt: null } },
        { new: true },
      );
      if (!claimed) continue;
      await processDelivery(claimed);
    } catch (err) {
      console.error(`[WebhookRetryPoller] processing failed for ${delivery._id}:`, err.message);
    }
  }
}

async function tick() {
  if (stopped || running) return;
  running = true;
  try {
    await pollAndRetry();
  } catch (err) {
    console.error('[WebhookRetryPoller] tick failed:', err);
  } finally {
    running = false;
    if (!stopped) timer = setTimeout(tick, POLL_INTERVAL_MS);
  }
}

export function startWebhookRetryPoller() {
  if (timer || stopped) return;
  console.log('[WebhookRetryPoller] started, polling every 60s');
  timer = setTimeout(tick, STARTUP_DELAY_MS);
}

export function stopWebhookRetryPoller() {
  stopped = true;
  if (timer) clearTimeout(timer);
  timer = null;
}

for (const sig of ['SIGTERM', 'SIGINT']) {
  process.once(sig, stopWebhookRetryPoller);
}
