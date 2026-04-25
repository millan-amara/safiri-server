import mongoose from 'mongoose';

// A scheduled outreach message attached to a deal — "send packing tips 14 days
// before travel start" / "send a review request 1 day after travel end" /
// "send this update on March 15". Operator drafts the body (with AI assist),
// picks channel + timing, and the poller delivers at sendAt.
const scheduledMessageSchema = new mongoose.Schema({
  organization: { type: mongoose.Schema.Types.ObjectId, ref: 'Organization', required: true },
  deal: { type: mongoose.Schema.Types.ObjectId, ref: 'Deal', required: true },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },

  // Email is the only supported channel for now — WhatsApp's session-window +
  // template-only restrictions don't fit free-form pre-trip messaging.
  channel: { type: String, enum: ['email'], default: 'email' },
  subject: { type: String, default: '' },
  body: { type: String, required: true },

  // Three timing modes. `sendAt` is the resolved date the poller looks at and
  // is recomputed from `timing` whenever travel dates change.
  timing: {
    mode: {
      type: String,
      enum: ['before_travel_start', 'after_travel_end', 'absolute'],
      required: true,
    },
    offsetDays: { type: Number, default: 0 }, // for relative modes; non-negative integer
    absoluteDate: { type: Date },             // for 'absolute' mode
  },

  sendAt: { type: Date, required: true },

  // Lifecycle:
  //  scheduled → poller picks up at sendAt → sending → sent (success) or failed
  //  scheduled/overdue → cancelled (operator cancel, deal Lost, or deal deleted)
  //  scheduled → overdue (travel-date change pushed sendAt into the past)
  status: {
    type: String,
    enum: ['scheduled', 'sending', 'sent', 'failed', 'cancelled', 'overdue'],
    default: 'scheduled',
  },
  sentAt: { type: Date },
  errorMessage: { type: String, default: '' },
}, { timestamps: true });

scheduledMessageSchema.index({ status: 1, sendAt: 1 });
scheduledMessageSchema.index({ deal: 1 });
scheduledMessageSchema.index({ organization: 1 });

export default mongoose.model('ScheduledMessage', scheduledMessageSchema);
