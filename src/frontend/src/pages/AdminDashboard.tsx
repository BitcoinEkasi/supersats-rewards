import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { usePriceFeed, formatZAR } from '../hooks/usePriceFeed';

interface UserRow {
  id: number;
  username: string;
  display_name: string;
  balance_sats: number;
  ln_payout_address: string | null;
  card_id: number | null;
  card_number: string | null;
  programmed_at: number | null;
  card_enabled: number | null;
  wiped_at: number | null;
  setup_token: string | null;
}

interface BlinkTx {
  id: string;
  status: string;
  direction: 'SEND' | 'RECEIVE';
  memo: string | null;
  settlementAmount: number;
  settlementFee: number;
  createdAt: number;
}

function authHeaders() {
  return { Authorization: `Bearer ${localStorage.getItem('admin_token')}` };
}

const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
function formatTs(unix: number) {
  const d = new Date(unix * 1000);
  return `${String(d.getDate()).padStart(2,'0')} ${MONTHS[d.getMonth()]} '${String(d.getFullYear()).slice(-2)}`;
}

export default function AdminDashboard() {
  const navigate = useNavigate();
  const { zarPerSat } = usePriceFeed();
  const [users, setUsers] = useState<UserRow[]>([]);
  const [systemBalance, setSystemBalance] = useState<number | null>(null);
  const [search, setSearch] = useState('');
  const [showCreate, setShowCreate] = useState(false);
  const [newUsername, setNewUsername] = useState('');
  const [newDisplayName, setNewDisplayName] = useState('');
  const [createError, setCreateError] = useState('');
  const [blinkTxs, setBlinkTxs] = useState<BlinkTx[] | null>(null);
  const [blinkError, setBlinkError] = useState('');

  async function load() {
    const res = await fetch('/api/admin/dashboard', { headers: authHeaders() });
    const data = await res.json();
    setUsers(data.users ?? []);
    setSystemBalance(data.systemBalance ?? null);
  }

  async function loadBlinkTxs() {
    try {
      const res = await fetch('/api/admin/blink-transactions', { headers: authHeaders() });
      const data = await res.json();
      if (!res.ok) { setBlinkError(data.error ?? 'Failed to load'); return; }
      setBlinkTxs(data);
    } catch {
      setBlinkError('Network error');
    }
  }

  useEffect(() => { load(); loadBlinkTxs(); }, []);

  async function createUser(e: React.FormEvent) {
    e.preventDefault();
    setCreateError('');
    const res = await fetch('/api/admin/users', {
      method: 'POST',
      headers: { ...authHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: newUsername, display_name: newDisplayName }),
    });
    const data = await res.json();
    if (!res.ok) { setCreateError(data.error); return; }
    setShowCreate(false);
    setNewUsername('');
    setNewDisplayName('');
    load();
  }

  function logout() {
    localStorage.removeItem('admin_token');
    navigate('/admin/login');
  }

  function cardStatus(row: UserRow) {
    if (!row.card_id) return <span className="badge" style={{ background: '#333', color: '#aaa' }}>No card</span>;
    if (row.setup_token || !row.programmed_at) return <span className="badge badge-yellow">Awaiting programming</span>;
    if (row.wiped_at) return <span className="badge" style={{ background: '#b45309', color: '#fff' }}>Wiped</span>;
    if (!row.card_enabled) return <span className="badge badge-red">Disabled</span>;
    return <span className="badge badge-green">Active</span>;
  }

  const filtered = users.filter((u) => {
    const q = search.toLowerCase();
    return !q || u.username.includes(q) || u.display_name.toLowerCase().includes(q);
  });

  return (
    <div className="page">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 24 }}>
        <h1 style={{ fontSize: 22 }}>⚡ BoltCard Admin</h1>
        <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
          {systemBalance !== null && (
            <span className="muted">
              Blink: <strong style={{ color: '#f0f0f0' }}>{systemBalance.toLocaleString()} sats</strong>
              {zarPerSat && <span style={{ color: '#888', marginLeft: 6 }}>({formatZAR(systemBalance, zarPerSat)})</span>}
            </span>
          )}
          <button className="btn-ghost" onClick={logout}>Logout</button>
        </div>
      </div>

      {/* ── Users ── */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
        <h2 style={{ fontSize: 16 }}>Users ({users.length})</h2>
        <button className="btn-primary" onClick={() => setShowCreate(true)}>+ New User</button>
      </div>

      <input
        placeholder="Search by username or name…"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        style={{ marginBottom: 12, width: '100%' }}
      />

      {showCreate && (
        <div className="card" style={{ marginBottom: 16 }}>
          <h3 style={{ marginBottom: 12 }}>Create User</h3>
          <form onSubmit={createUser} style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
            <input
              style={{ flex: '1 1 160px' }}
              placeholder="username (lowercase)"
              value={newUsername}
              onChange={(e) => setNewUsername(e.target.value.toLowerCase())}
              required
            />
            <input
              style={{ flex: '1 1 160px' }}
              placeholder="Display name"
              value={newDisplayName}
              onChange={(e) => setNewDisplayName(e.target.value)}
              required
            />
            <button type="submit" className="btn-primary">Create</button>
            <button type="button" className="btn-ghost" onClick={() => setShowCreate(false)}>Cancel</button>
          </form>
          {createError && <p className="error-text" style={{ marginTop: 8 }}>{createError}</p>}
        </div>
      )}

      <div className="card" style={{ marginBottom: 24 }}>
        <table>
          <thead>
            <tr>
              <th>Username</th>
              <th>Display Name</th>
              <th>Balance</th>
              <th>Card / LN</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((u) => (
              <tr key={u.id} style={{ cursor: 'pointer' }} onClick={() => navigate(`/admin/users/${u.id}`)}>
                <td><code>{u.username}</code></td>
                <td>{u.display_name}</td>
                <td>
                  {u.balance_sats.toLocaleString()} sats
                  {zarPerSat && <span className="muted" style={{ marginLeft: 6 }}>({formatZAR(u.balance_sats, zarPerSat)})</span>}
                </td>
                <td>
                  {u.ln_payout_address ? (
                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                      <span className="badge" style={{ background: '#1a3a2a', color: '#4ade80' }}>⚡ LN</span>
                      <code style={{ fontSize: 11, color: '#888' }}>{u.ln_payout_address}</code>
                    </span>
                  ) : (
                    <>
                      {cardStatus(u)}
                      {u.card_number && <code style={{ marginLeft: 8, fontSize: 11, color: '#888' }}>{u.card_number}</code>}
                    </>
                  )}
                </td>
                <td style={{ textAlign: 'right' }}>
                  <span style={{ color: '#f7931a', fontSize: 13 }}>View →</span>
                </td>
              </tr>
            ))}
            {filtered.length === 0 && (
              <tr><td colSpan={5} className="muted" style={{ textAlign: 'center', padding: 32 }}>
                {search ? 'No users match your search' : 'No users yet'}
              </td></tr>
            )}
          </tbody>
        </table>
      </div>

      {/* ── Blink account transactions ── */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
        <h2 style={{ fontSize: 16 }}>Blink Account — skredit@blink.sv</h2>
        <button className="btn-ghost" style={{ fontSize: 12 }} onClick={loadBlinkTxs}>↻ Refresh</button>
      </div>

      <div className="card">
        {blinkError && <p className="error-text">{blinkError}</p>}
        {!blinkTxs && !blinkError && <p className="muted" style={{ padding: 16, textAlign: 'center' }}>Loading…</p>}
        {blinkTxs && (
          <table>
            <thead>
              <tr>
                <th>Date</th>
                <th>Direction</th>
                <th>Amount</th>
                <th>Fee</th>
                <th>Memo</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {blinkTxs.map((tx) => (
                <tr key={tx.id}>
                  <td className="muted" style={{ whiteSpace: 'nowrap' }}>{formatTs(tx.createdAt)}</td>
                  <td>
                    {tx.direction === 'RECEIVE' ? (
                      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, color: '#4ade80' }}>
                        <svg xmlns="http://www.w3.org/2000/svg" style={{ width: 13, height: 13 }} viewBox="0 0 20 20" fill="currentColor">
                          <path fillRule="evenodd" d="M10 3a1 1 0 01.707.293l6 6a1 1 0 01-1.414 1.414L11 6.414V16a1 1 0 11-2 0V6.414L4.707 10.707a1 1 0 01-1.414-1.414l6-6A1 1 0 0110 3z" clipRule="evenodd" transform="rotate(180 10 10)" />
                        </svg>
                        In
                      </span>
                    ) : (
                      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, color: '#f87171' }}>
                        <svg xmlns="http://www.w3.org/2000/svg" style={{ width: 13, height: 13 }} viewBox="0 0 20 20" fill="currentColor">
                          <path fillRule="evenodd" d="M10 3a1 1 0 01.707.293l6 6a1 1 0 01-1.414 1.414L11 6.414V16a1 1 0 11-2 0V6.414L4.707 10.707a1 1 0 01-1.414-1.414l6-6A1 1 0 0110 3z" clipRule="evenodd" />
                        </svg>
                        Out
                      </span>
                    )}
                  </td>
                  <td style={{ color: tx.direction === 'RECEIVE' ? '#4ade80' : '#f0f0f0', fontWeight: 500 }}>
                    {tx.direction === 'RECEIVE' ? '+' : '−'}{Math.abs(tx.settlementAmount).toLocaleString()} sats
                    {zarPerSat && <span className="muted" style={{ marginLeft: 6, fontWeight: 400 }}>({formatZAR(Math.abs(tx.settlementAmount), zarPerSat)})</span>}
                  </td>
                  <td className="muted">{tx.settlementFee > 0 ? `${tx.settlementFee} sats` : '—'}</td>
                  <td className="muted" style={{ maxWidth: 220, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{tx.memo ?? '—'}</td>
                  <td>
                    <span className={`badge ${tx.status === 'SUCCESS' ? 'badge-green' : tx.status === 'PENDING' ? 'badge-yellow' : 'badge-red'}`}>
                      {tx.status.toLowerCase()}
                    </span>
                  </td>
                </tr>
              ))}
              {blinkTxs.length === 0 && (
                <tr><td colSpan={6} className="muted" style={{ textAlign: 'center', padding: 32 }}>No transactions</td></tr>
              )}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
