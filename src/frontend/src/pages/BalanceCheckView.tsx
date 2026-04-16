import { useState, useEffect, useRef } from 'react';
import { usePriceFeed, formatZAR } from '../hooks/usePriceFeed';

interface CardResult {
  display_name: string;
  balance_sats: number;
  card_id: string | null;
  division: string | null;
  tsk_level: string | null;
  jc_level: number | null;
  transactions: Transaction[];
}

interface Transaction {
  id: number | string;
  type: string;
  amount_sats: number;
  description: string | null;
  status?: string;
  created_at: number;
}

function txLabel(type: string) {
  if (type === 'refill') return 'Credit';
  if (type === 'spend') return 'Spend';
  if (type === 'card_fee') return 'Card fee';
  if (type === 'ln_payout') return 'LN payout';
  return type;
}

function txColor(type: string) {
  if (type === 'refill') return '#4ade80';
  if (type === 'spend' || type === 'card_fee') return '#f87171';
  if (type === 'ln_payout') return '#facc15';
  return '#aaa';
}

function formatDate(unixSecs: number) {
  return new Date(unixSecs * 1000).toLocaleDateString('en-ZA', {
    day: '2-digit', month: 'short', year: 'numeric',
  });
}

function extractPQ(url: string): { p: string; c: string } | null {
  try {
    // Handle lnurlw:// and https:// schemes
    const normalized = url.replace(/^lnurlw:\/\//i, 'https://').replace(/^lnurlp:\/\//i, 'https://');
    const parsed = new URL(normalized);
    const p = parsed.searchParams.get('p');
    const c = parsed.searchParams.get('c');
    if (p && c) return { p, c };
  } catch { /* ignore */ }
  return null;
}

type State = 'unsupported' | 'idle' | 'scanning' | 'loading' | 'result' | 'error';

export default function BalanceCheckView() {
  const { zarPerSat } = usePriceFeed();
  const [state, setState] = useState<State>('NDEFReader' in window ? 'idle' : 'unsupported');
  const [result, setResult] = useState<CardResult | null>(null);
  const [errorMsg, setErrorMsg] = useState('');
  const readerRef = useRef<any>(null);

  async function startScan() {
    setState('scanning');
    setResult(null);
    setErrorMsg('');

    try {
      const reader = new (window as any).NDEFReader();
      readerRef.current = reader;

      reader.onreading = async (event: any) => {
        for (const record of event.message.records) {
          let url: string | null = null;

          if (record.recordType === 'url') {
            url = new TextDecoder().decode(record.data);
          } else if (record.recordType === 'absolute-url') {
            url = new TextDecoder().decode(record.data);
          }

          if (!url) continue;

          const params = extractPQ(url);
          if (!params) continue;

          setState('loading');
          try {
            const res = await fetch(`/api/balance-check?p=${encodeURIComponent(params.p)}&c=${encodeURIComponent(params.c)}`);
            const body = await res.json();
            if (!res.ok) {
              setErrorMsg(body.error ?? 'Card not recognized');
              setState('error');
            } else {
              setResult(body);
              setState('result');
            }
          } catch {
            setErrorMsg('Failed to fetch balance. Please try again.');
            setState('error');
          }
          return;
        }
        // No usable record found
        setErrorMsg('Could not read card data. Try again.');
        setState('error');
      };

      reader.onerror = () => {
        setErrorMsg('NFC read error. Try again.');
        setState('error');
      };

      await reader.scan();
    } catch (err: any) {
      if (err?.name === 'NotAllowedError') {
        setErrorMsg('NFC permission denied. Please check that NFC is enabled in your phone settings and try again.');
        setState('error');
      } else {
        setState('unsupported');
      }
    }
  }

  useEffect(() => {
    return () => { readerRef.current = null; };
  }, []);

  const bg = '#0f0f0f';

  if (state === 'unsupported') {
    return (
      <div style={{ minHeight: '100vh', background: bg, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24 }}>
        <div className="card" style={{ maxWidth: 340, width: '100%', textAlign: 'center', padding: 28 }}>
          <div style={{ fontSize: 36, marginBottom: 12 }}>📵</div>
          <h2 style={{ fontSize: 17, fontWeight: 700, marginBottom: 8 }}>NFC Not Supported</h2>
          <p className="muted" style={{ fontSize: 13, lineHeight: 1.5 }}>
            This page requires NFC support.<br />
            Please use <strong>Chrome on Android</strong> to use this feature.
          </p>
        </div>
      </div>
    );
  }

  if (state === 'idle') {
    return (
      <div style={{ minHeight: '100vh', background: bg, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: 24 }}>
        <div style={{ textAlign: 'center', maxWidth: 320 }}>
          <div style={{ fontSize: 72, marginBottom: 20 }}>💳</div>
          <h1 style={{ fontSize: 20, fontWeight: 700, color: '#f0f0f0', marginBottom: 8 }}>Card Balance Check</h1>
          <p className="muted" style={{ fontSize: 14, marginBottom: 28 }}>Press the button below, then hold your BoltCard to the back of your phone</p>
          <button className="btn-primary" onClick={startScan} style={{ width: '100%', padding: '13px 0', fontSize: 16 }}>
            Start Scanning
          </button>
        </div>
      </div>
    );
  }

  if (state === 'scanning') {
    return (
      <div style={{ minHeight: '100vh', background: bg, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: 24 }}>
        <div style={{ textAlign: 'center' }}>
          <div style={{ fontSize: 72, marginBottom: 20, animation: 'pulse 2s infinite' }}>💳</div>
          <h1 style={{ fontSize: 20, fontWeight: 700, color: '#f0f0f0', marginBottom: 8 }}>Tap Your Card</h1>
          <p className="muted" style={{ fontSize: 14 }}>Hold your BoltCard to the back of your phone</p>
        </div>
        <style>{`@keyframes pulse { 0%,100%{opacity:1} 50%{opacity:.4} }`}</style>
      </div>
    );
  }

  if (state === 'loading') {
    return (
      <div style={{ minHeight: '100vh', background: bg, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <p className="muted" style={{ fontSize: 14 }}>Reading card…</p>
      </div>
    );
  }

  if (state === 'error') {
    return (
      <div style={{ minHeight: '100vh', background: bg, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: 24 }}>
        <div className="card" style={{ maxWidth: 340, width: '100%', textAlign: 'center', padding: 28 }}>
          <div style={{ fontSize: 36, marginBottom: 12 }}>⚠️</div>
          <p style={{ fontSize: 14, color: '#f87171', marginBottom: 20 }}>{errorMsg}</p>
          <button className="btn-primary" onClick={startScan} style={{ width: '100%', padding: '10px 0', fontSize: 15 }}>
            Try Again
          </button>
        </div>
      </div>
    );
  }

  // result state
  if (!result) return null;

  return (
    <div style={{ background: bg, minHeight: '100vh', padding: '16px 12px 40px' }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 16 }}>
        <span style={{ fontSize: 22 }}>⚡</span>
        <h1 style={{ fontSize: 18, fontWeight: 700, margin: 0, color: '#f0f0f0' }}>Card Balance</h1>
      </div>

      {/* Balance card */}
      <div className="card" style={{ padding: '14px 14px 12px', marginBottom: 16 }}>
        {/* Row 1: name left, sats right */}
        <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 8 }}>
          <div style={{ fontWeight: 700, fontSize: 15, color: '#f0f0f0', lineHeight: 1.3, flex: 1 }}>{result.display_name}</div>
          <div style={{ fontSize: 16, fontWeight: 700, color: '#f7931a', whiteSpace: 'nowrap', flexShrink: 0 }}>
            ⚡ {result.balance_sats.toLocaleString()} sats
          </div>
        </div>

        {/* Row 2: card + meta left, ZAR right */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, marginTop: 4 }}>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '2px 10px' }}>
            {result.card_id && (
              <span className="muted" style={{ fontSize: 12 }}>
                <code style={{ color: '#aaa', fontSize: 12 }}>{result.card_id}</code>
              </span>
            )}
            {result.division && <span className="muted" style={{ fontSize: 12 }}>{result.division}</span>}
            {result.tsk_level && <span className="muted" style={{ fontSize: 12 }}>{result.tsk_level}</span>}
            {result.jc_level != null && <span className="muted" style={{ fontSize: 12 }}>JC {result.jc_level}</span>}
          </div>
          {zarPerSat && (
            <span className="muted" style={{ fontSize: 12, flexShrink: 0 }}>{formatZAR(result.balance_sats, zarPerSat)}</span>
          )}
        </div>
      </div>

      {/* Transactions */}
      <div style={{ fontSize: 12, color: '#666', marginBottom: 8, paddingLeft: 2 }}>Transaction history</div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 20 }}>
        {result.transactions.length === 0 ? (
          <p className="muted" style={{ textAlign: 'center', marginTop: 16, fontSize: 13 }}>No transactions yet.</p>
        ) : result.transactions.map((tx) => (
          <div key={tx.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '10px 12px', background: '#1a1a1a', borderRadius: 8 }}>
            <div>
              <div style={{ fontSize: 13, color: txColor(tx.type), fontWeight: 600 }}>{txLabel(tx.type)}</div>
              {tx.description && <div className="muted" style={{ fontSize: 11, marginTop: 2 }}>{tx.description}</div>}
              <div className="muted" style={{ fontSize: 11, marginTop: 2 }}>{formatDate(tx.created_at)}</div>
            </div>
            <div style={{ textAlign: 'right', flexShrink: 0 }}>
              <div style={{ fontSize: 14, fontWeight: 700, color: tx.type === 'refill' ? '#4ade80' : '#f0f0f0' }}>
                {tx.type === 'refill' ? '+' : '-'}{tx.amount_sats.toLocaleString()} sats
              </div>
              {zarPerSat && (
                <div className="muted" style={{ fontSize: 11, marginTop: 2 }}>{formatZAR(tx.amount_sats, zarPerSat)}</div>
              )}
            </div>
          </div>
        ))}
      </div>

      {/* Tap another card */}
      <button className="btn-primary" onClick={startScan} style={{ width: '100%', padding: '12px 0', fontSize: 15 }}>
        Tap Another Card
      </button>
    </div>
  );
}
