import { useState, useEffect } from 'react';
import { usePriceFeed, formatZAR } from '../hooks/usePriceFeed';

const STORAGE_KEY = 'balances_passcode';

interface UserBalance {
  display_name: string;
  balance_sats: number;
  card_id: string | null;
  card_status: 'active' | 'disabled' | 'awaiting' | 'wiped' | 'none';
  division: string | null;
  tsk_level: string | null;
  jc_level: number | null;
}


export default function BalancesView() {
  const { zarPerSat } = usePriceFeed();
  const [passcode, setPasscode] = useState('');
  const [error, setError] = useState('');
  const [users, setUsers] = useState<UserBalance[] | null>(null);
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(false);

  async function fetchBalances(code: string): Promise<boolean> {
    const res = await fetch('/api/balances', { headers: { 'X-Passcode': code } });
    if (!res.ok) return false;
    setUsers(await res.json());
    return true;
  }

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
    if (ok) sessionStorage.setItem(STORAGE_KEY, passcode);
    else setError('Incorrect passcode. Please try again.');
  }

  if (!users) {
    return (
      <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16, background: '#0f0f0f' }}>
        <div className="card" style={{ width: '100%', maxWidth: 340, textAlign: 'center', padding: 28 }}>
          <div style={{ fontSize: 36, marginBottom: 8 }}>⚡</div>
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
              style={{ textAlign: 'center', letterSpacing: 3, fontSize: 16 }}
            />
            {error && <p className="error-text" style={{ margin: 0, fontSize: 13 }}>{error}</p>}
            <button type="submit" className="btn-primary" disabled={loading} style={{ fontSize: 15, padding: '10px 0' }}>
              {loading ? 'Checking…' : 'View Balances'}
            </button>
          </form>
        </div>
      </div>
    );
  }

  const active = users.filter(u => u.card_status === 'active');
  const filtered = active.filter(u =>
    u.display_name.toLowerCase().includes(search.toLowerCase())
  );

  return (
    <div style={{ background: '#0f0f0f', minHeight: '100vh', padding: '16px 12px 40px' }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 16 }}>
        <span style={{ fontSize: 22 }}>⚡</span>
        <h1 style={{ fontSize: 18, fontWeight: 700, margin: 0, color: '#f0f0f0' }}>TSK Balances</h1>
        <span className="muted" style={{ fontSize: 12, marginLeft: 'auto' }}>{active.length} participants</span>
      </div>

      {/* Search with clear button */}
      <div style={{ position: 'relative', marginBottom: 12 }}>
        <input
          type="text"
          placeholder="Search by name…"
          value={search}
          onChange={e => setSearch(e.target.value)}
          style={{ width: '100%', fontSize: 15, padding: '10px 36px 10px 12px', boxSizing: 'border-box' }}
        />
        {search && (
          <button
            onClick={() => setSearch('')}
            style={{ position: 'absolute', right: 8, top: '50%', transform: 'translateY(-50%)', background: 'none', border: 'none', cursor: 'pointer', color: '#888', fontSize: 18, lineHeight: 1, padding: 4 }}
          >×</button>
        )}
      </div>

      {/* List */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {filtered.length === 0 ? (
          <p className="muted" style={{ textAlign: 'center', marginTop: 32 }}>No participants found.</p>
        ) : filtered.map((u) => (
          <div key={u.display_name} className="card" style={{ padding: '12px 14px' }}>
            {/* Top row: name left, sats right */}
            <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 8 }}>
              <div style={{ fontWeight: 700, fontSize: 15, color: '#f0f0f0', lineHeight: 1.3, flex: 1 }}>{u.display_name}</div>
              <div style={{ fontSize: 16, fontWeight: 700, color: '#f7931a', whiteSpace: 'nowrap', flexShrink: 0 }}>
                ⚡ {u.balance_sats.toLocaleString()} sats
              </div>
            </div>

            {/* Second row: meta left, ZAR right — same line */}
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, marginTop: 4 }}>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: '2px 10px' }}>
                <span className="muted" style={{ fontSize: 12 }}>
                  {u.card_id ? <code style={{ color: '#aaa', fontSize: 12 }}>{u.card_id}</code> : <span>—</span>}
                </span>
                {u.division && <span className="muted" style={{ fontSize: 12 }}>{u.division}</span>}
                {u.tsk_level && <span className="muted" style={{ fontSize: 12 }}>{u.tsk_level}</span>}
                {u.jc_level != null && <span className="muted" style={{ fontSize: 12 }}>JC {u.jc_level}</span>}
              </div>
              {zarPerSat && (
                <span className="muted" style={{ fontSize: 12, flexShrink: 0 }}>{formatZAR(u.balance_sats, zarPerSat)}</span>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
