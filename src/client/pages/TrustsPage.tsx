import React, { useEffect, useState } from 'react';
import { useApi } from '../hooks/useApi';
import { useAuth } from '../hooks/useAuth';

function formatCurrency(amount: number) {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(amount);
}

export default function TrustsPage() {
  const { apiFetch } = useApi();
  const { user } = useAuth();
  const [trusts, setTrusts] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [showCreate, setShowCreate] = useState(false);
  const [form, setForm] = useState({ name: '', description: '', balance: '' });
  const [error, setError] = useState('');

  const isAdmin = user?.role === 'admin';

  useEffect(() => {
    apiFetch('/api/trusts')
      .then((json) => setTrusts(json.data || []))
      .finally(() => setLoading(false));
  }, [apiFetch]);

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    try {
      const json = await apiFetch('/api/trusts', {
        method: 'POST',
        body: JSON.stringify({
          name: form.name,
          description: form.description,
          balance: parseFloat(form.balance) || 0,
        }),
      });
      setTrusts((prev) => [...prev, json.data]);
      setShowCreate(false);
      setForm({ name: '', description: '', balance: '' });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create trust');
    }
  }

  if (loading) return <div>Loading trusts...</div>;

  return (
    <div>
      <div className="page-header">
        <h1>Trusts</h1>
        {isAdmin && (
          <button className="btn btn-primary" onClick={() => setShowCreate(true)}>
            New Trust
          </button>
        )}
      </div>

      {trusts.length === 0 ? (
        <div className="card empty-state">No trusts found</div>
      ) : (
        <div className="card">
          <table>
            <thead>
              <tr>
                <th>Name</th>
                <th>Description</th>
                <th>Balance</th>
                <th>Created</th>
              </tr>
            </thead>
            <tbody>
              {trusts.map((t: any) => (
                <tr key={t.id}>
                  <td><strong>{t.name}</strong></td>
                  <td>{t.description}</td>
                  <td className="currency">{formatCurrency(t.balance)}</td>
                  <td>{new Date(t.created_at).toLocaleDateString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {showCreate && (
        <div className="modal-overlay" onClick={() => setShowCreate(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h2>Create Trust</h2>
            {error && <div className="error-msg">{error}</div>}
            <form onSubmit={handleCreate}>
              <div className="form-group">
                <label>Trust Name</label>
                <input
                  value={form.name}
                  onChange={(e) => setForm({ ...form, name: e.target.value })}
                  required
                  autoFocus
                />
              </div>
              <div className="form-group">
                <label>Description</label>
                <textarea
                  value={form.description}
                  onChange={(e) => setForm({ ...form, description: e.target.value })}
                  rows={3}
                />
              </div>
              <div className="form-group">
                <label>Initial Balance ($)</label>
                <input
                  type="number"
                  min="0"
                  step="0.01"
                  value={form.balance}
                  onChange={(e) => setForm({ ...form, balance: e.target.value })}
                />
              </div>
              <div className="modal-actions">
                <button type="button" className="btn" onClick={() => setShowCreate(false)}>
                  Cancel
                </button>
                <button type="submit" className="btn btn-primary">
                  Create Trust
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
