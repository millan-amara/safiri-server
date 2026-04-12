import Organization from '../models/Organization.js';

// ─── HELPERS ──────────────────────────────────────────────────────────────────

// Returns the cached org from req (set by protect) or fetches it fresh.
// Always prefer the cached version — protect loads it on every authenticated request.
async function getOrg(req) {
  if (req.organization) return req.organization;
  const org = await Organization.findById(req.organizationId)
    .select('subscriptionStatus plan trialEndsAt trialQuoteCount trialQuoteLimit aiItineraryGenerationsUsed aiItineraryGenerationsLimit aiCreditsResetAt currentPeriodEnd')
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

// ─── TRIAL QUOTE QUOTA ─────────────────────────────────────────────────────────

/**
 * Block quote creation if the org is on trial and has hit the quote limit.
 * Apply to POST /api/quotes/ and POST /api/quotes/templates/:id/use.
 */
export const requireTrialQuoteQuota = async (req, res, next) => {
  if (!req.organizationId) return next();

  try {
    const org = await getOrg(req);
    if (!org) return next();

    // Quota only applies during trial
    if (org.plan !== 'trial') return next();

    if (org.trialQuoteCount >= org.trialQuoteLimit) {
      return res.status(402).json({
        message: `You've used all ${org.trialQuoteLimit} trial quotes. Upgrade to Pro for unlimited quotes.`,
        status: org.subscriptionStatus,
        trialQuoteCount: org.trialQuoteCount,
        trialQuoteLimit: org.trialQuoteLimit,
        code: 'TRIAL_QUOTE_LIMIT',
      });
    }

    next();
  } catch (err) {
    next(err);
  }
};

// ─── AI ITINERARY QUOTA ────────────────────────────────────────────────────────

/**
 * Atomically check and increment the monthly AI itinerary generation counter.
 * Uses a conditional update so the increment only happens if under the limit —
 * no race condition, no double-decrement needed.
 *
 * Apply only to: POST /ai/draft-itinerary, POST /ai/generate-all-narratives
 */
export const checkAiItineraryQuota = async (req, res, next) => {
  if (!req.organizationId) return next();

  try {
    // Atomically increment — only if usage is currently below the limit
    const before = await Organization.findOneAndUpdate(
      {
        _id: req.organizationId,
        $expr: { $lt: ['$aiItineraryGenerationsUsed', '$aiItineraryGenerationsLimit'] },
      },
      { $inc: { aiItineraryGenerationsUsed: 1 } },
      { new: false } // return the pre-update document
    );

    if (!before) {
      // Conditional update didn't match — quota is exceeded
      const org = req.organization
        || await Organization.findById(req.organizationId)
            .select('aiItineraryGenerationsUsed aiItineraryGenerationsLimit aiCreditsResetAt')
            .lean();

      return res.status(402).json({
        message: "You've used all your AI itinerary generations for this month. They reset on the 1st.",
        used: org.aiItineraryGenerationsUsed,
        limit: org.aiItineraryGenerationsLimit,
        resetAt: org.aiCreditsResetAt,
        code: 'AI_QUOTA_EXCEEDED',
      });
    }

    // Increment succeeded — update the cached org so downstream sees the new count
    if (req.organization) {
      req.organization = {
        ...req.organization,
        aiItineraryGenerationsUsed: before.aiItineraryGenerationsUsed + 1,
      };
    }

    next();
  } catch (err) {
    next(err);
  }
};

// ─── TRIAL USAGE TRACKING ──────────────────────────────────────────────────────

/**
 * Increment the trial quote counter after a quote is successfully created.
 * Call this as a plain function from the route handler (after a successful save),
 * not as middleware — we only want to count successfully created quotes.
 *
 * @param {string|ObjectId} organizationId
 * @param {string} plan  - current org plan (skip if not 'trial')
 */
export async function trackTrialQuoteUsage(organizationId, plan) {
  if (plan !== 'trial') return;
  try {
    await Organization.findByIdAndUpdate(organizationId, { $inc: { trialQuoteCount: 1 } });
  } catch (err) {
    // Non-critical — log but don't surface to the user
    console.error('trackTrialQuoteUsage failed:', err.message);
  }
}
