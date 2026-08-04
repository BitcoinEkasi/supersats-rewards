import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { usePriceFeed, formatZAR } from '../hooks/usePriceFeed';
import { formatTs } from '../lib/time';
import MovementsTable, { type Movement } from '../components/MovementsTable';
import { exportMovementsCsv } from '../lib/csvExport';

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
  tsk_group: string | null;
  ac: boolean;
  archived_at: number | null;
}

const TSK_GROUPS = [
  { value: '', label: 'All' },
  { value: 'TURTLES', label: 'Turtles' },
  { value: 'SEALS', label: 'Seals' },
  { value: 'DOLPHINS', label: 'Dolphins' },
  { value: 'SHARKS', label: 'Sharks' },
  { value: 'FREE_SURFERS', label: 'Free Surfers' },
  { value: '__AC__', label: 'Assistant Coaches' },
  { value: '__ARCHIVED__', label: 'Archived' },
];

interface BulkLimitEvent {
  id: number;
  tx_max_sats: number | null;
  day_max_sats: number | null;
  affected_count: number;
  zar_per_sat: number | null;
  created_at: number;
}

interface BlinkTx {
  id: string;
  status: string;
  direction: 'SEND' | 'RECEIVE';
  memo: string | null;
  settlementAmount: number;
  settlementFee: number;
  createdAt: number;
  counterParty: string | null;
}

function authHeaders() {
  return { Authorization: `Bearer ${localStorage.getItem('admin_token')}` };
}

type Tab = 'users' | 'movements' | 'blink';

