import { Router } from 'express';
import crypto from 'crypto';
import User from '../models/User.js';
import Organization from '../models/Organization.js';
import { Pipeline } from '../models/Deal.js';
import { protect, generateToken, isSuperAdminEmail } from '../middleware/auth.js';
import { sendEmail, resetPasswordEmail, welcomeEmail, verifyEmailTemplate } from '../utils/email.js';
import slugify from 'slugify';
import { PLANS, nextMonthlyResetDate } from '../config/plans.js';

const router = Router();

// Seed the starter pipelines for a brand-new org.
// Two pipelines so cross-team workflow (marketing → sales) is visible from day one.
async function seedStarterPipelines(organizationId) {
  await Pipeline.create([
    {
      organization: organizationId,
      name: 'Sales Pipeline',
      isDefault: true,
      stages: [
        { name: 'New Inquiry', order: 0, color: '#6B7280', type: 'open' },
        { name: 'Qualified', order: 1, color: '#3B82F6', type: 'open' },
        { name: 'Proposal Sent', order: 2, color: '#F59E0B', type: 'open' },
        { name: 'Negotiation', order: 3, color: '#8B5CF6', type: 'open' },
        { name: 'Won', order: 4, color: '#10B981', type: 'won' },
        { name: 'Lost', order: 5, color: '#EF4444', type: 'lost' },
      ],
    },
    {
      organization: organizationId,
      name: 'Marketing Pipeline',
      isDefault: false,
      stages: [
        { name: 'New Lead', order: 0, color: '#6B7280', type: 'open' },
        { name: 'Nurturing', order: 1, color: '#3B82F6', type: 'open' },
        { name: 'Qualified', order: 2, color: '#F59E0B', type: 'open' },
        { name: 'Handed to Sales', order: 3, color: '#10B981', type: 'won' },
        { name: 'Disqualified', order: 4, color: '#EF4444', type: 'lost' },
      ],
    },
  ]);
}

// Register new org + owner
router.post('/register', async (req, res) => {
  try {
    const { name, email, password, companyName, phone } = req.body;
    if (!phone) return res.status(400).json({ message: 'Phone number is required' });

    // Create org
    const slug = slugify(companyName || name, { lower: true, strict: true }) + '-' + Date.now().toString(36);
    const apiKey = 'sk_' + crypto.randomBytes(24).toString('hex');
    const trialStartedAt = new Date();
    const trialEndsAt = new Date(trialStartedAt.getTime() + 14 * 24 * 60 * 60 * 1000);
    const trialPlan = PLANS.trial;
    const aiCreditsResetAt = nextMonthlyResetDate();
    const org = await Organization.create({
      name: companyName || `${name}'s Organization`,
      slug,
      apiKey,
      owner: '000000000000000000000000', // placeholder
      trialStartedAt,
      trialEndsAt,
      aiCreditsLimit: trialPlan.aiCredits,
      aiCreditsResetAt,
      quotesMonthResetAt: aiCreditsResetAt,
      trialQuoteLimit: trialPlan.quotesPerMonth,
      defaults: {
        inclusions: [
          'All accommodations as specified',
          'Meals as specified in day-by-day',
          'All park/conservancy fees',
          'Professional English-speaking guide',
          'All transportation as specified',
          'Drinking water during game drives',
        ],
        exclusions: [
          'International flights',
          'Visa fees',
          'Travel insurance',
          'Tips and gratuities',
          'Personal expenses',
          'Optional activities unless specified',
        ],
      },
    });

    // Create user
    const user = await User.create({
      name,
      email,
      password,
      phone,
      organization: org._id,
      role: 'owner',
    });

    // Update org owner
    org.owner = user._id;
    await org.save();

    // Seed starter pipelines (Sales + Marketing) so the multi-pipeline value is visible day one.
    await seedStarterPipelines(org._id);

    // Send verification email
    const verifyToken = crypto.randomBytes(32).toString('hex');
    user.verifyToken = verifyToken;
    await user.save();

    const verifyUrl = `${process.env.CLIENT_URL}/verify-email?token=${verifyToken}`;
    sendEmail({
      to: user.email,
      subject: 'Verify your email — Safari CRM',
      html: verifyEmailTemplate({ userName: name, verifyUrl }),
    }).catch(err => console.error('Verify email send failed:', err.message));

    const token = generateToken(user._id);
    res.status(201).json({ token, user: { ...user.toObject(), password: undefined }, organization: org });
  } catch (error) {
    if (error.code === 11000) {
      return res.status(400).json({ message: 'Email already registered' });
    }
    res.status(500).json({ message: error.message });
  }
});

