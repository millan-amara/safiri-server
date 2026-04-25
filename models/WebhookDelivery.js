import mongoose from 'mongoose';

// One row per webhook delivery attempt-set. Created when an event fires;
// updated by the immediate attempt and any subsequent retries from the
// background poller. Persisted so operators can see what's been delivered,
// what's pending, and what failed permanently — and manually retry failures.
const webhookDeliverySchema = new mongoose.Schema({
  organization: { type: mongoose.Schema.Types.ObjectId, ref: 'Organization', required: true },

  event: { type: String, required: true }, // e.g. 'invoice.created'

  // Snapshot of the URL at fire time. If the operator rotates the URL while
  // deliveries are pending, those still target the original — that's the
  // intent at the moment the event happened.
  url: { type: String, required: true },
  payload: { type: mongoose.Schema.Types.Mixed, required: true },

  status: {
    type: String,
    enum: ['pending', 'succeeded', 'failed'],
    default: 'pending',
  },
  attempts: { type: Number, default: 0 },
  maxAttempts: { type: Number, default: 5 },
  nextAttemptAt: { type: Date },
  lastAttemptAt: { type: Date },
  lastResponseStatus: { type: Number },
  lastError: { type: String, default: '' },
  deliveredAt: { type: Date },

  // Optional cross-link so the delivery log can show invoice number etc.
  relatedInvoice: { type: mongoose.Schema.Types.ObjectId, ref: 'Invoice' },

  // Auto-expiry for terminal-state rows (set when status flips to succeeded /
  // failed). MongoDB's TTL background process deletes the doc after this date
  // passes. Pending rows leave this null, so they're never auto-pruned.
  // Retention: succeeded = 90 days, failed = 180 days (longer for diagnostics).
  expireAt: { type: Date, default: null },
}, { timestamps: true });

webhookDeliverySchema.index({ organization: 1, createdAt: -1 });
webhookDeliverySchema.index({ status: 1, nextAttemptAt: 1 });
// TTL index — Mongo's background sweeper deletes docs where expireAt < now.
// Docs with expireAt = null are ignored.
webhookDeliverySchema.index({ expireAt: 1 }, { expireAfterSeconds: 0 });

export default mongoose.model('WebhookDelivery', webhookDeliverySchema);
