import React, { useEffect, useState } from 'react';
import { BrowserRouter, Routes, Route, NavLink } from 'react-router-dom';

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

interface Wallet {
  wallet_id: string;
  name: string;
  role: string;
  balance_usd: number | null;
  balance_cents: number;
}

interface AnalyticsSummary {
  trust_name: string;
  portfolio: {
    total_usd: number | null;
    trust_primary_usd: number | null;
    beneficiary_total_usd: number | null;
    total_wallets: number;
  };
  transactions: {
    total_count: number;
    total_credits_usd: number | null;
    total_debits_usd: number | null;
    net_flow_usd: number | null;
  };
  distributions: {
    count: number;
    total_usd: number | null;
  };
}

interface Bond {
  id: number;
  bond_name: string;
  issuer: string;
  face_value: number;
  coupon_rate: number;
  frequency: string;
  issue_date: string;
  maturity_date: string;
  status: string;
}

interface PaymentType {
  payment_type_id?: string;
  payment_type_name?: string;
  id?: string;
  name?: string;
}

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

const usd = (v: number | null | undefined) =>
  v != null ? `$${Number(v).toLocaleString('en-US', { minimumFractionDigits: 2 })}` : '—';

async function api<T>(url: string): Promise<T | null> {
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ */
/*  Styles                                                             */
/* ------------------------------------------------------------------ */

const styles: Record<string, React.CSSProperties> = {
  app: {
    fontFamily: "'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
    background: '#0f172a',
    color: '#e2e8f0',
    minHeight: '100vh',
    display: 'flex',
  },
  sidebar: {
    width: 240,
    background: '#1e293b',
    borderRight: '1px solid #334155',
    padding: '24px 0',
    display: 'flex',
    flexDirection: 'column',
    flexShrink: 0,
  },
  logo: {
    padding: '0 24px 24px',
    borderBottom: '1px solid #334155',
    marginBottom: 16,
  },
  logoTitle: {
    fontSize: 18,
    fontWeight: 700,
    color: '#38bdf8',
    margin: 0,
  },
  logoSub: {
    fontSize: 11,
    color: '#94a3b8',
    margin: '4px 0 0',
    letterSpacing: '0.05em',
    textTransform: 'uppercase' as const,
  },
  navLink: {
    display: 'block',
    padding: '10px 24px',
    color: '#94a3b8',
    textDecoration: 'none',
    fontSize: 14,
    fontWeight: 500,
    borderLeft: '3px solid transparent',
    transition: 'all 0.15s',
  },
  navLinkActive: {
    color: '#38bdf8',
    background: '#0f172a',
    borderLeftColor: '#38bdf8',
  },
  main: {
    flex: 1,
    padding: '32px 40px',
    overflowY: 'auto' as const,
    maxHeight: '100vh',
  },
  pageTitle: {
    fontSize: 24,
    fontWeight: 700,
    marginBottom: 24,
    color: '#f1f5f9',
  },
  grid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))',
    gap: 20,
    marginBottom: 32,
  },
  card: {
    background: '#1e293b',
    borderRadius: 12,
    padding: 24,
    border: '1px solid #334155',
  },
  cardLabel: {
    fontSize: 12,
    color: '#94a3b8',
    textTransform: 'uppercase' as const,
    letterSpacing: '0.05em',
    marginBottom: 8,
  },
  cardValue: {
    fontSize: 28,
    fontWeight: 700,
    color: '#f1f5f9',
  },
  table: {
    width: '100%',
    borderCollapse: 'collapse' as const,
    fontSize: 14,
  },
  th: {
    textAlign: 'left' as const,
    padding: '10px 12px',
    borderBottom: '1px solid #334155',
    color: '#94a3b8',
    fontSize: 12,
    textTransform: 'uppercase' as const,
    letterSpacing: '0.05em',
  },
  td: {
    padding: '10px 12px',
    borderBottom: '1px solid #1e293b',
  },
  badge: {
    display: 'inline-block',
    padding: '2px 10px',
    borderRadius: 9999,
    fontSize: 12,
    fontWeight: 600,
  },
  btn: {
    background: '#38bdf8',
    color: '#0f172a',
    border: 'none',
    borderRadius: 8,
    padding: '10px 20px',
    fontWeight: 600,
    cursor: 'pointer',
    fontSize: 14,
  },
  input: {
    background: '#0f172a',
    border: '1px solid #334155',
    borderRadius: 8,
    padding: '8px 12px',
    color: '#e2e8f0',
    fontSize: 14,
    width: '100%',
    boxSizing: 'border-box' as const,
  },
  formGroup: {
    marginBottom: 16,
  },
  label: {
    display: 'block',
    fontSize: 12,
    color: '#94a3b8',
    marginBottom: 4,
    textTransform: 'uppercase' as const,
    letterSpacing: '0.04em',
  },
  emptyState: {
    textAlign: 'center' as const,
    padding: 48,
    color: '#64748b',
  },
};

