import mongoose from 'mongoose';

const taskSchema = new mongoose.Schema({
  organization: { type: mongoose.Schema.Types.ObjectId, ref: 'Organization', required: true },
  
  title: { type: String, required: true, trim: true },
  description: { type: String, default: '' },
  
  // Links
  deal: { type: mongoose.Schema.Types.ObjectId, ref: 'Deal' },
  contact: { type: mongoose.Schema.Types.ObjectId, ref: 'Contact' },
  
  assignedTo: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  
  dueDate: Date,
  priority: { type: String, enum: ['low', 'medium', 'high', 'urgent'], default: 'medium' },
  status: { type: String, enum: ['todo', 'in_progress', 'done', 'cancelled'], default: 'todo' },
  
  completedAt: Date,
  reminderHours: { type: Number, default: null }, // null = use org default, 0 = no reminder
  reminderSentAt: { type: Date, default: null }, // set by reminder poller when fired — reset on dueDate/reminderHours change
  overdueNotifiedAt: { type: Date, default: null }, // set when overdue WhatsApp is sent — prevents repeat firing
}, { timestamps: true });

taskSchema.index({ organization: 1, assignedTo: 1, status: 1 });
taskSchema.index({ reminderSentAt: 1, status: 1, dueDate: 1 });

export default mongoose.model('Task', taskSchema);