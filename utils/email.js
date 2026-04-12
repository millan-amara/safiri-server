import nodemailer from 'nodemailer';

let transporter = null;

function getTransporter() {
  if (transporter) return transporter;
  
  if (!process.env.SMTP_HOST || !process.env.SMTP_USER) {
    console.warn('SMTP not configured — emails will be logged to console');
    return null;
  }

  transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: parseInt(process.env.SMTP_PORT) || 587,
    secure: parseInt(process.env.SMTP_PORT) === 465,
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    },
  });

  return transporter;
}

export async function sendEmail({ to, subject, html }) {
  const t = getTransporter();
  const fromName = process.env.SMTP_FROM_NAME || 'SafiriPro';
  const from = `"${fromName}" <${process.env.SMTP_USER}>`;

  if (!t) {
    console.log('─── EMAIL (not sent, SMTP not configured) ───');
    console.log(`To: ${to}`);
    console.log(`Subject: ${subject}`);
    console.log(`Body: ${html.substring(0, 200)}...`);
    console.log('──────────────────────────────────────────────');
    return;
  }

  await t.sendMail({ from, to, subject, html });
}

// ─── EMAIL TEMPLATES ────────────────────────────

const baseStyle = `
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
  max-width: 560px;
  margin: 0 auto;
  padding: 40px 24px;
`;

const btnStyle = `
  display: inline-block;
  padding: 12px 32px;
  background-color: #B45309;
  color: #ffffff;
  text-decoration: none;
  border-radius: 8px;
  font-weight: 600;
  font-size: 14px;
`;

function wrap(content, orgName) {
  return `
    <div style="${baseStyle}">
      <div style="text-align: center; margin-bottom: 32px;">
        <h2 style="margin: 0; color: #1e293b; font-size: 20px;">${orgName || 'SafiriPro'}</h2>
      </div>
      ${content}
      <div style="margin-top: 40px; padding-top: 20px; border-top: 1px solid #e7e5e4; text-align: center;">
        <p style="color: #a8a29e; font-size: 12px; margin: 0;">${orgName || 'SafiriPro'}</p>
      </div>
    </div>
  `;
}

export function inviteEmail({ inviterName, orgName, inviteUrl }) {
  return wrap(`
    <h3 style="color: #1e293b; font-size: 18px; margin-bottom: 8px;">You've been invited!</h3>
    <p style="color: #57534e; font-size: 14px; line-height: 1.6;">
      ${inviterName} has invited you to join <strong>${orgName}</strong> on SafiriPro.
    </p>
    <p style="color: #57534e; font-size: 14px; line-height: 1.6;">
      Click the button below to set up your account. This link expires in 48 hours.
    </p>
    <div style="text-align: center; margin: 32px 0;">
      <a href="${inviteUrl}" style="${btnStyle}">Set Up My Account</a>
    </div>
    <p style="color: #a8a29e; font-size: 12px;">
      If the button doesn't work, copy this link:<br/>
      <a href="${inviteUrl}" style="color: #B45309; word-break: break-all;">${inviteUrl}</a>
    </p>
  `, orgName);
}

export function resetPasswordEmail({ resetUrl, userName }) {
  return wrap(`
    <h3 style="color: #1e293b; font-size: 18px; margin-bottom: 8px;">Reset your password</h3>
    <p style="color: #57534e; font-size: 14px; line-height: 1.6;">
      Hi${userName ? ' ' + userName : ''}, we received a request to reset your password. Click below to choose a new one. This link expires in 1 hour.
    </p>
    <div style="text-align: center; margin: 32px 0;">
      <a href="${resetUrl}" style="${btnStyle}">Reset Password</a>
    </div>
    <p style="color: #a8a29e; font-size: 12px;">
      If you didn't request this, you can safely ignore this email. Your password won't change.
    </p>
  `);
}

export function welcomeEmail({ userName, loginUrl, orgName }) {
  return wrap(`
    <h3 style="color: #1e293b; font-size: 18px; margin-bottom: 8px;">Welcome to ${orgName}!</h3>
    <p style="color: #57534e; font-size: 14px; line-height: 1.6;">
      Hi ${userName}, your account is all set up. You can now log in and start working.
    </p>
    <div style="text-align: center; margin: 32px 0;">
      <a href="${loginUrl}" style="${btnStyle}">Go to SafiriPro</a>
    </div>
  `, orgName);
}

export function verifyEmailTemplate({ userName, verifyUrl }) {
  return wrap(`
    <h3 style="color: #1e293b; font-size: 18px; margin-bottom: 8px;">Verify your email</h3>
    <p style="color: #57534e; font-size: 14px; line-height: 1.6;">
      Hi ${userName}, please verify your email address to ensure you receive important notifications like quote views and client responses.
    </p>
    <div style="text-align: center; margin: 32px 0;">
      <a href="${verifyUrl}" style="${btnStyle}">Verify Email</a>
    </div>
    <p style="color: #a8a29e; font-size: 12px;">
      You can use SafiriPro without verifying, but you may miss email notifications.
    </p>
  `);
}