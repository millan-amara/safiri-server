import mongoose from 'mongoose';

// ─── Core price shapes ──────────────────────────────────────────────────
// A night of lodging can be priced several ways depending on how a party
// configures rooms. Operators quote from the rack/STO sheet by picking the
// occupancy column that matches the party's room layout.

// Child pricing modes handle both styles seen in real rate sheets:
//   'free'   — child stays free (often ages 0–3 sharing)
//   'pct'    — child pays `value`% of perPersonSharing (or singleOccupancy
//              if the child has their own room, per `sharingRule`)
//   'flat'   — child pays `value` absolute per night in the list's currency
const childBracketSchema = new mongoose.Schema({
  label: String,               // "0–3 sharing", "4–11 yrs", "12–17"
  minAge: { type: Number, default: 0 },
  maxAge: { type: Number, default: 17 },
  mode: { type: String, enum: ['free', 'pct', 'flat'], default: 'pct' },
  value: { type: Number, default: 0 },
  sharingRule: {
    type: String,
    enum: ['sharing_with_adults', 'own_room', 'any'],
    default: 'sharing_with_adults',
  },
}, { _id: false });

const roomPricingSchema = new mongoose.Schema({
  roomType: { type: String, required: true },         // "Standard", "Deluxe", "Family Suite"
  maxOccupancy: { type: Number, default: 2 },
  singleOccupancy: { type: Number, default: 0 },      // solo traveler per night
  perPersonSharing: { type: Number, default: 0 },     // standard "dbl" per-person rate
  triplePerPerson: { type: Number, default: 0 },      // per-person in a triple share
  quadPerPerson: { type: Number, default: 0 },        // per-person in a quad share
  singleSupplement: { type: Number, default: 0 },     // when a solo uses a dbl/twin; added on top of perPersonSharing
  childBrackets: [childBracketSchema],
  notes: String,
}, { _id: false });

// A date range — day-precision, not month. Speke's High covers three
// disjoint stretches, so a season holds many of these.
const dateRangeSchema = new mongoose.Schema({
  from: { type: Date, required: true },
  to: { type: Date, required: true },
}, { _id: false });

// Date-specific price bump inside a season (Christmas/NYE, shoulder weeks).
// Can be per-person or per-room, and typically applies only on nights that
// fall inside `dates`.
const supplementSchema = new mongoose.Schema({
  name: { type: String, required: true },
  dates: [dateRangeSchema],
  amountPerPerson: { type: Number, default: 0 },
  amountPerRoom: { type: Number, default: 0 },
  // Supplements can be priced in a different currency than the rate list.
  // Chui Lodge is the canonical example: rooms in KES, Christmas/Easter
  // supplements in USD. Blank = inherit from rate list currency.
  currency: { type: String, default: '' },
  mandatory: { type: Boolean, default: true },
  notes: String,
}, { _id: false });

const seasonSchema = new mongoose.Schema({
  label: { type: String, required: true },           // "High", "Mid", "Low", "Peak", "Shoulder", "Weekend"
  dateRanges: [dateRangeSchema],                     // multi-range (Speke's High = 3 windows)
  // Optional day-of-week filter. 0=Sunday ... 6=Saturday (JS getDay convention).
  // Use when a lodge prices weekends separately from weekdays (Chui Lodge:
  // Fri/Sat = [5,6], Sun–Thu = [0,1,2,3,4]). Empty = applies to every day.
  daysOfWeek: { type: [Number], default: [] },
  // Additional specific dates this season applies on, OR'd with daysOfWeek.
  // Use for public holidays that the PDF groups with weekend pricing
  // ("Friday, Saturday, Public Holidays" → daysOfWeek=[5,6] + specificDates=[Dec 25, Jan 1, …]).
  specificDates: { type: [Date], default: [] },
  minNights: { type: Number, default: 1 },
  rooms: [roomPricingSchema],                        // per-room-type pricing for this season
  supplements: [supplementSchema],
}, { _id: false });

// Optional hotel-level extras (drinks, vehicle hire, massages, conferencing).
// Priced per unit — the unit determines how the resolver multiplies.
const addOnSchema = new mongoose.Schema({
  name: { type: String, required: true },
  description: String,
  unit: {
    type: String,
    enum: ['per_person_per_day', 'per_day', 'per_trip', 'per_person', 'per_room_per_day'],
    default: 'per_person_per_day',
  },
  amount: { type: Number, default: 0 },
  optional: { type: Boolean, default: true },        // false = mandatory add-on (rare)
}, { _id: false });

