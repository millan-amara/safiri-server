import Organization from '../models/Organization.js';
import { AI_CREDIT_COST, PLANS, UNLIMITED } from '../config/plans.js';

// ─── HELPERS ──────────────────────────────────────────────────────────────────

// Returns the cached org from req (set by protect) or fetches it fresh.
// Always prefer the cached version — protect loads it on every authenticated request.
async function getOrg(req) {
  if (req.organization) return req.organization;
  const org = await Organization.findById(req.organizationId)
    .select('subscriptionStatus plan trialEndsAt trialQuoteCount trialQuoteLimit aiCreditsUsed aiCreditsLimit aiCreditsResetAt currentPeriodEnd')
    .lean();
  req.organization = org;
  return org;
}

// ─── SUBSCRIPTION STATUS ───────────────────────────────────────────────────────

/**
 * Block write operations when subscription is expired or cancelled.
 * GETs are always allowed — read-only mode is the expired-org experience.
 *
 * NOTE: protect() already calls this logic globally for all authenticated routes.
 * Export this for explicit use in specific middleware chains (e.g. billing routes).
 */
export const requireActiveSubscription = async (req, res, next) => {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  if (!req.organizationId) return next(); // not yet authenticated — let route handle it

  try {
    const org = await getOrg(req);
    if (!org) return next();

    if (org.subscriptionStatus === 'expired' || org.subscriptionStatus === 'cancelled') {
      return res.status(402).json({
        message: 'Your trial has ended. Reactivate your account to continue creating content.',
        status: org.subscriptionStatus,
        trialEndsAt: org.trialEndsAt,
        code: 'SUBSCRIPTION_INACTIVE',
      });
    }

    next();
  } catch (err) {
    next(err);
  }
};

// ─── QUOTE QUOTA ───────────────────────────────────────────────────────────────

/**
 * Block quote creation when the org has hit its plan's quote allowance.
 *   - trial: lifetime cap (trialQuoteCount vs trialQuoteLimit) — exhausting it ends the trial early via cron
 *   - starter: monthly cap (quotesThisMonth vs PLANS.starter.quotesPerMonth) — resets on the 1st
 *   - pro/business/enterprise: unlimited, passes through
 *
 * Apply to POST /api/quotes/ and POST /api/quotes/templates/:id/use.
 */
export const requireQuoteQuota = async (req, res, next) => {
  if (!req.organizationId) return next();

  try {
    const org = await getOrg(req);
    if (!org) return next();

    if (org.plan === 'trial') {
      if (org.trialQuoteCount >= org.trialQuoteLimit) {
        return res.status(402).json({
          message: `You've used all ${org.trialQuoteLimit} trial quotes. Upgrade to keep building.`,
          trialQuoteCount: org.trialQuoteCount,
          trialQuoteLimit: org.trialQuoteLimit,
          code: 'TRIAL_QUOTE_LIMIT',
        });
      }
      return next();
    }

    const monthlyCap = PLANS[org.plan]?.quotesPerMonth ?? UNLIMITED;
    if (monthlyCap !== UNLIMITED && (org.quotesThisMonth || 0) >= monthlyCap) {
      return res.status(402).json({
        message: `You've used all ${monthlyCap} quotes for this month. They reset on the 1st, or upgrade to Pro for unlimited.`,
        quotesThisMonth: org.quotesThisMonth,
        quotesMonthLimit: monthlyCap,
        resetAt: org.quotesMonthResetAt,
        code: 'QUOTE_MONTH_LIMIT',
      });
    }

    next();
  } catch (err) {
    next(err);
  }
};

// Legacy alias — old import name still works during the transition.
export const requireTrialQuoteQuota = requireQuoteQuota;

// ─── AI CREDITS ────────────────────────────────────────────────────────────────

/**
 * Factory: returns middleware that atomically deducts `cost` AI credits from the
 * org's monthly balance. The conditional update only fires when remaining credits
 * cover the cost — no race conditions, no over-spending.
 *
 * Auto-refunds on non-2xx responses (Claude failure, bad input, exceptions) so a
 * failed call doesn't burn the user's balance.
 *
 * Use the AI_CREDIT_COST constants for cost tiers:
 *   checkAiCredits(AI_CREDIT_COST.heavy)   // draft-itinerary, generate-all-narratives
 *   checkAiCredits(AI_CREDIT_COST.medium)  // generate-narrative, suggest-route
 *   checkAiCredits(AI_CREDIT_COST.light)   // deal-summary, draft-email, map-columns
 */
export const checkAiCredits = (cost) => async (req, res, next) => {
  if (!req.organizationId) return next();

  try {
    const before = await Organization.findOneAndUpdate(
      {
        _id: req.organizationId,
        $expr: { $lte: [{ $add: ['$aiCreditsUsed', cost] }, '$aiCreditsLimit'] },
      },
      { $inc: { aiCreditsUsed: cost } },
      { new: false }
    );

    if (!before) {
      const org = req.organization
        || await Organization.findById(req.organizationId)
            .select('aiCreditsUsed aiCreditsLimit aiCreditsResetAt')
            .lean();

      return res.status(402).json({
        message: "You've used all your AI credits for this month. They reset on the 1st.",
        used: org.aiCreditsUsed,
        limit: org.aiCreditsLimit,
        cost,
        resetAt: org.aiCreditsResetAt,
        code: 'AI_CREDITS_EXHAUSTED',
      });
    }

    if (req.organization) {
      req.organization = {
        ...req.organization,
        aiCreditsUsed: before.aiCreditsUsed + cost,
      };
    }

    let refunded = false;
    res.on('finish', () => {
      if (refunded) return;
      if (res.statusCode >= 200 && res.statusCode < 300) return;
      refunded = true;
      Organization.updateOne(
        { _id: req.organizationId, aiCreditsUsed: { $gte: cost } },
        { $inc: { aiCreditsUsed: -cost } }
      ).catch(e => console.error('AI credit refund failed:', e.message));
    });

    next();
  } catch (err) {
    next(err);
  }
};

// Legacy export — kept as a thin alias to avoid breaking imports until all callsites migrate.
export const checkAiItineraryQuota = checkAiCredits(AI_CREDIT_COST.heavy);

// ─── TRIAL USAGE TRACKING ──────────────────────────────────────────────────────

/**
 * Increment the right counter after a quote is successfully created.
 *   - trial: trialQuoteCount (lifetime; triggers trial expiry when full)
 *   - starter (or any finite-quote plan): quotesThisMonth (monthly; resets via cron)
 *   - unlimited plans: no-op
 *
 * Called from the route handler after a successful save so failed creates don't burn quota.
 */
export async function trackQuoteUsage(organizationId, plan) {
  try {
    if (plan === 'trial') {
      await Organization.findByIdAndUpdate(organizationId, { $inc: { trialQuoteCount: 1 } });
      return;
    }
    const cap = PLANS[plan]?.quotesPerMonth;
    if (cap != null && cap !== UNLIMITED) {
      await Organization.findByIdAndUpdate(organizationId, { $inc: { quotesThisMonth: 1 } });
    }
  } catch (err) {
    console.error('trackQuoteUsage failed:', err.message);
  }
}

// Legacy alias.
export const trackTrialQuoteUsage = trackQuoteUsage;
