// In-memory sliding-window limit on LN address invoice requests per payer IP.
// Each request creates a Blink invoice, so this stops a script from flooding
// Blink on our behalf. Resets on restart, which is fine for flood protection.

const WINDOW_MS = 60_000;
const recent = new Map<string, number[]>();

export function allowInvoiceRequest(ip: string, limitPerMin: number, now = Date.now()): boolean {
  const cutoff = now - WINDOW_MS;
  const hits = (recent.get(ip) ?? []).filter((t) => t > cutoff);
  if (hits.length >= limitPerMin) {
    recent.set(ip, hits);
    return false;
  }
  hits.push(now);
  recent.set(ip, hits);
  return true;
}

// Drop IPs with no requests in the last window so memory stays bounded
export function sweepInvoiceRequests(now = Date.now()) {
  const cutoff = now - WINDOW_MS;
  for (const [ip, hits] of recent) {
    if (!hits.some((t) => t > cutoff)) recent.delete(ip);
  }
}

export function invoiceRequestIpCount() {
  return recent.size;
}
