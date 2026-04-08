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

function authHeaders() {
  return { Authorization: `Bearer ${localStorage.getItem('admin_token')}` };
}

export default function AdminDashboard() {
  const navigate = useNavigate();
  const { zarPerSat } = usePriceFeed();
  const [users, setUsers] = useState<UserRow[]>([]);
  const [systemBalance, setSystemBalance] = useState<number | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [newUsername, setNewUsername] = useState('');
  const [newDisplayName, setNewDisplayName] = useState('');
  const [createError, setCreateError] = useState('');

  async function load() {
    const res = await fetch('/api/admin/dashboard', { headers: authHeaders() });
    const data = await res.json();
    setUsers(data.users ?? []);
    setSystemBalance(data.systemBalance ?? null);
  }

  useEffect(() => { load(); }, []);

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

      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
        <h2 style={{ fontSize: 16 }}>Users ({users.length})</h2>
        <button className="btn-primary" onClick={() => setShowCreate(true)}>+ New User</button>
      </div>

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

      <div className="card">
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
            {users.map((u) => (
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
            {users.length === 0 && (
              <tr><td colSpan={5} className="muted" style={{ textAlign: 'center', padding: 32 }}>No users yet</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
