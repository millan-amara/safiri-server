import mongoose from 'mongoose';

// Packages are multi-camp/multi-day trails priced as a single bundle — think
// "Maasai Trails 4-day Migration Camp" rather than hotel × nights. They carry
// their own pricing (pax-tiered, audience-aware) and a sequence of segments
// pointing to the lodges or camps included.

const paxTierSchema = new mongoose.Schema({
  minPax: { type: Number, default: 1 },
  maxPax: { type: Number, default: 99 },
  pricePerPerson: { type: Number, required: true },
}, { _id: false });

const childBracketSchema = new mongoose.Schema({
  label: String,
  minAge: { type: Number, default: 0 },
  maxAge: { type: Number, default: 17 },
  mode: { type: String, enum: ['free', 'pct', 'flat'], default: 'pct' },
  value: { type: Number, default: 0 },
  sharingRule: { type: String, enum: ['sharing_with_adults', 'own_room', 'any'], default: 'sharing_with_adults' },
}, { _id: false });

const dateRangeSchema = new mongoose.Schema({
  from: { type: Date, required: true },
  to: { type: Date, required: true },
}, { _id: false });

// One "leg" of the trail — e.g. days 1–3 in Rekero Camp, days 4–6 in Kicheche.
// `hotel` links to a Hotel document when we have inventory; otherwise we
// snapshot the name.
const segmentSchema = new mongoose.Schema({
  startDay: { type: Number, required: true },   // 1-indexed
  endDay: { type: Number, required: true },
  location: { type: String, default: '' },
  hotel: { type: mongoose.Schema.Types.ObjectId, ref: 'Hotel' },
  hotelName: { type: String, default: '' },
  notes: { type: String, default: '' },
}, { _id: true });

const cancellationTierSchema = new mongoose.Schema({
  daysBefore: { type: Number, required: true },
  penaltyPct: { type: Number, required: true },
  notes: String,
}, { _id: false });

// One pricing sheet for a package. Mirrors Hotel.rateListSchema so the same
// audience filter + validity-window + priority logic works: a package can
// carry Rack + STO + Resident lists on one record, and the resolver picks
// whichever matches the quote's clientType and trip dates.
const pricingListSchema = new mongoose.Schema({
  name: { type: String, required: true },            // "Rack 2026", "STO 2026", "Resident 2026"
  audience: { type: [String], default: ['retail'] }, // 'retail' | 'contract' | 'resident'
  currency: { type: String, default: 'USD' },
  validFrom: Date,
  validTo: Date,
  priority: { type: Number, default: 0 },
  seasonLabel: { type: String, default: '' },
  seasonDateRanges: [dateRangeSchema],
  paxTiers: [paxTierSchema],
  singleSupplement: { type: Number, default: 0 },
  childBrackets: [childBracketSchema],
  mealPlan: { type: String, default: 'FB' },
  mealPlanLabel: { type: String, default: '' },
  inclusions: [{ type: String }],
  exclusions: [{ type: String }],
  notes: { type: String, default: '' },
  isActive: { type: Boolean, default: true },
}, { _id: true });

const packageSchema = new mongoose.Schema({
  organization: { type: mongoose.Schema.Types.ObjectId, ref: 'Organization', required: true },

  name: { type: String, required: true, trim: true },
  destination: { type: String, default: '' },        // "Kenya + Tanzania" — free-text region/route
  description: { type: String, default: '' },
  durationNights: { type: Number, default: 0 },
  durationDays: { type: Number, default: 0 },

  images: [{
    url: String,
    caption: String,
    isHero: { type: Boolean, default: false },
  }],

  // The lodges/camps included (for display on the quote + for auto-populating days)
  segments: [segmentSchema],

  // Pricing lists — one per audience/season combination. The resolver filters
  // by audience + validity window, then picks highest priority.
  pricingLists: [pricingListSchema],

  cancellationTiers: [cancellationTierSchema],
  depositPct: { type: Number, default: 30 },
  bookingTerms: { type: String, default: '' },

  tags: [String],
  notes: { type: String, default: '' },
  isActive: { type: Boolean, default: true },
}, { timestamps: true });

packageSchema.index({ organization: 1, destination: 1 });
packageSchema.index({ organization: 1, name: 'text', destination: 'text' });

export default mongoose.model('Package', packageSchema);
