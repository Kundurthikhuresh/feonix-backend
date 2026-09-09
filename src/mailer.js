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
    const from = process.env.SMTP_FROM || '"Feonix AI" <support@applywithfeonix.com>';
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
        <a href="${process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3001'}/profile" style="background: linear-gradient(135deg, #00f5ff, #0891b2); color: #0a0b0f; font-weight: bold; text-decoration: none; padding: 12px 24px; border-radius: 8px; display: inline-block;">
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
 * Password Reset Email Template — Feonix AI 3.0 Neural Gate
 */
async function sendPasswordResetEmail(to, resetUrl, options = {}) {
  const expiresInMinutes = (options && options.expiresInMinutes) || 60;
  const subject = 'Feonix AI — Secure Password Reset';
  const preheader = 'Securely reset your Feonix AI account password.';

  const html = `<!DOCTYPE html>
<html lang="en" xmlns="http://www.w3.org/1999/xhtml" xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="X-UA-Compatible" content="IE=edge">
  <meta name="x-apple-disable-message-reformatting">
  <title>${subject}</title>
  <!--[if mso]>
  <noscript>
    <xml>
      <o:OfficeDocumentSettings>
        <o:PixelsPerInch>96</o:PixelsPerInch>
      </o:OfficeDocumentSettings>
    </xml>
  </noscript>
  <![endif]-->
  <style>
    body { margin: 0; padding: 0; width: 100% !important; -webkit-text-size-adjust: 100%; -ms-text-size-adjust: 100%; background-color: #06080d; }
    table, td { mso-table-lspace: 0pt; mso-table-rspace: 0pt; border-collapse: collapse; }
    img { -ms-interpolation-mode: bicubic; border: 0; outline: none; text-decoration: none; }
    a { text-decoration: none; }
    @media only screen and (max-width: 620px) {
      .email-container { width: 100% !important; padding: 12px !important; }
      .email-card { padding: 24px 18px !important; }
      .cta-button { width: 100% !important; text-align: center !important; box-sizing: border-box !important; }
    }
  </style>
</head>
<body style="margin:0;padding:0;background-color:#06080d;color:#f8fafc;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
  <!-- Hidden Preheader -->
  <div style="display:none;font-size:1px;color:#06080d;line-height:1px;max-height:0px;max-width:0px;opacity:0;overflow:hidden;mso-hide:all;">
    ${preheader}&#847;&zwnj;&nbsp;&#847;&zwnj;&nbsp;&#847;&zwnj;&nbsp;&#847;&zwnj;&nbsp;&#847;&zwnj;&nbsp;&#847;&zwnj;&nbsp;&#847;&zwnj;&nbsp;&#847;&zwnj;&nbsp;&#847;&zwnj;&nbsp;&#847;&zwnj;&nbsp;
  </div>

  <table width="100%" cellpadding="0" cellspacing="0" border="0" role="presentation" style="background-color:#06080d;width:100%;table-layout:fixed;">
    <tr>
      <td align="center" style="padding:40px 16px;">
        <!-- Email Container -->
        <table class="email-container" width="100%" cellpadding="0" cellspacing="0" border="0" role="presentation" style="max-width:580px;margin:0 auto;">
          <tr>
            <td>
              <!-- Main Card -->
              <table class="email-card" width="100%" cellpadding="0" cellspacing="0" border="0" role="presentation" style="background-color:#0d111b;border:1px solid #1a2233;border-radius:14px;padding:36px 32px;box-shadow:0 12px 36px rgba(0,0,0,0.5);">
                
                <!-- HEADER: Brand & Neural Gate -->
                <tr>
                  <td>
                    <table width="100%" cellpadding="0" cellspacing="0" border="0" role="presentation">
                      <tr>
                        <td>
                          <!-- Brand Badge -->
                          <table cellpadding="0" cellspacing="0" border="0" role="presentation">
                            <tr>
                              <td style="background-color:rgba(0,245,255,0.08);border:1px solid rgba(0,245,255,0.25);border-radius:20px;padding:5px 14px;">
                                <span style="display:inline-block;width:7px;height:7px;border-radius:50%;background-color:#00f5ff;margin-right:7px;vertical-align:middle;"></span>
                                <span style="font-family:'Courier New',Courier,monospace,-apple-system,sans-serif;font-size:11px;font-weight:700;color:#00f5ff;letter-spacing:1.5px;vertical-align:middle;text-transform:uppercase;">FEONIX AI 3.0</span>
                                <span style="color:#475569;margin:0 6px;vertical-align:middle;">•</span>
                                <span style="font-family:'Courier New',Courier,monospace,-apple-system,sans-serif;font-size:11px;font-weight:700;color:#a855f7;letter-spacing:1.5px;vertical-align:middle;text-transform:uppercase;">NEURAL GATE</span>
                              </td>
                            </tr>
                          </table>
                          <!-- Subtitle / Tagline -->
                          <div style="color:#94a3b8;font-size:13px;letter-spacing:0.3px;margin-top:10px;font-weight:500;">
                            Secure Technical Interview Copilot
                          </div>
                        </td>
                      </tr>
                    </table>
                  </td>
                </tr>

                <!-- DIVIDER -->
                <tr>
                  <td style="padding:22px 0 26px 0;">
                    <table width="100%" cellpadding="0" cellspacing="0" border="0" role="presentation">
                      <tr>
                        <td style="height:1px;background-color:#1a2233;font-size:1px;line-height:1px;">&nbsp;</td>
                      </tr>
                    </table>
                  </td>
                </tr>

                <!-- MAIN HEADING -->
                <tr>
                  <td style="color:#f8fafc;font-size:22px;font-weight:700;line-height:1.3;letter-spacing:-0.3px;">
                    Reset your Feonix AI password
                  </td>
                </tr>

                <!-- SUPPORTING COPY -->
                <tr>
                  <td style="color:#cbd5e1;font-size:15px;line-height:1.6;padding-top:14px;">
                    We received a request to reset the password for your Feonix AI account.
                  </td>
                </tr>
                <tr>
                  <td style="color:#cbd5e1;font-size:15px;line-height:1.6;padding-top:8px;">
                    Use the secure button below to create a new password and regain access to your AI Interview Copilot.
                  </td>
                </tr>

                <!-- CTA BUTTON -->
                <tr>
                  <td align="center" style="padding:32px 0 28px 0;">
                    <table cellpadding="0" cellspacing="0" border="0" role="presentation" style="margin:0 auto;">
                      <tr>
                        <td align="center" style="border-radius:8px;background-color:#00f5ff;background:linear-gradient(135deg, #00f5ff 0%, #8b5cf6 100%);box-shadow:0 4px 20px rgba(0,245,255,0.35);">
                          <a class="cta-button" href="${resetUrl}" target="_blank" rel="noopener noreferrer" style="display:inline-block;padding:15px 36px;font-size:15px;font-weight:700;color:#06080d;text-decoration:none;letter-spacing:0.3px;border-radius:8px;">
                            Reset Password &rarr;
                          </a>
                        </td>
                      </tr>
                    </table>
                    <!-- Direct link fallback -->
                    <div style="color:#64748b;font-size:12px;line-height:1.5;margin-top:16px;word-break:break-all;text-align:center;">
                      Button not working? Copy and paste this link into your browser:<br>
                      <a href="${resetUrl}" target="_blank" rel="noopener noreferrer" style="color:#00f5ff;text-decoration:underline;">${resetUrl}</a>
                    </div>
                  </td>
                </tr>

                <!-- SECURITY CHECK SECTION -->
                <tr>
                  <td style="padding-top:6px;">
                    <table width="100%" cellpadding="0" cellspacing="0" border="0" role="presentation" style="background-color:#090d16;border:1px solid #192236;border-left:3px solid #00f5ff;border-radius:8px;padding:18px 20px;">
                      <tr>
                        <td style="color:#00f5ff;font-family:'Courier New',Courier,monospace,-apple-system,sans-serif;font-size:11px;font-weight:700;letter-spacing:1.5px;text-transform:uppercase;padding-bottom:12px;">
                          SECURITY CHECK
                        </td>
                      </tr>
                      <tr>
                        <td style="color:#cbd5e1;font-size:13.5px;line-height:1.8;">
                          <span style="color:#10b981;font-weight:bold;margin-right:8px;">&#10003;</span> Secure password reset<br>
                          <span style="color:#10b981;font-weight:bold;margin-right:8px;">&#10003;</span> One-time recovery link<br>
                          <span style="color:#10b981;font-weight:bold;margin-right:8px;">&#10003;</span> This secure recovery link expires in ${expiresInMinutes} minutes.<br>
                          <span style="color:#10b981;font-weight:bold;margin-right:8px;">&#10003;</span> Your account remains protected
                        </td>
                      </tr>
                    </table>
                  </td>
                </tr>

                <!-- DIDN'T REQUEST THIS SECTION -->
                <tr>
                  <td style="padding-top:20px;">
                    <table width="100%" cellpadding="0" cellspacing="0" border="0" role="presentation" style="background-color:rgba(148,163,184,0.04);border:1px solid #1a2335;border-radius:8px;padding:16px 20px;">
                      <tr>
                        <td style="color:#e2e8f0;font-size:13px;font-weight:700;padding-bottom:4px;">
                          Didn&#39;t request this?
                        </td>
                      </tr>
                      <tr>
                        <td style="color:#94a3b8;font-size:13px;line-height:1.5;">
                          If you did not request a password reset, you can safely ignore this email. Your password will remain unchanged.
                        </td>
                      </tr>
                    </table>
                  </td>
                </tr>

                <!-- DIVIDER -->
                <tr>
                  <td style="padding:28px 0 20px 0;">
                    <table width="100%" cellpadding="0" cellspacing="0" border="0" role="presentation">
                      <tr>
                        <td style="height:1px;background-color:#1a2233;font-size:1px;line-height:1px;">&nbsp;</td>
                      </tr>
                    </table>
                  </td>
                </tr>

                <!-- FOOTER -->
                <tr>
                  <td align="center" style="color:#94a3b8;font-size:12px;line-height:1.7;">
                    <div style="font-weight:700;color:#cbd5e1;font-size:13px;letter-spacing:0.5px;">FEONIX AI 3.0</div>
                    <div style="color:#8b5cf6;font-size:12px;font-weight:600;">Neural Interview Intelligence</div>
                    <div style="color:#64748b;font-size:12px;margin-top:2px;">Secure Technical Interview Copilot</div>
                    <div style="color:#475569;font-size:11px;margin-top:12px;">&copy; 2026 Feonix AI. All rights reserved.</div>
                    <div style="color:#475569;font-size:11px;margin-top:4px;">Automated security notification. Please do not reply.</div>
                  </td>
                </tr>

              </table>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;

  const text = `FEONIX AI 3.0 — NEURAL GATE
Secure Technical Interview Copilot
==================================================

Reset your Feonix AI password

We received a request to reset the password for your Feonix AI account.
Use the secure link below to create a new password and regain access to your AI Interview Copilot:

${resetUrl}

SECURITY CHECK:
[✓] Secure password reset
[✓] One-time recovery link
[✓] This secure recovery link expires in ${expiresInMinutes} minutes.
[✓] Your account remains protected

Didn't request this?
If you did not request a password reset, you can safely ignore this email. Your password will remain unchanged.

==================================================
FEONIX AI 3.0
Neural Interview Intelligence
Secure Technical Interview Copilot
© 2026 Feonix AI. All rights reserved.
Automated security notification. Please do not reply.`;

  return sendEmail({ to, subject, html, text });
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
        <a href="${process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3001'}/billing" style="background: #00f5ff; color: #0a0b0f; font-weight: bold; text-decoration: none; padding: 10px 20px; border-radius: 6px; display: inline-block;">
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
