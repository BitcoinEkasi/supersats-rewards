import { useState, useEffect } from 'react';
import { usePriceFeed, formatZAR } from '../hooks/usePriceFeed';

const STORAGE_KEY = 'balances_passcode';

interface UserBalance {
  display_name: string;
  username: string;
  balance_sats: number;
  card_status: 'active' | 'disabled' | 'awaiting' | 'wiped' | 'none';
}

const cardStatusBadge: Record<string, { label: string; cls: string }> = {
  active:   { label: 'Active',    cls: 'badge-green' },
  disabled: { label: 'Disabled',  cls: 'badge-red' },
  awaiting: { label: 'Awaiting',  cls: 'badge-yellow' },
  wiped:    { label: 'Wiped',     cls: 'badge-gray' },
  none:     { label: 'No card',   cls: 'badge-gray' },
};

export default function BalancesView() {
  const { zarPerSat } = usePriceFeed();
  const [passcode, setPasscode] = useState('');
  const [error, setError] = useState('');
  const [users, setUsers] = useState<UserBalance[] | null>(null);
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(false);

  async function fetchBalances(code: string): Promise<boolean> {
    const res = await fetch('/api/balances', {
      headers: { 'X-Passcode': code },
    });
    if (!res.ok) return false;
    const data = await res.json();
    setUsers(data);
    return true;
  }

  // Try stored passcode on mount
  useEffect(() => {
    const stored = sessionStorage.getItem(STORAGE_KEY);
    if (stored) fetchBalances(stored).then((ok) => { if (!ok) sessionStorage.removeItem(STORAGE_KEY); });
  }, []);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    setLoading(true);
    const ok = await fetchBalances(passcode);
    setLoading(false);
    if (ok) {
      sessionStorage.setItem(STORAGE_KEY, passcode);
    } else {
      setError('Incorrect passcode. Please try again.');
    }
  }

  if (!users) {
    return (
      <div className="page" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: '100vh' }}>
        <div className="card" style={{ width: '100%', maxWidth: 360, textAlign: 'center' }}>
          <div style={{ fontSize: 32, marginBottom: 8 }}>⚡</div>
          <h1 style={{ fontSize: 20, fontWeight: 700, marginBottom: 4 }}>TSK Balances</h1>
          <p className="muted" style={{ marginBottom: 20, fontSize: 13 }}>Enter the passcode to view participant balances.</p>
          <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <input
              type="password"
              placeholder="Passcode"
              value={passcode}
              onChange={e => setPasscode(e.target.value)}
              required
              autoFocus
              style={{ textAlign: 'center', letterSpacing: 2 }}
            />
            {error && <p className="error-text" style={{ margin: 0, fontSize: 13 }}>{error}</p>}
            <button type="submit" className="btn-primary" disabled={loading}>
              {loading ? 'Checking…' : 'View Balances'}
            </button>
          </form>
        </div>
      </div>
    );
  }

  const filtered = users.filter(u =>
    u.display_name.toLowerCase().includes(search.toLowerCase()) ||
    u.username.toLowerCase().includes(search.toLowerCase())
  );

  return (
    <div className="page" style={{ paddingTop: 32, paddingBottom: 40 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 24 }}>
        <span style={{ fontSize: 24 }}>⚡</span>
        <h1 style={{ fontSize: 22, fontWeight: 700, margin: 0 }}>TSK Balances</h1>
        <span className="muted" style={{ fontSize: 13, marginLeft: 'auto' }}>{users.length} participants</span>
      </div>

      <input
        type="text"
        placeholder="Search by name or username…"
        value={search}
        onChange={e => setSearch(e.target.value)}
        style={{ width: '100%', marginBottom: 16, fontSize: 14 }}
      />

      <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
        <table style={{ width: '100%' }}>
          <thead>
            <tr style={{ borderBottom: '1px solid #2a2a2a' }}>
              <th style={{ padding: '10px 16px', textAlign: 'left', fontSize: 12, color: '#888', fontWeight: 500 }}>Participant</th>
              <th style={{ padding: '10px 16px', textAlign: 'right', fontSize: 12, color: '#888', fontWeight: 500 }}>Balance</th>
              <th style={{ padding: '10px 16px', textAlign: 'center', fontSize: 12, color: '#888', fontWeight: 500 }}>Card</th>
            </tr>
          </thead>
          <tbody>
            {filtered.length === 0 ? (
              <tr><td colSpan={3} className="muted" style={{ padding: '24px 16px', textAlign: 'center' }}>No participants found.</td></tr>
            ) : filtered.map((u, i) => {
              const badge = cardStatusBadge[u.card_status] ?? cardStatusBadge.none;
              return (
                <tr key={u.username} style={{ borderTop: i === 0 ? 'none' : '1px solid #1f1f1f' }}>
                  <td style={{ padding: '12px 16px' }}>
                    <div style={{ fontWeight: 600, fontSize: 14 }}>{u.display_name}</div>
                    <div className="muted" style={{ fontSize: 12 }}>@{u.username}</div>
                  </td>
                  <td style={{ padding: '12px 16px', textAlign: 'right' }}>
                    <div style={{ fontWeight: 600, fontSize: 14 }}>{u.balance_sats.toLocaleString()} <span className="muted" style={{ fontSize: 12 }}>sats</span></div>
                    {zarPerSat && <div className="muted" style={{ fontSize: 12 }}>{formatZAR(u.balance_sats, zarPerSat)}</div>}
                  </td>
                  <td style={{ padding: '12px 16px', textAlign: 'center' }}>
                    <span className={`badge ${badge.cls}`}>{badge.label}</span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