export default function AdminDashboard() {
  const navigate = useNavigate();
  const { zarPerSat } = usePriceFeed();
  const [tab, setTab] = useState<Tab>('users');
  const [users, setUsers] = useState<UserRow[]>([]);
  const [systemBalance, setSystemBalance] = useState<number | null>(null);
  const [search, setSearch] = useState('');
  const [groupFilter, setGroupFilter] = useState('');
  const [showCreate, setShowCreate] = useState(false);
  const [newUsername, setNewUsername] = useState('');
  const [newDisplayName, setNewDisplayName] = useState('');
  const [createError, setCreateError] = useState('');
  const [blinkTxs, setBlinkTxs] = useState<BlinkTx[] | null>(null);
  const [blinkError, setBlinkError] = useState('');
  const [blinkLoading, setBlinkLoading] = useState(false);
  const [blinkLoadingMore, setBlinkLoadingMore] = useState(false);
  const [blinkCursor, setBlinkCursor] = useState<string | null>(null);
  const [blinkHasMore, setBlinkHasMore] = useState(false);
  const [movements, setMovements] = useState<Movement[] | null>(null);
  const [movementsError, setMovementsError] = useState('');
  const [movementsLoading, setMovementsLoading] = useState(false);
  const [exportingPdf, setExportingPdf] = useState(false);
  const [cardsEnabled, setCardsEnabled] = useState(true);
  const [togglingCards, setTogglingCards] = useState(false);
  const [showBulkLimits, setShowBulkLimits] = useState(false);
  const [bulkTxInput, setBulkTxInput] = useState('');
  const [bulkDayInput, setBulkDayInput] = useState('');
  const [bulkSaving, setBulkSaving] = useState(false);
  const [bulkHistory, setBulkHistory] = useState<BulkLimitEvent[]>([]);
  const [showVelocitySettings, setShowVelocitySettings] = useState(false);
  const [velocityMaxTapsInput, setVelocityMaxTapsInput] = useState('3');
  const [velocityWindowInput, setVelocityWindowInput] = useState('5');
  const [velocitySaving, setVelocitySaving] = useState(false);

  async function load() {
    const res = await fetch('/api/admin/dashboard', { headers: authHeaders() });
    const data = await res.json();
    setUsers(data.users ?? []);
    setSystemBalance(data.systemBalance ?? null);
    setCardsEnabled(data.cardsEnabled ?? true);
    if (data.velocityMaxTaps) setVelocityMaxTapsInput(String(data.velocityMaxTaps));
    if (data.velocityWindowSecs) setVelocityWindowInput(String(Math.round(data.velocityWindowSecs / 60)));
  }

  async function setCardsEnabledRemote(enabled: boolean) {
    setTogglingCards(true);
    try {
      const res = await fetch('/api/admin/system-settings/cards-enabled', {
        method: 'POST',
        headers: { ...authHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled }),
      });
      const data = await res.json();
      setCardsEnabled(data.enabled);
    } finally {
      setTogglingCards(false);
    }
  }

  function handleEmergencyStop() {
    if (!window.confirm('Stop ALL cards from being tapped/spent right now? This can be undone at any time by reactivating.')) {
      return;
    }
    setCardsEnabledRemote(false);
  }

  async function saveVelocitySettings(e: React.FormEvent) {
    e.preventDefault();
    const maxTaps = parseInt(velocityMaxTapsInput);
    const windowMins = parseInt(velocityWindowInput);
    if (!maxTaps || maxTaps <= 0 || !windowMins || windowMins <= 0) {
      alert('Enter valid positive values');
      return;
    }
    setVelocitySaving(true);
    try {
      const res = await fetch('/api/admin/system-settings/velocity-limit', {
        method: 'POST',
        headers: { ...authHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ max_taps: maxTaps, window_secs: windowMins * 60 }),
      });
      const data = await res.json();
      if (!res.ok) { alert(data.error); return; }
      setShowVelocitySettings(false);
    } finally {
      setVelocitySaving(false);
    }
  }

  async function loadBulkHistory() {
    const res = await fetch('/api/admin/cards/limits/bulk/history', { headers: authHeaders() });
    const data = await res.json();
    setBulkHistory(data.history ?? []);
  }

  function toggleBulkLimits() {
    setShowBulkLimits((v) => {
      const next = !v;
      if (next) loadBulkHistory();
      return next;
    });
  }

  async function saveBulkLimits(e: React.FormEvent) {
    e.preventDefault();
    const tx = parseInt(bulkTxInput);
    const day = parseInt(bulkDayInput);
    if ((!bulkTxInput && !bulkDayInput) || (bulkTxInput && (!tx || tx <= 0)) || (bulkDayInput && (!day || day <= 0))) {
      alert('Enter at least one valid positive value');
      return;
    }
    const activeCount = users.filter((u) => u.card_enabled).length;
    if (!window.confirm(`Overwrite spending limits for all ${activeCount} active card(s)? This cannot be undone.`)) return;
    setBulkSaving(true);
    try {
      const res = await fetch('/api/admin/cards/limits/bulk', {
        method: 'PATCH',
        headers: { ...authHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...(bulkTxInput ? { tx_max_sats: tx } : {}),
          ...(bulkDayInput ? { day_max_sats: day } : {}),
        }),
      });
      const data = await res.json();
      if (!res.ok) { alert(data.error); return; }
      alert(`Updated limits on ${data.updated} active card(s).`);
      setBulkTxInput('');
      setBulkDayInput('');
      load();
      loadBulkHistory();
    } finally {
      setBulkSaving(false);
    }
  }

  async function loadBlinkTxs() {
    setBlinkLoading(true);
    setBlinkError('');
    try {
      const res = await fetch('/api/admin/blink-transactions', { headers: authHeaders() });
      const data = await res.json();
      if (!res.ok) { setBlinkError(data.error ?? 'Failed to load'); return; }
      setBlinkTxs(data.transactions);
      setBlinkCursor(data.endCursor);
      setBlinkHasMore(data.hasNextPage);
    } catch {
      setBlinkError('Network error');
    } finally {
      setBlinkLoading(false);
    }
  }

  async function loadMoreBlinkTxs() {
    if (!blinkCursor) return;
    setBlinkLoadingMore(true);
    setBlinkError('');
    try {
      const res = await fetch(`/api/admin/blink-transactions?after=${encodeURIComponent(blinkCursor)}`, { headers: authHeaders() });
      const data = await res.json();
      if (!res.ok) { setBlinkError(data.error ?? 'Failed to load'); return; }
      setBlinkTxs((prev) => [...(prev ?? []), ...data.transactions]);
      setBlinkCursor(data.endCursor);
      setBlinkHasMore(data.hasNextPage);
    } catch {
      setBlinkError('Network error');
    } finally {
      setBlinkLoadingMore(false);
    }
  }

  async function loadMovements() {
    setMovementsLoading(true);
    setMovementsError('');
    try {
      const res = await fetch('/api/admin/movements', { headers: authHeaders() });
      const data = await res.json();
      if (!res.ok) { setMovementsError(data.error ?? 'Failed to load'); return; }
      setMovements(data);
    } catch {
      setMovementsError('Network error');
    } finally {
      setMovementsLoading(false);
    }
  }

  async function handleExportMovementsPdf() {
    if (!movements) return;
    setExportingPdf(true);
    try {
      const { exportMovementsPdf } = await import('../lib/pdfExport');
      exportMovementsPdf(movements);
    } finally {
      setExportingPdf(false);
    }
  }

  useEffect(() => { load(); }, []);

  // Load Blink txs / movements when their tab is first opened
  useEffect(() => {
    if (tab === 'blink' && blinkTxs === null && !blinkLoading) {
      loadBlinkTxs();
    }
    if (tab === 'movements' && movements === null && !movementsLoading) {
      loadMovements();
    }
  }, [tab]);

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
    if (q && !u.username.includes(q) && !u.display_name.toLowerCase().includes(q)) return false;
    if (groupFilter === '__ARCHIVED__') return !!u.archived_at;
    if (u.archived_at) return false;
    if (groupFilter === '__AC__') return u.ac;
    if (groupFilter) return u.tsk_group === groupFilter;
    return true;
  });

  const totalUserBalance = users.reduce((s, u) => s + u.balance_sats, 0);
  const reserveSats = systemBalance !== null ? systemBalance - totalUserBalance : null;

  return (
    <div className="page">
      {/* ── Header ── */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 24, flexWrap: 'wrap', gap: 12 }}>
        <h1 style={{ fontSize: 22 }}>⚡ BoltCard Admin</h1>
        <div style={{ display: 'flex', gap: 16, alignItems: 'center', flexWrap: 'wrap' }}>
          {systemBalance !== null && (
            <>
              <span style={{ fontSize: 12 }}>
                <span className="muted">Wallet </span>
                <strong style={{ color: '#f0f0f0' }}>{systemBalance.toLocaleString()}</strong>
                <span className="muted"> sats</span>
                {zarPerSat && <span style={{ color: '#666', marginLeft: 4 }}>({formatZAR(systemBalance, zarPerSat)})</span>}
              </span>
              <span style={{ color: '#444' }}>·</span>
              <span style={{ fontSize: 12 }}>
                <span className="muted">Issued </span>
                <strong style={{ color: '#f0f0f0' }}>{totalUserBalance.toLocaleString()}</strong>
                <span className="muted"> sats</span>
                {zarPerSat && <span style={{ color: '#666', marginLeft: 4 }}>({formatZAR(totalUserBalance, zarPerSat)})</span>}
              </span>
              <span style={{ color: '#444' }}>·</span>
              <span style={{ fontSize: 12 }}>
                <span className="muted">Reserve </span>
                <strong style={{ color: reserveSats! < 0 ? '#dc2626' : reserveSats! === 0 ? '#facc15' : '#4ade80' }}>
                  {reserveSats!.toLocaleString()}
                </strong>
                <span className="muted"> sats</span>
                {zarPerSat && <span style={{ color: '#666', marginLeft: 4 }}>({formatZAR(reserveSats!, zarPerSat)})</span>}
              </span>
            </>
          )}
          {cardsEnabled ? (
            <button
              className="btn-ghost"
              style={{ color: '#f87171', borderColor: '#f87171' }}
              onClick={handleEmergencyStop}
              disabled={togglingCards}
            >
              {togglingCards ? '…' : '🛑 Emergency Stop'}
            </button>
          ) : (
            <button
              className="btn-primary"
              style={{ background: '#16a34a' }}
              onClick={() => setCardsEnabledRemote(true)}
              disabled={togglingCards}
            >
              {togglingCards ? '…' : '▶ Reactivate All Cards'}
            </button>
          )}
          <button className="btn-ghost" onClick={() => setShowVelocitySettings((v) => !v)}>🔒 Auto-Lock Settings</button>
          <button className="btn-ghost" onClick={logout}>Logout</button>
        </div>
      </div>

      {showVelocitySettings && (
        <div className="card" style={{ marginBottom: 20 }}>
          <h3 style={{ marginBottom: 8 }}>Auto-Lock Settings</h3>
          <p className="muted" style={{ fontSize: 12, marginBottom: 12 }}>
            If a card is tapped this many times within the given window, it is automatically disabled to protect against a lost or stolen card being drained.
          </p>
          <form onSubmit={saveVelocitySettings} style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'flex-end' }}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              <label className="muted" style={{ fontSize: 12 }}>Max taps</label>
              <input
                type="number"
                value={velocityMaxTapsInput}
                onChange={(e) => setVelocityMaxTapsInput(e.target.value)}
                min="1"
                style={{ width: 100 }}
              />
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              <label className="muted" style={{ fontSize: 12 }}>Within (minutes)</label>
              <input
                type="number"
                value={velocityWindowInput}
                onChange={(e) => setVelocityWindowInput(e.target.value)}
                min="1"
                style={{ width: 100 }}
              />
            </div>
            <button type="submit" className="btn-primary" disabled={velocitySaving}>{velocitySaving ? '…' : 'Save'}</button>
            <button type="button" className="btn-ghost" onClick={() => setShowVelocitySettings(false)}>Cancel</button>
          </form>
        </div>
      )}

      {!cardsEnabled && (
        <div style={{
          background: '#450a0a', border: '1px solid #dc2626', borderRadius: 8,
          padding: '10px 16px', marginBottom: 20, color: '#fecaca', fontSize: 13,
        }}>
          ⚠ Card spending is currently disabled for all cards. Balance checks still work, but no card can be tapped to spend until you reactivate.
        </div>
      )}

      {/* ── Tabs ── */}
      <div style={{ display: 'flex', gap: 0, marginBottom: 20, borderBottom: '1px solid #2a2a2a' }}>
        {(['users', 'movements', 'blink'] as Tab[]).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            style={{
              background: 'none',
              border: 'none',
              borderBottom: tab === t ? '2px solid #f7931a' : '2px solid transparent',
              color: tab === t ? '#f7931a' : '#888',
              cursor: 'pointer',
              fontSize: 14,
              fontWeight: tab === t ? 600 : 400,
              padding: '8px 18px',
              marginBottom: -1,
              transition: 'color 0.15s',
            }}
          >
            {t === 'users' ? `Users (${users.length})` : t === 'movements' ? 'Movements' : 'Blink Account'}
          </button>
        ))}
      </div>

      {/* ── Users Tab ── */}
      {tab === 'users' && (
        <>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
            <span />
            <div style={{ display: 'flex', gap: 8 }}>
              <button className="btn-ghost" onClick={toggleBulkLimits}>Set Limits for All Active Cards</button>
              <button className="btn-primary" onClick={() => setShowCreate(true)}>+ New User</button>
            </div>
          </div>

          {showBulkLimits && (
            <div className="card" style={{ marginBottom: 16 }}>
              <h3 style={{ marginBottom: 12 }}>Set Limits for All Active Cards</h3>
              <p className="muted" style={{ fontSize: 12, marginBottom: 12 }}>
                Overwrites the tap/day limit on every currently active card. Leave a field blank to leave that limit unchanged.
              </p>
              <form onSubmit={saveBulkLimits} style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'flex-end' }}>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                  <label className="muted" style={{ fontSize: 12 }}>Per tap (sats)</label>
                  <input
                    type="number"
                    value={bulkTxInput}
                    onChange={(e) => setBulkTxInput(e.target.value)}
                    min="1"
                    style={{ width: 140 }}
                    placeholder="unchanged"
                  />
                  {bulkTxInput && zarPerSat && (
                    <span className="muted" style={{ fontSize: 11 }}>≈ {formatZAR(parseInt(bulkTxInput) || 0, zarPerSat)}</span>
                  )}
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                  <label className="muted" style={{ fontSize: 12 }}>Per day (sats)</label>
                  <input
                    type="number"
                    value={bulkDayInput}
                    onChange={(e) => setBulkDayInput(e.target.value)}
                    min="1"
                    style={{ width: 140 }}
                    placeholder="unchanged"
                  />
                  {bulkDayInput && zarPerSat && (
                    <span className="muted" style={{ fontSize: 11 }}>≈ {formatZAR(parseInt(bulkDayInput) || 0, zarPerSat)}</span>
                  )}
                </div>
                <button type="submit" className="btn-primary" disabled={bulkSaving}>{bulkSaving ? '…' : 'Save'}</button>
                <button type="button" className="btn-ghost" onClick={() => setShowBulkLimits(false)}>Cancel</button>
              </form>

              {bulkHistory.length > 0 && (
                <div style={{ marginTop: 14, borderTop: '1px solid #2a2a2a', paddingTop: 10 }}>
                  <div className="muted" style={{ fontSize: 12, marginBottom: 6 }}>Recent bulk updates</div>
                  {bulkHistory.map((h) => (
                    <div key={h.id} style={{ fontSize: 12, color: '#ccc', marginBottom: 4 }}>
                      <span className="muted">{formatTs(h.created_at)}</span>{' — '}
                      {h.tx_max_sats ? `${h.tx_max_sats.toLocaleString()} sats/tap` : 'tap unchanged'}
                      {h.zar_per_sat && h.tx_max_sats ? ` (${formatZAR(h.tx_max_sats, h.zar_per_sat)})` : ''}
                      {', '}
                      {h.day_max_sats ? `${h.day_max_sats.toLocaleString()} sats/day` : 'day unchanged'}
                      {h.zar_per_sat && h.day_max_sats ? ` (${formatZAR(h.day_max_sats, h.zar_per_sat)})` : ''}
                      {' · '}{h.affected_count} card(s)
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
            <input
              placeholder="Search by username or name…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              style={{ flex: 3 }}
            />
            <select
              value={groupFilter}
              onChange={(e) => setGroupFilter(e.target.value)}
              style={{ flex: 1, background: '#1a1a1a', color: '#f0f0f0', border: '1px solid #333', borderRadius: 6, padding: '6px 10px', fontSize: 13, cursor: 'pointer' }}
            >
              {TSK_GROUPS.map((g) => (
                <option key={g.value} value={g.value}>{g.label}</option>
              ))}
            </select>
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
        </>
      )}

      {/* ── Movements Tab ── */}
      {tab === 'movements' && (
        <>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
            <span className="muted" style={{ fontSize: 13 }}>Internal ledger — card top-ups, card taps, and LN address payouts</span>
            <div style={{ display: 'flex', gap: 8 }}>
              <button
                className="btn-ghost"
                style={{ fontSize: 12 }}
                onClick={() => movements && exportMovementsCsv(movements)}
                disabled={!movements || movements.length === 0}
              >
                ⬇ Export CSV
              </button>
              <button
                className="btn-ghost"
                style={{ fontSize: 12 }}
                onClick={handleExportMovementsPdf}
                disabled={!movements || movements.length === 0 || exportingPdf}
              >
                {exportingPdf ? '…' : '⬇ Export PDF'}
              </button>
              <button className="btn-ghost" style={{ fontSize: 12 }} onClick={loadMovements} disabled={movementsLoading}>
                {movementsLoading ? '…' : '↻ Refresh'}
              </button>
            </div>
          </div>

          <div className="card">
            {movementsError && <p className="error-text">{movementsError}</p>}
            {movementsLoading && <p className="muted" style={{ padding: 16, textAlign: 'center' }}>Loading…</p>}
            {movements && !movementsLoading && <MovementsTable movements={movements} />}
          </div>
        </>
      )}

      {/* ── Blink Account Tab ── */}
      {tab === 'blink' && (
        <>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
            <span className="muted" style={{ fontSize: 13 }}>skredit@blink.sv</span>
            <button className="btn-ghost" style={{ fontSize: 12 }} onClick={loadBlinkTxs} disabled={blinkLoading}>
              {blinkLoading ? '…' : '↻ Refresh'}
            </button>
          </div>

          <div className="card">
            {blinkError && <p className="error-text">{blinkError}</p>}
            {blinkLoading && <p className="muted" style={{ padding: 16, textAlign: 'center' }}>Loading…</p>}
            {blinkTxs && !blinkLoading && (
              <table>
                <thead>
                  <tr>
                    <th>Date</th>
                    <th>Direction</th>
                    <th>From / To</th>
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
                      <td style={{ fontSize: 12 }}>
                        {tx.counterParty ? (
                          <code style={{ color: '#ccc' }}>{tx.counterParty}</code>
                        ) : (
                          <span className="muted">—</span>
                        )}
                      </td>
                      <td style={{ color: tx.direction === 'RECEIVE' ? '#4ade80' : '#f0f0f0', fontWeight: 500 }}>
                        {tx.direction === 'RECEIVE' ? '+' : '−'}{Math.abs(tx.settlementAmount).toLocaleString()} sats
                        {zarPerSat && <span className="muted" style={{ marginLeft: 6, fontWeight: 400 }}>({formatZAR(Math.abs(tx.settlementAmount), zarPerSat)})</span>}
                      </td>
                      <td className="muted">{tx.settlementFee > 0 ? `${tx.settlementFee} sats` : '—'}</td>
                      <td className="muted" style={{ maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{tx.memo ?? '—'}</td>
                      <td>
                        <span className={`badge ${tx.status === 'SUCCESS' ? 'badge-green' : tx.status === 'PENDING' ? 'badge-yellow' : 'badge-red'}`}>
                          {tx.status.toLowerCase()}
                        </span>
                      </td>
                    </tr>
                  ))}
                  {blinkTxs.length === 0 && (
                    <tr><td colSpan={7} className="muted" style={{ textAlign: 'center', padding: 32 }}>No transactions</td></tr>
                  )}
                </tbody>
              </table>
            )}
            {blinkTxs && !blinkLoading && blinkHasMore && (
              <div style={{ textAlign: 'center', padding: 12 }}>
                <button className="btn-ghost" style={{ fontSize: 12 }} onClick={loadMoreBlinkTxs} disabled={blinkLoadingMore}>
                  {blinkLoadingMore ? 'Loading…' : '↓ Load older'}
                </button>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
