import { Router } from 'express';
import Organization from '../models/Organization.js';

const router = Router();

/**
 * Guard middleware — all cron endpoints require the X-Cron-Secret header
 * matching the CRON_SECRET env var. Set this value in cron-job.org's custom headers.
 */
function cronGuard(req, res, next) {
  const secret = req.headers['x-cron-secret'];
  if (!secret || secret !== process.env.CRON_SECRET) {
    return res.status(401).json({ message: 'Unauthorized' });
  }
  next();
}

// ─── TRIAL EXPIRATION ──────────────────────────────────────────────────────────

/**
 * POST /api/cron/check-trial-expirations
 *
 * Finds all orgs still in 'trialing' status where:
 *   - trialEndsAt has passed, OR
 *   - trialQuoteCount has reached trialQuoteLimit
 *
 * Updates them to subscriptionStatus: 'expired'.
 *
 * Idempotent — already-expired orgs don't match the 'trialing' filter,
 * so re-running this is safe.
 *
 * Schedule via cron-job.org: daily at 00:05 UTC
 */
router.post('/check-trial-expirations', cronGuard, async (req, res) => {
  try {
    const now = new Date();

    const result = await Organization.updateMany(
      {
        subscriptionStatus: 'trialing',
        $or: [
          { trialEndsAt: { $lt: now } },
          { $expr: { $gte: ['$trialQuoteCount', '$trialQuoteLimit'] } },
        ],
      },
      { $set: { subscriptionStatus: 'expired' } }
    );

    console.log(`[cron] check-trial-expirations: expired ${result.modifiedCount} org(s)`);
    res.json({ ok: true, expired: result.modifiedCount, checkedAt: now });
  } catch (err) {
    console.error('[cron] check-trial-expirations error:', err.message);
    res.status(500).json({ message: err.message });
  }
});

// ─── MONTHLY AI CREDIT RESET ───────────────────────────────────────────────────

/**
 * POST /api/cron/reset-ai-credits
 *
 * Resets aiItineraryGenerationsUsed to 0 for all non-expired orgs.
 * Sets aiCreditsResetAt to the 1st of the next UTC month.
 *
 * Idempotent — running it twice in a month resets to 0 both times, which is fine.
 *
 * Schedule via cron-job.org: 1st of every month at 00:01 UTC
 */
router.post('/reset-ai-credits', cronGuard, async (req, res) => {
  try {
    const now = new Date();
    const nextReset = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));

    const result = await Organization.updateMany(
      {
        // Reset for all orgs that could be using AI — skip hard-expired/cancelled
        subscriptionStatus: { $in: ['trialing', 'active', 'past_due'] },
      },
      {
        $set: {
          aiItineraryGenerationsUsed: 0,
          aiCreditsResetAt: nextReset,
        },
      }
    );

    console.log(`[cron] reset-ai-credits: reset ${result.modifiedCount} org(s), next reset at ${nextReset.toISOString()}`);
    res.json({ ok: true, reset: result.modifiedCount, nextResetAt: nextReset });
  } catch (err) {
    console.error('[cron] reset-ai-credits error:', err.message);
    res.status(500).json({ message: err.message });
  }
});

export default router;
