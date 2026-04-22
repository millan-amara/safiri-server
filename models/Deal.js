import mongoose from 'mongoose';

// Pipeline definition (customizable stages)
const pipelineSchema = new mongoose.Schema({
  organization: { type: mongoose.Schema.Types.ObjectId, ref: 'Organization', required: true },
  name: { type: String, required: true, trim: true },
  stages: [{
    name: { type: String, required: true },
    order: { type: Number, required: true },
    color: { type: String, default: '#6B7280' },
  }],
  isDefault: { type: Boolean, default: false },
  isActive: { type: Boolean, default: true },
}, { timestamps: true });

export const Pipeline = mongoose.model('Pipeline', pipelineSchema);

// Deal (a potential booking in the pipeline)
const dealSchema = new mongoose.Schema({
  organization: { type: mongoose.Schema.Types.ObjectId, ref: 'Organization', required: true },
  
  title: { type: String, required: true, trim: true },
  
  contact: { type: mongoose.Schema.Types.ObjectId, ref: 'Contact' },
  pipeline: { type: mongoose.Schema.Types.ObjectId, ref: 'Pipeline', required: true },
  stage: { type: String, required: true },
  
  // Trip details
  destination: { type: String, default: '' },
  arrivalCity: { type: String, default: '' },
  travelDates: {
    start: Date,
    end: Date,
  },
  tripDuration: { type: Number, default: 0 },          // nights
  groupSize: { type: Number, default: 0 },
  budget: { type: Number, default: 0 },
  budgetCurrency: { type: String, default: 'USD' },
  tripType: { type: String, enum: ['safari', 'beach', 'honeymoon', 'family', 'corporate', 'adventure', 'cultural', 'mixed', ''], default: '' },
  interests: [String],                                   // safari, beach, culture, etc.
  specialRequests: { type: String, default: '' },

  // Which rate sheet the operator should quote from.
  // 'retail' = walk-in/public rack; 'contract' = DMC/agent/STO; 'resident' = EA/citizen pricing.
  clientType: {
    type: String,
    enum: ['retail', 'contract', 'resident'],
    default: 'retail',
  },
  // Used to resolve nationality-tiered pass-through fees (park fees etc.).
  // 'citizen' = passport of the operating country; 'resident' = East African
  // Community resident with proof; 'nonResident' = international visitor.
  nationality: {
    type: String,
    enum: ['citizen', 'resident', 'nonResident'],
    default: 'nonResident',
  },
  
  // Sales tracking
  leadSource: { type: String, enum: ['website', 'referral', 'repeat', 'travel_agent', 'social', 'email', 'phone', 'walk_in', 'other', ''], default: '' },
  expectedCloseDate: Date,
  value: { type: Number, default: 0 },
  currency: { type: String, default: 'USD' },
  probability: { type: Number, default: 0, min: 0, max: 100 },
  
  // Assignment
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  assignedTo: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  
  // Linked quotes
  quotes: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Quote' }],
  
  // Notes (separate from activity — operator's own notes)
  notes: [{
    text: { type: String, required: true },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    createdAt: { type: Date, default: Date.now },
    isPinned: { type: Boolean, default: false },
  }],
  
  // Activity log (auto-generated system events only)
  activities: [{
    type: { type: String, enum: ['stage_change', 'quote_sent', 'quote_viewed', 'deal_created', 'assignment_change'] },
    description: String,
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    createdAt: { type: Date, default: Date.now },
    metadata: mongoose.Schema.Types.Mixed,
  }],
  
  // Attachments
  attachments: [{
    name: String,
    url: String,
    type: String,
    uploadedAt: { type: Date, default: Date.now },
  }],
  
  tags: [String],
  
  wonAt: Date,
  lostAt: Date,
  lostReason: String,
  inactiveNotifiedAt: { type: Date, default: null }, // set when inactive WhatsApp is sent — resets when deal is touched
  
  isActive: { type: Boolean, default: true },
}, { timestamps: true });

// Virtual: is this deal ready for quote generation?
dealSchema.virtual('isQuoteReady').get(function() {
  return !!(this.destination && this.travelDates?.start && this.groupSize > 0 && this.budget > 0);
});

dealSchema.set('toJSON', { virtuals: true });
dealSchema.set('toObject', { virtuals: true });

dealSchema.index({ organization: 1, pipeline: 1 });
dealSchema.index({ organization: 1, contact: 1 });
dealSchema.index({ organization: 1, assignedTo: 1 });

export const Deal = mongoose.model('Deal', dealSchema);