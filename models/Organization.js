import mongoose from 'mongoose';

const organizationSchema = new mongoose.Schema({
  name: { type: String, required: true, trim: true },
  slug: { type: String, unique: true, lowercase: true },
  
  // Branding
  branding: {
    logo: { type: String, default: '' },            // Cloudinary URL
    primaryColor: { type: String, default: '#B45309' },
    secondaryColor: { type: String, default: '#1E293B' },
    accentColor: { type: String, default: '#059669' },
    fontFamily: { type: String, default: 'Inter' },
    coverQuote: { type: String, default: '' },           // Shown on PDF/link closing page
    coverQuoteAuthor: { type: String, default: '' },
  },
  
  // Business info (appears on quotes)
  businessInfo: {
    email: { type: String, default: '' },
    phone: { type: String, default: '' },
    website: { type: String, default: '' },
    address: { type: String, default: '' },
    country: { type: String, default: 'Kenya' },
    tagline: { type: String, default: '' },
    aboutUs: { type: String, default: '' },
  },

  // Defaults
  defaults: {
    currency: { type: String, default: 'USD' },
    marginPercent: { type: Number, default: 20 },
    paymentTerms: { type: String, default: '40% deposit, 60% balance due 30 days before tour.' },
    inclusions: [{ type: String }],
    exclusions: [{ type: String }],
    taskReminderHours: { type: Number, default: 24 },
  },

  // FX rates — "1 unit of KEY = fxRates[KEY] units of defaults.currency".
  // Overrides the server-wide default table. Operators can tune their book rate.
  // Empty object = use server defaults in utils/fx.js.
  fxRates: { type: mongoose.Schema.Types.Mixed, default: {} },

  // Org-level policy toggles (admin-managed in Settings).
  preferences: {
    // How the marketing→sales handoff behaves. 'convert' creates a new deal in the
    // target pipeline with sourcedFrom ref; 'move' updates the same deal's pipeline.
    dealHandoffMode: { type: String, enum: ['convert', 'move'], default: 'convert' },
    // Whether agents can delete deals at all. 'own' = only deals they created/own;
    // 'none' = agents cannot delete deals (admins/owner still can).
    agentDealDeletion: { type: String, enum: ['own', 'none'], default: 'own' },
    // Whether agents can reassign deals. 'own' = only deals currently assigned to
    // themselves (plus self-claiming unassigned deals); 'none' = admin-only.
    // Owners/admins can always reassign regardless.
    agentDealReassign: { type: String, enum: ['own', 'none'], default: 'own' },
    // Additional users notified whenever a deal moves to Won. The deal's creator
    // and assignee are always notified — these are extras (e.g. accountant, ops).
    dealWonNotifyUsers: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
    // Time-of-day for relative scheduled messages (before/after travel). Sends
    // at this hour in the configured timezone instead of midnight UTC.
    // Absolute-date messages ignore these and use the operator-picked time.
    scheduledMessageHour: { type: Number, min: 0, max: 23, default: 9 },
    scheduledMessageTimezone: { type: String, default: 'Africa/Nairobi' },
    // Auto-create a draft invoice when a deal moves to a Won-typed stage.
    // Operators using external accounting (QuickBooks, etc.) can switch off.
    autoGenerateInvoiceOnWon: { type: Boolean, default: true },
    // Default tax percentage applied to new invoices. Operator overrides per-invoice.
    defaultTaxPercent: { type: Number, default: 0, min: 0, max: 100 },
    // Payment instructions text shown at the bottom of every invoice
    // (bank details, M-Pesa paybill, etc.). Snapshotted onto the invoice
    // at creation; operator can override per-invoice.
    paymentInstructions: { type: String, default: '' },
    // External accounting webhook — fires JSON payloads on invoice lifecycle
    // events (created, sent, paid, cancelled) so QuickBooks/Xero/n8n/Zapier
    // can react. Separate from the n8n `webhookUrl` field above (general CRM
    // events). Signed with HMAC-SHA256 of body using accountingWebhookSecret.
    accountingWebhookUrl: { type: String, default: '' },
    accountingWebhookSecret: { type: String, default: '' },
  },

  // ─── Subscription & billing ────────────────────────────────────────────────
  subscriptionStatus: {
    type: String,
    enum: ['trialing', 'active', 'past_due', 'expired', 'cancelled'],
    default: 'trialing',
  },
  plan: {
    type: String,
    enum: ['trial', 'starter', 'pro', 'business', 'enterprise'],
    default: 'trial',
  },
  // Annual billing flag — toggled by the chosen Paystack plan code at checkout.
  annual: { type: Boolean, default: false },

  // Trial window
  trialStartedAt: { type: Date, default: Date.now },
  trialEndsAt: { type: Date },           // set on org creation: trialStartedAt + 14 days
  trialQuoteCount: { type: Number, default: 0 },
  trialQuoteLimit: { type: Number, default: 10 },

  // Paid billing period
  currentPeriodEnd: { type: Date },      // when the current paid period ends

  // Paystack identifiers
  paystackCustomerCode: { type: String },
  paystackSubscriptionCode: { type: String },
  paystackAuthorizationCode: { type: String }, // Saved card token — used to auto-charge at period end for scheduled downgrades

  // Scheduled plan change — set to a lower-tier plan when user downgrades; cron applies it at currentPeriodEnd.
  pendingPlan: {
    type: String,
    enum: ['starter', 'pro', 'business', null],
    default: null,
  },

  // ─── AI credit ledger (resets calendar-monthly) ───────────────────────────
  // Credits consumed at varying cost: heavy=50, medium=5, light=1 (see config/plans.js).
  aiCreditsUsed: { type: Number, default: 0 },
  aiCreditsLimit: { type: Number, default: 100 }, // seeded from PLANS[plan].aiCredits
  aiCreditsResetAt: { type: Date },      // 1st of next month — set on org creation & each reset

  // ─── One-off purchased credit pool (does NOT reset monthly) ───────────────
  // Topped up via /api/billing/buy-credits. Charged AFTER monthly allowance is
  // exhausted, so power users only burn paid credits when they overflow the
  // plan. Carries indefinitely.
  purchasedCredits: { type: Number, default: 0 },
  // Paystack transaction references already credited to purchasedCredits —
  // dedup key for the credit-pack callback + webhook (both fire on success;
  // callback may also fire twice if the user reloads the redirect URL).
  appliedCreditPackRefs: { type: [String], default: [] },

  // ─── PDF rate-card extraction page ledger (resets calendar-monthly) ───────
  // Pages charged per upload via partners.js extract-pdf, counted with pdf-lib
  // before the Claude call. Separate from AI credits because PDF cost variance
  // ($0.03-$0.72) was the original mispricing problem.
  pdfPagesUsed: { type: Number, default: 0 },
  pdfPagesLimit: { type: Number, default: 10 },  // seeded from PLANS[plan].pdfPagesPerMonth
  pdfPagesResetAt: { type: Date },               // 1st of next month — set on org creation & each reset
  // Purchased PDF pages overflow pool (does NOT reset). Charged after monthly.
  purchasedPdfPages: { type: Number, default: 0 },
  appliedPdfPackRefs: { type: [String], default: [] },

  // ─── Quote monthly counter (only enforced on tiers with a quotesPerMonth cap) ──
  quotesThisMonth: { type: Number, default: 0 },
  quotesMonthResetAt: { type: Date },

  // Feature flag — derived from plan but stored for fast lookups on hot paths (PDF render, quote share).
  whiteLabel: { type: Boolean, default: false }, // hides "Powered by SafiriPro" on quote share pages
  
  // n8n automation endpoint
  webhookUrl: { type: String, default: '' },
  
  // API key for external integrations (n8n, Zapier, etc.)
  apiKey: { type: String, unique: true, sparse: true },
  
  owner: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
}, { timestamps: true });

export default mongoose.model('Organization', organizationSchema);