import { useEffect, useState } from 'react';
import { useLocation } from 'react-router-dom';

const isPwaRoute = (p: string) => p === '/balances' || p === '/balance_check';

export default function PwaHead() {
  const { pathname } = useLocation();
  const [installPrompt, setInstallPrompt] = useState<any>(null);

  useEffect(() => {
    document.querySelectorAll('link[rel="manifest"]').forEach(el => el.remove());

    let manifestHref: string | null = null;
    let swSrc: string | null = null;
    let swScope: string | null = null;

    if (pathname === '/balances') {
      manifestHref = '/balances-manifest.json';
      swSrc = '/balances-sw.js';
      swScope = '/balances';
    } else if (pathname === '/balance_check') {
      manifestHref = '/balance-check-manifest.json';
      swSrc = '/balance-check-sw.js';
      swScope = '/balance_check';
    }

    if (manifestHref) {
      const link = document.createElement('link');
      link.rel = 'manifest';
      link.href = manifestHref;
      document.head.appendChild(link);
    }

    if (swSrc && swScope && 'serviceWorker' in navigator) {
      navigator.serviceWorker.register(swSrc, { scope: swScope }).catch(() => {});
    }
  }, [pathname]);

  useEffect(() => {
    if (!isPwaRoute(pathname)) return;
    const handler = (e: Event) => {
      e.preventDefault();
      setInstallPrompt(e);
    };
    window.addEventListener('beforeinstallprompt', handler);
    return () => window.removeEventListener('beforeinstallprompt', handler);
  }, [pathname]);

  if (!installPrompt || !isPwaRoute(pathname)) return null;

  return (
    <div style={{ position: 'fixed', bottom: 16, left: 16, right: 16, zIndex: 9999, background: '#1a1a1a', border: '1px solid #f7931a', borderRadius: 12, padding: '12px 16px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
      <span style={{ color: '#f0f0f0', fontSize: 14 }}>Install this app on your device</span>
      <div style={{ display: 'flex', gap: 8, flexShrink: 0 }}>
        <button onClick={() => setInstallPrompt(null)} style={{ background: 'none', border: 'none', color: '#888', fontSize: 13, cursor: 'pointer', padding: '6px 10px' }}>Later</button>
        <button
          onClick={() => { installPrompt.prompt(); installPrompt.userChoice.then(() => setInstallPrompt(null)); }}
          style={{ background: '#f7931a', border: 'none', borderRadius: 8, color: '#000', fontSize: 13, fontWeight: 700, cursor: 'pointer', padding: '6px 14px' }}
        >Install</button>
      </div>
    </div>
  );
}