// Login
router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    const user = await User.findOne({ email, authProvider: 'local' }).select('+password');
    
    if (!user || !(await user.comparePassword(password))) {
      return res.status(401).json({ message: 'Invalid email or password' });
    }

    if (!user.isActive) {
      return res.status(401).json({ message: 'Account is disabled' });
    }

    user.lastLogin = new Date();
    await user.save();

    const org = await Organization.findById(user.organization);
    const token = generateToken(user._id);
    
    res.json({ token, user: { ...user.toObject(), password: undefined, isSuperAdmin: isSuperAdminEmail(user.email) }, organization: org });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Get current user
router.get('/me', protect, async (req, res) => {
  try {
    const org = await Organization.findById(req.user.organization);
    // Auto-generate API key if missing
    if (org && !org.apiKey) {
      org.apiKey = 'sk_' + crypto.randomBytes(24).toString('hex');
      await org.save();
    }
    const userObj = req.user.toObject ? req.user.toObject() : req.user;
    userObj.isSuperAdmin = isSuperAdminEmail(userObj.email);
    res.json({ user: userObj, organization: org });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// ─── EMAIL VERIFICATION ─────────────────────────

// Verify email via token
router.get('/verify-email/:token', async (req, res) => {
  try {
    const user = await User.findOne({ verifyToken: req.params.token });
    if (!user) return res.status(400).json({ message: 'Invalid verification link' });

    user.emailVerified = true;
    user.verifyToken = undefined;
    await user.save();

    res.json({ message: 'Email verified successfully' });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Resend verification email
router.post('/resend-verification', protect, async (req, res) => {
  try {
    if (req.user.emailVerified) return res.json({ message: 'Already verified' });

    const verifyToken = crypto.randomBytes(32).toString('hex');
    await User.findByIdAndUpdate(req.user._id, { verifyToken });

    const verifyUrl = `${process.env.CLIENT_URL}/verify-email?token=${verifyToken}`;
    await sendEmail({
      to: req.user.email,
      subject: 'Verify your email — Safari CRM',
      html: verifyEmailTemplate({ userName: req.user.name, verifyUrl }),
    });

    res.json({ message: 'Verification email sent' });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// ─── ACCEPT INVITE ──────────────────────────────

// Validate invite token
router.get('/invite/:token', async (req, res) => {
  try {
    const user = await User.findOne({
      inviteToken: req.params.token,
      inviteTokenExpires: { $gt: new Date() },
      status: 'pending',
    });
    if (!user) return res.status(400).json({ message: 'Invalid or expired invite link' });

    const org = await Organization.findById(user.organization);
    res.json({ email: user.email, orgName: org?.name || '' });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Complete invite — set name + password
router.post('/invite/:token', async (req, res) => {
  try {
    const { name, password, phone } = req.body;
    if (!name || !password) return res.status(400).json({ message: 'Name and password are required' });
    if (!phone) return res.status(400).json({ message: 'Phone number is required' });
    if (password.length < 6) return res.status(400).json({ message: 'Password must be at least 6 characters' });

    const user = await User.findOne({
      inviteToken: req.params.token,
      inviteTokenExpires: { $gt: new Date() },
      status: 'pending',
    });
    if (!user) return res.status(400).json({ message: 'Invalid or expired invite link' });

    user.name = name;
    user.password = password;
    user.phone = phone;
    user.status = 'active';
    user.emailVerified = true;
    user.inviteToken = undefined;
    user.inviteTokenExpires = undefined;
    user.lastLogin = new Date();
    await user.save();

    // Send welcome email
    const org = await Organization.findById(user.organization);
    await sendEmail({
      to: user.email,
      subject: `Welcome to ${org?.name || 'Safari CRM'}!`,
      html: welcomeEmail({
        userName: name,
        loginUrl: `${process.env.CLIENT_URL}/login`,
        orgName: org?.name || 'Safari CRM',
      }),
    });

    const token = generateToken(user._id);
    res.json({ token, user: { _id: user._id, name: user.name, email: user.email, role: user.role } });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// ─── FORGOT PASSWORD ────────────────────────────

router.post('/forgot-password', async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ message: 'Email is required' });

    // Find user(s) with this email — could be in multiple orgs
    const user = await User.findOne({ email: email.toLowerCase(), status: 'active' });
    
    // Always return success to prevent email enumeration
    if (!user) return res.json({ message: 'If that email exists, a reset link has been sent.' });

    const resetToken = crypto.randomBytes(32).toString('hex');
    user.resetToken = resetToken;
    user.resetTokenExpires = new Date(Date.now() + 60 * 60 * 1000); // 1 hour
    await user.save();

    const resetUrl = `${process.env.CLIENT_URL}/reset-password?token=${resetToken}`;
    await sendEmail({
      to: user.email,
      subject: 'Reset your password — Safari CRM',
      html: resetPasswordEmail({ resetUrl, userName: user.name }),
    });

    res.json({ message: 'If that email exists, a reset link has been sent.' });
  } catch (error) {
    console.error('Forgot password error:', error.message);
    res.status(500).json({ message: error.message });
  }
});

// Validate reset token
router.get('/reset-password/:token', async (req, res) => {
  try {
    const user = await User.findOne({
      resetToken: req.params.token,
      resetTokenExpires: { $gt: new Date() },
    });
    if (!user) return res.status(400).json({ message: 'Invalid or expired reset link' });
    res.json({ email: user.email });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Set new password
router.post('/reset-password/:token', async (req, res) => {
  try {
    const { password } = req.body;
    if (!password || password.length < 6) return res.status(400).json({ message: 'Password must be at least 6 characters' });

    const user = await User.findOne({
      resetToken: req.params.token,
      resetTokenExpires: { $gt: new Date() },
    });
    if (!user) return res.status(400).json({ message: 'Invalid or expired reset link' });

    user.password = password;
    user.resetToken = undefined;
    user.resetTokenExpires = undefined;
    await user.save();

    const token = generateToken(user._id);
    res.json({ token, message: 'Password reset successfully' });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// ─── GOOGLE OAUTH ────────────────────────────────

// Step 1: Redirect to Google
router.get('/google', (req, res) => {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  if (!clientId) return res.status(500).json({ message: 'Google OAuth not configured' });

  const redirectUri = process.env.GOOGLE_CALLBACK_URL;
  const scope = encodeURIComponent('openid email profile');
  const url = `https://accounts.google.com/o/oauth2/v2/auth?client_id=${clientId}&redirect_uri=${encodeURIComponent(redirectUri)}&response_type=code&scope=${scope}&access_type=offline&prompt=consent`;

  res.redirect(url);
});

// Step 2: Handle callback
router.get('/google/callback', async (req, res) => {
  try {
    const { code } = req.query;
    if (!code) return res.redirect(`${process.env.CLIENT_URL}/login?error=no_code`);

    // Exchange code for tokens
    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        code,
        client_id: process.env.GOOGLE_CLIENT_ID,
        client_secret: process.env.GOOGLE_CLIENT_SECRET,
        redirect_uri: process.env.GOOGLE_CALLBACK_URL,
        grant_type: 'authorization_code',
      }),
    });
    const tokens = await tokenRes.json();
    if (!tokens.access_token) return res.redirect(`${process.env.CLIENT_URL}/login?error=token_failed`);

    // Get user info
    const userInfoRes = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
      headers: { Authorization: `Bearer ${tokens.access_token}` },
    });
    const googleUser = await userInfoRes.json();

    // Find or create user
    let user = await User.findOne({ googleId: googleUser.id });

    if (!user) {
      // Check if email exists (link accounts)
      user = await User.findOne({ email: googleUser.email });

      if (user) {
        // Link Google to existing account
        user.googleId = googleUser.id;
        user.authProvider = 'google';
        if (!user.avatar && googleUser.picture) user.avatar = googleUser.picture;
        await user.save();
      } else {
        // Create new org + user
        const slug = slugify(googleUser.name || 'workspace', { lower: true, strict: true }) + '-' + Date.now().toString(36);
        const gTrialStartedAt = new Date();
        const gTrialEndsAt = new Date(gTrialStartedAt.getTime() + 14 * 24 * 60 * 60 * 1000);
        const gAiCreditsResetAt = nextMonthlyResetDate();
        const gTrialPlan = PLANS.trial;
        const org = await Organization.create({
          name: `${googleUser.name}'s Workspace`,
          slug,
          apiKey: 'sk_' + crypto.randomBytes(24).toString('hex'),
          owner: '000000000000000000000000',
          trialStartedAt: gTrialStartedAt,
          trialEndsAt: gTrialEndsAt,
          aiCreditsLimit: gTrialPlan.aiCredits,
          aiCreditsResetAt: gAiCreditsResetAt,
          quotesMonthResetAt: gAiCreditsResetAt,
          trialQuoteLimit: gTrialPlan.quotesPerMonth,
          defaults: {
            currency: 'USD',
            marginPercent: 20,
            inclusions: ['All accommodations', 'Meals as specified', 'Park fees', 'Professional guide', 'All transportation', 'Drinking water'],
            exclusions: ['International flights', 'Visa fees', 'Travel insurance', 'Tips', 'Personal expenses'],
          },
        });

        user = await User.create({
          name: googleUser.name || googleUser.email,
          email: googleUser.email,
          googleId: googleUser.id,
          authProvider: 'google',
          avatar: googleUser.picture || '',
          organization: org._id,
          role: 'owner',
        });

        org.owner = user._id;
        await org.save();

        await seedStarterPipelines(org._id);
      }
    }

    user.lastLogin = new Date();
    await user.save();

    const token = generateToken(user._id);

    // Redirect to client with token
    res.redirect(`${process.env.CLIENT_URL}/login?token=${token}`);
  } catch (error) {
    console.error('Google OAuth error:', error);
    res.redirect(`${process.env.CLIENT_URL}/login?error=oauth_failed`);
  }
});

export default router;