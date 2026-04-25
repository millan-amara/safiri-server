import mongoose from 'mongoose';

// Per-deal invoice. Generated either manually from the deal-detail panel or
// auto-drafted when a deal moves to a Won-typed stage (org preference).
const invoiceSchema = new mongoose.Schema({
  organization: { type: mongoose.Schema.Types.ObjectId, ref: 'Organization', required: true },
  deal: { type: mongoose.Schema.Types.ObjectId, ref: 'Deal', required: true },
  contact: { type: mongoose.Schema.Types.ObjectId, ref: 'Contact' },
  // Snapshot reference: which quote (if any) seeded the line items at creation.
  quote: { type: mongoose.Schema.Types.ObjectId, ref: 'Quote' },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },

  // Per-org auto-incrementing integer; rendered as INV-NNNN at display time.
  // Never reset — keeping a clean monotonic series simplifies accounting.
  invoiceNumber: { type: Number, required: true },

  // Snapshotted at creation so renaming/editing the contact later doesn't
  // mutate historical invoices. If the contact is gone, the invoice still has
  // a record of who it was for.
  client: {
    name: { type: String, default: '' },
    email: { type: String, default: '' },
    phone: { type: String, default: '' },
    company: { type: String, default: '' },
    address: { type: String, default: '' },
  },

  issueDate: { type: Date, default: Date.now },
  dueDate: { type: Date },

  lineItems: [{
    description: { type: String, default: '' },
    quantity: { type: Number, default: 1 },
    unitPrice: { type: Number, default: 0 },
    total: { type: Number, default: 0 },
  }],

  subtotal: { type: Number, default: 0 },
  taxPercent: { type: Number, default: 0 },
  taxAmount: { type: Number, default: 0 },
  total: { type: Number, default: 0 },
  currency: { type: String, default: 'USD' },

  // Snapshotted at creation from org.preferences.paymentInstructions; operator
  // can edit on the invoice if they want to override for this client.
  paymentInstructions: { type: String, default: '' },
  notes: { type: String, default: '' },

  status: {
    type: String,
    enum: ['draft', 'sent', 'paid', 'cancelled'],
    default: 'draft',
  },
  sentAt: Date,
  paidAt: Date,
}, { timestamps: true });

invoiceSchema.index({ organization: 1, invoiceNumber: 1 }, { unique: true });
invoiceSchema.index({ deal: 1 });
invoiceSchema.index({ organization: 1, status: 1 });
invoiceSchema.index({ organization: 1, createdAt: -1 });

export default mongoose.model('Invoice', invoiceSchema);
