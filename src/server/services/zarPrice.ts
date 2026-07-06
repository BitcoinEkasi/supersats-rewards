const PRICE_URL = 'https://price-feed.dev.fedibtc.com/latest';
const CACHE_TTL_MS = 60_000;

let cached: { zarPerSat: number; fetchedAt: number } | null = null;

// Locks in the ZAR/sat rate at transaction time. Never throws — a failed
// price lookup must never block a payment from completing; callers get
// `null` and store no rate for that row instead.
export async function getZarPerSat(): Promise<number | null> {
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
    return cached.zarPerSat;
  }
  try {
    const res = await fetch(PRICE_URL, { signal: AbortSignal.timeout(5_000) });
    if (!res.ok) return cached?.zarPerSat ?? null;
    const data = await res.json() as { prices?: Record<string, { rate: number }> };
    const btcUsd = data.prices?.['BTC/USD']?.rate;
    const zarUsd = data.prices?.['ZAR/USD']?.rate;
    if (!btcUsd || !zarUsd) return cached?.zarPerSat ?? null;
    const zarPerSat = btcUsd / zarUsd / 1e8;
    cached = { zarPerSat, fetchedAt: Date.now() };
    return zarPerSat;
  } catch {
    return cached?.zarPerSat ?? null;
  }
}
