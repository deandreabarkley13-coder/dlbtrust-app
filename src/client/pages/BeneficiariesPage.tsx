import React, { useEffect, useState } from 'react';
import { useApi } from '../hooks/useApi';
import { useAuth } from '../hooks/useAuth';

export default function BeneficiariesPage() {
  const { apiFetch } = useApi();
  const { user } = useAuth();
  const [beneficiaries, setBeneficiaries] = useState<any[]>([]);
  const [trusts, setTrusts] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [showCreate, setShowCreate] = useState(false);
  const [form, setForm] = useState({
    trust_id: '', first_name: '', last_name: '', email: '', phone: '',
    address_line1: '', city: '', state: '', zip: '',
    routing_number: '', account_number: '', account_type: 'checking',
  });
  const [error, setError] = useState('');

  const canManage = user?.role === 'admin' || user?.role === 'trustee';

  useEffect(() => {
    Promise.all([apiFetch('/api/beneficiaries'), apiFetch('/api/trusts')])
      .then(([b, t]) => {
        setBeneficiaries(b.data || []);
        setTrusts(t.data || []);
      })
      .finally(() => setLoading(false));
  }, [apiFetch]);

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    try {
      const json = await apiFetch('/api/beneficiaries', {
        method: 'POST',
        body: JSON.stringify(form),
      });
      setBeneficiaries((prev) => [...prev, json.data]);
      setShowCreate(false);
      setForm({
        trust_id: '', first_name: '', last_name: '', email: '', phone: '',
        address_line1: '', city: '', state: '', zip: '',
        routing_number: '', account_number: '', account_type: 'checking',
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create beneficiary');
    }
  }

  if (loading) return <div>Loading beneficiaries...</div>;

  return (
    <div>
      <div className="page-header">
        <h1>Beneficiaries</h1>
        {canManage && (
          <button className="btn btn-primary" onClick={() => setShowCreate(true)}>
            Add Beneficiary
          </button>
        )}
      </div>

      {beneficiaries.length === 0 ? (
        <div className="card empty-state">No beneficiaries found</div>
      ) : (
        <div className="card">
          <table>
            <thead>
              <tr>
                <th>Name</th>
                <th>Email</th>
                <th>City/State</th>
                <th>Account</th>
              </tr>
            </thead>
            <tbody>
              {beneficiaries.map((b: any) => (
                <tr key={b.id}>
                  <td><strong>{b.first_name} {b.last_name}</strong></td>
                  <td>{b.email}</td>
                  <td>{b.city}{b.state ? `, ${b.state}` : ''}</td>
                  <td>{b.account_type ? `${b.account_type} ****${b.account_number_last4}` : 'Not set'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {showCreate && (
        <div className="modal-overlay" onClick={() => setShowCreate(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h2>Add Beneficiary</h2>
            {error && <div className="error-msg">{error}</div>}
            <form onSubmit={handleCreate}>
              <div className="form-group">
                <label>Trust</label>
                <select
                  value={form.trust_id}
                  onChange={(e) => setForm({ ...form, trust_id: e.target.value })}
                  required
                >
                  <option value="">Select a trust</option>
                  {trusts.map((t: any) => (
                    <option key={t.id} value={t.id}>{t.name}</option>
                  ))}
                </select>
              </div>
              <div className="form-row">
                <div className="form-group">
                  <label>First Name</label>
                  <input value={form.first_name} onChange={(e) => setForm({ ...form, first_name: e.target.value })} required />
                </div>
                <div className="form-group">
                  <label>Last Name</label>
                  <input value={form.last_name} onChange={(e) => setForm({ ...form, last_name: e.target.value })} required />
                </div>
              </div>
              <div className="form-row">
                <div className="form-group">
                  <label>Email</label>
                  <input type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} required />
                </div>
                <div className="form-group">
                  <label>Phone</label>
                  <input value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} />
                </div>
              </div>
              <div className="form-group">
                <label>Address</label>
                <input value={form.address_line1} onChange={(e) => setForm({ ...form, address_line1: e.target.value })} />
              </div>
              <div className="form-row">
                <div className="form-group">
                  <label>City</label>
                  <input value={form.city} onChange={(e) => setForm({ ...form, city: e.target.value })} />
                </div>
                <div className="form-group">
                  <label>State</label>
                  <input value={form.state} onChange={(e) => setForm({ ...form, state: e.target.value })} maxLength={2} />
                </div>
              </div>
              <div className="form-group">
                <label>ZIP Code</label>
                <input value={form.zip} onChange={(e) => setForm({ ...form, zip: e.target.value })} />
              </div>
              <hr style={{ margin: '1rem 0', border: 'none', borderTop: '1px solid var(--color-border)' }} />
              <h3 style={{ fontSize: '0.95rem', marginBottom: '0.75rem' }}>Bank Account (for ACH payments)</h3>
              <div className="form-row">
                <div className="form-group">
                  <label>Routing Number</label>
                  <input value={form.routing_number} onChange={(e) => setForm({ ...form, routing_number: e.target.value })} />
                </div>
                <div className="form-group">
                  <label>Account Number</label>
                  <input value={form.account_number} onChange={(e) => setForm({ ...form, account_number: e.target.value })} />
                </div>
              </div>
              <div className="form-group">
                <label>Account Type</label>
                <select value={form.account_type} onChange={(e) => setForm({ ...form, account_type: e.target.value })}>
                  <option value="checking">Checking</option>
                  <option value="savings">Savings</option>
                </select>
              </div>
              <div className="modal-actions">
                <button type="button" className="btn" onClick={() => setShowCreate(false)}>Cancel</button>
                <button type="submit" className="btn btn-primary">Add Beneficiary</button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
