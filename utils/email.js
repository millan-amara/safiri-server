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

// Pull the bare address out of DEFAULT_FROM so we can rebuild From with a
// custom display name (operator + org) without losing the configured sender
// address. Accepts either "Name <addr>" or just "addr".
const FROM_ADDRESS = (DEFAULT_FROM.match(/<([^>]+)>/)?.[1] || DEFAULT_FROM).trim();

// Quote-escape a display name per RFC 5322 quoted-string rules. Names with
// commas, parens, or em dashes are common (operator org names like
// "Smith, Jones & Co.") and would otherwise break the From parser.
const escapeDisplayName = (s) => String(s).replace(/[\\"]/g, '\\$&');

// Build a "${operator} at ${org}" display name, falling back gracefully when
// either is missing. Returns null when both are empty so the caller can let
// sendEmail fall back to DEFAULT_FROM. Used by routes that send on behalf of
// a specific operator (voucher email, templated email) — NOT by system
// transactional mail (verify/invite/reset), which keeps the SafiriPro brand.
export function operatorSenderName({ user, org }) {
  const u = (user?.name || '').trim();
  const o = (org?.name || '').trim();
  if (u && o) return `${u} at ${o}`;
  return u || o || null;
}

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

// `attachments` follows Resend's shape: [{ filename, content: Buffer, contentType? }].
// `replyTo` is a single address string — when set, replies route there instead
// of to DEFAULT_FROM (which is a noreply mailbox).
// `senderName` (optional) overrides the From display name while keeping the
// configured FROM_ADDRESS — used to send "Sara at Kenya Safari Co." from the
// shared azayon.com mailbox so the recipient sees the operator's brand, not
// the SaaS brand. Ignored when `from` is explicitly passed.
export async function sendEmail({ to, subject, html, from, attachments, replyTo, senderName }) {
  const client = getClient();

  // Compose the From header. Explicit `from` wins; otherwise senderName builds
  // "Name <addr>"; otherwise DEFAULT_FROM.
  const fromHeader = from
    || (senderName ? `"${escapeDisplayName(senderName)}" <${FROM_ADDRESS}>` : DEFAULT_FROM);

  if (!client) {
    console.log('─── EMAIL (not sent, Resend not configured) ───');
    console.log(`From: ${fromHeader}`);
    console.log(`To: ${to}`);
    console.log(`Subject: ${subject}`);
    console.log(`Body: ${html.substring(0, 200)}...`);
    if (attachments?.length) console.log(`Attachments: ${attachments.map(a => a.filename).join(', ')}`);
    console.log('────────────────────────────────────────────────');
    return;
  }

  const payload = {
    from: fromHeader,
    to,
    subject,
    html,
  };
  if (replyTo) payload.replyTo = replyTo;
  if (attachments?.length) {
    payload.attachments = attachments.map(a => ({
      filename: a.filename,
      content: Buffer.isBuffer(a.content) ? a.content.toString('base64') : a.content,
      contentType: a.contentType,
    }));
  }

  const { error } = await client.emails.send(payload);

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

export function invoiceEmail({ clientName, invoiceNumber, total, currency, dueDate, paymentInstructions, orgName, message, type, amountPaid, amountDue }) {
  const safeName = escapeHtml(clientName || 'there');
  const safeNum = escapeHtml(invoiceNumber);
  const cur = escapeHtml(currency || 'USD');
  const fmt = (n) => `${cur} ${Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  const dateStr = (d) => d ? new Date(d).toLocaleDateString('en-US', { weekday: 'short', year: 'numeric', month: 'short', day: 'numeric' }) : '';
  const typeLabel = type === 'deposit' ? 'deposit invoice'
    : type === 'balance' ? 'balance invoice'
    : 'invoice';
  const safeMessage = message ? escapeHtml(message).replace(/\n/g, '<br/>') : '';
  const safePay = paymentInstructions ? escapeHtml(paymentInstructions).replace(/\n/g, '<br/>') : '';

  // Detect partial-payment state. amountPaid > 0 means payments have been
  // recorded — the email shifts from "here's your invoice" to "here's the
  // outstanding balance" so the client doesn't pay the full amount twice.
  const totalNum = Number(total || 0);
  const paidNum = Number(amountPaid || 0);
  const dueNum = amountDue != null ? Number(amountDue) : Math.max(0, totalNum - paidNum);
  const hasPayments = paidNum > 0.005;
  const fullyPaid = hasPayments && dueNum <= 0.005;

  const heading = fullyPaid
    ? `Receipt for ${typeLabel} ${safeNum}`
    : hasPayments
      ? `Balance reminder for ${typeLabel} ${safeNum}`
      : `Your ${typeLabel} is attached`;
  const intro = fullyPaid
    ? `Hi ${safeName}, thank you for your payment. ${escapeHtml(typeLabel.charAt(0).toUpperCase() + typeLabel.slice(1))} <strong style="color: ${COLORS.text};">${safeNum}</strong> has been paid in full. The PDF is attached for your records.`
    : hasPayments
      ? `Hi ${safeName}, this is a reminder for the outstanding balance on ${escapeHtml(typeLabel)} <strong style="color: ${COLORS.text};">${safeNum}</strong>. The full PDF is attached.`
      : `Hi ${safeName}, please find attached ${escapeHtml(typeLabel)} <strong style="color: ${COLORS.text};">${safeNum}</strong>.`;

  // Amount block: show outstanding balance prominently when partial; for
  // fully-paid receipts, swap the framing to "Paid in full".
  const amountBlock = fullyPaid ? `
      <p style="margin: 0; color: ${COLORS.text}; font-size: 14px;"><strong>Paid in full:</strong> ${fmt(totalNum)}</p>
    ` : hasPayments ? `
      <p style="margin: 0; color: ${COLORS.text}; font-size: 14px;"><strong>Outstanding balance:</strong> ${fmt(dueNum)}</p>
      <p style="margin: 6px 0 0; color: ${COLORS.muted}; font-size: 13px;">Total ${fmt(totalNum)} · already paid ${fmt(paidNum)}</p>
      ${dueDate ? `<p style="margin: 6px 0 0; color: ${COLORS.text}; font-size: 14px;"><strong>Due:</strong> ${escapeHtml(dateStr(dueDate))}</p>` : ''}
    ` : `
      <p style="margin: 0; color: ${COLORS.text}; font-size: 14px;"><strong>Amount due:</strong> ${fmt(totalNum)}</p>
      ${dueDate ? `<p style="margin: 6px 0 0; color: ${COLORS.text}; font-size: 14px;"><strong>Due:</strong> ${escapeHtml(dateStr(dueDate))}</p>` : ''}
    `;

  return wrap(`
    <h3 style="color: ${COLORS.text}; font-size: 18px; margin-bottom: 8px;">${heading}</h3>
    <p style="color: ${COLORS.muted}; font-size: 14px; line-height: 1.6;">${intro}</p>
    <div style="margin: 24px 0; padding: 16px; background: ${COLORS.bg}; border-radius: 8px;">${amountBlock}</div>
    ${safeMessage ? `<p style="color: ${COLORS.muted}; font-size: 14px; line-height: 1.6;">${safeMessage}</p>` : ''}
    ${safePay && !fullyPaid ? `
      <div style="margin: 16px 0; padding: 12px; border-left: 3px solid ${COLORS.primary}; background: ${COLORS.bg};">
        <p style="margin: 0 0 6px; color: ${COLORS.subtle}; font-size: 11px; text-transform: uppercase; letter-spacing: 0.05em;">Payment instructions</p>
        <p style="margin: 0; color: ${COLORS.text}; font-size: 13px; line-height: 1.5;">${safePay}</p>
      </div>
    ` : ''}
    <p style="color: ${COLORS.subtle}; font-size: 12px;">
      Reply to this email if you have any questions about this ${escapeHtml(typeLabel)}.
    </p>
  `, orgName);
}

export function voucherEmail({ guestName, hotelName, checkIn, checkOut, voucherNumber, orgName, message }) {
  const safeGuest = escapeHtml(guestName || 'there');
  const safeHotel = escapeHtml(hotelName || 'your accommodation');
  const safeNum = escapeHtml(voucherNumber);
  const dateStr = (d) => d ? new Date(d).toLocaleDateString('en-US', { weekday: 'short', year: 'numeric', month: 'short', day: 'numeric' }) : '';
  const safeMessage = message ? escapeHtml(message).replace(/\n/g, '<br/>') : '';
  return wrap(`
    <h3 style="color: ${COLORS.text}; font-size: 18px; margin-bottom: 8px;">Your hotel voucher is ready</h3>
    <p style="color: ${COLORS.muted}; font-size: 14px; line-height: 1.6;">
      Hi ${safeGuest}, please find attached your voucher (${safeNum}) for <strong style="color: ${COLORS.text};">${safeHotel}</strong>.
    </p>
    <div style="margin: 24px 0; padding: 16px; background: ${COLORS.bg}; border-radius: 8px;">
      <p style="margin: 0; color: ${COLORS.text}; font-size: 14px;"><strong>Check-in:</strong> ${escapeHtml(dateStr(checkIn))}</p>
      <p style="margin: 6px 0 0; color: ${COLORS.text}; font-size: 14px;"><strong>Check-out:</strong> ${escapeHtml(dateStr(checkOut))}</p>
    </div>
    ${safeMessage ? `<p style="color: ${COLORS.muted}; font-size: 14px; line-height: 1.6;">${safeMessage}</p>` : ''}
    <p style="color: ${COLORS.subtle}; font-size: 12px;">
      Please present the attached voucher at check-in. Reply to this email if you have any questions.
    </p>
  `, orgName);
}
