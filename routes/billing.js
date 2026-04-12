import { Router } from 'express';
import Organization from '../models/Organization.js';
import { protect } from '../middleware/auth.js';
import * as paystack from '../services/paystack.js';

const router = Router();

// Plan config — amounts in kobo (KES × 100)
const PLAN_CONFIG = {
  pro:      { amount: 499900,  aiLimit: 20,     whiteLabel: false },
  business: { amount: 1299900, aiLimit: 999999, whiteLabel: true  },
};

// ─── GET /api/billing/status ──────────────────────────────────────────────────

/**
 * Returns the org's full subscription snapshot.
 * Fetched fresh (not from req.organization cache) so the billing page
 * always shows current numbers after an upgrade.
 */
router.get('/status', protect, async (req, res) => {
  try {
    const org = await Organization.findById(req.organizationId)
      .select('subscriptionStatus plan trialStartedAt trialEndsAt trialQuoteCount trialQuoteLimit currentPeriodEnd aiItineraryGenerationsUsed aiItineraryGenerationsLimit aiCreditsResetAt whiteLabel paystackSubscriptionCode')
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
    const { plan } = req.body;
    if (!PLAN_CONFIG[plan]) {
      return res.status(400).json({ message: 'Invalid plan. Must be "pro" or "business".' });
    }

    const planCode = plan === 'pro'
      ? process.env.PAYSTACK_PLAN_PRO
      : process.env.PAYSTACK_PLAN_BUSINESS;

    if (!planCode) {
      return res.status(500).json({ message: `Paystack plan code for "${plan}" is not configured. Set PAYSTACK_PLAN_${plan.toUpperCase()} in env.` });
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

    const { amount } = PLAN_CONFIG[plan];

    const { data } = await paystack.initializeTransaction(
      req.user.email,
      amount,
      planCode,
      {
        organizationId: req.organizationId.toString(),
        plan,
        userId: req.user._id.toString(),
        customerCode,
      }
    );

    res.json({ authorizationUrl: data.authorization_url, reference: data.reference });
  } catch (err) {
    console.error('[billing] checkout error:', err.message);
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

    const { organizationId, plan } = data.metadata || {};
    if (!organizationId || !plan || !PLAN_CONFIG[plan]) {
      return res.redirect(`${frontendBilling}?error=invalid_metadata`);
    }

    // Calculate billing period end (1 month from payment date)
    const paidAt = data.paid_at ? new Date(data.paid_at) : new Date();
    const periodEnd = new Date(paidAt);
    periodEnd.setMonth(periodEnd.getMonth() + 1);

    const { aiLimit, whiteLabel } = PLAN_CONFIG[plan];

    await Organization.findByIdAndUpdate(organizationId, {
      subscriptionStatus: 'active',
      plan,
      currentPeriodEnd: periodEnd,
      aiItineraryGenerationsLimit: aiLimit,
      ...(whiteLabel && { whiteLabel: true }),
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
      // Fires on both the initial payment and recurring subscription charges.
      // Use metadata.organizationId (set during checkout) for the first charge;
      // for recurring charges, fall back to looking up by subscription code.
      const orgId = data.metadata?.organizationId;
      const subscriptionCode = data.subscription_code;

      let query = orgId ? { _id: orgId } : null;
      if (!query && subscriptionCode) {
        query = { paystackSubscriptionCode: subscriptionCode };
      }

      if (query) {
        const paidAt = data.paid_at ? new Date(data.paid_at) : new Date();
        const periodEnd = new Date(paidAt);
        periodEnd.setMonth(periodEnd.getMonth() + 1);

        await Organization.findOneAndUpdate(query, {
          subscriptionStatus: 'active',
          currentPeriodEnd: periodEnd,
        });
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
