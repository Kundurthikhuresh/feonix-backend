/**
 * Nodemailer Email Service
 * Handles transactional emails: Welcome, Password Reset, Email Verification,
 * and Subscription Updates.
 *
 * Designed with modern, production-level, responsive HTML email standards
 * matching Stripe, Linear, and Vercel.
 */

const nodemailer = require('nodemailer');

let transporter = null;

function getTransporter() {
  if (transporter) return transporter;

  if (process.env.NODE_ENV === 'test' || process.env.DISABLE_MAILER === 'true') {
    transporter = {
      sendMail: async () => ({ messageId: 'mock-test-id' }),
    };
    return transporter;
  }

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
      // Keep the signed-in connection open and reuse it, so later emails skip
      // the connect + TLS + login steps.
      pool: true,
      maxConnections: 2,
    });
  } else {
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
 * Password Reset Email Template — Production Level Standard
 */
async function sendPasswordResetEmail(to, resetUrl, options = {}) {
  const expiresInMinutes = (options && options.expiresInMinutes) || 60;
  const subject = 'Reset your Feonix AI password';
  const preheader = 'Use this secure one-time link to reset your Feonix AI password.';

  const html = `<!DOCTYPE html>
<html lang="en" xmlns="http://www.w3.org/1999/xhtml" xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="X-UA-Compatible" content="IE=edge">
  <meta name="x-apple-disable-message-reformatting">
  <meta name="color-scheme" content="light dark">
  <meta name="supported-color-schemes" content="light dark">
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
    body { margin: 0; padding: 0; width: 100% !important; -webkit-text-size-adjust: 100%; -ms-text-size-adjust: 100%; background-color: #f8fafc; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; }
    table, td { mso-table-lspace: 0pt; mso-table-rspace: 0pt; border-collapse: collapse; }
    img { -ms-interpolation-mode: bicubic; border: 0; outline: none; text-decoration: none; }
    a { text-decoration: none; }
    .email-card { background-color: #ffffff; border: 1px solid #e2e8f0; border-radius: 16px; box-shadow: 0 4px 20px -2px rgba(15, 23, 42, 0.06); }
    @media only screen and (max-width: 620px) {
      .email-container { width: 100% !important; padding: 16px !important; }
      .email-card { padding: 28px 20px !important; border-radius: 12px !important; }
      .cta-btn { display: block !important; width: 100% !important; text-align: center !important; }
    }
  </style>
</head>
<body style="margin:0;padding:0;background-color:#f8fafc;color:#1e293b;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;-webkit-font-smoothing:antialiased;">
  <!-- Preheader -->
  <div style="display:none;font-size:1px;color:#f8fafc;line-height:1px;max-height:0px;max-width:0px;opacity:0;overflow:hidden;mso-hide:all;">
    ${preheader}&#847;&zwnj;&nbsp;&#847;&zwnj;&nbsp;&#847;&zwnj;&nbsp;&#847;&zwnj;&nbsp;&#847;&zwnj;&nbsp;
  </div>

  <table width="100%" cellpadding="0" cellspacing="0" border="0" role="presentation" style="background-color:#f8fafc;width:100%;table-layout:fixed;">
    <tr>
      <td align="center" style="padding:48px 16px 40px 16px;">
        <!-- Email Container -->
        <table class="email-container" width="100%" cellpadding="0" cellspacing="0" border="0" role="presentation" style="max-width:540px;margin:0 auto;">
          
          <!-- BRAND HEADER -->
          <tr>
            <td align="center" style="padding-bottom:28px;">
              <table cellpadding="0" cellspacing="0" border="0" role="presentation">
                <tr>
                  <td align="center">
                    <div style="width:40px;height:40px;border-radius:10px;background:linear-gradient(135deg, #0284c7 0%, #6366f1 100%);background-color:#0284c7;display:inline-block;line-height:40px;text-align:center;box-shadow:0 4px 12px rgba(2,132,199,0.3);">
                      <span style="font-size:20px;color:#ffffff;font-weight:900;font-family:-apple-system,sans-serif;">⚡</span>
                    </div>
                  </td>
                  <td style="padding-left:12px;text-align:left;">
                    <div style="font-size:18px;font-weight:800;color:#0f172a;letter-spacing:-0.3px;line-height:1.2;">
                      Feonix AI
                    </div>
                    <div style="font-size:12px;font-weight:600;color:#64748b;letter-spacing:0.2px;">
                      Real-Time Interview Intelligence
                    </div>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- MAIN CARD -->
          <tr>
            <td>
              <table class="email-card" width="100%" cellpadding="0" cellspacing="0" border="0" role="presentation" style="background-color:#ffffff;border:1px solid #e2e8f0;border-radius:16px;padding:40px 36px;box-shadow:0 4px 24px -2px rgba(15,23,42,0.06);">
                
                <!-- HEADING -->
                <tr>
                  <td style="color:#0f172a;font-size:22px;font-weight:800;line-height:1.3;letter-spacing:-0.4px;">
                    Reset your password
                  </td>
                </tr>

                <!-- MESSAGE -->
                <tr>
                  <td style="color:#334155;font-size:15px;line-height:1.65;padding-top:16px;">
                    Hello,
                  </td>
                </tr>
                <tr>
                  <td style="color:#334155;font-size:15px;line-height:1.65;padding-top:8px;">
                    We received a request to reset the password for your Feonix AI account. Click the button below to choose a new password:
                  </td>
                </tr>

                <!-- CTA BUTTON -->
                <tr>
                  <td align="center" style="padding:32px 0 24px 0;">
                    <table cellpadding="0" cellspacing="0" border="0" role="presentation" style="margin:0 auto;">
                      <tr>
                        <td align="center" style="border-radius:10px;background-color:#0f172a;background:linear-gradient(135deg, #0f172a 0%, #1e293b 100%);box-shadow:0 4px 14px rgba(15,23,42,0.25);">
                          <a class="cta-btn" href="${resetUrl}" target="_blank" rel="noopener noreferrer" style="display:inline-block;padding:14px 34px;font-size:15px;font-weight:700;color:#ffffff;text-decoration:none;letter-spacing:0.2px;border-radius:10px;background-color:#0f172a;">
                            Reset Password &rarr;
                          </a>
                        </td>
                      </tr>
                    </table>
                  </td>
                </tr>

                <!-- EXPIRATION NOTICE -->
                <tr>
                  <td align="center" style="color:#64748b;font-size:13px;line-height:1.5;padding-bottom:24px;">
                    This link is valid for <strong>${expiresInMinutes} minutes</strong> and can only be used once.
                  </td>
                </tr>

                <!-- DIVIDER -->
                <tr>
                  <td style="border-top:1px solid #f1f5f9;padding-top:24px;">
                    <!-- SECURITY INFO BOX -->
                    <table width="100%" cellpadding="0" cellspacing="0" border="0" role="presentation" style="background-color:#f8fafc;border:1px solid #e2e8f0;border-radius:10px;padding:16px 18px;">
                      <tr>
                        <td style="font-size:13px;font-weight:700;color:#0f172a;padding-bottom:6px;">
                          🛡️ Security Notice
                        </td>
                      </tr>
                      <tr>
                        <td style="font-size:13px;color:#475569;line-height:1.6;">
                          If you did not request a password reset, you can safely ignore this email. Your password will remain unchanged and your account stays completely secure.
                        </td>
                      </tr>
                    </table>
                  </td>
                </tr>

                <!-- DIRECT LINK FALLBACK -->
                <tr>
                  <td style="padding-top:24px;">
                    <div style="font-size:12px;color:#64748b;line-height:1.5;margin-bottom:8px;">
                      Having trouble with the button? Copy and paste this URL into your browser:
                    </div>
                    <div style="background-color:#f1f5f9;border:1px solid #e2e8f0;border-radius:8px;padding:12px 14px;word-break:break-all;font-family:ui-monospace,Menlo,Monaco,Consolas,monospace;font-size:11.5px;color:#0284c7;line-height:1.4;">
                      <a href="${resetUrl}" target="_blank" rel="noopener noreferrer" style="color:#0284c7;text-decoration:none;">${resetUrl}</a>
                    </div>
                  </td>
                </tr>

              </table>
            </td>
          </tr>

          <!-- FOOTER -->
          <tr>
            <td align="center" style="padding-top:32px;color:#94a3b8;font-size:12px;line-height:1.6;text-align:center;">
              <div style="font-weight:600;color:#64748b;margin-bottom:4px;">
                Feonix AI &bull; The Undetectable AI Copilot for Live Technical Interviews
              </div>
              <div style="color:#94a3b8;font-size:11.5px;">
                &copy; 2026 Feonix AI Inc. All rights reserved.
              </div>
              <div style="color:#94a3b8;font-size:11.5px;margin-top:4px;">
                Need assistance? Contact our team at <a href="mailto:support@applywithfeonix.com" style="color:#64748b;text-decoration:underline;">support@applywithfeonix.com</a>
              </div>
            </td>
          </tr>

        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;

  const text = `FEONIX AI — Real-Time Interview Intelligence
==================================================

Reset your password

Hello,

We received a request to reset the password for your Feonix AI account.
Use the secure link below to create a new password (valid for ${expiresInMinutes} minutes):

${resetUrl}

SECURITY NOTICE:
If you did not request a password reset, you can safely ignore this email.
Your password will remain unchanged and your account stays completely secure.

==================================================
© 2026 Feonix AI Inc. All rights reserved.
support@applywithfeonix.com`;

  return sendEmail({ to, subject, html, text });
}

/**
 * Welcome Email Template — Production Level Standard
 */
async function sendWelcomeEmail(to, name = '') {
  const subject = 'Welcome to Feonix AI — Your Live Interview Copilot';
  const preheader = 'Get started with Feonix AI and ace your upcoming technical interviews.';
  const appUrl = process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000';

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${subject}</title>
  <style>
    body { margin: 0; padding: 0; width: 100% !important; background-color: #f8fafc; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; }
    table, td { border-collapse: collapse; }
    .email-card { background-color: #ffffff; border: 1px solid #e2e8f0; border-radius: 16px; box-shadow: 0 4px 20px -2px rgba(15, 23, 42, 0.06); }
    @media only screen and (max-width: 620px) {
      .email-container { width: 100% !important; padding: 16px !important; }
      .email-card { padding: 28px 20px !important; }
    }
  </style>
</head>
<body style="margin:0;padding:0;background-color:#f8fafc;color:#1e293b;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" border="0" role="presentation" style="background-color:#f8fafc;width:100%;">
    <tr>
      <td align="center" style="padding:48px 16px 40px 16px;">
        <table class="email-container" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:540px;margin:0 auto;">
          
          <!-- BRAND HEADER -->
          <tr>
            <td align="center" style="padding-bottom:28px;">
              <table cellpadding="0" cellspacing="0" border="0">
                <tr>
                  <td align="center">
                    <div style="width:40px;height:40px;border-radius:10px;background:linear-gradient(135deg, #0284c7 0%, #6366f1 100%);background-color:#0284c7;display:inline-block;line-height:40px;text-align:center;box-shadow:0 4px 12px rgba(2,132,199,0.3);">
                      <span style="font-size:20px;color:#ffffff;font-weight:900;">⚡</span>
                    </div>
                  </td>
                  <td style="padding-left:12px;text-align:left;">
                    <div style="font-size:18px;font-weight:800;color:#0f172a;letter-spacing:-0.3px;">Feonix AI</div>
                    <div style="font-size:12px;font-weight:600;color:#64748b;">Real-Time Interview Intelligence</div>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- CARD -->
          <tr>
            <td>
              <table class="email-card" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#ffffff;border:1px solid #e2e8f0;border-radius:16px;padding:40px 36px;box-shadow:0 4px 24px -2px rgba(15,23,42,0.06);">
                <tr>
                  <td style="color:#0f172a;font-size:22px;font-weight:800;line-height:1.3;letter-spacing:-0.4px;">
                    Welcome to Feonix AI${name ? `, ${name}` : ''}! 🚀
                  </td>
                </tr>

                <tr>
                  <td style="color:#334155;font-size:15px;line-height:1.65;padding-top:16px;">
                    Thank you for joining Feonix AI. Your account is active and loaded with <strong>5 complimentary trial interview sessions</strong>.
                  </td>
                </tr>

                <tr>
                  <td style="padding:20px 0;">
                    <table width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#f8fafc;border:1px solid #e2e8f0;border-radius:12px;padding:18px 20px;">
                      <tr>
                        <td style="color:#0f172a;font-size:13.5px;line-height:1.8;">
                          <strong>✨ What you can do next:</strong><br>
                          &bull; <strong>Launch Live Copilot</strong> — Test real-time teleprompter question capture<br>
                          &bull; <strong>100% Screen-Share Stealth</strong> — Verified exclusion on Zoom, Teams & Meet<br>
                          &bull; <strong>STAR Answer Engine</strong> — Instant structured behavioral & system design talking points<br>
                          &bull; <strong>Algorithm Solver</strong> — O(1) complexity breakdowns and code generation
                        </td>
                      </tr>
                    </table>
                  </td>
                </tr>

                <tr>
                  <td align="center" style="padding:10px 0 24px 0;">
                    <table cellpadding="0" cellspacing="0" border="0" style="margin:0 auto;">
                      <tr>
                        <td align="center" style="border-radius:10px;background-color:#0f172a;box-shadow:0 4px 14px rgba(15,23,42,0.25);">
                          <a href="${appUrl}/dashboard" target="_blank" rel="noopener noreferrer" style="display:inline-block;padding:14px 34px;font-size:15px;font-weight:700;color:#ffffff;text-decoration:none;border-radius:10px;">
                            Go to Dashboard &rarr;
                          </a>
                        </td>
                      </tr>
                    </table>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- FOOTER -->
          <tr>
            <td align="center" style="padding-top:32px;color:#94a3b8;font-size:12px;line-height:1.6;text-align:center;">
              <div style="font-weight:600;color:#64748b;">Feonix AI &bull; Built for ambitious software engineers</div>
              <div style="color:#94a3b8;font-size:11.5px;margin-top:4px;">&copy; 2026 Feonix AI Inc. All rights reserved.</div>
            </td>
          </tr>

        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;

  return sendEmail({ to, subject, html });
}

/**
 * Subscription Confirmation Email Template — Production Level Standard
 */
async function sendSubscriptionEmail(to, plan) {
  const planName = String(plan || 'Pro').toUpperCase();
  const subject = `Subscription Activated — Feonix AI ${planName} Plan`;
  const appUrl = process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000';

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${subject}</title>
  <style>
    body { margin: 0; padding: 0; width: 100% !important; background-color: #f8fafc; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; }
    table, td { border-collapse: collapse; }
    .email-card { background-color: #ffffff; border: 1px solid #e2e8f0; border-radius: 16px; box-shadow: 0 4px 20px -2px rgba(15, 23, 42, 0.06); }
  </style>
</head>
<body style="margin:0;padding:0;background-color:#f8fafc;color:#1e293b;">
  <table width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#f8fafc;width:100%;">
    <tr>
      <td align="center" style="padding:48px 16px 40px 16px;">
        <table width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:540px;margin:0 auto;">
          
          <!-- BRAND -->
          <tr>
            <td align="center" style="padding-bottom:28px;">
              <div style="font-size:18px;font-weight:800;color:#0f172a;">⚡ Feonix AI</div>
            </td>
          </tr>

          <!-- CARD -->
          <tr>
            <td>
              <table class="email-card" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#ffffff;border:1px solid #e2e8f0;border-radius:16px;padding:40px 36px;">
                <tr>
                  <td style="color:#0f172a;font-size:22px;font-weight:800;">
                    Subscription Confirmed! 🎉
                  </td>
                </tr>

                <tr>
                  <td style="color:#334155;font-size:15px;line-height:1.65;padding-top:16px;">
                    Your subscription to the <strong>Feonix AI ${planName} Plan</strong> is now active.
                  </td>
                </tr>

                <tr>
                  <td style="color:#64748b;font-size:14px;line-height:1.6;padding-top:12px;">
                    You now have full access to unlimited interview sessions, high-priority inference queues, and all advanced system design & live coding blueprints.
                  </td>
                </tr>

                <tr>
                  <td align="center" style="padding:28px 0 10px 0;">
                    <a href="${appUrl}/dashboard" target="_blank" rel="noopener noreferrer" style="display:inline-block;padding:14px 34px;font-size:15px;font-weight:700;color:#ffffff;background-color:#0f172a;text-decoration:none;border-radius:10px;">
                      Open Live Copilot &rarr;
                    </a>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <tr>
            <td align="center" style="padding-top:24px;color:#94a3b8;font-size:12px;">
              &copy; 2026 Feonix AI Inc. All rights reserved.
            </td>
          </tr>

        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;

  return sendEmail({ to, subject, html });
}

module.exports = {
  sendEmail,
  sendWelcomeEmail,
  sendPasswordResetEmail,
  sendSubscriptionEmail,
};
