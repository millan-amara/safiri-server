import mongoose from 'mongoose';

const notificationSchema = new mongoose.Schema({
  organization: { type: mongoose.Schema.Types.ObjectId, ref: 'Organization', required: true },
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  
  type: { type: String, enum: ['deal_created', 'deal_stage_changed', 'deal_won', 'quote_viewed', 'task_assigned', 'task_overdue', 'system'], default: 'system' },
  title: { type: String, required: true },
  message: { type: String, default: '' },
  
  // Link to entity
  entityType: { type: String, enum: ['deal', 'quote', 'contact', 'task', null], default: null },
  entityId: { type: mongoose.Schema.Types.ObjectId },
  
  isRead: { type: Boolean, default: false },
  readAt: Date,
}, { timestamps: true });

notificationSchema.index({ user: 1, isRead: 1, createdAt: -1 });

export default mongoose.model('Notification', notificationSchema);