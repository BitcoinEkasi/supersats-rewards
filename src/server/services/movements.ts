import { getTransactions } from './blink.js';

export interface Movement {
  id: string;
  created_at: number;
  type: 'spend' | 'refill' | 'card_fee' | 'ln_payout';
  direction: 'in' | 'out';
  amount_sats: number;
  from: string;
  to: string;
  description: string | null;
  zar_per_sat: number | null;
}

// Look up Blink's own resolved counterparty (username / on-chain address) for
// spends, by matching the invoice's payment_hash — Blink knows the eventual
// destination even when it's outside our own card/ln_address bookkeeping.
export async function blinkCounterPartyByPaymentHash(maxPages = 4): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  let cursor: string | undefined;
  for (let i = 0; i < maxPages; i++) {
    const page = await getTransactions(50, cursor);
    for (const tx of page.transactions) {
      if (tx.paymentHash && tx.counterParty) {
        map.set(tx.paymentHash, tx.counterParty);
      }
    }
    if (!page.hasNextPage || !page.endCursor) break;
    cursor = page.endCursor;
  }
  return map;
}

export function txToMovement(
  t: { id: number; type: 'spend' | 'refill' | 'card_fee'; amount_sats: number; payment_hash: string | null; description: string | null; created_at: number; zar_per_sat: number | null },
  cardLabel: string,
  blinkCounterParties: Map<string, string>
): Movement {
  if (t.type === 'spend') {
    const resolved = t.payment_hash ? blinkCounterParties.get(t.payment_hash) : undefined;
    return {
      id: `tx-${t.id}`, created_at: t.created_at, type: t.type, direction: 'out',
      amount_sats: t.amount_sats, from: cardLabel, to: resolved ?? 'Lightning (external)', description: t.description,
      zar_per_sat: t.zar_per_sat,
    };
  }
  if (t.type === 'card_fee') {
    return {
      id: `tx-${t.id}`, created_at: t.created_at, type: t.type, direction: 'out',
      amount_sats: t.amount_sats, from: cardLabel, to: 'System (card fee)', description: t.description,
      zar_per_sat: t.zar_per_sat,
    };
  }
  return {
    id: `tx-${t.id}`, created_at: t.created_at, type: t.type, direction: 'in',
    amount_sats: t.amount_sats, from: `Reserve — ${t.description ?? 'credit'}`, to: cardLabel, description: t.description,
    zar_per_sat: t.zar_per_sat,
  };
}

export function lnPayoutToMovement(
  p: { id: number; amount_sats: number; ln_address: string; status: string; description: string | null; created_at: number; zar_per_sat: number | null },
  displayName: string
): Movement {
  return {
    id: `ln-${p.id}`, created_at: p.created_at, type: 'ln_payout', direction: 'out',
    amount_sats: p.amount_sats,
    from: `Reserve — ${p.description ?? 'payout'}`,
    to: `${p.ln_address} — ${displayName}`,
    description: p.status !== 'paid' ? `[${p.status}]${p.description ? ' ' + p.description : ''}` : p.description,
    zar_per_sat: p.zar_per_sat,
  };
}
