'use strict';

/**
 * Email Engine
 *
 * Sends real email using:
 * 1. SendGrid when SENDGRID_API_KEY is set.
 * 2. Gmail SMTP when GMAIL_USER and GMAIL_APP_PASSWORD are set.
 * 3. A generic SMTP server when SMTP_HOST, SMTP_USER, and SMTP_PASS are set.
 *
 * Falls back to in-app messaging via MessagingEngine and console logging
 * when no email provider is configured.
 */

let MessagingEngine;
let nodemailer;
try { MessagingEngine = require('../messaging/messagingEngine').MessagingEngine; } catch (e) { MessagingEngine = null; }
try { nodemailer = require('nodemailer'); } catch (e) { nodemailer = null; }

const SENDGRID_KEY = process.env.SENDGRID_API_KEY || process.env.DLB_SENDGRID_API_KEY || '';
const FROM_EMAIL = process.env.SENDGRID_FROM_EMAIL || process.env.EMAIL_FROM || process.env.GMAIL_USER || 'noreply@dlbtrust.co';

function getSmtpTransporter() {
  if (!nodemailer) return null;

  if (process.env.GMAIL_USER && process.env.GMAIL_APP_PASSWORD) {
    return nodemailer.createTransport({
      host: 'smtp.gmail.com',
      port: 465,
      secure: true,
      auth: { user: process.env.GMAIL_USER, pass: process.env.GMAIL_APP_PASSWORD },
    });
  }

  if (process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS) {
    return nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: parseInt(process.env.SMTP_PORT || '587', 10),
      secure: process.env.SMTP_SECURE === 'true' || (process.env.SMTP_PORT || '587') === '465',
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
    });
  }

  return null;
}

class EmailEngine {

  static async send({ to, subject, body, html, from } = {}) {
    if (!to || !subject) throw new Error('to and subject required');

    if (SENDGRID_KEY) {
      try {
        const payload = {
          personalizations: [{ to: [{ email: to }] }],
          from: { email: from || FROM_EMAIL, name: 'DLB Trust' },
          subject,
          content: [
            { type: 'text/plain', value: body || '' },
            ...(html ? [{ type: 'text/html', value: html }] : []),
          ],
        };
        const res = await fetch('https://api.sendgrid.com/v3/mail/send', {
          method: 'POST',
          headers: { Authorization: `Bearer ${SENDGRID_KEY}`, 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
        if (!res.ok) throw new Error(`SendGrid returned ${res.status}`);
        return { sent: true, provider: 'sendgrid', to, subject };
      } catch (e) {
        console.warn('[EmailEngine] SendGrid send failed:', e.message);
      }
    }

    const smtp = getSmtpTransporter();
    if (smtp) {
      try {
        const info = await smtp.sendMail({
          from: `"DLB Trust" <${from || FROM_EMAIL}>`,
          to,
          subject,
          text: body || '',
          html: html || undefined,
        });
        return { sent: true, provider: 'smtp', to, subject, messageId: info.messageId };
      } catch (e) {
        console.warn('[EmailEngine] SMTP send failed:', e.message);
      }
    }

    // Fallback: in-app notification
    if (MessagingEngine) {
      try {
        await MessagingEngine.notify({
          subject,
          body: body || html || subject,
          participants: [{ email: to, name: to }],
          referenceType: 'email',
          referenceId: `${Date.now()}`,
          sender: 'DLB Trust',
        });
      } catch (e) { console.warn('[EmailEngine] messaging fallback failed:', e.message); }
    }

    console.log('[EmailEngine] (logged - no provider) to:', to, 'subject:', subject, 'body:', body || '');
    return { sent: false, provider: 'log', to, subject, note: 'No email provider configured; message logged and sent in-app if available.' };
  }

  /**
   * Convenience method to send a one-time PIN/login link to a trustee or beneficiary.
   */
  static async sendOtp({ to, name, otp, actionUrl, role, action = 'approve' } = {}) {
    const subject = `DLB Trust ${action === 'approve' ? 'approval' : 'login'} code`;
    const body = `Hello ${name || to},\n\nYour one-time ${action} code is: ${otp}\n\n${actionUrl ? `Open: ${actionUrl}` : 'Log into the portal and enter this code.'}\n\n-DLB Trust`;
    return this.send({ to, subject, body });
  }
}

module.exports = { EmailEngine };