/* ------------------------------------------------------------------ */
/*  Dashboard Page                                                     */
/* ------------------------------------------------------------------ */

function Dashboard() {
  const [summary, setSummary] = useState<AnalyticsSummary | null>(null);
  const [wallets, setWallets] = useState<Wallet[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    Promise.all([
      api<AnalyticsSummary>('/api/analytics/summary'),
      api<{ wallets: Wallet[] }>('/api/analytics/wallets'),
    ]).then(([s, w]) => {
      setSummary(s);
      setWallets(w?.wallets ?? []);
      setLoading(false);
    });
  }, []);

  if (loading) return <p style={{ color: '#94a3b8' }}>Loading dashboard...</p>;

  return (
    <>
      <h1 style={styles.pageTitle}>Dashboard</h1>

      <div style={styles.grid}>
        <div style={styles.card}>
          <div style={styles.cardLabel}>Total Portfolio</div>
          <div style={styles.cardValue}>{usd(summary?.portfolio?.total_usd)}</div>
        </div>
        <div style={styles.card}>
          <div style={styles.cardLabel}>Trust Primary</div>
          <div style={styles.cardValue}>{usd(summary?.portfolio?.trust_primary_usd)}</div>
        </div>
        <div style={styles.card}>
          <div style={styles.cardLabel}>Beneficiary Total</div>
          <div style={styles.cardValue}>{usd(summary?.portfolio?.beneficiary_total_usd)}</div>
        </div>
        <div style={styles.card}>
          <div style={styles.cardLabel}>Transactions</div>
          <div style={styles.cardValue}>{summary?.transactions?.total_count ?? '—'}</div>
        </div>
        <div style={styles.card}>
          <div style={styles.cardLabel}>Net Flow</div>
          <div style={styles.cardValue}>{usd(summary?.transactions?.net_flow_usd)}</div>
        </div>
        <div style={styles.card}>
          <div style={styles.cardLabel}>Distributions</div>
          <div style={styles.cardValue}>{summary?.distributions?.count ?? '—'}</div>
        </div>
      </div>

      <h2 style={{ ...styles.pageTitle, fontSize: 18 }}>Wallets</h2>
      {wallets.length === 0 ? (
        <div style={styles.emptyState}>No wallet data available.</div>
      ) : (
        <table style={styles.table}>
          <thead>
            <tr>
              <th style={styles.th}>ID</th>
              <th style={styles.th}>Name</th>
              <th style={styles.th}>Role</th>
              <th style={styles.th}>Balance</th>
            </tr>
          </thead>
          <tbody>
            {wallets.map((w) => (
              <tr key={w.wallet_id}>
                <td style={styles.td}>{w.wallet_id}</td>
                <td style={styles.td}>{w.name}</td>
                <td style={styles.td}>
                  <span
                    style={{
                      ...styles.badge,
                      background: w.role === 'trust_entity' ? '#164e63' : w.role === 'beneficiary' ? '#1e3a5f' : '#312e81',
                      color: w.role === 'trust_entity' ? '#67e8f9' : w.role === 'beneficiary' ? '#7dd3fc' : '#a5b4fc',
                    }}
                  >
                    {w.role}
                  </span>
                </td>
                <td style={styles.td}>{usd(w.balance_usd)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}

/* ------------------------------------------------------------------ */
/*  Bonds Page                                                         */
/* ------------------------------------------------------------------ */

function BondsPage() {
  const [bonds, setBonds] = useState<Bond[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({
    bond_name: '',
    issuer: 'DEANDREA LAVAR BARKLEY TRUST',
    face_value: '',
    coupon_rate: '',
    frequency: 'semi-annual',
    issue_date: '',
    maturity_date: '',
  });

  const load = () => {
    api<{ bonds: Bond[] } | Bond[]>('/api/bonds').then((data) => {
      if (Array.isArray(data)) setBonds(data);
      else if (data && 'bonds' in data) setBonds(data.bonds);
      else setBonds([]);
      setLoading(false);
    });
  };

  useEffect(load, []);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    await fetch('/api/bonds', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...form,
        face_value: parseFloat(form.face_value),
        coupon_rate: parseFloat(form.coupon_rate),
      }),
    });
    setShowForm(false);
    setForm({ bond_name: '', issuer: 'DEANDREA LAVAR BARKLEY TRUST', face_value: '', coupon_rate: '', frequency: 'semi-annual', issue_date: '', maturity_date: '' });
    load();
  };

  return (
    <>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 24 }}>
        <h1 style={{ ...styles.pageTitle, marginBottom: 0 }}>Bond Master</h1>
        <button style={styles.btn} onClick={() => setShowForm(!showForm)}>
          {showForm ? 'Cancel' : '+ Create Bond'}
        </button>
      </div>

      {showForm && (
        <form onSubmit={submit} style={{ ...styles.card, marginBottom: 24 }}>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
            <div style={styles.formGroup}>
              <label style={styles.label}>Bond Name</label>
              <input style={styles.input} required value={form.bond_name} onChange={(e) => setForm({ ...form, bond_name: e.target.value })} />
            </div>
            <div style={styles.formGroup}>
              <label style={styles.label}>Issuer</label>
              <input style={styles.input} value={form.issuer} onChange={(e) => setForm({ ...form, issuer: e.target.value })} />
            </div>
            <div style={styles.formGroup}>
              <label style={styles.label}>Face Value ($)</label>
              <input style={styles.input} type="number" step="0.01" required value={form.face_value} onChange={(e) => setForm({ ...form, face_value: e.target.value })} />
            </div>
            <div style={styles.formGroup}>
              <label style={styles.label}>Coupon Rate (%)</label>
              <input style={styles.input} type="number" step="0.01" required value={form.coupon_rate} onChange={(e) => setForm({ ...form, coupon_rate: e.target.value })} />
            </div>
            <div style={styles.formGroup}>
              <label style={styles.label}>Frequency</label>
              <select style={styles.input} value={form.frequency} onChange={(e) => setForm({ ...form, frequency: e.target.value })}>
                <option value="monthly">Monthly</option>
                <option value="quarterly">Quarterly</option>
                <option value="semi-annual">Semi-Annual</option>
                <option value="annual">Annual</option>
              </select>
            </div>
            <div style={styles.formGroup}>
              <label style={styles.label}>Issue Date</label>
              <input style={styles.input} type="date" required value={form.issue_date} onChange={(e) => setForm({ ...form, issue_date: e.target.value })} />
            </div>
            <div style={styles.formGroup}>
              <label style={styles.label}>Maturity Date</label>
              <input style={styles.input} type="date" required value={form.maturity_date} onChange={(e) => setForm({ ...form, maturity_date: e.target.value })} />
            </div>
          </div>
          <button type="submit" style={{ ...styles.btn, marginTop: 8 }}>Create Bond</button>
        </form>
      )}

      {loading ? (
        <p style={{ color: '#94a3b8' }}>Loading bonds...</p>
      ) : bonds.length === 0 ? (
        <div style={styles.emptyState}>No bonds created yet.</div>
      ) : (
        <table style={styles.table}>
          <thead>
            <tr>
              <th style={styles.th}>ID</th>
              <th style={styles.th}>Name</th>
              <th style={styles.th}>Issuer</th>
              <th style={styles.th}>Face Value</th>
              <th style={styles.th}>Coupon</th>
              <th style={styles.th}>Frequency</th>
              <th style={styles.th}>Maturity</th>
              <th style={styles.th}>Status</th>
            </tr>
          </thead>
          <tbody>
            {bonds.map((b) => (
              <tr key={b.id}>
                <td style={styles.td}>{b.id}</td>
                <td style={styles.td}>{b.bond_name}</td>
                <td style={styles.td}>{b.issuer}</td>
                <td style={styles.td}>{usd(b.face_value)}</td>
                <td style={styles.td}>{b.coupon_rate}%</td>
                <td style={styles.td}>{b.frequency}</td>
                <td style={styles.td}>{b.maturity_date}</td>
                <td style={styles.td}>
                  <span
                    style={{
                      ...styles.badge,
                      background: b.status === 'active' ? '#064e3b' : '#78350f',
                      color: b.status === 'active' ? '#6ee7b7' : '#fcd34d',
                    }}
                  >
                    {b.status}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}

/* ------------------------------------------------------------------ */
/*  Payments Page                                                      */
/* ------------------------------------------------------------------ */

function PaymentsPage() {
  const [types, setTypes] = useState<PaymentType[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api<{ payment_types: PaymentType[] }>('/api/payments/types').then((data) => {
      setTypes(data?.payment_types ?? []);
      setLoading(false);
    });
  }, []);

  return (
    <>
      <h1 style={styles.pageTitle}>ACH Disbursements</h1>

      <h2 style={{ ...styles.pageTitle, fontSize: 18 }}>Payment Types</h2>
      {loading ? (
        <p style={{ color: '#94a3b8' }}>Loading payment types...</p>
      ) : types.length === 0 ? (
        <div style={styles.emptyState}>
          No payment types configured.
          <br />
          <span style={{ fontSize: 13 }}>
            Connect OpenACH and configure at least one payment type.
          </span>
        </div>
      ) : (
        <div style={styles.grid}>
          {types.map((t, i) => (
            <div key={i} style={styles.card}>
              <div style={styles.cardLabel}>Payment Type</div>
              <div style={{ fontSize: 18, fontWeight: 600, color: '#f1f5f9' }}>
                {t.payment_type_name || t.name || 'Unnamed'}
              </div>
              <div style={{ fontSize: 12, color: '#64748b', marginTop: 4 }}>
                ID: {t.payment_type_id || t.id || '—'}
              </div>
            </div>
          ))}
        </div>
      )}

      <h2 style={{ ...styles.pageTitle, fontSize: 18 }}>Quick Disburse</h2>
      <DisburseForm types={types} />
    </>
  );
}

function DisburseForm({ types }: { types: PaymentType[] }) {
  const [form, setForm] = useState({
    first_name: '',
    last_name: '',
    email: '',
    bank_name: '',
    routing_number: '',
    account_number: '',
    account_type: 'Checking',
    amount: '',
    send_date: '',
    payment_type_id: '',
  });
  const [result, setResult] = useState<string | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setResult(null);
    try {
      const res = await fetch('/api/payments/disburse', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...form, amount: parseFloat(form.amount) }),
      });
      const data = await res.json();
      setResult(data.success ? `Disbursement scheduled: ${data.message || 'OK'}` : `Error: ${data.error}`);
    } catch (err) {
      setResult(`Network error: ${err}`);
    }
  };

  return (
    <form onSubmit={submit} style={{ ...styles.card }}>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 16 }}>
        <div style={styles.formGroup}>
          <label style={styles.label}>First Name</label>
          <input style={styles.input} required value={form.first_name} onChange={(e) => setForm({ ...form, first_name: e.target.value })} />
        </div>
        <div style={styles.formGroup}>
          <label style={styles.label}>Last Name</label>
          <input style={styles.input} required value={form.last_name} onChange={(e) => setForm({ ...form, last_name: e.target.value })} />
        </div>
        <div style={styles.formGroup}>
          <label style={styles.label}>Email</label>
          <input style={styles.input} type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
        </div>
        <div style={styles.formGroup}>
          <label style={styles.label}>Bank Name</label>
          <input style={styles.input} required value={form.bank_name} onChange={(e) => setForm({ ...form, bank_name: e.target.value })} />
        </div>
        <div style={styles.formGroup}>
          <label style={styles.label}>Routing Number</label>
          <input style={styles.input} required pattern="\d{9}" value={form.routing_number} onChange={(e) => setForm({ ...form, routing_number: e.target.value })} />
        </div>
        <div style={styles.formGroup}>
          <label style={styles.label}>Account Number</label>
          <input style={styles.input} required value={form.account_number} onChange={(e) => setForm({ ...form, account_number: e.target.value })} />
        </div>
        <div style={styles.formGroup}>
          <label style={styles.label}>Account Type</label>
          <select style={styles.input} value={form.account_type} onChange={(e) => setForm({ ...form, account_type: e.target.value })}>
            <option value="Checking">Checking</option>
            <option value="Savings">Savings</option>
          </select>
        </div>
        <div style={styles.formGroup}>
          <label style={styles.label}>Amount ($)</label>
          <input style={styles.input} type="number" step="0.01" required value={form.amount} onChange={(e) => setForm({ ...form, amount: e.target.value })} />
        </div>
        <div style={styles.formGroup}>
          <label style={styles.label}>Send Date</label>
          <input style={styles.input} type="date" required value={form.send_date} onChange={(e) => setForm({ ...form, send_date: e.target.value })} />
        </div>
        <div style={styles.formGroup}>
          <label style={styles.label}>Payment Type</label>
          <select style={styles.input} required value={form.payment_type_id} onChange={(e) => setForm({ ...form, payment_type_id: e.target.value })}>
            <option value="">Select...</option>
            {types.map((t, i) => (
              <option key={i} value={t.payment_type_id || t.id || ''}>
                {t.payment_type_name || t.name || 'Type'}
              </option>
            ))}
          </select>
        </div>
      </div>
      <button type="submit" style={{ ...styles.btn, marginTop: 8 }}>Schedule Disbursement</button>
      {result && (
        <div style={{ marginTop: 12, padding: 12, borderRadius: 8, background: result.startsWith('Error') ? '#7f1d1d' : '#064e3b', fontSize: 14 }}>
          {result}
        </div>
      )}
    </form>
  );
}

