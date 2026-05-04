// Central plan configuration — single source of truth for tier limits, prices, and feature flags.
// Amounts in kobo (KES × 100). Paystack plan codes are read from env so they can differ per environment.

// Credit weights reflect real per-call cost ratios (after Sonnet 4.6 + Haiku 4.5
// + prompt caching). At ~$3-7/M output for Sonnet vs ~$1/M for Haiku and tiny
// inputs on light calls, real cost ratios are roughly 1 : 5 : 50.
// PDF rate-card extraction is intentionally NOT in this map — it's metered
// per-page in Chunk 4 because its cost variance ($0.03-$0.72) is too wide.
export const AI_CREDIT_COST = {
  heavy: 50,   // /ai/draft-itinerary, /ai/generate-all-narratives (Sonnet 4.6, large output)
  medium: 5,   // /ai/generate-narrative, /ai/suggest-route, /ai/draft-scheduled-message (Haiku, modest output)
  light: 1,    // /ai/draft-email, /ai/deal-summary, /ai/map-columns (Haiku, small output)
};

// Sentinel for "unlimited" — used for seats, quotes, partner records on higher tiers.
export const UNLIMITED = Number.MAX_SAFE_INTEGER;

// One-off credit packs purchased via Paystack on top of the monthly plan
// allowance. `amount` is in kobo (KES × 100). Bigger packs are priced for
// more credits per shilling, but every pack keeps a healthy gross margin
// on the worst case (200 heavy calls at $0.07 each).
//   small  500 credits   = max  10 heavy ≈ $0.70 cost vs KES 600  → 85% margin
//   medium 2,000 credits = max  40 heavy ≈ $2.80 cost vs KES 2,000 → 81% margin
//   large  10,000 credits = max 200 heavy ≈ $14.00 cost vs KES 8,000 → 77% margin
export const CREDIT_PACKS = {
  small:  { credits:    500, amount:   60000 },   // KES   600
  medium: { credits:   2000, amount:  200000 },   // KES 2,000
  large:  { credits:  10000, amount:  800000 },   // KES 8,000
};

// One-off PDF rate-card extraction page packs. Pages are deducted at extract
// time using pdf-lib's getPageCount() — operators see the count before they
// upload (in 402 errors and the BillingPage usage bar).
//   small  25 pages  ≈ $1.25 cost vs KES   750 → 80% margin
//   medium 100 pages ≈ $5.00 cost vs KES 2,500 → 75% margin
//   large  500 pages ≈ $25.00 cost vs KES 10,000 → 67% margin
// (Worst-case page cost ~$0.05 with Sonnet 4.6 + cached system prompt.)
export const PDF_PAGE_PACKS = {
  small:  { pages:  25, amount:   75000 },   // KES   750
  medium: { pages: 100, amount:  250000 },   // KES 2,500
  large:  { pages: 500, amount: 1000000 },   // KES 10,000
};

// Partner record types (hotels/activities/destinations/transport) have per-type caps.
// Each record also has a max images limit to prevent Cloudinary-abuse via a single bloated record.
export const PARTNER_TYPES = ['hotel', 'activity', 'destination', 'transport'];

export const PLANS = {
  trial: {
    label: 'Trial',
    amount: 0,
    aiCredits: 100,
    pdfPagesPerMonth: 10,
    aiRateLimitPerMin: 5,
    seats: 2,
    quotesPerMonth: 5,
    partnerCaps: { hotel: 10, activity: 10, destination: 10, transport: 5 },
    maxImagesPerRecord: 3,
    pipelines: 1,
    trialContacts: 100,
    csvImportRows: 50,
    pdfPresets: 1,
    whiteLabel: false,
    whatsapp: false,
    webhooks: false,
  },
  starter: {
    label: 'Starter',
    amount: 250000,                 // KES 2,500
    planCodeEnv: 'PAYSTACK_PLAN_STARTER',
    annualPlanCodeEnv: 'PAYSTACK_PLAN_STARTER_ANNUAL',
    annualAmount: 2500000,          // KES 25,000 — 10 months (2 free)
    aiCredits: 250,
    pdfPagesPerMonth: 10,
    aiRateLimitPerMin: 5,
    seats: 2,
    quotesPerMonth: 25,
    partnerCaps: { hotel: 50, activity: 50, destination: 25, transport: 15 },
    maxImagesPerRecord: 5,
    pipelines: 2,
    csvImportRows: 500,
    pdfPresets: 1,
    whiteLabel: false,
    whatsapp: false,
    webhooks: false,
  },
  pro: {
    label: 'Pro',
    amount: 750000,                 // KES 7,500
    planCodeEnv: 'PAYSTACK_PLAN_PRO',
    annualPlanCodeEnv: 'PAYSTACK_PLAN_PRO_ANNUAL',
    annualAmount: 7500000,          // KES 75,000 — 10 months (2 free)
    aiCredits: 1500,
    pdfPagesPerMonth: 75,
    aiRateLimitPerMin: 10,
    seats: 8,
    quotesPerMonth: UNLIMITED,
    partnerCaps: { hotel: 250, activity: 250, destination: 100, transport: 50 },
    maxImagesPerRecord: 8,
    pipelines: 5,
    csvImportRows: 5000,
    pdfPresets: 3,
    whiteLabel: false,
    whatsapp: true,
    webhooks: true,
  },
  business: {
    label: 'Business',
    amount: 1800000,                // KES 18,000
    planCodeEnv: 'PAYSTACK_PLAN_BUSINESS',
    annualPlanCodeEnv: 'PAYSTACK_PLAN_BUSINESS_ANNUAL',
    annualAmount: 18000000,         // KES 180,000 — 10 months (2 free)
    aiCredits: 6000,
    pdfPagesPerMonth: 300,
    aiRateLimitPerMin: 20,
    seats: 25,
    quotesPerMonth: UNLIMITED,
    partnerCaps: { hotel: 1500, activity: 1500, destination: 500, transport: 250 },
    maxImagesPerRecord: 15,
    pipelines: 15,
    csvImportRows: 25000,
    pdfPresets: 3,                  // + custom flag below
    customPdfPresets: true,
    whiteLabel: true,
    whatsapp: true,
    webhooks: true,
  },
  enterprise: {
    label: 'Enterprise',
    amount: 5000000,                // KES 50,000 starting price; actual is negotiated
    planCodeEnv: 'PAYSTACK_PLAN_ENTERPRISE',
    annualPlanCodeEnv: 'PAYSTACK_PLAN_ENTERPRISE_ANNUAL',
    annualAmount: 50000000,         // KES 500,000 — display anchor only
    aiCredits: 30000,
    pdfPagesPerMonth: UNLIMITED,
    aiRateLimitPerMin: 30,
    seats: UNLIMITED,
    quotesPerMonth: UNLIMITED,
    partnerCaps: { hotel: UNLIMITED, activity: UNLIMITED, destination: UNLIMITED, transport: UNLIMITED },
    maxImagesPerRecord: UNLIMITED,
    pipelines: UNLIMITED,
    csvImportRows: UNLIMITED,
    pdfPresets: UNLIMITED,
    customPdfPresets: true,
    whiteLabel: true,
    whatsapp: true,
    webhooks: true,
  },
};

export function getPlan(planName) {
  return PLANS[planName] || PLANS.trial;
}

// First day of the next calendar month (UTC) — used to schedule credit/quote resets.
export function nextMonthlyResetDate(from = new Date()) {
  return new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth() + 1, 1, 0, 0, 0, 0));
}
