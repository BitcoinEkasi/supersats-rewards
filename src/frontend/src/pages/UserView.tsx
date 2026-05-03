import { useEffect, useState } from 'react';

const _MONTHS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
function fmtDate(unix: number) {
  const d = new Date(unix * 1000);
  const time = `${String(d.getHours()).padStart(2,"0")}:${String(d.getMinutes()).padStart(2,"0")}`;
  return `${String(d.getDate()).padStart(2,"0")} ${_MONTHS[d.getMonth()]} '${String(d.getFullYear()).slice(-2)} ${time}`;
}
import { useParams } from 'react-router-dom';
import { usePriceFeed, formatZAR } from '../hooks/usePriceFeed';

interface UserData {
  username: string;
  display_name: string;
  balance_sats: number;
  ln_address: string | null;
  card_status: 'active' | 'disabled' | 'awaiting' | 'wiped' | null;
  transactions: {
    id: number;
    type: 'spend' | 'refill';
    amount_sats: number;
    description: string | null;
    created_at: number;
  }[];
}

export default function UserView() {
  const { magic_token } = useParams<{ magic_token: string }>();
  const { zarPerSat } = usePriceFeed();
  const [data, setData] = useState<UserData | null>(null);
  const [error, setError] = useState('');
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);

  useEffect(() => {
    fetch(`/api/user/${magic_token}`)
      .then((r) => {
        if (!r.ok) throw new Error('Not found');
        return r.json();
      })
      .then((d: UserData) => {
        setData(d);
        if (d.ln_address) {
          generateQr(d.ln_address);
        }
      })
      .catch(() => setError('This link is invalid or has expired.'));
  }, [magic_token]);

  async function generateQr(address: string) {
    // Use a public QR API for the frontend — or generate client-side via canvas
    // We'll render a simple SVG-based QR using the address as text
    const lnurlEncoded = `lightning:${address}`;
    try {
      // Dynamically import qrcode (it's a dev dep but available at runtime via vite)
      const QRCode = await import('qrcode');
      const url = await QRCode.toDataURL(lnurlEncoded, {
        width: 300,
        margin: 2,
        color: { dark: '#000000', light: '#ffffff' },
      });
      setQrDataUrl(url);
    } catch {
      // Fallback: show text only
    }
  }

  if (error) {
    return (
      <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', minHeight: '100vh' }}>
        <div className="card" style={{ maxWidth: 360, textAlign: 'center' }}>
          <p style={{ fontSize: 32, marginBottom: 12 }}>⚡</p>
          <p className="error-text">{error}</p>
        </div>
      </div>
    );
  }

  if (!data) {
    return <div className="page muted">Loading…</div>;
  }

  return (
    <div className="page" style={{ maxWidth: 560 }}>
      <div style={{ textAlign: 'center', marginBottom: 24 }}>
        <p style={{ fontSize: 36, marginBottom: 8 }}>⚡</p>
        <h1 style={{ fontSize: 22 }}>{data.display_name}</h1>
        <p className="muted">@{data.username}</p>
      </div>

      {/* Balance */}
      <div className="card" style={{ textAlign: 'center', marginBottom: 16 }}>
        <p className="muted" style={{ marginBottom: 4 }}>Balance</p>
        <p style={{ fontSize: 40, fontWeight: 700 }}>
          {data.balance_sats.toLocaleString()}
          <span className="muted" style={{ fontSize: 18, marginLeft: 6 }}>sats</span>
        </p>
        {zarPerSat && (
          <p style={{ fontSize: 22, fontWeight: 600, color: '#f7931a', marginTop: 4 }}>
            {formatZAR(data.balance_sats, zarPerSat)}
          </p>
        )}
        <p className="muted" style={{ fontSize: 12, marginTop: 4 }}>
          ≈ {(data.balance_sats / 100_000_000).toFixed(8)} BTC
        </p>
      </div>

      {/* Card status */}
      {data.card_status && (() => {
        const statusMap = {
          active:   { label: 'Card Active',    color: '#166534', bg: '#dcfce7' },
          disabled: { label: 'Card Disabled',  color: '#991b1b', bg: '#fee2e2' },
          awaiting: { label: 'Card Being Set Up', color: '#92400e', bg: '#fef3c7' },
          wiped:    { label: 'Card Wiped',     color: '#92400e', bg: '#fef3c7' },
        };
        const s = statusMap[data.card_status];
        const sub = data.card_status === 'disabled'
          ? 'Contact your administrator.'
          : data.card_status === 'wiped'
          ? 'Contact your administrator to reprogram your card.'
          : data.card_status === 'awaiting'
          ? 'Your card is being configured — check back shortly.'
          : null;
        return (
          <div className="card" style={{ marginBottom: 16, display: 'flex', alignItems: 'center', gap: 12 }}>
            <span style={{ padding: '4px 12px', borderRadius: 999, fontSize: 13, fontWeight: 600, background: s.bg, color: s.color }}>
              {s.label}
            </span>
            {sub && <span className="muted" style={{ fontSize: 13 }}>{sub}</span>}
          </div>
        );
      })()}

      {/* Refill QR */}
      {data.ln_address && (
        <div className="card" style={{ textAlign: 'center', marginBottom: 16 }}>
          <h2 style={{ fontSize: 15, marginBottom: 12 }}>Refill via Lightning</h2>
          {qrDataUrl ? (
            <img
              src={qrDataUrl}
              alt="Lightning address QR"
              style={{ width: 240, height: 240, borderRadius: 8, margin: '0 auto', display: 'block' }}
            />
          ) : (
            <div style={{ width: 240, height: 240, background: '#111', borderRadius: 8, margin: '0 auto', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              <span className="muted">Loading QR…</span>
            </div>
          )}
          <p style={{ marginTop: 12, fontWeight: 600 }}>{data.ln_address}</p>
          <p className="muted" style={{ fontSize: 12, marginTop: 4 }}>
            Send any Lightning payment to this address to top up your balance.
          </p>
          <button
            className="btn-ghost"
            style={{ marginTop: 10, fontSize: 12 }}
            onClick={() => navigator.clipboard.writeText(data.ln_address!)}
          >
            Copy address
          </button>
        </div>
      )}

      {/* Transaction history */}
      <div className="card">
        <h2 style={{ fontSize: 15, marginBottom: 12 }}>Recent Transactions</h2>
        {data.transactions.length === 0 ? (
          <p className="muted" style={{ textAlign: 'center', padding: 16 }}>No transactions yet.</p>
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
              {data.transactions.map((tx) => (
                <tr key={tx.id}>
                  <td>
                    <span className={`badge ${tx.type === 'refill' ? 'badge-green' : 'badge-red'}`}>
                      {tx.type === 'refill' ? '↓ refill' : '↑ spend'}
                    </span>
                  </td>
                  <td style={{ fontWeight: 600 }}>
                    {tx.amount_sats.toLocaleString()} sats
                    {zarPerSat && <span className="muted" style={{ display: 'block', fontSize: 12, fontWeight: 400 }}>{formatZAR(tx.amount_sats, zarPerSat)}</span>}
                  </td>
                  <td className="muted">{tx.description ?? '—'}</td>
                  <td className="muted" style={{ fontSize: 12 }}>{fmtDate(tx.created_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <p className="muted" style={{ textAlign: 'center', marginTop: 24, fontSize: 12 }}>
        ⚡ Powered by BoltCard Server
      </p>
    </div>
  );
}
