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
  
  // Reference
  quoteNumber: { type: String, unique: true, sparse: true },
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
      { id: 'pricing', enabled: true, order: 5 },
      { id: 'inclusions', enabled: true, order: 6 },
      { id: 'exclusions', enabled: true, order: 7 },
      { id: 'payment_terms', enabled: true, order: 8 },
      { id: 'about_us', enabled: false, order: 9 },
      { id: 'terms', enabled: false, order: 10 },
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
  },
  
  // Inclusions / Exclusions
  inclusions: [String],
  exclusions: [String],
  paymentTerms: { type: String, default: '' },
  
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

// Auto-generate quote number and share token
quoteSchema.pre('save', async function() {
  if (!this.quoteNumber) {
    const year = new Date().getFullYear();
    const count = await this.constructor.countDocuments({ organization: this.organization });
    this.quoteNumber = `${year}-${String(count + 1).padStart(4, '0')}`;
  }
  if (!this.shareToken) {
    this.shareToken = nanoid(12);
  }
});

quoteSchema.index({ organization: 1 });
quoteSchema.index({ organization: 1, deal: 1 });

export default mongoose.model('Quote', quoteSchema);