import mongoose from 'mongoose';

const contactSchema = new mongoose.Schema({
  organization: { type: mongoose.Schema.Types.ObjectId, ref: 'Organization', required: true },
  
  // Basic info
  firstName: { type: String, required: true, trim: true },
  lastName: { type: String, trim: true, default: '' },
  email: { type: String, trim: true, lowercase: true, default: '' },
  phone: { type: String, trim: true, default: '' },
  
  // Business info
  company: { type: String, trim: true, default: '' },
  position: { type: String, trim: true, default: '' },
  country: { type: String, default: '' },
  
  // Source tracking
  source: { type: String, enum: ['manual', 'import', 'website', 'referral', 'social', 'email', 'other'], default: 'manual' },
  
  // Preferences (for better quote suggestions)
  preferences: {
    budget: { type: String, enum: ['budget', 'mid-range', 'luxury', 'ultra-luxury', ''], default: '' },
    interests: [String],       // safari, beach, culture, adventure
    groupSize: { type: Number, default: 0 },
    preferredCurrency: { type: String, default: '' },
  },
  
  tags: [String],
  notes: { type: String, default: '' },
  
  // Attachments
  attachments: [{
    name: String,
    url: String,        // Cloudinary URL
    type: String,
    uploadedAt: { type: Date, default: Date.now },
  }],
  
  assignedTo: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  
  isActive: { type: Boolean, default: true },
}, { timestamps: true });

contactSchema.index({ organization: 1 });
contactSchema.index({ organization: 1, email: 1 });
contactSchema.index({ organization: 1, firstName: 'text', lastName: 'text', email: 'text', company: 'text' });

export default mongoose.model('Contact', contactSchema);