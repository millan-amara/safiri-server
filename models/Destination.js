import mongoose from 'mongoose';

const destinationSchema = new mongoose.Schema({
  organization: { type: mongoose.Schema.Types.ObjectId, ref: 'Organization', required: true },
  
  name: { type: String, required: true, trim: true },
  country: { type: String, default: 'Kenya' },
  region: { type: String, default: '' },

  description: { type: String, default: '' },
  highlights: [String],

  images: [{
    url: String,
    caption: String,
    isHero: { type: Boolean, default: false },
    credit: String,
  }],

  coordinates: {
    lat: Number,
    lng: Number,
  },

  nearbyDestinations: [{
    destination: { type: mongoose.Schema.Types.ObjectId, ref: 'Destination' },
    distanceKm: Number,
    driveTimeHours: Number,
    suggestedTransport: String,
  }],

  type: { type: String, enum: ['safari', 'beach', 'city', 'mountain', 'lake', 'cultural', 'adventure'], default: 'safari' },
  bestMonths: [Number],
  averageDaysNeeded: { type: Number, default: 2 },

  isActive: { type: Boolean, default: true },
}, { timestamps: true });

destinationSchema.index({ organization: 1, name: 1 });

export default mongoose.model('Destination', destinationSchema);