/**
 * Nodemailer Email Service
 * Handles transactional emails: Welcome, Password Reset, Email Verification,
 * Subscription Updates, and Interview Reminders.
 *
 * Configured via .env:
 *   SMTP_HOST=smtp.gmail.com
 *   SMTP_PORT=587
 *   SMTP_SECURE=false
 *   SMTP_USER=your-email@gmail.com
 *   SMTP_PASS=your-app-password
 *   SMTP_FROM="Fenoix AI" <no-reply@feonixai.com>
 */

const nodemailer = require('nodemailer');

let transporter = null;

function getTransporter() {
  if (transporter) return transporter;

  const host = process.env.SMTP_HOST;
  const port = Number(process.env.SMTP_PORT || 587);
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;

  if (host && user && pass) {
    transporter = nodemailer.createTransport({
      host,
      port,
      secure: process.env.SMTP_SECURE === 'true' || port === 465,
      auth: { user, pass },
    });
  } else {
    // Development / Fallback mode (logs to console if SMTP not configured)
    console.warn('⚠️ SMTP credentials not set in .env — Email notifications will be logged to console.');
    transporter = {
      sendMail: async (options) => {
        console.log('--------------------------------------------------');
        console.log('📧 [MOCK EMAIL SENT]');
        console.log(`To: ${options.to}`);
        console.log(`Subject: ${options.subject}`);
        console.log(`Text preview: ${String(options.text || options.html || '').slice(0, 200)}...`);
        console.log('--------------------------------------------------');
        return { messageId: 'mock-email-id-' + Date.now() };
      },
    };
  }
  return transporter;
}

/**
 * Base email sending function
 */
async function sendEmail({ to, subject, html, text }) {
  try {
    const transport = getTransporter();
    const from = process.env.SMTP_FROM || '"Fenoix AI" <no-reply@feonixai.com>';
    const info = await transport.sendMail({
      from,
      to,
      subject,
      text: text || html.replace(/<[^>]+>/g, ''),
      html,
    });
    return { success: true, messageId: info.messageId };
  } catch (err) {
    console.error('Failed to send email:', err);
    return { success: false, error: err.message };
  }
}

/**
 * Welcome Email Template
 */
async function sendWelcomeEmail(to, name = '') {
  const subject = 'Welcome to Fenoix AI — Supercharge Your Career!';
  const html = `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; background: #0a0b0f; color: #f8fafc; padding: 30px; border-radius: 12px;">
      <h2 style="color: #00f5ff; margin-top: 0;">Welcome to Fenoix AI${name ? `, ${name}` : ''}! 🚀</h2>
      <p style="color: #cbd5e1; font-size: 15px; line-height: 1.6;">
        Thank you for joining Fenoix AI. You now have access to our suite of AI-powered career tools:
      </p>
      <ul style="color: #94a3b8; font-size: 14px; line-height: 1.8;">
        <li>📄 <strong>AI Resume Analyzer</strong> — Instant ATS scoring and bullet point improvements</li>
        <li>🛠 <strong>AI Resume Builder</strong> — Executive resume templates with AI polish</li>
        <li>🎯 <strong>Resume ↔ Job Matcher</strong> — Detailed keyword gap analysis</li>
        <li>✉️ <strong>AI Cover Letter Generator</strong> — Personalized letters streamed in seconds</li>
        <li>🎤 <strong>AI Interview Prep</strong> — Practice questions with real-time scoring</li>
      </ul>
      <div style="margin-top: 25px;">
        <a href="${process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000'}/profile" style="background: linear-gradient(135deg, #00f5ff, #0891b2); color: #0a0b0f; font-weight: bold; text-decoration: none; padding: 12px 24px; border-radius: 8px; display: inline-block;">
          Set Up Your Profile →
        </a>
      </div>
      <p style="color: #64748b; font-size: 12px; margin-top: 30px; border-top: 1px solid rgba(255,255,255,0.1); padding-top: 15px;">
        Fenoix AI Team • Built for ambitious professionals.
      </p>
    </div>
  `;
  return sendEmail({ to, subject, html });
}

/**
 * Password Reset Email Template
 */
async function sendPasswordResetEmail(to, resetUrl) {
  const subject = 'Reset Your Fenoix AI Password';
  const html = `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; background: #0a0b0f; color: #f8fafc; padding: 30px; border-radius: 12px;">
      <h2 style="color: #00f5ff; margin-top: 0;">Password Reset Request</h2>
      <p style="color: #cbd5e1; font-size: 15px; line-height: 1.6;">
        We received a request to reset your Fenoix AI password. Click the button below to reset it:
      </p>
      <div style="margin: 25px 0;">
        <a href="${resetUrl}" style="background: #a855f7; color: #ffffff; font-weight: bold; text-decoration: none; padding: 12px 24px; border-radius: 8px; display: inline-block;">
          Reset Password
        </a>
      </div>
      <p style="color: #94a3b8; font-size: 13px;">
        If you did not request a password reset, you can safely ignore this email. This link expires in 1 hour.
      </p>
    </div>
  `;
  return sendEmail({ to, subject, html });
}

/**
 * Subscription Confirmation Email
 */
async function sendSubscriptionEmail(to, plan) {
  const subject = `Subscription Activated — Fenoix AI ${plan.toUpperCase()} Plan`;
  const html = `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; background: #0a0b0f; color: #f8fafc; padding: 30px; border-radius: 12px;">
      <h2 style="color: #34d399; margin-top: 0;">Subscription Confirmed! 🎉</h2>
      <p style="color: #cbd5e1; font-size: 15px; line-height: 1.6;">
        Your subscription to the <strong>Fenoix AI ${plan.toUpperCase()} Plan</strong> is now active.
      </p>
      <p style="color: #94a3b8; font-size: 14px;">
        You now have access to higher AI generation quotas and priority analysis speeds.
      </p>
      <div style="margin-top: 20px;">
        <a href="${process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000'}/billing" style="background: #00f5ff; color: #0a0b0f; font-weight: bold; text-decoration: none; padding: 10px 20px; border-radius: 6px; display: inline-block;">
          Manage Subscription →
        </a>
      </div>
    </div>
  `;
  return sendEmail({ to, subject, html });
}

module.exports = {
  sendEmail,
  sendWelcomeEmail,
  sendPasswordResetEmail,
  sendSubscriptionEmail,
};
