import React, { useEffect, useState } from 'react';
import { useApi } from '../hooks/useApi';
import { useAuth } from '../hooks/useAuth';

function formatCurrency(amount: number) {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(amount);
}

export default function DashboardPage() {
  const { apiFetch } = useApi();
  const { user } = useAuth();
  const [trusts, setTrusts] = useState<any[]>([]);
  const [disbursements, setDisbursements] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    Promise.all([
      apiFetch('/api/trusts'),
      apiFetch('/api/disbursements?limit=5'),
    ])
      .then(([t, d]) => {
        setTrusts(t.data || []);
        setDisbursements(d.data || []);
      })
      .finally(() => setLoading(false));
  }, [apiFetch]);

  if (loading) return <div>Loading dashboard...</div>;

  const totalBalance = trusts.reduce((sum: number, t: any) => sum + t.balance, 0);
  const pendingCount = disbursements.filter((d: any) => d.status === 'pending').length;

  return (
    <div>
      <div className="page-header">
        <h1>Dashboard</h1>
        <span style={{ color: 'var(--color-text-secondary)' }}>Welcome, {user?.name}</span>
      </div>

      <div className="stats-grid">
        <div className="stat-card">
          <div className="label">Total Trust Balance</div>
          <div className="value currency">{formatCurrency(totalBalance)}</div>
        </div>
        <div className="stat-card">
          <div className="label">Active Trusts</div>
          <div className="value">{trusts.length}</div>
        </div>
        <div className="stat-card">
          <div className="label">Pending Disbursements</div>
          <div className="value">{pendingCount}</div>
        </div>
      </div>

      <div className="card">
        <div className="card-header">
          <h2>Recent Disbursements</h2>
        </div>
        {disbursements.length === 0 ? (
          <div className="empty-state">No disbursements yet</div>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Beneficiary</th>
                <th>Trust</th>
                <th>Amount</th>
                <th>Status</th>
                <th>Date</th>
              </tr>
            </thead>
            <tbody>
              {disbursements.map((d: any) => (
                <tr key={d.id}>
                  <td>{d.beneficiary_name}</td>
                  <td>{d.trust_name}</td>
                  <td className="currency">{formatCurrency(d.amount)}</td>
                  <td>
                    <span className={`badge badge-${d.status}`}>{d.status}</span>
                  </td>
                  <td>{new Date(d.created_at).toLocaleDateString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
