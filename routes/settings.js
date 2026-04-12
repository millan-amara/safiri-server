import { Router } from 'express';
import Organization from '../models/Organization.js';
import User from '../models/User.js';
import { protect, authorize } from '../middleware/auth.js';

import { sendEmail, inviteEmail } from '../utils/email.js';
import crypto from 'crypto';

const router = Router();

// ─── PROFILE ─────────────────────────────────────

router.put('/profile', protect, async (req, res) => {
  try {
    const { name, phone, jobTitle, signature, signatureNote, avatar } = req.body;
    const patch = {};
    if (name) patch.name = name;
    if (phone !== undefined) patch.phone = phone;
    if (jobTitle !== undefined) patch.jobTitle = jobTitle;
    if (signature !== undefined) patch.signature = signature;
    if (signatureNote !== undefined) patch.signatureNote = signatureNote;
    if (avatar !== undefined) patch.avatar = avatar;
    const updated = await User.findByIdAndUpdate(req.user._id, patch, { new: true }).select('-password');
    res.json(updated);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// ─── ORGANIZATION ────────────────────────────────

router.get('/organization', protect, async (req, res) => {
  try {
    const org = await Organization.findById(req.organizationId);
    res.json(org);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

router.put('/organization', protect, authorize('owner', 'admin'), async (req, res) => {
  try {
    const org = await Organization.findByIdAndUpdate(req.organizationId, req.body, { new: true });
    res.json(org);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Regenerate API key
router.post('/regenerate-api-key', protect, authorize('owner'), async (req, res) => {
  try {
    const crypto = await import('crypto');
    const apiKey = 'sk_' + crypto.randomBytes(24).toString('hex');
    const org = await Organization.findByIdAndUpdate(req.organizationId, { apiKey }, { new: true });
    res.json({ apiKey: org.apiKey });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// ─── TEAM ────────────────────────────────────────

router.get('/team', protect, async (req, res) => {
  try {
    const members = await User.find({ organization: req.organizationId }).select('-password');
    res.json({ members });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

router.post('/team/invite', protect, authorize('owner', 'admin'), async (req, res) => {
  try {
    const { email, role = 'agent' } = req.body;
    if (!email) return res.status(400).json({ message: 'Email is required' });

    // Pro and Trial plans are capped at 6 team members. Business and Enterprise are unlimited.
    const org = req.organization; // cached by protect
    if (org && (org.plan === 'pro' || org.plan === 'trial')) {
      const memberCount = await User.countDocuments({ organization: req.organizationId });
      if (memberCount >= 6) {
        return res.status(403).json({
          message: 'Your plan supports up to 6 team members. Upgrade to Business for unlimited members.',
          memberLimit: 6,
          memberCount,
          code: 'TEAM_MEMBER_LIMIT',
        });
      }
    }

    // Check if already exists in this org
    const existing = await User.findOne({ email, organization: req.organizationId });
    if (existing) return res.status(400).json({ message: 'User already exists in this organization' });

    // Generate invite token
    const inviteToken = crypto.randomBytes(32).toString('hex');
    const inviteTokenExpires = new Date(Date.now() + 48 * 60 * 60 * 1000); // 48 hours

    const user = await User.create({
      name: '',
      email,
      organization: req.organizationId,
      role,
      status: 'pending',
      inviteToken,
      inviteTokenExpires,
      invitedBy: req.user._id,
    });

    // Send invite email (need full org doc for name field)
    const orgDoc = await Organization.findById(req.organizationId);
    const inviteUrl = `${process.env.CLIENT_URL}/accept-invite?token=${inviteToken}`;

    await sendEmail({
      to: email,
      subject: `You're invited to join ${orgDoc.name} on Safari CRM`,
      html: inviteEmail({
        inviterName: req.user.name,
        orgName: orgDoc.name,
        inviteUrl,
      }),
    });

    res.status(201).json({
      user: { ...user.toObject(), inviteToken: undefined },
      message: 'Invite sent',
    });
  } catch (error) {
    if (error.code === 11000) {
      return res.status(400).json({ message: 'User already exists in this organization' });
    }
    console.error('Invite error:', error.message);
    res.status(500).json({ message: error.message });
  }
});

router.put('/team/:id', protect, authorize('owner', 'admin'), async (req, res) => {
  try {
    const { role, isActive } = req.body;
    const update = {};
    if (role) update.role = role;
    if (typeof isActive === 'boolean') update.isActive = isActive;

    const user = await User.findOneAndUpdate(
      { _id: req.params.id, organization: req.organizationId },
      update,
      { new: true }
    ).select('-password');

    if (!user) return res.status(404).json({ message: 'User not found' });
    res.json(user);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

router.delete('/team/:id', protect, authorize('owner'), async (req, res) => {
  try {
    if (req.params.id === req.user._id.toString()) {
      return res.status(400).json({ message: 'Cannot delete yourself' });
    }
    await User.findOneAndDelete({ _id: req.params.id, organization: req.organizationId });
    res.json({ message: 'Removed' });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// ─── API KEY ────────────────────────────────────

// Generate or regenerate API key
router.post('/api-key/regenerate', protect, authorize('owner', 'admin'), async (req, res) => {
  try {
    const crypto = (await import('crypto')).default;
    const apiKey = 'sk_' + crypto.randomBytes(24).toString('hex');
    const org = await Organization.findByIdAndUpdate(req.organizationId, { apiKey }, { new: true });
    res.json({ apiKey: org.apiKey });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

export default router;