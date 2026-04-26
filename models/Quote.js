import mongoose from 'mongoose';
import { nanoid } from 'nanoid';

// A single day in the itinerary — the source of truth
const daySchema = new mongoose.Schema({
  dayNumber: { type: Number, required: true },        // 1, 2, 3...
  title: { type: String, default: '' },                // "Arrival in Nairobi" / "Game drive in Mara"
  location: { type: String, default: '' },             // "Maasai Mara" / "Nairobi → Naivasha"
  isTransitDay: { type: Boolean, default: false },     // For driving days between locations

  // Narrative
  narrative: { type: String, default: '' },            // The descriptive text for the day

  // Meals — what's included for the client
  meals: {
    breakfast: { type: Boolean, default: false },
    lunch: { type: Boolean, default: false },
    dinner: { type: Boolean, default: false },
    notes: { type: String, default: '' },              // "Breakfast at lodge, packed lunch, dinner at boma"
  },

  // Accommodation for this night (null for transit/last day)
  hotel: { type: mongoose.Schema.Types.Mixed, default: null },
  roomType: { type: String, default: '' },

  // Activities scheduled for this specific day
  activities: { type: [mongoose.Schema.Types.Mixed], default: [] },

  // Transport for this day (if a driving/transfer day)
  transport: { type: mongoose.Schema.Types.Mixed, default: null },

  // Images for this day — flexible gallery
  images: { type: [mongoose.Schema.Types.Mixed], default: [] },

  // Per-day cost & price (operator sees both, client sees only price)
  dayCost: { type: Number, default: 0 },     // What you pay suppliers
  dayPrice: { type: Number, default: 0 },    // What client pays (cost + margin)
  marginOverride: { type: Number, default: null },  // Per-day margin override (null = use global)
}, { _id: true });

