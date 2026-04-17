import mongoose from 'mongoose';

export const TRIGGER_TYPES = [
  'deal.stage_changed',
  'deal.created',
  'deal.won',
  'deal.lost',
  'contact.created',
  'task.overdue',
  'deal.inactive',
  'quote.viewed',
  'quote.sent',
];

export const ACTION_TYPES = [
  'send_email',
  'send_notification',
  'send_webhook',
  'send_whatsapp',
  'create_task',
  'create_deal',
  'assign_to_user',
  'add_tag',
];

const conditionSchema = new mongoose.Schema({
  field: String,      // e.g. 'deal.stage', 'contact.country', 'deal.value'
  operator: { type: String, enum: ['equals', 'not_equals', 'contains', 'greater_than', 'less_than', 'exists'] },
  value: mongoose.Schema.Types.Mixed,
}, { _id: false });

const actionSchema = new mongoose.Schema({
  type: { type: String, enum: ACTION_TYPES, required: true },
  config: {
    // send_email
    to: String,            // 'contact' | 'assigned_user' | specific email
    subject: String,
    body: String,          // supports {{contact.firstName}}, {{deal.title}} etc.

    // send_notification
    message: String,
    targetUser: String,    // 'assigned_user' | 'creator' | userId

    // send_webhook
    url: String,
    method: { type: String, enum: ['POST', 'GET'], default: 'POST' },
    payload: mongoose.Schema.Types.Mixed,

    // send_whatsapp
    whatsappTo: String,        // 'contact' | 'assigned_user'
    whatsappMessage: String,   // supports {{contact.firstName}}, {{deal.title}} etc.

    // create_task
    taskTitle: String,
    taskPriority: { type: String, default: 'medium' },
    taskDueDays: { type: Number, default: 1 },
    assignTo: String,      // 'same_as_deal' | 'same_as_contact' | userId

    // create_deal
    dealTitle: String,
    pipelineId: mongoose.Schema.Types.ObjectId,
    stageId: String,
    assignDealTo: String,

    // assign_to_user
    userId: mongoose.Schema.Types.ObjectId,

    // add_tag
    tag: String,
  },
}, { _id: false });

const automationSchema = new mongoose.Schema({
  organization: { type: mongoose.Schema.Types.ObjectId, ref: 'Organization', required: true, index: true },

  name: { type: String, required: true, trim: true },
  description: { type: String, default: '' },
  isActive: { type: Boolean, default: true },

  trigger: {
    type: { type: String, enum: TRIGGER_TYPES, required: true },
    config: {
      inactiveDays: Number,          // for deal.inactive
      toStage: String,               // for deal.stage_changed — only fire for this stage
    },
  },

  conditions: [conditionSchema],
  actions: [actionSchema],

  // Stats
  runCount: { type: Number, default: 0 },
  lastRunAt: Date,
  lastRunStatus: { type: String, enum: ['success', 'failed', 'partial'] },

  // Meta
  templateId: String,                // which template this was created from
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
}, { timestamps: true });

automationSchema.index({ organization: 1, isActive: 1 });
automationSchema.index({ organization: 1, 'trigger.type': 1 });

export default mongoose.model('Automation', automationSchema);