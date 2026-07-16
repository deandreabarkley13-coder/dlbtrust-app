export type UserRole = 'admin' | 'trustee' | 'beneficiary' | 'viewer';

export type DisbursementStatus = 'pending' | 'approved' | 'processing' | 'completed' | 'rejected' | 'failed';

export type DisbursementMethod = 'ach' | 'check' | 'wire';

export interface Trust {
  id: string;
  name: string;
  description: string;
  balance: number;
  created_at: string;
  updated_at: string;
}

export interface Beneficiary {
  id: string;
  trust_id: string;
  first_name: string;
  last_name: string;
  email: string;
  phone: string | null;
  address_line1: string;
  address_line2: string | null;
  city: string;
  state: string;
  zip: string;
  routing_number: string | null;
  account_number_last4: string | null;
  account_type: 'checking' | 'savings' | null;
  created_at: string;
  updated_at: string;
}

export interface Disbursement {
  id: string;
  trust_id: string;
  beneficiary_id: string;
  amount: number;
  method: DisbursementMethod;
  status: DisbursementStatus;
  description: string;
  requested_by: string;
  approved_by: string | null;
  ach_transaction_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface Transaction {
  id: string;
  trust_id: string;
  disbursement_id: string | null;
  type: 'credit' | 'debit';
  amount: number;
  description: string;
  reference_id: string | null;
  created_at: string;
}

export interface AppUser {
  id: string;
  email: string;
  name: string;
  role: UserRole;
  created_at: string;
  updated_at: string;
}

export interface AuditLog {
  id: string;
  user_id: string;
  action: string;
  entity_type: string;
  entity_id: string;
  details: string | null;
  created_at: string;
}

export interface ApiResponse<T> {
  data?: T;
  error?: string;
}

export interface PaginatedResponse<T> {
  data: T[];
  total: number;
  page: number;
  limit: number;
}
