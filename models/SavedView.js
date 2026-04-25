import mongoose from 'mongoose';

// Per-user saved filter combinations, scoped to a CRM tab. For now only the
// pipeline tab uses these — the schema's `scope` enum is intentionally a
// single value so we can extend to 'contacts' / 'tasks' later without migration.
const savedViewSchema = new mongoose.Schema({
  organization: { type: mongoose.Schema.Types.ObjectId, ref: 'Organization', required: true },
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  name: { type: String, required: true, trim: true },
  scope: { type: String, enum: ['pipeline'], default: 'pipeline' },
  // Opaque filter blob — shape is owned by the frontend per scope. Backend
  // doesn't validate the keys, just stores them so the same view can apply
  // identical filter state across sessions/devices.
  filters: { type: mongoose.Schema.Types.Mixed, default: {} },
}, { timestamps: true });

savedViewSchema.index({ user: 1, scope: 1 });

export default mongoose.model('SavedView', savedViewSchema);
