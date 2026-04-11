import mongoose from 'mongoose';
import bcrypt from 'bcryptjs';

const userSchema = new mongoose.Schema({
  name: { type: String, trim: true, default: '' },
  email: { type: String, required: true, lowercase: true, trim: true },
  password: { type: String, select: false },  // Hidden by default
  avatar: { type: String, default: '' },
  
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