/* ------------------------------------------------------------------ */
/*  Analytics Page                                                     */
/* ------------------------------------------------------------------ */

function AnalyticsPage() {
  const [summary, setSummary] = useState<AnalyticsSummary | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api<AnalyticsSummary>('/api/analytics/summary').then((s) => {
      setSummary(s);
      setLoading(false);
    });
  }, []);

  if (loading) return <p style={{ color: '#94a3b8' }}>Loading analytics...</p>;
  if (!summary) return <div style={styles.emptyState}>Analytics data unavailable.</div>;

  return (
    <>
      <h1 style={styles.pageTitle}>Analytics</h1>

      <div style={styles.grid}>
        <div style={styles.card}>
          <div style={styles.cardLabel}>Total Portfolio</div>
          <div style={styles.cardValue}>{usd(summary.portfolio?.total_usd)}</div>
          <div style={{ fontSize: 12, color: '#64748b', marginTop: 4 }}>{summary.portfolio?.total_wallets} wallets</div>
        </div>
        <div style={styles.card}>
          <div style={styles.cardLabel}>Total Credits</div>
          <div style={styles.cardValue}>{usd(summary.transactions?.total_credits_usd)}</div>
        </div>
        <div style={styles.card}>
          <div style={styles.cardLabel}>Total Debits</div>
          <div style={styles.cardValue}>{usd(summary.transactions?.total_debits_usd)}</div>
        </div>
        <div style={styles.card}>
          <div style={styles.cardLabel}>Net Flow</div>
          <div style={styles.cardValue}>{usd(summary.transactions?.net_flow_usd)}</div>
        </div>
        <div style={styles.card}>
          <div style={styles.cardLabel}>Distributions</div>
          <div style={{ ...styles.cardValue, fontSize: 22 }}>{summary.distributions?.count} totaling {usd(summary.distributions?.total_usd)}</div>
        </div>
        <div style={styles.card}>
          <div style={styles.cardLabel}>Transaction Count</div>
          <div style={styles.cardValue}>{summary.transactions?.total_count ?? 0}</div>
        </div>
      </div>
    </>
  );
}

/* ------------------------------------------------------------------ */
/*  App Shell                                                          */
/* ------------------------------------------------------------------ */

const navItems = [
  { to: '/', label: 'Dashboard' },
  { to: '/bonds', label: 'Bond Master' },
  { to: '/payments', label: 'ACH Disbursements' },
  { to: '/analytics', label: 'Analytics' },
];

export default function App() {
  return (
    <BrowserRouter>
      <div style={styles.app}>
        <nav style={styles.sidebar}>
          <div style={styles.logo}>
            <p style={styles.logoTitle}>DLB Trust</p>
            <p style={styles.logoSub}>Wealth Management Portal</p>
          </div>
          {navItems.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.to === '/'}
              style={({ isActive }) => ({
                ...styles.navLink,
                ...(isActive ? styles.navLinkActive : {}),
              })}
            >
              {item.label}
            </NavLink>
          ))}
        </nav>
        <main style={styles.main}>
          <Routes>
            <Route path="/" element={<Dashboard />} />
            <Route path="/bonds" element={<BondsPage />} />
            <Route path="/payments" element={<PaymentsPage />} />
            <Route path="/analytics" element={<AnalyticsPage />} />
          </Routes>
        </main>
      </div>
    </BrowserRouter>
  );
}
