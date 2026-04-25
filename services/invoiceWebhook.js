import crypto from 'crypto';
import Organization from '../models/Organization.js';
import WebhookDelivery from '../models/WebhookDelivery.js';

// Retry schedule: gap between attempt N and attempt N+1.
// Total window before permanent failure: ~15 hours over 5 attempts.
const BACKOFF_SECONDS = [60, 300, 1800, 7200, 43200]; // 1m, 5m, 30m, 2h, 12h
const MAX_ATTEMPTS = 5;
const REQUEST_TIMEOUT_MS = 10000;

// Retention windows for terminal-state delivery rows. TTL index on
// WebhookDelivery.expireAt prunes them automatically once the date passes.
const RETAIN_SUCCEEDED_DAYS = 90;
const RETAIN_FAILED_DAYS = 180;
const DAY_MS = 24 * 60 * 60 * 1000;

function buildPayload(event, invoice, org) {
  return {
    event,
    timestamp: new Date().toISOString(),
    organization: { id: String(org._id), name: org.name },
    invoice: {
      id: String(invoice._id),
      number: `INV-${String(invoice.invoiceNumber).padStart(4, '0')}`,
      status: invoice.status,
      issueDate: invoice.issueDate,
      dueDate: invoice.dueDate,
      sentAt: invoice.sentAt,
      paidAt: invoice.paidAt,
      client: invoice.client,
      deal: invoice.deal ? { id: String(invoice.deal) } : null,
      lineItems: invoice.lineItems,
      subtotal: invoice.subtotal,
      taxPercent: invoice.taxPercent,
      taxAmount: invoice.taxAmount,
      total: invoice.total,
      currency: invoice.currency,
      paymentInstructions: invoice.paymentInstructions,
      notes: invoice.notes,
    },
  };
}

function sign(body, secret) {
  return 'sha256=' + crypto.createHmac('sha256', secret).update(body).digest('hex');
}

// Single HTTP attempt — never throws. Returns { success, statusCode?, error? }.
export async function attemptHttpPost({ url, body, signature, event }) {
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-safiripro-event': event,
        'x-safiripro-signature': signature,
        'User-Agent': 'SafiriPro-Webhook/1.0',
      },
      body,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (res.ok) return { success: true, statusCode: res.status };
    return { success: false, statusCode: res.status, error: `HTTP ${res.status}` };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

// Run one attempt against a WebhookDelivery row. Updates status + scheduling
// based on the outcome. Re-fetches the org's current signing secret each time
// so a deliberate rotation is honored on the next retry. URL is snapshotted
// at fire time and never changes for a given delivery.
export async function processDelivery(delivery) {
  const org = await Organization.findById(delivery.organization)
    .select('preferences.accountingWebhookSecret')
    .lean();
  const secret = org?.preferences?.accountingWebhookSecret;

  if (!secret) {
    delivery.status = 'failed';
    delivery.lastError = 'Webhook secret not configured';
    delivery.nextAttemptAt = null;
    delivery.lastAttemptAt = new Date();
    delivery.expireAt = new Date(Date.now() + RETAIN_FAILED_DAYS * DAY_MS);
    await delivery.save();
    return delivery;
  }

  const body = JSON.stringify(delivery.payload);
  const signature = sign(body, secret);

  delivery.attempts++;
  delivery.lastAttemptAt = new Date();

  const result = await attemptHttpPost({
    url: delivery.url,
    body,
    signature,
    event: delivery.event,
  });

  delivery.lastResponseStatus = result.statusCode ?? null;
  delivery.lastError = result.error || '';

  if (result.success) {
    delivery.status = 'succeeded';
    delivery.deliveredAt = new Date();
    delivery.nextAttemptAt = null;
    delivery.expireAt = new Date(Date.now() + RETAIN_SUCCEEDED_DAYS * DAY_MS);
  } else if (delivery.attempts >= delivery.maxAttempts) {
    delivery.status = 'failed';
    delivery.nextAttemptAt = null;
    delivery.expireAt = new Date(Date.now() + RETAIN_FAILED_DAYS * DAY_MS);
    console.warn(`[invoice-webhook] ${delivery.event} → ${delivery.url} failed permanently after ${delivery.attempts} attempts: ${delivery.lastError}`);
  } else {
    const backoffMs = BACKOFF_SECONDS[Math.min(delivery.attempts - 1, BACKOFF_SECONDS.length - 1)] * 1000;
    delivery.status = 'pending';
    delivery.nextAttemptAt = new Date(Date.now() + backoffMs);
    delivery.expireAt = null; // never expire while still actively retrying
  }

  await delivery.save();
  return delivery;
}

// Best-effort fire — never throws. Records the delivery and runs the first
// attempt async; if it fails, the retry poller takes over per BACKOFF_SECONDS.
export function fireInvoiceWebhook(event, invoice) {
  (async () => {
    try {
      const org = await Organization.findById(invoice.organization)
        .select('name preferences.accountingWebhookUrl preferences.accountingWebhookSecret')
        .lean();
      const url = org?.preferences?.accountingWebhookUrl;
      const secret = org?.preferences?.accountingWebhookSecret;
      if (!url || !secret) return; // no webhook configured

      const payload = buildPayload(event, invoice, org);

      const delivery = await WebhookDelivery.create({
        organization: invoice.organization,
        event,
        url,
        payload,
        status: 'pending',
        attempts: 0,
        maxAttempts: MAX_ATTEMPTS,
        relatedInvoice: invoice._id,
      });

      await processDelivery(delivery);
    } catch (err) {
      console.warn(`[invoice-webhook] ${event} setup failed:`, err.message);
    }
  })();
}

// Synchronous one-off test ping — used by the Settings "Send test event"
// button. Doesn't write to WebhookDelivery (avoids polluting the log with
// integration-setup pings). Returns the result for the UI to display.
export async function sendTestEvent(org) {
  const url = org?.preferences?.accountingWebhookUrl;
  const secret = org?.preferences?.accountingWebhookSecret;
  if (!url) return { success: false, error: 'No webhook URL configured' };
  if (!secret) return { success: false, error: 'No signing secret — save the URL first to generate one' };

  const payload = {
    event: 'invoice.test',
    timestamp: new Date().toISOString(),
    organization: { id: String(org._id), name: org.name },
    message: 'This is a test event from SafiriPro. If you see it, your webhook is wired up correctly.',
  };
  const body = JSON.stringify(payload);
  const signature = sign(body, secret);

  return attemptHttpPost({ url, body, signature, event: 'invoice.test' });
}
