import { Router } from 'express';
import Organization from '../models/Organization.js';
import { protect } from '../middleware/auth.js';
import * as paystack from '../services/paystack.js';
import { PLANS, CREDIT_PACKS, PDF_PAGE_PACKS } from '../config/plans.js';

const router = Router();

// Plans the user can self-serve checkout for. Enterprise is sales-led.
const SELF_SERVE_PLANS = ['starter', 'pro', 'business'];

// ─── GET /api/billing/plans ───────────────────────────────────────────────────
// Public catalog used by the pricing page. No auth — these are public prices.
router.get('/plans', (req, res) => {
  const catalog = Object.entries(PLANS).map(([key, p]) => ({
    key,
    label: p.label,
    monthlyPriceKES: Math.round(p.amount / 100),
    annualPriceKES: p.annualAmount ? Math.round(p.annualAmount / 100) : null,
    aiCredits: p.aiCredits,
    pdfPagesPerMonth: p.pdfPagesPerMonth,
    aiRateLimitPerMin: p.aiRateLimitPerMin,
    seats: p.seats,
    quotesPerMonth: p.quotesPerMonth,
    partnerCaps: p.partnerCaps,
    maxImagesPerRecord: p.maxImagesPerRecord,
    pipelines: p.pipelines,
    csvImportRows: p.csvImportRows,
    pdfPresets: p.pdfPresets,
    customPdfPresets: !!p.customPdfPresets,
    whiteLabel: p.whiteLabel,
    whatsapp: p.whatsapp,
    webhooks: p.webhooks,
    selfServe: SELF_SERVE_PLANS.includes(key),
  }));
  // Expose the credit-pack catalog alongside plans so the BillingPage only
  // needs one round-trip to render both the subscription and top-up UI.
  const creditPacks = Object.entries(CREDIT_PACKS).map(([key, p]) => ({
    key,
    credits: p.credits,
    priceKES: Math.round(p.amount / 100),
  }));
  const pdfPagePacks = Object.entries(PDF_PAGE_PACKS).map(([key, p]) => ({
    key,
    pages: p.pages,
    priceKES: Math.round(p.amount / 100),
  }));
  res.json({ plans: catalog, creditPacks, pdfPagePacks });
});

// ─── GET /api/billing/status ──────────────────────────────────────────────────

/**
 * Returns the org's full subscription snapshot.
 * Fetched fresh (not from req.organization cache) so the billing page
 * always shows current numbers after an upgrade.
 */
