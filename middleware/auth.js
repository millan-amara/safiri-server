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

    if (!token) {
      return res.status(401).json({ message: 'Not authorized' });
    }

    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    // Reject single-use OAuth-exchange codes here — they're meant to be redeemed
    // by the /auth/oauth-exchange endpoint, not used as session tokens.
    if (decoded.purpose && decoded.purpose !== 'session') {
      return res.status(401).json({ message: 'Not authorized' });
    }
    const user = await User.findById(decoded.id).select('-password');

    if (!user || !user.isActive) {
      return res.status(401).json({ message: 'Not authorized' });
    }

    // Token revocation: tokens issued before the user's tokenVersion was bumped
    // (logout, password reset) are rejected even though they're still inside
    // their JWT expiry window.
    if ((decoded.tv ?? 0) !== (user.tokenVersion ?? 0)) {
      return res.status(401).json({ message: 'Session expired' });
    }

    req.user = user;
    req.organizationId = user.organization;

    // Load and cache the org on every authenticated request.
    // Subscription middleware reads req.organization directly — no extra DB round-trip.
    const org = await Organization.findById(user.organization)
      .select('subscriptionStatus plan annual trialStartedAt trialEndsAt trialQuoteCount trialQuoteLimit aiCreditsUsed aiCreditsLimit aiCreditsResetAt quotesThisMonth quotesMonthResetAt libraryImageCount currentPeriodEnd whiteLabel paystackSubscriptionCode preferences')
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

// Superadmin check — email whitelist from env (comma-separated SUPERADMIN_EMAILS).
export const isSuperAdminEmail = (email) => {
  if (!email) return false;
  const list = (process.env.SUPERADMIN_EMAILS || '')
    .split(',')
    .map(e => e.trim().toLowerCase())
    .filter(Boolean);
  return list.includes(email.toLowerCase());
};

// Apply AFTER `protect` so req.user is populated.
export const requireSuperAdmin = (req, res, next) => {
  if (!isSuperAdminEmail(req.user?.email)) {
    return res.status(403).json({ message: 'Superadmin access required' });
  }
  next();
};

// Generate JWT. `purpose: 'session'` distinguishes long-lived session tokens
// from short-lived single-use codes (e.g. OAuth exchange) signed with the
// same secret — the middleware rejects anything that isn't 'session'.
// `tv` carries the user's tokenVersion at issue time; the middleware refuses
// the token if the user has since bumped tokenVersion (logout/reset).
export const generateToken = (userId, tokenVersion = 0) => {
  return jwt.sign(
    { id: userId, purpose: 'session', tv: tokenVersion },
    process.env.JWT_SECRET,
    { expiresIn: process.env.JWT_EXPIRE || '7d' },
  );
};