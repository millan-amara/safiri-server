import mongoose from 'mongoose';

const libraryImageSchema = new mongoose.Schema({
  url: { type: String, required: true },
  publicId: { type: String, default: '' },

  caption: { type: String, default: '' },
  credit: { type: String, default: '' },
  attribution: { type: String, default: '' },
  sourceUrl: { type: String, default: '' },

  tags: { type: [String], default: [], index: true },
  destinationType: {
    type: String,
    enum: ['safari', 'beach', 'city', 'mountain', 'lake', 'cultural', 'adventure', 'other'],
    default: 'other',
  },

  isActive: { type: Boolean, default: true },
  usageCount: { type: Number, default: 0 },

  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
}, { timestamps: true });

libraryImageSchema.index({ isActive: 1, tags: 1 });
libraryImageSchema.index({ isActive: 1, destinationType: 1 });

libraryImageSchema.pre('save', function () {
  if (this.tags) this.tags = this.tags.map(t => String(t).toLowerCase().trim()).filter(Boolean);
});

export default mongoose.model('LibraryImage', libraryImageSchema);
