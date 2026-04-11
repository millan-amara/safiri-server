import mongoose from 'mongoose';

const organizationSchema = new mongoose.Schema({
  name: { type: String, required: true, trim: true },
  slug: { type: String, unique: true, lowercase: true },
  
  // Branding
  branding: {
    logo: { type: String, default: '' },            // Cloudinary URL
    primaryColor: { type: String, default: '#B45309' },
    secondaryColor: { type: String, default: '#1E293B' },
    accentColor: { type: String, default: '#059669' },
    fontFamily: { type: String, default: 'Inter' },
  },
  
  // Business info (appears on quotes)
  businessInfo: {
    email: { type: String, default: '' },
    phone: { type: String, default: '' },
    website: { type: String, default: '' },
    address: { type: String, default: '' },
    country: { type: String, default: 'Kenya' },
    tagline: { type: String, default: '' },
    aboutUs: { type: String, default: '' },
  },

  // Defaults
  defaults: {
    currency: { type: String, default: 'USD' },
    marginPercent: { type: Number, default: 20 },
    paymentTerms: { type: String, default: '40% deposit, 60% balance due 30 days before tour.' },
    inclusions: [{ type: String }],
    exclusions: [{ type: String }],
  },

  // Subscription / plan (for future monetization)
  plan: { type: String, enum: ['free', 'starter', 'pro', 'enterprise'], default: 'free' },
  
  // n8n automation endpoint
  webhookUrl: { type: String, default: '' },
  
  // API key for external integrations (n8n, Zapier, etc.)
  apiKey: { type: String, unique: true, sparse: true },
  
  owner: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
}, { timestamps: true });

export default mongoose.model('Organization', organizationSchema);