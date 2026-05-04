import { Router } from 'express';
import crypto from 'crypto';
import Organization from '../models/Organization.js';
import User from '../models/User.js';
import * as paystack from '../services/paystack.js';
import { PLANS, nextMonthlyResetDate } from '../config/plans.js';

const router = Router();

// Constant-time string compare. `===` returns as soon as it finds the first
// mismatching byte, which leaks the prefix length via timing — over enough
// requests an attacker can reconstruct the secret one byte at a time.
function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const aBuf = Buffer.from(a);
  const bBuf = Buffer.from(b);
  if (aBuf.length !== bBuf.length) return false;
  return crypto.timingSafeEqual(aBuf, bBuf);
}

/**
 * Guard middleware — all cron endpoints require the X-Cron-Secret header
 * matching the CRON_SECRET env var. Set this value in cron-job.org's custom headers.
 */
function cronGuard(req, res, next) {
  const secret = req.headers['x-cron-secret'];
  if (!secret || !safeEqual(secret, process.env.CRON_SECRET || '')) {
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
 * Monthly reset for all orgs that could be using metered features:
 *   - aiCreditsUsed → 0
 *   - quotesThisMonth → 0
 *   - pdfPagesUsed → 0
 *   - aiCreditsResetAt + quotesMonthResetAt + pdfPagesResetAt → 1st of next UTC month
 *
 * `purchasedCredits` and `purchasedPdfPages` are NOT reset — those are paid
 * top-ups that carry indefinitely.
 *
 * Idempotent — running twice in a month resets to 0 both times, which is fine.
 * Schedule via cron-job.org: 1st of every month at 00:01 UTC.
 */
router.post('/reset-ai-credits', cronGuard, async (req, res) => {
  try {
    const nextReset = nextMonthlyResetDate();

    const result = await Organization.updateMany(
      { subscriptionStatus: { $in: ['trialing', 'active', 'past_due'] } },
      {
        $set: {
          aiCreditsUsed: 0,
          quotesThisMonth: 0,
          pdfPagesUsed: 0,
          aiCreditsResetAt: nextReset,
          quotesMonthResetAt: nextReset,
          pdfPagesResetAt: nextReset,
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

// ─── SCHEDULED DOWNGRADES ──────────────────────────────────────────────────────

/**
 * POST /api/cron/process-scheduled-downgrades
 *
 * Finds orgs where a downgrade was scheduled (pendingPlan set) and their
 * currentPeriodEnd has passed. For each one:
 *   1. Charge the saved Paystack authorization for the new plan's amount
 *   2. Create a new subscription on the new plan code
 *   3. Update the org to the new plan and clear pendingPlan
 *
 * On auth-charge failure (expired card, insufficient funds), the org is marked
 * past_due and pendingPlan is kept so the user can fix their card and retry.
 *
 * Schedule via cron-job.org: daily at 00:10 UTC
 */
router.post('/process-scheduled-downgrades', cronGuard, async (req, res) => {
  const now = new Date();
  const results = { processed: 0, downgraded: 0, failed: 0, skipped: 0 };

  try {
    const dueOrgs = await Organization.find({
      pendingPlan: { $ne: null },
      currentPeriodEnd: { $lte: now },
      subscriptionStatus: { $in: ['active', 'cancelled'] },
    });

    for (const org of dueOrgs) {
      results.processed += 1;
      const targetPlan = org.pendingPlan;
      const config = PLANS[targetPlan];

      if (!config || !config.planCodeEnv || !org.paystackAuthorizationCode || !org.paystackCustomerCode) {
        console.warn(`[cron] downgrade skipped for org ${org._id}: missing config, auth code, or customer code`);
        org.subscriptionStatus = 'past_due';
        await org.save();
        results.skipped += 1;
        continue;
      }

      // Find any user on the org to use as the email for the charge
      const user = await User.findOne({ organization: org._id }).select('email');
      if (!user?.email) {
        console.warn(`[cron] downgrade skipped for org ${org._id}: no user email found`);
        results.skipped += 1;
        continue;
      }

      // Scheduled downgrade always uses monthly billing for simplicity (annual upgrades go through checkout).
      const planCode = process.env[config.planCodeEnv];
      if (!planCode) {
        console.warn(`[cron] downgrade skipped for org ${org._id}: ${config.planCodeEnv} not set`);
        results.skipped += 1;
        continue;
      }

      try {
        // Charge the saved card for the new plan's amount
        const chargeResult = await paystack.chargeAuthorization(
          user.email,
          config.amount,
          org.paystackAuthorizationCode,
          {
            organizationId: org._id.toString(),
            plan: targetPlan,
            reason: 'scheduled_downgrade',
          }
        );

        if (chargeResult?.data?.status !== 'success') {
          throw new Error(`Charge not successful: ${chargeResult?.data?.gateway_response || 'unknown'}`);
        }

        // Create a new subscription so future renewals happen automatically
        let newSubscriptionCode = null;
        try {
          const { data: sub } = await paystack.createSubscription(org.paystackCustomerCode, planCode);
          newSubscriptionCode = sub.subscription_code;
        } catch (e) {
          // Non-fatal — the charge succeeded, so the user keeps access. They can re-subscribe later for auto-renewal.
          console.warn(`[cron] failed to create new subscription for org ${org._id}:`, e.message);
        }

        const periodEnd = new Date();
        periodEnd.setMonth(periodEnd.getMonth() + 1);

        org.plan = targetPlan;
        org.annual = false;
        org.subscriptionStatus = 'active';
        org.currentPeriodEnd = periodEnd;
        org.aiCreditsLimit = config.aiCredits;
        org.pdfPagesLimit = config.pdfPagesPerMonth;
        org.whiteLabel = config.whiteLabel;
        org.pendingPlan = null;
        if (newSubscriptionCode) org.paystackSubscriptionCode = newSubscriptionCode;
        await org.save();

        console.log(`[cron] downgraded org ${org._id} to ${targetPlan}`);
        results.downgraded += 1;
      } catch (err) {
        console.error(`[cron] downgrade failed for org ${org._id}:`, err.message);
        // Mark past_due so the paywall triggers; keep pendingPlan so the user fixes card and we retry next run
        org.subscriptionStatus = 'past_due';
        await org.save();
        results.failed += 1;
      }
    }

    res.json({ ok: true, checkedAt: now, ...results });
  } catch (err) {
    console.error('[cron] process-scheduled-downgrades error:', err.message);
    res.status(500).json({ message: err.message, ...results });
  }
});

export default router;