// Pass-through fees are collected by the hotel but paid through to a third
// party (park fees, community fees, government levies). They can price by
// nationality tier and age — Mara Reserve Fee alone has 4 price rows.
// Each fee row is a self-contained rate table entry (one effective window).
const feeRowSchema = new mongoose.Schema({
  adultCitizen: { type: Number, default: 0 },
  adultResident: { type: Number, default: 0 },
  adultNonResident: { type: Number, default: 0 },
  childCitizen: { type: Number, default: 0 },
  childResident: { type: Number, default: 0 },
  childNonResident: { type: Number, default: 0 },
  childMinAge: { type: Number, default: 0 },          // e.g. 9 for Mara
  childMaxAge: { type: Number, default: 17 },         // e.g. 17 for Mara
  validFrom: Date,
  validTo: Date,
  notes: String,
}, { _id: false });

const passThroughFeeSchema = new mongoose.Schema({
  name: { type: String, required: true },            // "Mara Reserve Fee", "Community Fee", "Tanzania Tourism Levy"
  unit: {
    type: String,
    enum: ['per_person_per_day', 'per_person_per_entry', 'per_person_per_night', 'per_room_per_night', 'flat'],
    default: 'per_person_per_day',
  },
  currency: String,                                  // fee currency can differ from rate list currency
  flatAmount: { type: Number, default: 0 },          // fallback when no tiered table given
  tieredRows: [feeRowSchema],                        // use if fee varies by nationality/age
  mandatory: { type: Boolean, default: true },
  notes: String,
}, { _id: false });

const cancellationTierSchema = new mongoose.Schema({
  daysBefore: { type: Number, required: true },      // e.g. 60, 30, 14, 7
  penaltyPct: { type: Number, required: true },      // % of total forfeited
  notes: String,
}, { _id: false });

// A rate list = one price sheet. Audience + currency + validity + priority
// + meal plan + seasons. A hotel can have many (Rack + STO + Resident + a
// Feb promo). The resolver filters by audience & validity, then picks the
// highest-priority match.
const rateListSchema = new mongoose.Schema({
  name: { type: String, required: true },            // "Rack 2026", "STO Contract 2026", "Resident Pricelist", "Feb Flash"
  audience: {
    type: [String],
    default: ['retail'],
    // Canonical tags: 'retail' (public/rack), 'contract' (DMC/agent/STO),
    // 'resident' (EA/citizen). Free-text allowed so operators can add custom
    // audiences (e.g. 'staff', 'press') without a schema change.
  },
  currency: { type: String, default: 'USD' },
  validFrom: Date,
  validTo: Date,
  priority: { type: Number, default: 0 },            // higher wins on overlapping windows
  mealPlan: { type: String, default: 'FB' },         // 'RO' | 'BB' | 'HB' | 'FB' | 'AI' | 'GAME_PACKAGE' — free-text
  mealPlanLabel: { type: String, default: '' },      // "Full Board", "Game Package incl. drives"
  seasons: [seasonSchema],
  addOns: [addOnSchema],
  passThroughFees: [passThroughFeeSchema],
  cancellationTiers: [cancellationTierSchema],
  depositPct: { type: Number, default: 0 },
  bookingTerms: { type: String, default: '' },
  notes: { type: String, default: '' },
  isActive: { type: Boolean, default: true },
}, { _id: true });

// ─── Hotel ──────────────────────────────────────────────────────────────
const hotelSchema = new mongoose.Schema({
  organization: { type: mongoose.Schema.Types.ObjectId, ref: 'Organization', required: true },

  name: { type: String, required: true, trim: true },
  destination: { type: String, required: true, trim: true },    // e.g. "Maasai Mara"
  location: { type: String, trim: true },                        // e.g. "Talek"
  stars: { type: Number, min: 1, max: 5 },
  type: {
    type: String,
    enum: ['hotel', 'lodge', 'tented_camp', 'resort', 'villa', 'apartment', 'guesthouse', 'conservancy_camp'],
    default: 'hotel',
  },

  description: { type: String, default: '' },

  images: [{
    url: String,
    caption: String,
    isHero: { type: Boolean, default: false },
  }],

  // Rate lists — each a self-contained price sheet for an audience/validity window.
  rateLists: [rateListSchema],

  coordinates: {
    lat: Number,
    lng: Number,
  },

  amenities: [String],
  contactEmail: String,
  contactPhone: String,

  // Default display currency. Individual rate lists may override.
  currency: { type: String, default: 'USD' },
  tags: [String],
  notes: { type: String, default: '' },
  isActive: { type: Boolean, default: true },
}, { timestamps: true });

hotelSchema.index({ organization: 1, destination: 1 });
hotelSchema.index({ organization: 1, name: 'text', destination: 'text' });

export default mongoose.model('Hotel', hotelSchema);
