import mongoose from 'mongoose';

// Hotel voucher — the document the lead presents at check-in. Created from a
// deal once accommodation is confirmed; PDF gets emailed to client and lodge.
//
// Hotel + guest + stay details are SNAPSHOTTED at creation, not live refs.
// Editing the source hotel/contact later must not silently mutate vouchers
// that have already been issued — the lodge has a copy of the original.
const voucherSchema = new mongoose.Schema({
  organization: { type: mongoose.Schema.Types.ObjectId, ref: 'Organization', required: true },
  deal: { type: mongoose.Schema.Types.ObjectId, ref: 'Deal', required: true },
  contact: { type: mongoose.Schema.Types.ObjectId, ref: 'Contact' },
  quote: { type: mongoose.Schema.Types.ObjectId, ref: 'Quote' },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },

  // Per-org auto-incrementing integer; rendered as VCH-NNNN at display time.
  voucherNumber: { type: Number, required: true },

  // Hotel snapshot — captured at creation. `hotelRef` is informational only.
  hotelRef: { type: mongoose.Schema.Types.ObjectId, ref: 'Hotel' },
  hotel: {
    name: { type: String, default: '' },
    location: { type: String, default: '' },          // e.g. "Talek, Maasai Mara"
    address: { type: String, default: '' },
    contactEmail: { type: String, default: '' },
    contactPhone: { type: String, default: '' },
  },

  // Lead guest (the one the booking is in the name of) + party composition.
  guest: {
    name: { type: String, default: '' },
    email: { type: String, default: '' },
    phone: { type: String, default: '' },
  },
  adults: { type: Number, default: 1 },
  children: { type: Number, default: 0 },

  // Stay
  checkIn: { type: Date, required: true },
  checkOut: { type: Date, required: true },
  nights: { type: Number, default: 0 },               // computed at save
  roomType: { type: String, default: '' },            // "Deluxe Tent", "Family Suite"
  rooms: { type: Number, default: 1 },
  mealPlan: { type: String, default: '' },            // 'BB' | 'HB' | 'FB' | 'AI' | free-text label

  // Booking refs
  confirmationNumber: { type: String, default: '' },  // lodge's PRN
  bookingReference: { type: String, default: '' },    // operator's internal ref

  inclusions: { type: [String], default: [] },
  exclusions: { type: [String], default: [] },
  specialRequests: { type: String, default: '' },
  notes: { type: String, default: '' },

  status: {
    type: String,
    enum: ['draft', 'issued', 'cancelled'],
    default: 'draft',
  },
  issuedAt: Date,
  cancelledAt: Date,

  // Tracks the most recent email send (to client and/or hotel).
  lastSentAt: Date,
  lastSentTo: { type: [String], default: [] },
}, { timestamps: true });

voucherSchema.index({ organization: 1, voucherNumber: 1 }, { unique: true });
voucherSchema.index({ deal: 1 });
voucherSchema.index({ organization: 1, status: 1 });
voucherSchema.index({ organization: 1, createdAt: -1 });

// Recompute nights from check-in/out so stale `nights` can't drift from dates.
voucherSchema.pre('save', function () {
  if (this.checkIn && this.checkOut) {
    const ms = new Date(this.checkOut).getTime() - new Date(this.checkIn).getTime();
    this.nights = Math.max(0, Math.round(ms / (1000 * 60 * 60 * 24)));
  }
});

export default mongoose.model('Voucher', voucherSchema);
