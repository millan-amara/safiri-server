import mongoose from 'mongoose';

const transportSchema = new mongoose.Schema({
  organization: { type: mongoose.Schema.Types.ObjectId, ref: 'Organization', required: true },
  
  name: { type: String, required: true, trim: true },
  type: { type: String, enum: ['4x4', 'van', 'minibus', 'bus', 'flight', 'train', 'boat', 'helicopter', 'other'], required: true },
  capacity: { type: Number, default: 6 },
  
  pricingModel: { type: String, enum: ['per_day', 'per_trip', 'per_person', 'per_km'], default: 'per_day' },
  season: { type: String, enum: ['low', 'mid', 'high', 'peak', 'all'], default: 'all' },
  routeOrZone: { type: String, default: '' },      // e.g. "Nairobi to Maasai Mara"
  rate: { type: Number, required: true },
  
  fuelIncluded: { type: Boolean, default: true },
  driverIncluded: { type: Boolean, default: true },
  
  destinations: [String],   // Which destinations this serves
  
  images: [{
    url: String,
    caption: String,
  }],
  
  currency: { type: String, default: 'KES' },
  notes: { type: String, default: '' },
  isActive: { type: Boolean, default: true },

  // ── Pass-3 search embedding (mirrors Hotel.embeddingV1) ────────────────
  // Voyage AI semantic vector for vibe queries on transport ("romantic boat
  // transfer", "comfortable airport pickup"). Populated by the backfill
  // script and on transport POST/PUT when the source content changes.
  // Searched via Atlas $vectorSearch index 'transport_embeddings_v1'.
  embeddingV1: { type: [Number], default: undefined, select: false },
  embeddingV1Model: { type: String, default: '' },
  embeddingV1SourceHash: { type: String, default: '' },
  embeddingV1UpdatedAt: { type: Date },
}, { timestamps: true });

transportSchema.index({ organization: 1 });

export default mongoose.model('Transport', transportSchema);