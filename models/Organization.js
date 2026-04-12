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

  // ─── Subscription & billing ────────────────────────────────────────────────
  subscriptionStatus: {
    type: String,
    enum: ['trialing', 'active', 'past_due', 'expired', 'cancelled'],
    default: 'trialing',
  },
  plan: {
    type: String,
    enum: ['trial', 'pro', 'business', 'enterprise'],
    default: 'trial',
  },

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

  // AI usage (resets monthly)
  aiItineraryGenerationsUsed: { type: Number, default: 0 },
  aiItineraryGenerationsLimit: { type: Number, default: 20 }, // 20 for trial/pro, unlimited (999999) for business
  aiCreditsResetAt: { type: Date },      // 1st of next month — set on org creation & each reset

  // Business plan feature
  whiteLabel: { type: Boolean, default: false }, // hides "Powered by SafiriPro" on quote share pages
  
  // n8n automation endpoint
  webhookUrl: { type: String, default: '' },
  
  // API key for external integrations (n8n, Zapier, etc.)
  apiKey: { type: String, unique: true, sparse: true },
  
  owner: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
}, { timestamps: true });

export default mongoose.model('Organization', organizationSchema);