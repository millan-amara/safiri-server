import mongoose from 'mongoose';
import bcrypt from 'bcryptjs';

const userSchema = new mongoose.Schema({
  name: { type: String, trim: true, default: '' },
  email: { type: String, required: true, lowercase: true, trim: true },
  password: { type: String, select: false },  // Hidden by default
  avatar: { type: String, default: '' },
  phone: { type: String, trim: true, default: '' },

  // Quote signature block — shown on closing page of quotes authored by this user
  jobTitle: { type: String, trim: true, default: '' },
  signature: { type: String, default: '' },      // URL to handwritten signature image
  signatureNote: { type: String, default: '' },  // Short personal note shown above signature
  
  // Auth
  googleId: { type: String, sparse: true },
  authProvider: { type: String, enum: ['local', 'google'], default: 'local' },
  
  // Invite flow
  inviteToken: { type: String, sparse: true },
  inviteTokenExpires: Date,
  status: { type: String, enum: ['active', 'pending', 'disabled'], default: 'active' },
  
  // Email verification
  emailVerified: { type: Boolean, default: false },
  verifyToken: { type: String, sparse: true },
  
  // Password reset
  resetToken: { type: String, sparse: true },
  resetTokenExpires: Date,
  
  // Multi-tenancy
  organization: { type: mongoose.Schema.Types.ObjectId, ref: 'Organization', required: true },
  role: { type: String, enum: ['owner', 'admin', 'agent', 'viewer'], default: 'agent' },
  
  isActive: { type: Boolean, default: true },
  lastLogin: { type: Date },
  invitedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },

  // Bumped on logout / password reset so existing JWTs stop working — gives
  // server-side revocation despite stateless tokens. The middleware verifies
  // the token's `tv` claim equals the current user.tokenVersion.
  tokenVersion: { type: Number, default: 0 },

  // First-login checklist state (per-user).
  // `onboardingDismissed` hides the whole checklist; "Getting started" sidebar link reopens it.
  // `onboardingItemsDismissed` is an array of item ids the user has explicitly skipped
  // (e.g. 'first_hotel' when SafiriPro is uploading their hotels manually).
  onboardingDismissed: { type: Boolean, default: false },
  onboardingItemsDismissed: [{ type: String }],

  // Auto-restore the operator's last-used pipeline view on next CRM page load.
  // null when they explicitly cleared (chose "All deals") last.
  lastPipelineViewId: { type: mongoose.Schema.Types.ObjectId, ref: 'SavedView', default: null },
}, { timestamps: true });

// Compound unique: same email can exist in different orgs
userSchema.index({ email: 1, organization: 1 }, { unique: true });

userSchema.pre('save', async function() {
  if (!this.isModified('password') || !this.password) return;
  this.password = await bcrypt.hash(this.password, 12);
});

userSchema.methods.comparePassword = async function(candidatePassword) {
  return bcrypt.compare(candidatePassword, this.password);
};

export default mongoose.model('User', userSchema);