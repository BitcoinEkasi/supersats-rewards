import { useEffect, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { usePriceFeed, formatZAR } from '../hooks/usePriceFeed';

function authHeaders() {
  return { Authorization: `Bearer ${localStorage.getItem('admin_token')}` };
}

interface UserDetail {
  id: number;
  username: string;
  display_name: string;
  balance_sats: number;
  magic_link_url: string;
  ln_address_enabled: number;
  card: {
    id: number;
    card_id: string | null;
    uid: string | null;
    counter: number;
    day_spent_sats: number;
    setup_token: string | null;
    wipe_token: string | null;
    programmed_at: number | null;
    enabled: number;
  } | null;
  transactions: {
    id: number;
    type: 'spend' | 'refill';
    amount_sats: number;
    description: string | null;
    created_at: number;
  }[];
}

export default function AdminUserDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { zarPerSat } = usePriceFeed();
  const [user, setUser] = useState<UserDetail | null>(null);
  const [error, setError] = useState('');
  const [creditAmount, setCreditAmount] = useState('');
  const [creditDesc, setCreditDesc] = useState('');
  const [creditError, setCreditError] = useState('');
  const [copied, setCopied] = useState(false);
  const [qrUrl, setQrUrl] = useState<string | null>(null);
  const [wipeQrUrl, setWipeQrUrl] = useState<string | null>(null);
  const [editingCardId, setEditingCardId] = useState(false);
  const [cardIdInput, setCardIdInput] = useState('');

  async function load() {
    const res = await fetch(`/api/admin/users/${id}`, { headers: authHeaders() });
    if (!res.ok) { setError('User not found'); return; }
    const data = await res.json();
    setUser(data);
    if (data.card?.setup_token) {
      const qrRes = await fetch(`/api/admin/users/${id}/card/qr`, { headers: authHeaders() });
      if (qrRes.ok) {
        const blob = await qrRes.blob();
        setQrUrl(URL.createObjectURL(blob));
      }
    } else {
      setQrUrl(null);
    }
    setWipeQrUrl(null);
  }

  useEffect(() => { load(); }, [id]);

  async function createCard(e: React.FormEvent) {
    e.preventDefault();
    const res = await fetch(`/api/admin/users/${id}/card`, {
      method: 'POST',
      headers: { ...authHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    if (!res.ok) {
      const d = await res.json();
      alert(d.error);
      return;
    }
    load();
  }

  async function withdrawAll() {
    if (!user || user.balance_sats <= 0) return;
    if (!confirm(`Withdraw all ${user.balance_sats.toLocaleString()} sats from this account?`)) return;
    const res = await fetch(`/api/admin/users/${id}/withdraw-all`, {
      method: 'POST',
      headers: authHeaders(),
    });
    if (!res.ok) { const d = await res.json(); alert(d.error); return; }
    load();
  }

  async function deleteCard() {
    const choice = window.confirm(
      'Is this card lost or damaged?\n\nOK = Lost / Damaged (delete card)\nCancel = I want to wipe the card for re-use'
    );
    if (choice) {
      // Lost / Damaged — delete
      if (!window.confirm('Delete this card? This cannot be undone.')) return;
      const res = await fetch(`/api/admin/users/${id}/card`, {
        method: 'DELETE',
        headers: authHeaders(),
      });
      if (!res.ok) { const d = await res.json(); alert(d.error); return; }
      load();
    } else {
      // Wipe for re-use
      await wipeCard();
    }
  }

  async function credit(e: React.FormEvent) {
    e.preventDefault();
    setCreditError('');
    const res = await fetch(`/api/admin/users/${id}/credit`, {
      method: 'POST',
      headers: { ...authHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ amount_sats: parseInt(creditAmount), description: creditDesc || undefined }),
    });
    const data = await res.json();
    if (!res.ok) { setCreditError(data.error); return; }
    setCreditAmount('');
    setCreditDesc('');
    load();
  }

  async function toggleCard(enable: boolean) {
    const action = enable ? 'enable' : 'disable';
    await fetch(`/api/admin/users/${id}/card/${action}`, {
      method: 'POST',
      headers: authHeaders(),
    });
    load();
  }

  async function reprogramCard() {
    if (!confirm('This will generate new keys and invalidate the current card. Continue?')) return;
    const res = await fetch(`/api/admin/users/${id}/card/reprogram`, {
      method: 'POST',
      headers: authHeaders(),
    });
    if (!res.ok) { const d = await res.json(); alert(d.error); return; }
    load();
  }

  async function wipeCard() {
    if (!confirm('This will generate a wipe token so the card can be wiped and re-used. Continue?')) return;
    const res = await fetch(`/api/admin/users/${id}/card/wipe`, {
      method: 'POST',
      headers: authHeaders(),
    });
    if (!res.ok) { const d = await res.json(); alert(d.error); return; }
    // Reload user data first (load() resets wipeQrUrl to null), then fetch QR
    await load();
    const qrRes = await fetch(`/api/admin/users/${id}/card/wipe/qr`, { headers: authHeaders() });
    if (qrRes.ok) {
      const blob = await qrRes.blob();
      setWipeQrUrl(URL.createObjectURL(blob));
    }
  }

  async function saveCardId(e: React.FormEvent) {
    e.preventDefault();
    await fetch(`/api/admin/users/${id}/card/card-id`, {
      method: 'PATCH',
      headers: { ...authHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ card_id: cardIdInput }),
    });
    setEditingCardId(false);
    load();
  }

  function copyMagicLink() {
    if (!user) return;
    navigator.clipboard.writeText(user.magic_link_url);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  if (error) return <div className="page error-text">{error}</div>;
  if (!user) return <div className="page muted">Loading…</div>;

  return (
    <div className="page">
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 24 }}>
        <button className="btn-ghost" onClick={() => navigate('/admin')}>← Back</button>
        <h1 style={{ fontSize: 20 }}>{user.display_name}</h1>
        <code className="muted">@{user.username}</code>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, marginBottom: 16 }}>
        {/* Balance */}
        <div className="card">
          <p className="muted" style={{ marginBottom: 4 }}>Balance</p>
          <p style={{ fontSize: 28, fontWeight: 700 }}>{user.balance_sats.toLocaleString()} <span className="muted" style={{ fontSize: 14 }}>sats</span></p>
          {zarPerSat && <p className="muted" style={{ fontSize: 13, marginTop: 2 }}>{formatZAR(user.balance_sats, zarPerSat)}</p>}
          <form onSubmit={credit} style={{ display: 'flex', gap: 8, marginTop: 12, flexWrap: 'wrap' }}>
            <input
              style={{ width: 110 }}
              type="number"
              placeholder="sats"
              value={creditAmount}
              onChange={(e) => setCreditAmount(e.target.value)}
              min="1"
              required
            />
            <input
              style={{ flex: 1, minWidth: 100 }}
              placeholder="Note (optional)"
              value={creditDesc}
              onChange={(e) => setCreditDesc(e.target.value)}
            />
            <button type="submit" className="btn-primary">Credit</button>
          </form>
          {creditError && <p className="error-text" style={{ marginTop: 6 }}>{creditError}</p>}
          {user.balance_sats > 0 && (
            <button className="btn-danger" onClick={withdrawAll} style={{ marginTop: 10, fontSize: 12 }}>
              Withdraw All
            </button>
          )}
        </div>

        {/* Magic link */}
        <div className="card">
          <p className="muted" style={{ marginBottom: 4 }}>User page (magic link)</p>
          <code style={{ fontSize: 12, wordBreak: 'break-all', color: '#f7931a' }}>{user.magic_link_url}</code>
          <div style={{ marginTop: 10, display: 'flex', gap: 8 }}>
            <button className="btn-ghost" onClick={copyMagicLink} style={{ fontSize: 12 }}>
              {copied ? 'Copied!' : 'Copy link'}
            </button>
            <a href={user.magic_link_url} target="_blank" rel="noreferrer">
              <button className="btn-ghost" style={{ fontSize: 12 }}>Open →</button>
            </a>
          </div>
        </div>
      </div>

      {/* Card section */}
      <div className="card" style={{ marginBottom: 16 }}>
        <h2 style={{ fontSize: 16, marginBottom: 14 }}>BoltCard</h2>
        {!user.card ? (
          <form onSubmit={createCard}>
            <p className="muted" style={{ marginBottom: 12 }}>No card assigned yet. Create one to generate a programming QR.</p>
            <button type="submit" className="btn-primary">Create Card</button>
          </form>
        ) : (
          <div>
            <div style={{ display: 'flex', gap: 24, flexWrap: 'wrap' }}>
              {/* QR / programming */}
              <div>
                {user.card.setup_token ? (
                  <>
                    <p className="muted" style={{ marginBottom: 8, fontSize: 13 }}>Scan with Boltcard Programmer app to program card:</p>
                    {qrUrl && (
                      <img
                        src={qrUrl}
                        alt="Programming QR"
                        style={{ width: 200, height: 200, display: 'block', borderRadius: 8 }}
                      />
                    )}
                    <p className="muted" style={{ marginTop: 6, marginBottom: 8, fontSize: 12 }}>QR is single-use. On mobile, tap below instead:</p>
                    <a
                      href={`boltcard://program?url=${encodeURIComponent(`${window.location.origin}/api/card/setup/${user.card.setup_token}`)}`}
                      className="btn-ghost"
                      style={{ display: 'inline-block', fontSize: 12, padding: '6px 12px' }}
                    >
                      Open in Programmer App
                    </a>
                  </>
                ) : (
                  <div style={{ padding: '16px 0' }}>
                    <span className="badge badge-green" style={{ marginBottom: 8 }}>Programmed</span>
                    {user.card.uid && (
                      <p className="muted" style={{ fontSize: 12, marginTop: 6 }}>
                        UID: <code>{user.card.uid}</code>
                      </p>
                    )}
                    <p className="muted" style={{ fontSize: 12, marginTop: 4 }}>
                      Programmed: {new Date(user.card.programmed_at! * 1000).toLocaleDateString()}
                    </p>
                  </div>
                )}
              </div>

              {/* Card info */}
              <div style={{ flex: 1 }}>
                <table style={{ marginBottom: 12 }}>
                  <tbody>
                    <tr><td className="muted" style={{ paddingLeft: 0 }}>Status</td><td>{user.card.enabled ? <span className="badge badge-green">Enabled</span> : <span className="badge badge-red">Disabled</span>}</td></tr>
                    <tr>
                      <td className="muted" style={{ paddingLeft: 0 }}>Card No.</td>
                      <td>
                        {editingCardId ? (
                          <form onSubmit={saveCardId} style={{ display: 'inline-flex', gap: 4 }}>
                            <input
                              autoFocus
                              value={cardIdInput}
                              onChange={e => setCardIdInput(e.target.value)}
                              placeholder="Card number"
                              style={{ width: 120, fontSize: 12 }}
                            />
                            <button type="submit" className="btn-primary" style={{ fontSize: 11, padding: '2px 8px' }}>Save</button>
                            <button type="button" className="btn-ghost" style={{ fontSize: 11, padding: '2px 8px' }} onClick={() => setEditingCardId(false)}>Cancel</button>
                          </form>
                        ) : (
                          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                            {user.card.card_id ? <code>{user.card.card_id}</code> : <span className="muted" style={{ fontSize: 12 }}>—</span>}
                            <button className="btn-ghost" style={{ fontSize: 11, padding: '1px 6px' }} onClick={() => { setCardIdInput(user.card!.card_id ?? ''); setEditingCardId(true); }}>Edit</button>
                          </span>
                        )}
                      </td>
                    </tr>
                    <tr><td className="muted" style={{ paddingLeft: 0 }}>Day spent</td><td>{user.card.day_spent_sats.toLocaleString()} sats</td></tr>
                    <tr><td className="muted" style={{ paddingLeft: 0 }}>Counter</td><td>{user.card.counter === -1 ? 'Never tapped' : user.card.counter}</td></tr>
                  </tbody>
                </table>

                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                  {user.card.enabled ? (
                    <button className="btn-danger" onClick={() => toggleCard(false)}>Disable Card</button>
                  ) : (
                    <button className="btn-primary" onClick={() => toggleCard(true)}>Enable Card</button>
                  )}
                  <button className="btn-ghost" onClick={reprogramCard} style={{ fontSize: 12 }}>Replace Card</button>
                  <button className="btn-ghost" onClick={wipeCard} style={{ fontSize: 12 }}>Wipe Card</button>
                  <button className="btn-danger" onClick={deleteCard} style={{ fontSize: 12 }}>Delete Card</button>
                </div>
              </div>
            </div>

            {/* Wipe QR */}
            {wipeQrUrl && (
              <div style={{ marginTop: 16, padding: '12px 0', borderTop: '1px solid #333' }}>
                <p className="muted" style={{ marginBottom: 8, fontSize: 13 }}>Scan with Boltcard Programmer app to wipe card keys:</p>
                <img
                  src={wipeQrUrl}
                  alt="Wipe QR"
                  style={{ width: 200, height: 200, display: 'block', borderRadius: 8, marginBottom: 8 }}
                />
                <p className="muted" style={{ marginTop: 4, fontSize: 11 }}>After wiping, click Replace Card to generate a new setup QR.</p>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Transaction history */}
      <div className="card">
        <h2 style={{ fontSize: 16, marginBottom: 12 }}>Transactions ({user.transactions.length})</h2>
        {user.transactions.length === 0 ? (
          <p className="muted">No transactions yet.</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Type</th>
                <th>Amount</th>
                <th>Description</th>
                <th>Date</th>
              </tr>
            </thead>
            <tbody>
              {user.transactions.map((tx) => (
                <tr key={tx.id}>
                  <td>
                    <span className={`badge ${tx.type === 'refill' ? 'badge-green' : 'badge-red'}`}>
                      {tx.type === 'refill' ? '↓ refill' : '↑ spend'}
                    </span>
                  </td>
                  <td>
                    {tx.amount_sats.toLocaleString()} sats
                    {zarPerSat && <span className="muted" style={{ marginLeft: 6 }}>({formatZAR(tx.amount_sats, zarPerSat)})</span>}
                  </td>
                  <td className="muted">{tx.description ?? '—'}</td>
                  <td className="muted">{new Date(tx.created_at * 1000).toLocaleString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
