import jwt from 'jsonwebtoken';
import User from '../models/User.js';
import Organization from '../models/Organization.js';

// Protect routes - require auth
export const protect = async (req, res, next) => {
  try {
    let token;
    if (req.headers.authorization?.startsWith('Bearer')) {
      token = req.headers.authorization.split(' ')[1];
    }
    // Also accept token as query param (for PDF links opened in new tabs)
    if (!token && req.query.token) {
      token = req.query.token;
    }

    if (!token) {
      return res.status(401).json({ message: 'Not authorized' });
    }

    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const user = await User.findById(decoded.id).select('-password');

    if (!user || !user.isActive) {
      return res.status(401).json({ message: 'Not authorized' });
    }

    req.user = user;
    req.organizationId = user.organization;

    // Load and cache the org on every authenticated request.
    // Subscription middleware reads req.organization directly — no extra DB round-trip.
    const org = await Organization.findById(user.organization)
      .select('subscriptionStatus plan trialStartedAt trialEndsAt trialQuoteCount trialQuoteLimit aiItineraryGenerationsUsed aiItineraryGenerationsLimit aiCreditsResetAt currentPeriodEnd whiteLabel paystackSubscriptionCode')
      .lean();
    req.organization = org;

    // ── Global paywall enforcement ─────────────────────────────────────────
    // Read-only mode triggers when:
    //   - status is 'expired' (trial ended, no payment), OR
    //   - status is 'cancelled' AND the paid period has already elapsed
    // Cancelled orgs with a future currentPeriodEnd retain full write access
    // until that date — they only see a "cancellation pending" banner.
    // past_due orgs retain full access — they only see a warning banner.
    if (org && !['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
      const now = new Date();
      const isBlocked =
        org.subscriptionStatus === 'expired' ||
        (org.subscriptionStatus === 'cancelled' &&
          (!org.currentPeriodEnd || new Date(org.currentPeriodEnd) < now));

      if (isBlocked) {
        return res.status(402).json({
          message: 'Your subscription has ended. Reactivate your account to continue creating content.',
          status: org.subscriptionStatus,
          trialEndsAt: org.trialEndsAt,
          code: 'SUBSCRIPTION_INACTIVE',
        });
      }
    }

    next();
  } catch (error) {
    res.status(401).json({ message: 'Not authorized' });
  }
};

// Role-based access
export const authorize = (...roles) => {
  return (req, res, next) => {
    if (!roles.includes(req.user.role)) {
      return res.status(403).json({ message: 'Not authorized for this action' });
    }
    next();
  };
};

// Generate JWT
export const generateToken = (userId) => {
  return jwt.sign({ id: userId }, process.env.JWT_SECRET, {
    expiresIn: process.env.JWT_EXPIRE || '30d',
  });
};