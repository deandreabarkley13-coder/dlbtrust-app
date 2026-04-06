const OPENACH_API_URL = process.env.OPENACH_API_URL || '';
const OPENACH_API_KEY = process.env.OPENACH_API_KEY || '';
const OPENACH_ORIGINATOR_ID = process.env.OPENACH_ORIGINATOR_ID || '';

export interface AchPaymentRequest {
  amount: number;
  routingNumber: string;
  accountNumber: string;
  accountType: 'checking' | 'savings';
  recipientName: string;
  description: string;
  referenceId: string;
}

export interface AchPaymentResponse {
  transactionId: string;
  status: 'pending' | 'submitted' | 'completed' | 'returned' | 'failed';
  message: string;
}

export interface AchStatusResponse {
  transactionId: string;
  status: 'pending' | 'submitted' | 'completed' | 'returned' | 'failed';
  settledAt: string | null;
  returnCode: string | null;
  returnReason: string | null;
}

async function openachFetch(endpoint: string, options: RequestInit = {}): Promise<Response> {
  if (!OPENACH_API_URL) {
    throw new Error('OpenACH API URL is not configured');
  }

  const url = `${OPENACH_API_URL}${endpoint}`;
  const response = await fetch(url, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${OPENACH_API_KEY}`,
      ...options.headers,
    },
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`OpenACH API error ${response.status}: ${body}`);
  }

  return response;
}

export async function initiateAchPayment(payment: AchPaymentRequest): Promise<AchPaymentResponse> {
  const response = await openachFetch('/payments', {
    method: 'POST',
    body: JSON.stringify({
      originator_id: OPENACH_ORIGINATOR_ID,
      amount: Math.round(payment.amount * 100),
      routing_number: payment.routingNumber,
      account_number: payment.accountNumber,
      account_type: payment.accountType,
      receiver_name: payment.recipientName,
      transaction_type: 'credit',
      description: payment.description,
      external_id: payment.referenceId,
    }),
  });

  const data = await response.json() as { id: string; status: string; message: string };
  return {
    transactionId: data.id,
    status: data.status as AchPaymentResponse['status'],
    message: data.message || 'Payment submitted',
  };
}

export async function getAchPaymentStatus(transactionId: string): Promise<AchStatusResponse> {
  const response = await openachFetch(`/payments/${transactionId}`);
  const data = await response.json() as {
    id: string;
    status: string;
    settled_at: string | null;
    return_code: string | null;
    return_reason: string | null;
  };

  return {
    transactionId: data.id,
    status: data.status as AchStatusResponse['status'],
    settledAt: data.settled_at,
    returnCode: data.return_code,
    returnReason: data.return_reason,
  };
}

export function isOpenAchConfigured(): boolean {
  return !!(OPENACH_API_URL && OPENACH_API_KEY && OPENACH_ORIGINATOR_ID);
}