const quoteSchema = new mongoose.Schema({
  organization: { type: mongoose.Schema.Types.ObjectId, ref: 'Organization', required: true },
  
  // Reference — uniqueness is enforced per-organization via a compound index below,
  // not globally, so two orgs can both have "2026-0001".
  quoteNumber: { type: String },
  version: { type: Number, default: 1 },
  parentQuote: { type: mongoose.Schema.Types.ObjectId, ref: 'Quote' },  // For versioning
  
  // Link to CRM
  deal: { type: mongoose.Schema.Types.ObjectId, ref: 'Deal' },
  contact: { type: mongoose.Schema.Types.ObjectId, ref: 'Contact' },
  
  // Trip overview
  title: { type: String, required: true },
  tourType: { type: String, enum: ['private', 'group', 'self-drive', 'custom'], default: 'private' },
  
  travelers: {
    adults: { type: Number, default: 2 },
    children: { type: Number, default: 0 },
    childAges: [Number],
  },
  
  startDate: { type: Date },
  endDate: { type: Date },
  startPoint: { type: String, default: 'Nairobi' },
  endPoint: { type: String, default: 'Nairobi' },

  // Client/audience segmentation — drives rate-list resolution.
  clientType: {
    type: String,
    enum: ['retail', 'contract', 'resident'],
    default: 'retail',
  },
  nationality: {
    type: String,
    enum: ['citizen', 'resident', 'nonResident'],
    default: 'nonResident',
  },
  
  // The itinerary — days are the source of truth
  days: [daySchema],

  // Cover image (for the share page hero / PDF cover)
  coverImage: { type: mongoose.Schema.Types.Mixed, default: null },

  // Block-based output configuration — controls what shows on the share page
  blocks: {
    type: [{
      id: String,         // 'cover' | 'highlights' | 'day_by_day' | 'map' | 'accommodations' | 'pricing' | 'inclusions' | 'exclusions' | 'payment_terms' | 'about_us' | 'terms'
      enabled: { type: Boolean, default: true },
      order: Number,
    }],
    default: [
      { id: 'cover', enabled: true, order: 0 },
      { id: 'highlights', enabled: true, order: 1 },
      { id: 'day_by_day', enabled: true, order: 2 },
      { id: 'map', enabled: true, order: 3 },
      { id: 'accommodations', enabled: true, order: 4 },
      { id: 'optional_extras', enabled: true, order: 5 },
      { id: 'pricing', enabled: true, order: 6 },
      { id: 'inclusions', enabled: true, order: 7 },
      { id: 'exclusions', enabled: true, order: 8 },
      { id: 'payment_terms', enabled: true, order: 9 },
      { id: 'about_us', enabled: false, order: 10 },
      { id: 'terms', enabled: false, order: 11 },
    ],
  },
  
  // Pricing
  pricing: {
    subtotal: { type: Number, default: 0 },         // Total cost before margin
    marginPercent: { type: Number, default: 20 },
    marginAmount: { type: Number, default: 0 },
    totalPrice: { type: Number, default: 0 },        // Client-facing price
    perPersonPrice: { type: Number, default: 0 },
    currency: { type: String, default: 'USD' },
    
    // What to show client
    displayMode: { type: String, enum: ['total_only', 'line_items'], default: 'total_only' },
    
    // Editable line items for client view
    lineItems: [{
      description: String,
      quantity: Number,
      unitPrice: Number,         // Marked-up price
      total: Number,
    }],

    // FX snapshot — locks the conversion rates used when this quote's prices
    // were calculated, so a later FX move doesn't silently rewrite the total.
    // Keys are source currencies; values are "1 unit of source = N units of quote currency".
    fxRates: { type: mongoose.Schema.Types.Mixed, default: {} },
  },
  
  // Inclusions / Exclusions
  inclusions: [String],
  exclusions: [String],
  paymentTerms: { type: String, default: '' },

  // Package snapshot — populated when the quote was built from a Package
  // (multi-camp trail). Carries the package-level metadata that doesn't
  // belong on a single day: pax tier used, single supplement, child
  // breakdown, cancellation policy, deposit, booking terms, mealPlan, and
  // source/quote-currency context. Surfaced by the Payment Terms / policy
  // blocks on the share page (Chunk 6 wiring).
  packageSnapshot: { type: mongoose.Schema.Types.Mixed, default: null },
  
  // Shareable link
  shareToken: { type: String, unique: true, sparse: true },
  shareSettings: {
    isPublic: { type: Boolean, default: true },
    expiresAt: Date,
    password: String,
  },
  
  // Tracking
  tracking: {
    views: { type: Number, default: 0 },
    lastViewedAt: Date,
    viewLog: [{
      viewedAt: { type: Date, default: Date.now },
      device: String,
      location: String,
      duration: Number,          // seconds
    }],
  },
  
  // Status
  status: { type: String, enum: ['draft', 'sent', 'viewed', 'accepted', 'rejected', 'expired'], default: 'draft' },

  // Template
  isTemplate: { type: Boolean, default: false },
  templateName: { type: String, default: '' },
  templateDescription: { type: String, default: '' },
  
  // AI-generated content
  coverNarrative: { type: String, default: '' },
  closingNote: { type: String, default: '' },
  highlights: [String],
  
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  
  // PDF style preset — controls typography, accents, cover treatment
  pdfStyle: { type: String, enum: ['editorial', 'modern', 'minimal'], default: 'editorial' },
  coverLayout: { type: String, enum: ['full_bleed', 'split', 'band'], default: 'full_bleed' },

  // Branding snapshot (in case org branding changes later)
  brandingSnapshot: {
    logo: String,
    primaryColor: String,
    secondaryColor: String,
    companyName: String,
    companyEmail: String,
    companyPhone: String,
    companyAddress: String,
    aboutUs: String,
    coverQuote: String,
    coverQuoteAuthor: String,
  },
}, { timestamps: true });

// Auto-generate quote number and share token.
// The number resets every calendar year and is scoped per-organization.
// We pick the next number from the *max* existing number for this org+year
// (not a count) so deleting a quote doesn't cause the next save to collide.
quoteSchema.pre('save', async function() {
  if (!this.quoteNumber) {
    const year = new Date().getFullYear();
    const last = await this.constructor.findOne({
      organization: this.organization,
      quoteNumber: { $regex: `^${year}-` },
    }).sort({ quoteNumber: -1 }).select('quoteNumber').lean();
    let next = 1;
    if (last?.quoteNumber) {
      const n = parseInt(last.quoteNumber.split('-')[1], 10);
      if (Number.isFinite(n)) next = n + 1;
    }
    this.quoteNumber = `${year}-${String(next).padStart(4, '0')}`;
  }
  if (!this.shareToken) {
    this.shareToken = nanoid(12);
  }
});

quoteSchema.index({ organization: 1 });
quoteSchema.index({ organization: 1, deal: 1 });
// Per-org uniqueness on quoteNumber. Sparse so quotes without a number (rare) don't collide.
quoteSchema.index({ organization: 1, quoteNumber: 1 }, { unique: true, sparse: true });

export default mongoose.model('Quote', quoteSchema);