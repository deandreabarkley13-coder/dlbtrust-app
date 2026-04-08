/**
 * OpenACH Service — dlbtrust.cloud
 * 
 * Connects to the self-hosted OpenACH instance at ach.dlbtrust.cloud
 * using the correct session-cookie REST API (not Bearer token).
 * 
 * ODFI: Eaton Family Credit Union (routing: 241075470)
 * Originator: DEANDREA LAVAR BARKLEY TRUST
 * Originator Info ID: 0eb26e1d-5fcc-4978-a132-dd93c2655429
 */

import https from 'https';
import http from 'http';
import { URL } from 'url';

const OPENACH_BASE_URL   = process.env.OPENACH_BASE_URL   || 'https://ach.dlbtrust.cloud/openach/api';
const OPENACH_API_TOKEN  = process.env.OPENACH_API_TOKEN  || '';
const OPENACH_API_KEY    = process.env.OPENACH_API_KEY    || '';
const OPENACH_PAYMENT_TYPE_ID = process.env.OPENACH_PAYMENT_TYPE_ID || '';

export interface AchPaymentRequest {
  amount: number;
  routingNumber: string;
  accountNumber: string;
  accountType: 'checking' | 'savings';
  recipientName: string;
  recipientEmail?: string;
  description: string;
  referenceId: string;
  billingAddress?: string;
  billingCity?: string;
  billingState?: string;
  billingZip?: string;
}

export interface AchPaymentResponse {
  transactionId: string;  // payment_schedule_id from OpenACH
  profileId: string;      // payment_profile_id
  accountId: string;      // external_account_id
  status: 'scheduled' | 'processing' | 'failed';
  message: string;
}

export interface AchStatusResponse {
  transactionId: string;
  status: 'pending' | 'submitted' | 'completed' | 'returned' | 'failed';
  settledAt: string | null;
  returnCode: string | null;
  returnReason: string | null;
}

// ─── Low-level HTTP POST ──────────────────────────────────────────────────────

function openachPost(endpoint: string, params: Record<string, string>, sessionCookie?: string): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const baseUrl = OPENACH_BASE_URL.endsWith('/') ? OPENACH_BASE_URL.slice(0, -1) : OPENACH_BASE_URL;
    const urlStr = `${baseUrl}/${endpoint}`;
    const parsed = new URL(urlStr);
    const body = new URLSearchParams(params).toString();

    const headers: Record<string, string | number> = {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Content-Length': Buffer.byteLength(body),
      'Accept': 'application/json',
    };
    if (sessionCookie) headers['Cookie'] = sessionCookie;

    const options = {
      hostname: parsed.hostname,
      port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path: parsed.pathname,
      method: 'POST',
      headers,
      rejectUnauthorized: false,  // allow self-signed on local server
    };

    const lib = parsed.protocol === 'https:' ? https : http;
    const req = lib.request(options, (res) => {
      let data = '';
      res.on('data', (chunk: Buffer) => { data += chunk; });
      res.on('end', () => {
        try {
          const json = JSON.parse(data) as Record<string, unknown>;
          // Capture session cookie
          const setCookie = (res.headers['set-cookie'] as string[] | undefined);
          if (setCookie) {
            const phpSessId = setCookie.find((c: string) => c.startsWith('PHPSESSID'));
            if (phpSessId) json._sessionCookie = phpSessId.split(';')[0];
          }
          resolve(json);
        } catch {
          reject(new Error(`OpenACH parse error: ${data.substring(0, 200)}`));
        }
      });
    });

    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// ─── Session ──────────────────────────────────────────────────────────────────

class OpenACHSession {
  private sessionCookie: string | null = null;
  private connected = false;

  async connect(): Promise<void> {
    if (this.connected) return;
    const res = await openachPost('connect', {
      user_api_token: OPENACH_API_TOKEN,
      user_api_key: OPENACH_API_KEY,
    });
    if (!res.success) throw new Error(`OpenACH auth failed: ${res.error}`);
    this.sessionCookie = (res._sessionCookie as string) || `PHPSESSID=${res.session_id}`;
    this.connected = true;
  }

  async disconnect(): Promise<void> {
    if (!this.connected) return;
    await openachPost('disconnect', {}, this.sessionCookie ?? undefined);
    this.connected = false;
    this.sessionCookie = null;
  }

