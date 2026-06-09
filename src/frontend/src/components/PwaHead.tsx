import { useEffect } from 'react';
import { useLocation } from 'react-router-dom';

export default function PwaHead() {
  const { pathname } = useLocation();

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

  return null;
}
