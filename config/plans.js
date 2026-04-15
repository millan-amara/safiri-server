// Central plan configuration — single source of truth for tier limits, prices, and feature flags.
// Amounts in kobo (KES × 100). Paystack plan codes are read from env so they can differ per environment.

export const AI_CREDIT_COST = {
  heavy: 10,   // /ai/draft-itinerary, /ai/generate-all-narratives
  medium: 3,   // /ai/generate-narrative, /ai/suggest-route
  light: 1,    // /ai/draft-email, /ai/deal-summary, /ai/map-columns
};

// Sentinel for "unlimited" — used for seats, quotes, partner records on higher tiers.
export const UNLIMITED = Number.MAX_SAFE_INTEGER;

// Partner record types (hotels/activities/destinations/transport) have per-type caps.
// Each record also has a max images limit to prevent Cloudinary-abuse via a single bloated record.
export const PARTNER_TYPES = ['hotel', 'activity', 'destination', 'transport'];

export const PLANS = {
  trial: {
    label: 'Trial',
    amount: 0,
    aiCredits: 20,
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
    amount: 249900,                 // KES 2,499
    planCodeEnv: 'PAYSTACK_PLAN_STARTER',
    annualPlanCodeEnv: 'PAYSTACK_PLAN_STARTER_ANNUAL',
    annualAmount: 2499000,          // 10 months (2 free)
    aiCredits: 120,
    aiRateLimitPerMin: 5,
    seats: 2,
    quotesPerMonth: 15,
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
    amount: 699900,                 // KES 6,999
    planCodeEnv: 'PAYSTACK_PLAN_PRO',
    annualPlanCodeEnv: 'PAYSTACK_PLAN_PRO_ANNUAL',
    annualAmount: 6999000,
    aiCredits: 400,
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
    amount: 1799900,                // KES 17,999
    planCodeEnv: 'PAYSTACK_PLAN_BUSINESS',
    annualPlanCodeEnv: 'PAYSTACK_PLAN_BUSINESS_ANNUAL',
    annualAmount: 17999000,
    aiCredits: 1500,
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
    amount: 4500000,                // KES 45,000 starting price; actual is negotiated
    planCodeEnv: 'PAYSTACK_PLAN_ENTERPRISE',
    annualPlanCodeEnv: 'PAYSTACK_PLAN_ENTERPRISE_ANNUAL',
    annualAmount: 45000000,
    aiCredits: 5000,
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