  async request(endpoint: string, params: Record<string, string> = {}): Promise<Record<string, unknown>> {
    if (!this.connected) await this.connect();
    return openachPost(endpoint, params, this.sessionCookie ?? undefined);
  }
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Initiate a real ACH credit disbursement.
 * Creates a payment profile + bank account + schedules the payment.
 * Send date defaults to the next business day.
 */
export async function initiateAchPayment(payment: AchPaymentRequest): Promise<AchPaymentResponse> {
  const session = new OpenACHSession();
  await session.connect();

  try {
    // Determine the payment type ID
    const paymentTypeId = OPENACH_PAYMENT_TYPE_ID || await getFirstCreditPaymentTypeId(session);
    if (!paymentTypeId) throw new Error('No payment type configured. Set OPENACH_PAYMENT_TYPE_ID in .env');

    // Send date = next business day (skip weekends)
    const sendDate = getNextBusinessDay();

    // Parse name
    const nameParts = payment.recipientName.trim().split(' ');
    const firstName = nameParts[0];
    const lastName  = nameParts.slice(1).join(' ') || firstName;

    // Step 1: Create or find payment profile
    let profileId: string;
    const existingProfile = await session.request('getPaymentProfileByExtId', {
      payment_profile_external_id: payment.referenceId,
    });

    if (existingProfile.success && existingProfile.payment_profile_id) {
      profileId = existingProfile.payment_profile_id as string;
    } else {
      const profileRes = await session.request('savePaymentProfile', {
        payment_profile_first_name: firstName,
        payment_profile_last_name:  lastName,
        payment_profile_email_address: payment.recipientEmail || '',
        payment_profile_external_id: payment.referenceId,
      });
      if (!profileRes.success) throw new Error(`Profile creation failed: ${profileRes.error}`);
      profileId = profileRes.payment_profile_id as string;
    }

    // Step 2: Add bank account
    const accountRes = await session.request('saveExternalAccount', {
      external_account_payment_profile_id: profileId,
      external_account_name:    `${firstName} ${lastName} - ACH`,
      external_account_bank:    'Recipient Bank',
      external_account_holder:  payment.recipientName,
      external_account_type:    payment.accountType === 'savings' ? 'Savings' : 'Checking',
      external_account_country_code: 'US',
      external_account_dfi_id:  payment.routingNumber,
      external_account_number:  payment.accountNumber,
      external_account_billing_address:        payment.billingAddress || '',
      external_account_billing_city:           payment.billingCity    || '',
      external_account_billing_state_province: payment.billingState   || 'OH',
      external_account_billing_postal_code:    payment.billingZip     || '',
      external_account_billing_country: 'US',
      external_account_business: '0',
    });
    if (!accountRes.success) throw new Error(`Bank account creation failed: ${accountRes.error}`);
    const externalAccountId = accountRes.external_account_id as string;

    // Step 3: Schedule ACH credit payment
    const scheduleRes = await session.request('savePaymentSchedule', {
      payment_schedule_external_account_id:  externalAccountId,
      payment_schedule_payment_type_id:      paymentTypeId,
      payment_schedule_amount:               (payment.amount / 100).toFixed(2),  // convert cents → dollars
      payment_schedule_currency_code:        'USD',
      payment_schedule_next_date:            sendDate,
      payment_schedule_frequency:            'once',
      payment_schedule_remaining_occurrences: '1',
    });
    if (!scheduleRes.success) throw new Error(`Payment scheduling failed: ${scheduleRes.error}`);

    return {
      transactionId: scheduleRes.payment_schedule_id as string,
      profileId,
      accountId: externalAccountId,
      status: 'scheduled',
      message: `ACH credit of $${(payment.amount / 100).toFixed(2)} scheduled for ${sendDate} to ${payment.recipientName}`,
    };

  } finally {
    await session.disconnect();
  }
}

/**
 * Get ACH payment status by payment_schedule_id
 */
export async function getAchPaymentStatus(transactionId: string): Promise<AchStatusResponse> {
  const session = new OpenACHSession();
  await session.connect();
  try {
    const res = await session.request('getPaymentSchedule', {
      payment_schedule_id: transactionId,
    });
    if (!res.success) throw new Error(`getPaymentSchedule failed: ${res.error}`);

    const schedule = res as Record<string, string>;
    const statusMap: Record<string, AchStatusResponse['status']> = {
      enabled:    'pending',
      processing: 'submitted',
      complete:   'completed',
      returned:   'returned',
      disabled:   'failed',
    };

    return {
      transactionId,
      status: statusMap[schedule.payment_schedule_status] || 'pending',
      settledAt:    schedule.payment_schedule_last_date || null,
      returnCode:   null,
      returnReason: null,
    };
  } finally {
    await session.disconnect();
  }
}

/**
 * Check if OpenACH is fully configured
 */
export function isOpenAchConfigured(): boolean {
  return !!(OPENACH_API_TOKEN && OPENACH_API_KEY && OPENACH_BASE_URL);
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function getFirstCreditPaymentTypeId(session: OpenACHSession): Promise<string | null> {
  const res = await session.request('getPaymentTypes');
  if (!res.success) return null;

  const types = (Array.isArray(res) ? res : res.data) as Array<Record<string, string>> || [];
  // Prefer credit types (trust disbursements are credits)
  const creditType = types.find(t =>
    (t.payment_type_action || '').toLowerCase() === 'credit' ||
    (t.payment_type_name   || '').toLowerCase().includes('dist') ||
    (t.payment_type_name   || '').toLowerCase().includes('trust')
  );
  return (creditType?.payment_type_id || types[0]?.payment_type_id) ?? null;
}

function getNextBusinessDay(): string {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  // Skip Saturday (6) and Sunday (0)
  while (d.getDay() === 0 || d.getDay() === 6) {
    d.setDate(d.getDate() + 1);
  }
  return d.toISOString().split('T')[0];  // YYYY-MM-DD
}
