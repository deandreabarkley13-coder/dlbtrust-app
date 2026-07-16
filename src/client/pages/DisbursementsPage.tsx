import React, { useEffect, useState, useCallback } from 'react';
import { useApi } from '../hooks/useApi';
import { useAuth } from '../hooks/useAuth';

function formatCurrency(amount: number) {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(amount);
}

export default function DisbursementsPage() {
  const { apiFetch } = useApi();
  const { user } = useAuth();
  const [disbursements, setDisbursements] = useState<any[]>([]);
  const [trusts, setTrusts] = useState<any[]>([]);
  const [beneficiaries, setBeneficiaries] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [showCreate, setShowCreate] = useState(false);
  const [form, setForm] = useState({
    trust_id: '', beneficiary_id: '', amount: '', method: 'ach', description: '',
  });
  const [error, setError] = useState('');

  const canManage = user?.role === 'admin' || user?.role === 'trustee';

  const loadData = useCallback(() => {
    Promise.all([
      apiFetch('/api/disbursements'),
      apiFetch('/api/trusts'),
      apiFetch('/api/beneficiaries'),
    ])
      .then(([d, t, b]) => {
        setDisbursements(d.data || []);
        setTrusts(t.data || []);
        setBeneficiaries(b.data || []);
      })
      .finally(() => setLoading(false));
  }, [apiFetch]);

  useEffect(() => { loadData(); }, [loadData]);

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    try {
      await apiFetch('/api/disbursements', {
        method: 'POST',
        body: JSON.stringify({
          trust_id: form.trust_id,
          beneficiary_id: form.beneficiary_id,
          amount: parseFloat(form.amount),
          method: form.method,
          description: form.description,
        }),
      });
      setShowCreate(false);
      setForm({ trust_id: '', beneficiary_id: '', amount: '', method: 'ach', description: '' });
      loadData();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create disbursement');
    }
  }

  async function handleApprove(id: string) {
    try {
      await apiFetch(`/api/disbursements/${id}/approve`, { method: 'POST' });
      loadData();
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Approval failed');
    }
  }

  async function handleReject(id: string) {
    const reason = prompt('Reason for rejection:');
    if (reason === null) return;
    try {
      await apiFetch(`/api/disbursements/${id}/reject`, {
        method: 'POST',
        body: JSON.stringify({ reason }),
      });
      loadData();
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Rejection failed');
    }
  }

  const filteredBeneficiaries = form.trust_id
    ? beneficiaries.filter((b: any) => b.trust_id === form.trust_id)
    : beneficiaries;

  if (loading) return <div>Loading disbursements...</div>;

  return (
    <div>
      <div className="page-header">
        <h1>Disbursements</h1>
        {canManage && (
          <button className="btn btn-primary" onClick={() => setShowCreate(true)}>
            New Disbursement
          </button>
        )}
      </div>

      {disbursements.length === 0 ? (
        <div className="card empty-state">No disbursements found</div>
      ) : (
        <div className="card">
          <table>
            <thead>
              <tr>
                <th>Beneficiary</th>
                <th>Trust</th>
                <th>Amount</th>
                <th>Method</th>
                <th>Status</th>
                <th>Date</th>
                {canManage && <th>Actions</th>}
              </tr>
            </thead>
            <tbody>
              {disbursements.map((d: any) => (
                <tr key={d.id}>
                  <td>{d.beneficiary_name}</td>
                  <td>{d.trust_name}</td>
                  <td className="currency">{formatCurrency(d.amount)}</td>
                  <td>{d.method.toUpperCase()}</td>
                  <td>
                    <span className={`badge badge-${d.status}`}>{d.status}</span>
                  </td>
                  <td>{new Date(d.created_at).toLocaleDateString()}</td>
                  {canManage && (
                    <td>
                      {d.status === 'pending' && (
                        <>
                          <button
                            className="btn btn-success btn-sm"
                            onClick={() => handleApprove(d.id)}
                            style={{ marginRight: '0.3rem' }}
                          >
                            Approve
                          </button>
                          <button
                            className="btn btn-danger btn-sm"
                            onClick={() => handleReject(d.id)}
                          >
                            Reject
                          </button>
                        </>
                      )}
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {showCreate && (
        <div className="modal-overlay" onClick={() => setShowCreate(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h2>New Disbursement</h2>
            {error && <div className="error-msg">{error}</div>}
            <form onSubmit={handleCreate}>
              <div className="form-group">
                <label>Trust</label>
                <select
                  value={form.trust_id}
                  onChange={(e) => setForm({ ...form, trust_id: e.target.value, beneficiary_id: '' })}
                  required
                >
                  <option value="">Select a trust</option>
                  {trusts.map((t: any) => (
                    <option key={t.id} value={t.id}>{t.name}</option>
                  ))}
                </select>
              </div>
              <div className="form-group">
                <label>Beneficiary</label>
                <select
                  value={form.beneficiary_id}
                  onChange={(e) => setForm({ ...form, beneficiary_id: e.target.value })}
                  required
                >
                  <option value="">Select a beneficiary</option>
                  {filteredBeneficiaries.map((b: any) => (
                    <option key={b.id} value={b.id}>{b.first_name} {b.last_name}</option>
                  ))}
                </select>
              </div>
              <div className="form-row">
                <div className="form-group">
                  <label>Amount ($)</label>
                  <input
                    type="number"
                    min="0.01"
                    step="0.01"
                    value={form.amount}
                    onChange={(e) => setForm({ ...form, amount: e.target.value })}
                    required
                  />
                </div>
                <div className="form-group">
                  <label>Method</label>
                  <select value={form.method} onChange={(e) => setForm({ ...form, method: e.target.value })}>
                    <option value="ach">ACH</option>
                    <option value="check">Check</option>
                    <option value="wire">Wire</option>
                  </select>
                </div>
              </div>
              <div className="form-group">
                <label>Description</label>
                <textarea
                  value={form.description}
                  onChange={(e) => setForm({ ...form, description: e.target.value })}
                  rows={2}
                />
              </div>
              <div className="modal-actions">
                <button type="button" className="btn" onClick={() => setShowCreate(false)}>Cancel</button>
                <button type="submit" className="btn btn-primary">Submit Disbursement</button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
