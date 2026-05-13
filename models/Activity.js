import mongoose from 'mongoose';

const activitySchema = new mongoose.Schema({
  organization: { type: mongoose.Schema.Types.ObjectId, ref: 'Organization', required: true },
  
  name: { type: String, required: true, trim: true },
  destination: { type: String, required: true, trim: true },
  description: { type: String, default: '' },
  duration: { type: Number, default: 0 },           // in hours
  
  pricingModel: { type: String, enum: ['per_person', 'per_group', 'flat'], default: 'per_person' },
  season: { type: String, enum: ['low', 'mid', 'high', 'peak', 'all'], default: 'all' },
  costPerPerson: { type: Number, default: 0 },
  groupRate: { type: Number, default: 0 },
  maxGroupSize: { type: Number, default: 0 },
  
  commissionRate: { type: Number, default: 0 },      // % the operator earns
  minimumAge: { type: Number, default: 0 },
  
  isOptional: { type: Boolean, default: false },     // optional activity on quote
  
  images: [{
    url: String,
    caption: String,
  }],
  
  tags: [String],
  currency: { type: String, default: 'KES' },
  notes: { type: String, default: '' },
  isActive: { type: Boolean, default: true },

  // ── Pass-3 search embedding (mirrors Hotel.embeddingV1) ────────────────
  // Voyage AI semantic vector for vibe queries on activities ("scenic walking
  // safari", "kid-friendly cultural visit"). Populated by the backfill script
  // and on activity POST/PUT when the source content changes. Searched via
  // Atlas $vectorSearch index 'activity_embeddings_v1'.
  embeddingV1: { type: [Number], default: undefined, select: false },
  embeddingV1Model: { type: String, default: '' },
  embeddingV1SourceHash: { type: String, default: '' },
  embeddingV1UpdatedAt: { type: Date },
}, { timestamps: true });

activitySchema.index({ organization: 1, destination: 1 });

export default mongoose.model('Activity', activitySchema);