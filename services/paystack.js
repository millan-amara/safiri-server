import crypto from 'crypto';

const BASE_URL = 'https://api.paystack.co';

// ─── INTERNAL HELPER ──────────────────────────────────────────────────────────

async function paystackRequest(method, path, body) {
  const secretKey = process.env.PAYSTACK_SECRET_KEY;
  if (!secretKey) throw new Error('PAYSTACK_SECRET_KEY is not configured');

  const options = {
    method,
    headers: {
      Authorization: `Bearer ${secretKey}`,
      'Content-Type': 'application/json',
    },
  };

  if (body) options.body = JSON.stringify(body);

  const res = await fetch(`${BASE_URL}${path}`, options);
  const data = await res.json();

  if (!data.status) {
    throw new Error(data.message || `Paystack ${method} ${path} failed`);
  }

  return data;
}

// ─── CUSTOMERS ────────────────────────────────────────────────────────────────

/**
 * Create a Paystack customer record.
 * Call once per org and store the returned customer_code on the org.
 */
export async function createCustomer(email, name) {
  const nameParts = (name || '').trim().split(' ');
  const firstName = nameParts[0] || '';
  const lastName = nameParts.slice(1).join(' ') || '';

  return paystackRequest('POST', '/customer', { email, first_name: firstName, last_name: lastName });
}

// ─── TRANSACTIONS ─────────────────────────────────────────────────────────────

/**
 * Initialize a Paystack transaction.
 * Passing a planCode turns this into a subscription transaction —
 * Paystack will auto-create the recurring subscription after successful payment.
 * Pass null/undefined planCode for a one-off charge (e.g. credit pack).
 *
 * @param {string} email          - Customer email
 * @param {number} amount         - Amount in kobo (e.g. 499900 for KES 4,999)
 * @param {string|null} planCode  - Paystack plan code (PLN_xxx) for subscriptions, or null for one-off
 * @param {object} metadata       - Arbitrary metadata attached to the transaction
 * @returns {object} data.authorization_url — redirect the user here
 */
export async function initializeTransaction(email, amount, planCode, metadata = {}) {
  const body = {
    email,
    amount,
    metadata,
    // callback_url overrides the dashboard default for this specific transaction
    callback_url: process.env.BILLING_CALLBACK_URL || `${process.env.BASE_URL || 'http://localhost:5000'}/api/billing/callback`,
  };
  if (planCode) body.plan = planCode;
  return paystackRequest('POST', '/transaction/initialize', body);
}

/**
 * Verify a transaction by its reference.
 * Use this in the billing callback to confirm payment before updating the org.
 */
export async function verifyTransaction(reference) {
  return paystackRequest('GET', `/transaction/verify/${encodeURIComponent(reference)}`);
}

/**
 * Charge a previously-saved authorization (card token).
 * Used by the scheduled-downgrade cron to auto-charge the new plan at period end
 * without requiring the user to re-enter card details.
 */
export async function chargeAuthorization(email, amount, authorizationCode, metadata = {}) {
  return paystackRequest('POST', '/transaction/charge_authorization', {
    email,
    amount,
    authorization_code: authorizationCode,
    metadata,
  });
}

// ─── SUBSCRIPTIONS ────────────────────────────────────────────────────────────

/**
 * Create a subscription for an existing customer on a plan.
 * Only needed if not using initializeTransaction with a planCode.
 */
export async function createSubscription(customerCode, planCode) {
  return paystackRequest('POST', '/subscription', {
    customer: customerCode,
    plan: planCode,
  });
}

/**
 * Fetch a subscription's details — needed to get the email_token for cancellation.
 */
export async function fetchSubscription(subscriptionCode) {
  return paystackRequest('GET', `/subscription/${encodeURIComponent(subscriptionCode)}`);
}

/**
 * Disable (cancel) a subscription.
 * Paystack requires the email_token from the subscription object —
 * call fetchSubscription first to get it.
 */
export async function disableSubscription(subscriptionCode, emailToken) {
  return paystackRequest('POST', '/subscription/disable', {
    code: subscriptionCode,
    token: emailToken,
  });
}

// ─── WEBHOOKS ─────────────────────────────────────────────────────────────────

/**
 * Verify Paystack's HMAC-SHA512 webhook signature.
 * Always verify before trusting webhook payloads.
 *
 * @param {string} signature  - Value of x-paystack-signature header
 * @param {string} rawBody    - The raw request body string (before JSON.parse)
 * @returns {boolean}
 */
export function verifyWebhookSignature(signature, rawBody) {
  if (!signature || !rawBody) return false;

  const secret = process.env.PAYSTACK_WEBHOOK_SECRET || process.env.PAYSTACK_SECRET_KEY;
  if (!secret) {
    console.error('[paystack] No webhook secret configured');
    return false;
  }

  const expected = crypto
    .createHmac('sha512', secret)
    .update(rawBody)
    .digest('hex');

  return expected === signature;
}
