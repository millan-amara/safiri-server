import { Resend } from 'resend';

let resend = null;

function getClient() {
  if (resend) return resend;
  if (!process.env.RESEND_API_KEY) {
    console.warn('RESEND_API_KEY not configured — emails will be logged to console');
    return null;
  }
  resend = new Resend(process.env.RESEND_API_KEY);
  return resend;
}

const APP_NAME = process.env.APP_NAME || 'SafiriPro';
const DEFAULT_FROM = process.env.EMAIL_FROM || `${APP_NAME} <noreply@azayon.com>`;

// HTML-escape any user-controlled value before interpolating into a template.
// Without this, an attacker who can set inviterName / userName / orgName (e.g.
// during registration) could inject anchor/script tags that hijack the
// recipient's email — phishing through a legitimate Resend send.
const escapeHtml = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
));

// URLs the server itself constructs (verify, reset, invite) are safe by
// origin, but still encode them so a stray quote in CLIENT_URL doesn't break
// the markup.
const escapeAttr = (s) => String(s ?? '').replace(/["']/g, (c) => ({ '"': '&quot;', "'": '&#39;' }[c]));

export async function sendEmail({ to, subject, html, from }) {
  const client = getClient();

  if (!client) {
    console.log('─── EMAIL (not sent, Resend not configured) ───');
    console.log(`To: ${to}`);
    console.log(`Subject: ${subject}`);
    console.log(`Body: ${html.substring(0, 200)}...`);
    console.log('────────────────────────────────────────────────');
    return;
  }

  const { error } = await client.emails.send({
    from: from || DEFAULT_FROM,
    to,
    subject,
    html,
  });

  if (error) {
    console.error('Resend error:', error);
    throw new Error(error.message || 'Failed to send email');
  }
}

// ─── EMAIL TEMPLATES ────────────────────────────
// Theme: indigo primary (#4F46E5) on slate (#171c2b) — matches SafiriPro app

const COLORS = {
  primary: '#4F46E5',
  primaryDark: '#4338CA',
  text: '#171c2b',
  muted: '#6B7280',
  subtle: '#9CA3AF',
  border: '#E5E7EB',
  bg: '#F9FAFB',
  card: '#FFFFFF',
};

const baseStyle = `
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
  max-width: 560px;
  margin: 0 auto;
  padding: 40px 24px;
  background-color: ${COLORS.card};
`;

const btnStyle = `
  display: inline-block;
  padding: 12px 32px;
  background-color: ${COLORS.primary};
  color: #ffffff;
  text-decoration: none;
  border-radius: 8px;
  font-weight: 600;
  font-size: 14px;
`;

function wrap(content, orgName) {
  const brand = escapeHtml(orgName || APP_NAME);
  return `
    <div style="background-color: ${COLORS.bg}; padding: 24px 0;">
      <div style="${baseStyle}">
        <div style="text-align: center; margin-bottom: 32px;">
          <h2 style="margin: 0; color: ${COLORS.text}; font-size: 22px; letter-spacing: -0.01em;">${brand}</h2>
        </div>
        ${content}
        <div style="margin-top: 40px; padding-top: 20px; border-top: 1px solid ${COLORS.border}; text-align: center;">
          <p style="color: ${COLORS.subtle}; font-size: 12px; margin: 0;">${brand}</p>
        </div>
      </div>
    </div>
  `;
}

export function inviteEmail({ inviterName, orgName, inviteUrl }) {
  const safeInviter = escapeHtml(inviterName);
  const safeOrg = escapeHtml(orgName);
  const safeUrl = escapeAttr(inviteUrl);
  const safeAppName = escapeHtml(APP_NAME);
  return wrap(`
    <h3 style="color: ${COLORS.text}; font-size: 18px; margin-bottom: 8px;">You've been invited!</h3>
    <p style="color: ${COLORS.muted}; font-size: 14px; line-height: 1.6;">
      ${safeInviter} has invited you to join <strong style="color: ${COLORS.text};">${safeOrg}</strong> on ${safeAppName}.
    </p>
    <p style="color: ${COLORS.muted}; font-size: 14px; line-height: 1.6;">
      Click the button below to set up your account. This link expires in 48 hours.
    </p>
    <div style="text-align: center; margin: 32px 0;">
      <a href="${safeUrl}" style="${btnStyle}">Set Up My Account</a>
    </div>
    <p style="color: ${COLORS.subtle}; font-size: 12px;">
      If the button doesn't work, copy this link:<br/>
      <a href="${safeUrl}" style="color: ${COLORS.primary}; word-break: break-all;">${escapeHtml(inviteUrl)}</a>
    </p>
  `, orgName);
}

export function resetPasswordEmail({ resetUrl, userName }) {
  const safeName = escapeHtml(userName);
  const safeUrl = escapeAttr(resetUrl);
  return wrap(`
    <h3 style="color: ${COLORS.text}; font-size: 18px; margin-bottom: 8px;">Reset your password</h3>
    <p style="color: ${COLORS.muted}; font-size: 14px; line-height: 1.6;">
      Hi${userName ? ' ' + safeName : ''}, we received a request to reset your password. Click below to choose a new one. This link expires in 1 hour.
    </p>
    <div style="text-align: center; margin: 32px 0;">
      <a href="${safeUrl}" style="${btnStyle}">Reset Password</a>
    </div>
    <p style="color: ${COLORS.subtle}; font-size: 12px;">
      If you didn't request this, you can safely ignore this email. Your password won't change.
    </p>
  `);
}

export function welcomeEmail({ userName, loginUrl, orgName }) {
  const safeName = escapeHtml(userName);
  const safeOrg = escapeHtml(orgName);
  const safeUrl = escapeAttr(loginUrl);
  const safeAppName = escapeHtml(APP_NAME);
  return wrap(`
    <h3 style="color: ${COLORS.text}; font-size: 18px; margin-bottom: 8px;">Welcome to ${safeOrg}!</h3>
    <p style="color: ${COLORS.muted}; font-size: 14px; line-height: 1.6;">
      Hi ${safeName}, your account is all set up. You can now log in and start working.
    </p>
    <div style="text-align: center; margin: 32px 0;">
      <a href="${safeUrl}" style="${btnStyle}">Go to ${safeAppName}</a>
    </div>
  `, orgName);
}

export function verifyEmailTemplate({ userName, verifyUrl }) {
  const safeName = escapeHtml(userName);
  const safeUrl = escapeAttr(verifyUrl);
  const safeAppName = escapeHtml(APP_NAME);
  return wrap(`
    <h3 style="color: ${COLORS.text}; font-size: 18px; margin-bottom: 8px;">Verify your email</h3>
    <p style="color: ${COLORS.muted}; font-size: 14px; line-height: 1.6;">
      Hi ${safeName}, please verify your email address to ensure you receive important notifications like quote views and client responses.
    </p>
    <div style="text-align: center; margin: 32px 0;">
      <a href="${safeUrl}" style="${btnStyle}">Verify Email</a>
    </div>
    <p style="color: ${COLORS.subtle}; font-size: 12px;">
      You can use ${safeAppName} without verifying, but you may miss email notifications.
    </p>
  `);
}