router.get('/status', protect, async (req, res) => {
  try {
    const org = await Organization.findById(req.organizationId)
      .select('subscriptionStatus plan annual trialStartedAt trialEndsAt trialQuoteCount trialQuoteLimit currentPeriodEnd aiCreditsUsed aiCreditsLimit aiCreditsResetAt purchasedCredits pdfPagesUsed pdfPagesLimit pdfPagesResetAt purchasedPdfPages quotesThisMonth libraryImageCount whiteLabel paystackSubscriptionCode pendingPlan')
      .lean();

    if (!org) return res.status(404).json({ message: 'Organization not found' });

    // Compute derived fields the frontend uses for display
    const now = new Date();
    const trialDaysLeft = org.trialEndsAt
      ? Math.max(0, Math.ceil((new Date(org.trialEndsAt) - now) / (1000 * 60 * 60 * 24)))
      : 0;
    const trialQuotesLeft = Math.max(0, (org.trialQuoteLimit || 10) - (org.trialQuoteCount || 0));

    res.json({
      ...org,
      trialDaysLeft,
      trialQuotesLeft,
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// ─── POST /api/billing/checkout ───────────────────────────────────────────────

/**
 * Creates a Paystack transaction for the requested plan.
 * Returns { authorizationUrl, reference } — frontend redirects to authorizationUrl.
 *
 * Paystack will auto-create the subscription after payment and fire webhooks.
 */
router.post('/checkout', protect, async (req, res) => {
  try {
    const { plan, annual = false } = req.body;
    if (!SELF_SERVE_PLANS.includes(plan)) {
      return res.status(400).json({ message: 'Invalid plan. Must be "starter", "pro", or "business".' });
    }

    const planConfig = PLANS[plan];
    const codeEnv = annual ? planConfig.annualPlanCodeEnv : planConfig.planCodeEnv;
    const planCode = process.env[codeEnv];
    if (!planCode) {
      return res.status(500).json({ message: `Paystack plan code missing. Set ${codeEnv} in env.` });
    }

    // Ensure the org has a Paystack customer record
    let customerCode = req.organization?.paystackCustomerCode;
    if (!customerCode) {
      // Fetch full org to check (cached lean org might not have it if field was added later)
      const orgDoc = await Organization.findById(req.organizationId).select('paystackCustomerCode');
      customerCode = orgDoc?.paystackCustomerCode;

      if (!customerCode) {
        const { data: customer } = await paystack.createCustomer(req.user.email, req.user.name);
        customerCode = customer.customer_code;
        await Organization.findByIdAndUpdate(req.organizationId, { paystackCustomerCode: customerCode });
      }
    }

    const amount = annual ? planConfig.annualAmount : planConfig.amount;

    // If the org already has an active paid subscription on a different plan, this is a plan change.
    // For upgrades (higher-priced plan), cancel the existing subscription in Paystack so it doesn't
    // double-charge, and credit any unused days from the current period onto the new subscription.
    const orgFull = await Organization.findById(req.organizationId)
      .select('plan subscriptionStatus currentPeriodEnd paystackSubscriptionCode pendingPlan')
      .lean();

    let creditDays = 0;
    const isPlanChange = orgFull
      && SELF_SERVE_PLANS.includes(orgFull.plan)
      && orgFull.plan !== plan
      && orgFull.subscriptionStatus === 'active';

    const currentPrice = orgFull && PLANS[orgFull.plan]?.amount;
    const isUpgrade = isPlanChange && currentPrice != null && amount > currentPrice;

    if (isUpgrade) {
      // Cancel the existing subscription in Paystack so the old plan doesn't renew.
      if (orgFull.paystackSubscriptionCode) {
        try {
          const { data: sub } = await paystack.fetchSubscription(orgFull.paystackSubscriptionCode);
          await paystack.disableSubscription(sub.subscription_code, sub.email_token);
        } catch (e) {
          console.warn('[billing] failed to cancel old subscription during upgrade:', e.message);
          // Non-fatal — proceed with upgrade checkout
        }
      }

      // Credit unused time: days remaining on the current period get added to the new period.
      if (orgFull.currentPeriodEnd) {
        const msRemaining = new Date(orgFull.currentPeriodEnd) - new Date();
        creditDays = Math.max(0, Math.ceil(msRemaining / (1000 * 60 * 60 * 24)));
      }
    }

    const { data } = await paystack.initializeTransaction(
      req.user.email,
      amount,
      planCode,
      {
        organizationId: req.organizationId.toString(),
        plan,
        annual,
        userId: req.user._id.toString(),
        customerCode,
        creditDays,
      }
    );

    res.json({ authorizationUrl: data.authorization_url, reference: data.reference });
  } catch (err) {
    console.error('[billing] checkout error:', err.message);
    res.status(500).json({ message: err.message });
  }
});

// ─── POST /api/billing/buy-credits ────────────────────────────────────────────

/**
 * One-off purchase of an AI credit pack. Initializes a Paystack transaction
 * with no `plan` field (no recurring subscription), then the callback below
 * tops up the org's `purchasedCredits` after successful payment.
 *
 * Body: { packKey: 'small'|'medium'|'large' }
 * Returns: { authorizationUrl, reference }
 */
router.post('/buy-credits', protect, async (req, res) => {
  try {
    const { packKey } = req.body || {};
    const pack = CREDIT_PACKS[packKey];
    if (!pack) {
      return res.status(400).json({ message: `Invalid pack. Must be one of: ${Object.keys(CREDIT_PACKS).join(', ')}` });
    }

    // Ensure the org has a Paystack customer record (mirrors /checkout).
    let customerCode = req.organization?.paystackCustomerCode;
    if (!customerCode) {
      const orgDoc = await Organization.findById(req.organizationId).select('paystackCustomerCode');
      customerCode = orgDoc?.paystackCustomerCode;
      if (!customerCode) {
        const { data: customer } = await paystack.createCustomer(req.user.email, req.user.name);
        customerCode = customer.customer_code;
        await Organization.findByIdAndUpdate(req.organizationId, { paystackCustomerCode: customerCode });
      }
    }

    const { data } = await paystack.initializeTransaction(
      req.user.email,
      pack.amount,
      null, // one-off — no subscription plan
      {
        kind: 'credit_pack',
        organizationId: req.organizationId.toString(),
        userId: req.user._id.toString(),
        customerCode,
        packKey,
        credits: pack.credits,
      }
    );

    res.json({ authorizationUrl: data.authorization_url, reference: data.reference });
  } catch (err) {
    console.error('[billing] buy-credits error:', err.message);
    res.status(500).json({ message: err.message });
  }
});

// ─── POST /api/billing/buy-pdf-pages ──────────────────────────────────────────

/**
 * One-off purchase of a PDF page pack. Same shape as /buy-credits but tops up
 * the org's `purchasedPdfPages` pool instead of `purchasedCredits`.
 *
 * Body: { packKey: 'small'|'medium'|'large' }
 * Returns: { authorizationUrl, reference }
 */
router.post('/buy-pdf-pages', protect, async (req, res) => {
  try {
    const { packKey } = req.body || {};
    const pack = PDF_PAGE_PACKS[packKey];
    if (!pack) {
      return res.status(400).json({ message: `Invalid pack. Must be one of: ${Object.keys(PDF_PAGE_PACKS).join(', ')}` });
    }

    let customerCode = req.organization?.paystackCustomerCode;
    if (!customerCode) {
      const orgDoc = await Organization.findById(req.organizationId).select('paystackCustomerCode');
      customerCode = orgDoc?.paystackCustomerCode;
      if (!customerCode) {
        const { data: customer } = await paystack.createCustomer(req.user.email, req.user.name);
        customerCode = customer.customer_code;
        await Organization.findByIdAndUpdate(req.organizationId, { paystackCustomerCode: customerCode });
      }
    }

    const { data } = await paystack.initializeTransaction(
      req.user.email,
      pack.amount,
      null,
      {
        kind: 'pdf_pack',
        organizationId: req.organizationId.toString(),
        userId: req.user._id.toString(),
        customerCode,
        packKey,
        pages: pack.pages,
      }
    );

    res.json({ authorizationUrl: data.authorization_url, reference: data.reference });
  } catch (err) {
    console.error('[billing] buy-pdf-pages error:', err.message);
    res.status(500).json({ message: err.message });
  }
});

// ─── GET /api/billing/callback ────────────────────────────────────────────────

/**
 * Paystack redirects the user here after payment.
 * No auth required — identity comes from the verified transaction metadata.
 *
 * Verifies the transaction server-side, updates the org, then redirects
 * the browser to the frontend billing settings page.
 */
router.get('/callback', async (req, res) => {
  const frontendBilling = `${process.env.CLIENT_URL}/settings/billing`;

  try {
    const { reference } = req.query;
    if (!reference) {
      return res.redirect(`${frontendBilling}?error=missing_reference`);
    }

    const { data } = await paystack.verifyTransaction(reference);

    if (data.status !== 'success') {
      return res.redirect(`${frontendBilling}?error=payment_failed`);
    }

    const meta = data.metadata || {};
    const { organizationId } = meta;
    if (!organizationId) {
      return res.redirect(`${frontendBilling}?error=invalid_metadata`);
    }

    // Credit-pack purchase: top up the one-off pool, no plan change. Dedup
    // on `reference` so a browser reload here (and a parallel webhook) can't
    // double-credit.
    if (meta.kind === 'credit_pack') {
      const pack = CREDIT_PACKS[meta.packKey];
      const credits = pack?.credits || Number(meta.credits) || 0;
      if (!credits) {
        return res.redirect(`${frontendBilling}?error=invalid_metadata`);
      }
      await Organization.updateOne(
        { _id: organizationId, appliedCreditPackRefs: { $ne: reference } },
        {
          $inc: { purchasedCredits: credits },
          $push: { appliedCreditPackRefs: reference },
        }
      );
      console.log(`[billing] callback credited ${credits} credits to org ${organizationId} (ref=${reference})`);
      return res.redirect(`${frontendBilling}?success=true&credits=${credits}`);
    }

    // PDF page-pack purchase: top up purchasedPdfPages. Same dedup pattern.
    if (meta.kind === 'pdf_pack') {
      const pack = PDF_PAGE_PACKS[meta.packKey];
      const pages = pack?.pages || Number(meta.pages) || 0;
      if (!pages) {
        return res.redirect(`${frontendBilling}?error=invalid_metadata`);
      }
      await Organization.updateOne(
        { _id: organizationId, appliedPdfPackRefs: { $ne: reference } },
        {
          $inc: { purchasedPdfPages: pages },
          $push: { appliedPdfPackRefs: reference },
        }
      );
      console.log(`[billing] callback credited ${pages} PDF pages to org ${organizationId} (ref=${reference})`);
      return res.redirect(`${frontendBilling}?success=true&pages=${pages}`);
    }

    // Subscription purchase / upgrade.
    const { plan, annual } = meta;
    if (!plan || !SELF_SERVE_PLANS.includes(plan)) {
      return res.redirect(`${frontendBilling}?error=invalid_metadata`);
    }

    // Period end = 1 month (or 12 for annual) from payment date, plus any credited upgrade days.
    const paidAt = data.paid_at ? new Date(data.paid_at) : new Date();
    const periodEnd = new Date(paidAt);
    periodEnd.setMonth(periodEnd.getMonth() + (annual ? 12 : 1));

    const creditDays = Number(data.metadata?.creditDays) || 0;
    if (creditDays > 0) {
      periodEnd.setDate(periodEnd.getDate() + creditDays);
    }

    const planConfig = PLANS[plan];

    await Organization.findByIdAndUpdate(organizationId, {
      subscriptionStatus: 'active',
      plan,
      annual: !!annual,
      currentPeriodEnd: periodEnd,
      aiCreditsLimit: planConfig.aiCredits,
      pdfPagesLimit: planConfig.pdfPagesPerMonth,
      whiteLabel: planConfig.whiteLabel,
      pendingPlan: null, // Any scheduled downgrade is superseded by this upgrade
      ...(data.authorization?.authorization_code && { paystackAuthorizationCode: data.authorization.authorization_code }),
    });

    console.log(`[billing] org ${organizationId} upgraded to ${plan} (period ends ${periodEnd.toISOString()})`);
    res.redirect(`${frontendBilling}?success=true&plan=${plan}`);
  } catch (err) {
    console.error('[billing] callback error:', err.message);
    res.redirect(`${frontendBilling}?error=server_error`);
  }
});

// ─── POST /api/billing/webhook ────────────────────────────────────────────────

/**
 * Paystack webhook receiver.
 * Raw body is captured in app.js (before express.json()) and stored as req.rawBody.
 *
 * Events handled:
 *   charge.success          → extend subscription period (recurring payments)
 *   subscription.create     → store subscription code on org
 *   subscription.disable    → mark org as cancelled
 *   invoice.payment_failed  → mark org as past_due
 */
router.post('/webhook', async (req, res) => {
  try {
    const signature = req.headers['x-paystack-signature'];

    if (!paystack.verifyWebhookSignature(signature, req.rawBody)) {
      console.warn('[billing] webhook: invalid signature — request rejected');
      return res.status(401).json({ message: 'Invalid signature' });
    }

    const { event, data } = req.body;
    console.log(`[billing] webhook received: ${event}`);

    if (event === 'charge.success') {
      const meta = data.metadata || {};
      const orgId = meta.organizationId;

      // Credit-pack one-off charge — top up the purchased pool. The /callback
      // route also does this; both run idempotently *only* if guarded against
      // double-application, so we use the Paystack reference as a dedup key:
      // a successful $inc here AND in /callback would double-credit. We rely
      // on the practical fact that Paystack fires charge.success at most
      // once per reference, and /callback runs on browser redirect which the
      // user may or may not actually hit. This webhook is the reliable path.
      // To prevent double-credit when both fire, we record the reference and
      // skip if already applied.
      if (meta.kind === 'credit_pack' && orgId) {
        const pack = CREDIT_PACKS[meta.packKey];
        const credits = pack?.credits || Number(meta.credits) || 0;
        const reference = data.reference;
        if (credits && reference) {
          // Atomic: only credit if this reference hasn't been applied yet.
          const result = await Organization.updateOne(
            { _id: orgId, appliedCreditPackRefs: { $ne: reference } },
            {
              $inc: { purchasedCredits: credits },
              $push: { appliedCreditPackRefs: reference },
            }
          );
          if (result.modifiedCount > 0) {
            console.log(`[billing] webhook credited ${credits} credits to org ${orgId} (ref=${reference})`);
          }
        }
        return res.status(200).json({ received: true });
      }

      // PDF page pack — same shape, different pool.
      if (meta.kind === 'pdf_pack' && orgId) {
        const pack = PDF_PAGE_PACKS[meta.packKey];
        const pages = pack?.pages || Number(meta.pages) || 0;
        const reference = data.reference;
        if (pages && reference) {
          const result = await Organization.updateOne(
            { _id: orgId, appliedPdfPackRefs: { $ne: reference } },
            {
              $inc: { purchasedPdfPages: pages },
              $push: { appliedPdfPackRefs: reference },
            }
          );
          if (result.modifiedCount > 0) {
            console.log(`[billing] webhook credited ${pages} PDF pages to org ${orgId} (ref=${reference})`);
          }
        }
        return res.status(200).json({ received: true });
      }

      // Subscription charge — fires on both the initial payment and recurring
      // subscription charges. Use metadata.organizationId for the first
      // charge; for recurring charges, fall back to subscription code.
      const subscriptionCode = data.subscription_code;
      let query = orgId ? { _id: orgId } : null;
      if (!query && subscriptionCode) {
        query = { paystackSubscriptionCode: subscriptionCode };
      }

      if (query) {
        // Look up annual flag so recurring charges extend by the right interval.
        const orgRow = await Organization.findOne(query).select('annual').lean();
        const paidAt = data.paid_at ? new Date(data.paid_at) : new Date();
        const periodEnd = new Date(paidAt);
        periodEnd.setMonth(periodEnd.getMonth() + (orgRow?.annual ? 12 : 1));

        const update = {
          subscriptionStatus: 'active',
          currentPeriodEnd: periodEnd,
        };
        // Save the authorization code so we can auto-charge at period end for scheduled downgrades
        if (data.authorization?.authorization_code) {
          update.paystackAuthorizationCode = data.authorization.authorization_code;
        }

        await Organization.findOneAndUpdate(query, update);
      }

    } else if (event === 'subscription.create') {
      // Store the subscription code so we can cancel later.
      // Keyed on customer code since metadata isn't on subscription events.
      const customerCode = data.customer?.customer_code;
      if (customerCode) {
        await Organization.findOneAndUpdate(
          { paystackCustomerCode: customerCode },
          { paystackSubscriptionCode: data.subscription_code }
        );
      }

    } else if (event === 'subscription.disable') {
      // Subscription cancelled — could be triggered by us or by Paystack (e.g. too many failed charges)
      await Organization.findOneAndUpdate(
        { paystackSubscriptionCode: data.subscription_code },
        { subscriptionStatus: 'cancelled' }
      );

    } else if (event === 'invoice.payment_failed') {
      // Recurring payment failed — enter grace period (past_due)
      const customerCode = data.customer?.customer_code;
      const subscriptionCode = data.subscription?.subscription_code;

      const query = subscriptionCode
        ? { paystackSubscriptionCode: subscriptionCode }
        : customerCode
          ? { paystackCustomerCode: customerCode }
          : null;

      if (query) {
        await Organization.findOneAndUpdate(query, { subscriptionStatus: 'past_due' });
      }
    }

    // Always return 200 — Paystack retries on non-2xx responses
    res.status(200).json({ received: true });
  } catch (err) {
    console.error('[billing] webhook error:', err.message);
    // Still return 200 to prevent Paystack from retrying an unrecoverable error
    res.status(200).json({ received: true, error: err.message });
  }
});

// ─── POST /api/billing/schedule-downgrade ────────────────────────────────────

/**
 * Schedule a downgrade to a lower-priced plan at the end of the current period.
 * Cancels the Paystack subscription so it doesn't auto-renew at the higher price,
 * then sets pendingPlan so the cron job can auto-charge for the new plan at period end.
 *
 * Currently only Business → Pro is supported.
 */
router.post('/schedule-downgrade', protect, async (req, res) => {
  try {
    const { plan: targetPlan } = req.body;
    if (!['starter', 'pro'].includes(targetPlan)) {
      return res.status(400).json({ message: 'Only downgrade to Starter or Pro is supported.' });
    }

    const org = await Organization.findById(req.organizationId)
      .select('plan subscriptionStatus paystackSubscriptionCode currentPeriodEnd');

    const currentRank = SELF_SERVE_PLANS.indexOf(org?.plan);
    const targetRank = SELF_SERVE_PLANS.indexOf(targetPlan);
    if (!org || org.subscriptionStatus !== 'active' || currentRank < 0 || targetRank >= currentRank) {
      return res.status(400).json({ message: 'No active higher-tier subscription to downgrade from.' });
    }

    // Cancel the Paystack subscription so it doesn't auto-renew at the Business price
    if (org.paystackSubscriptionCode) {
      try {
        const { data: sub } = await paystack.fetchSubscription(org.paystackSubscriptionCode);
        await paystack.disableSubscription(sub.subscription_code, sub.email_token);
      } catch (e) {
        console.warn('[billing] failed to cancel Paystack subscription during downgrade schedule:', e.message);
      }
    }

    org.pendingPlan = targetPlan;
    await org.save();

    const effectiveDate = org.currentPeriodEnd
      ? new Date(org.currentPeriodEnd).toLocaleDateString('en-KE', { day: 'numeric', month: 'long', year: 'numeric' })
      : 'the end of your current period';

    res.json({
      message: `Downgrade to ${PLANS[targetPlan].label} scheduled. You'll stay on ${PLANS[org.plan].label} until ${effectiveDate}, then move automatically.`,
      pendingPlan: targetPlan,
      effectiveAt: org.currentPeriodEnd,
    });
  } catch (err) {
    console.error('[billing] schedule-downgrade error:', err.message);
    res.status(500).json({ message: err.message });
  }
});

// ─── POST /api/billing/cancel-downgrade ──────────────────────────────────────

/**
 * Clear a scheduled downgrade. The user keeps their current plan until period end,
 * but since the Paystack subscription was cancelled when the downgrade was scheduled,
 * they'll need to re-subscribe to keep auto-renewal active. Returns a flag so the UI
 * can prompt them to re-checkout.
 */
router.post('/cancel-downgrade', protect, async (req, res) => {
  try {
    const org = await Organization.findById(req.organizationId).select('pendingPlan plan');
    if (!org || !org.pendingPlan) {
      return res.status(400).json({ message: 'No scheduled downgrade to cancel.' });
    }

    org.pendingPlan = null;
    await org.save();

    res.json({
      message: `Scheduled downgrade cancelled. To keep auto-renewing on ${org.plan}, please resubscribe.`,
      resubscribeRequired: true,
    });
  } catch (err) {
    console.error('[billing] cancel-downgrade error:', err.message);
    res.status(500).json({ message: err.message });
  }
});

// ─── POST /api/billing/cancel ─────────────────────────────────────────────────

/**
 * Cancel the current subscription.
 * Fetches the email_token from Paystack (required for their disable API),
 * calls disable, then marks the org as cancelled.
 *
 * Access is retained until currentPeriodEnd — the paywall in protect()
 * handles this grace period automatically.
 */
router.post('/cancel', protect, async (req, res) => {
  try {
    const subscriptionCode = req.organization?.paystackSubscriptionCode;

    if (!subscriptionCode) {
      return res.status(400).json({ message: 'No active Paystack subscription found on this account.' });
    }

    // Fetch the subscription to get the email_token (required by Paystack to disable)
    const { data: sub } = await paystack.fetchSubscription(subscriptionCode);

    await paystack.disableSubscription(sub.subscription_code, sub.email_token);

    // Mark as cancelled immediately for UI feedback.
    // The subscription.disable webhook will also arrive and set this — that's fine.
    await Organization.findByIdAndUpdate(req.organizationId, {
      subscriptionStatus: 'cancelled',
    });

    const org = await Organization.findById(req.organizationId).select('currentPeriodEnd').lean();
    const accessUntil = org?.currentPeriodEnd
      ? new Date(org.currentPeriodEnd).toLocaleDateString('en-KE', { day: 'numeric', month: 'long', year: 'numeric' })
      : 'the end of your billing period';

    res.json({
      message: `Subscription cancelled. You'll retain full access until ${accessUntil}.`,
      currentPeriodEnd: org?.currentPeriodEnd,
    });
  } catch (err) {
    console.error('[billing] cancel error:', err.message);
    res.status(500).json({ message: err.message });
  }
});

export default router;
