import mongoose from 'mongoose';

/**
 * Internal cost-tracking log for every AI call.
 * Not exposed to users — used for operator cost analysis only.
 */
const aiUsageLogSchema = new mongoose.Schema({
  organizationId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Organization',
    required: true,
    index: true,
  },
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
  },
  endpoint: {
    type: String,
    required: true,
    // One of: draft-itinerary, generate-all-narratives, generate-narrative,
    //         deal-summary, draft-email, suggest-route, map-columns,
    //         draft-scheduled-message, extract-rate-card
  },
  timestamp: { type: Date, default: Date.now },
  // Real token usage from Claude's response.usage. estimatedCostUsd is computed
  // from these in aiLogger using the per-model pricing table (so we can re-cost
  // historical logs if pricing changes).
  model: { type: String, default: null },
  inputTokens: { type: Number, default: 0 },
  outputTokens: { type: Number, default: 0 },
  cacheReadInputTokens: { type: Number, default: 0 },
  cacheCreationInputTokens: { type: Number, default: 0 },
  estimatedCostUsd: { type: Number, required: true },
  success: { type: Boolean, required: true },
  errorMessage: { type: String, default: null },
}, {
  // No updatedAt needed — logs are write-once
  timestamps: false,
  versionKey: false,
});

// TTL: auto-delete logs older than 2 years (keeps collection lean)
aiUsageLogSchema.index({ timestamp: 1 }, { expireAfterSeconds: 60 * 60 * 24 * 730 });

export default mongoose.model('AiUsageLog', aiUsageLogSchema);
