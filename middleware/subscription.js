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
    // Try the monthly allowance first. Atomic conditional update — only
    // succeeds if the org has enough monthly credits left to cover `cost`.
    let charged = await Organization.findOneAndUpdate(
      {
        _id: req.organizationId,
        $expr: { $lte: [{ $add: ['$aiCreditsUsed', cost] }, '$aiCreditsLimit'] },
      },
      { $inc: { aiCreditsUsed: cost } },
      { new: false }
    );
    let chargedFrom = charged ? 'monthly' : null;

    // Monthly exhausted — try the one-off purchased pool. Same atomic pattern.
    if (!charged) {
      charged = await Organization.findOneAndUpdate(
        { _id: req.organizationId, purchasedCredits: { $gte: cost } },
        { $inc: { purchasedCredits: -cost } },
        { new: false }
      );
      if (charged) chargedFrom = 'purchased';
    }

    if (!charged) {
      const org = req.organization
        || await Organization.findById(req.organizationId)
            .select('aiCreditsUsed aiCreditsLimit aiCreditsResetAt purchasedCredits')
            .lean();

      return res.status(402).json({
        message: "You've used all your AI credits for this month and have no purchased credits left. Buy a credit pack to keep going, or wait for your monthly allowance to reset on the 1st.",
        used: org.aiCreditsUsed,
        limit: org.aiCreditsLimit,
        purchasedCredits: org.purchasedCredits || 0,
        cost,
        resetAt: org.aiCreditsResetAt,
        code: 'AI_CREDITS_EXHAUSTED',
      });
    }

    if (req.organization) {
      req.organization = {
        ...req.organization,
        ...(chargedFrom === 'monthly'
          ? { aiCreditsUsed: charged.aiCreditsUsed + cost }
          : { purchasedCredits: Math.max(0, (charged.purchasedCredits || 0) - cost) }),
      };
    }

    // Auto-refund on non-2xx — back to whichever pool we charged.
    let refunded = false;
    res.on('finish', () => {
      if (refunded) return;
      if (res.statusCode >= 200 && res.statusCode < 300) return;
      refunded = true;
      const refund = chargedFrom === 'monthly'
        ? Organization.updateOne(
            { _id: req.organizationId, aiCreditsUsed: { $gte: cost } },
            { $inc: { aiCreditsUsed: -cost } }
          )
        : Organization.updateOne(
            { _id: req.organizationId },
            { $inc: { purchasedCredits: cost } }
          );
      refund.catch(e => console.error('AI credit refund failed:', e.message));
    });

    next();
  } catch (err) {
    next(err);
  }
};

// Legacy export — kept as a thin alias to avoid breaking imports until all callsites migrate.
export const checkAiItineraryQuota = checkAiCredits(AI_CREDIT_COST.heavy);

// ─── PDF PAGE METERING ────────────────────────────────────────────────────────

/**
 * Counts pages in the uploaded PDF (req.file.buffer, set by multer) and
 * atomically deducts that many pages from the org's monthly PDF allowance.
 * If monthly is exhausted, falls through to purchasedPdfPages. Auto-refunds
 * on non-2xx responses (Claude failure, parse error, etc.).
 *
 * Must run AFTER multer.single('file') so req.file is populated.
 *
 * Used by partners.js extract-pdf only — replaces the old fixed checkAiCredits(heavy)
 * charge so cost is proportional to PDF size (a 1-page rate card costs 1 page,
 * a 40-page A&K rate book costs 40 pages).
 */
export const checkPdfPages = async (req, res, next) => {
  if (!req.organizationId) return next();
  if (!req.file) {
    return res.status(400).json({ message: 'No PDF file uploaded' });
  }

  // Count pages with pdf-lib. ignoreEncryption lets us count encrypted PDFs
  // (the extraction itself may still fail downstream — we'll auto-refund).
  let pageCount;
  try {
    const { PDFDocument } = await import('pdf-lib');
    const pdfDoc = await PDFDocument.load(req.file.buffer, { ignoreEncryption: true });
    pageCount = pdfDoc.getPageCount();
  } catch (err) {
    return res.status(400).json({ message: `Could not parse PDF: ${err.message}` });
  }

  if (pageCount <= 0) {
    return res.status(400).json({ message: 'PDF has no pages' });
  }

  // Try monthly allowance first.
  let charged = await Organization.findOneAndUpdate(
    {
      _id: req.organizationId,
      $expr: { $lte: [{ $add: ['$pdfPagesUsed', pageCount] }, '$pdfPagesLimit'] },
    },
    { $inc: { pdfPagesUsed: pageCount } },
    { new: false }
  );
  let chargedFrom = charged ? 'monthly' : null;

  // Fall through to purchased pool.
  if (!charged) {
    charged = await Organization.findOneAndUpdate(
      { _id: req.organizationId, purchasedPdfPages: { $gte: pageCount } },
      { $inc: { purchasedPdfPages: -pageCount } },
      { new: false }
    );
    if (charged) chargedFrom = 'purchased';
  }

  if (!charged) {
    const org = await Organization.findById(req.organizationId)
      .select('pdfPagesUsed pdfPagesLimit pdfPagesResetAt purchasedPdfPages')
      .lean();
    const monthlyLeft = Math.max(0, (org.pdfPagesLimit || 0) - (org.pdfPagesUsed || 0));
    return res.status(402).json({
      message: `This PDF has ${pageCount} pages, but you only have ${monthlyLeft} monthly + ${org.purchasedPdfPages || 0} purchased PDF pages remaining. Buy a PDF page pack to continue, or split the PDF into smaller files.`,
      pageCount,
      monthlyRemaining: monthlyLeft,
      purchasedRemaining: org.purchasedPdfPages || 0,
      resetAt: org.pdfPagesResetAt,
      code: 'PDF_PAGES_EXHAUSTED',
    });
  }

  // Stash for the route handler (handy for response metadata) and refund logic.
  req._pdfPageDeduction = { pageCount, chargedFrom };

  let refunded = false;
  res.on('finish', () => {
    if (refunded) return;
    if (res.statusCode >= 200 && res.statusCode < 300) return;
    refunded = true;
    const refund = chargedFrom === 'monthly'
      ? Organization.updateOne(
          { _id: req.organizationId, pdfPagesUsed: { $gte: pageCount } },
          { $inc: { pdfPagesUsed: -pageCount } }
        )
      : Organization.updateOne(
          { _id: req.organizationId },
          { $inc: { purchasedPdfPages: pageCount } }
        );
    refund.catch(e => console.error('PDF page refund failed:', e.message));
  });

  next();
};

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
