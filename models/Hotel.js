import mongoose from 'mongoose';

const rateSchema = new mongoose.Schema({
  roomType: { type: String, required: true },
  maxOccupancy: { type: Number, default: 2 },
  season: { type: String, enum: ['low', 'mid', 'high', 'peak', 'all'], default: 'all' },
  startMonth: { type: Number, min: 1, max: 12 },
  endMonth: { type: Number, min: 1, max: 12 },
  ratePerNight: { type: Number, required: true },
  mealPlan: { type: String, enum: ['RO', 'BB', 'HB', 'FB', 'AI'], default: 'BB' },
  // RO=Room Only, BB=Bed&Breakfast, HB=Half Board, FB=Full Board, AI=All Inclusive
  childFreeAge: { type: Number, default: 3 },
  childReducedAge: { type: Number, default: 12 },
  childReducedPct: { type: Number, default: 50 },
  minimumNights: { type: Number, default: 1 },
}, { _id: true });

const hotelSchema = new mongoose.Schema({
  organization: { type: mongoose.Schema.Types.ObjectId, ref: 'Organization', required: true },
  
  name: { type: String, required: true, trim: true },
  destination: { type: String, required: true, trim: true },    // e.g. "Maasai Mara"
  location: { type: String, trim: true },                        // e.g. "Talek"
  stars: { type: Number, min: 1, max: 5 },
  type: { type: String, enum: ['hotel', 'lodge', 'tented_camp', 'resort', 'villa', 'apartment', 'guesthouse'], default: 'hotel' },
  
  description: { type: String, default: '' },
  
  // Images
  images: [{
    url: String,
    caption: String,
    isHero: { type: Boolean, default: false },
  }],
  
  // Rates (multiple per hotel — different rooms, seasons)
  rates: [rateSchema],
  
  // Location data (for map)
  coordinates: {
    lat: Number,
    lng: Number,
  },
  
  // Amenities
  amenities: [String],
  
  // Contact
  contactEmail: String,
  contactPhone: String,
  
  currency: { type: String, default: 'KES' },
  tags: [String],
  notes: { type: String, default: '' },
  isActive: { type: Boolean, default: true },
}, { timestamps: true });

hotelSchema.index({ organization: 1, destination: 1 });
hotelSchema.index({ organization: 1, name: 'text', destination: 'text' });

export default mongoose.model('Hotel', hotelSchema);