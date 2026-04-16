import { Router } from 'express';
import { db } from '../db/index.js';
import { decryptP, verifyCmac } from '../services/crypto.js';

const router = Router();

interface Card {
  id: number;
  user_id: number;
  k1: string;
  k2: string;
  uid: string | null;
  counter: number;
  enabled: number;
}

router.get('/', (req, res) => {
  const { p, c } = req.query as { p?: string; c?: string };

  if (!p || !c || p.length !== 32 || c.length !== 16) {
    res.status(400).json({ error: 'Missing or invalid p/c parameters' });
    return;
  }

  // Identify card by attempting K1 decryption — same loop as lnurlw.ts
  const cards = db.prepare('SELECT id, user_id, k1, k2, uid, counter, enabled FROM cards WHERE enabled = 1').all() as Card[];

  let matchedCard: Card | null = null;
  let uid = '';
  let counter = 0;

  for (const card of cards) {
    try {
      const result = decryptP(card.k1, p);
      uid = result.uid;
      counter = result.counter;
      matchedCard = card;
      break;
    } catch {
      // Magic byte mismatch — try next card
    }
  }

  if (!matchedCard) {
    res.status(404).json({ error: 'Card not recognized' });
    return;
  }

  // Verify CMAC
  if (!verifyCmac(matchedCard.k2, uid, counter, c)) {
    res.status(401).json({ error: 'CMAC verification failed' });
    return;
  }

  // Read-only — do NOT update UID/counter

  const user = db.prepare(
    'SELECT display_name, balance_sats, division, tsk_level, jc_level FROM users WHERE id = ?'
  ).get(matchedCard.user_id) as any;

  if (!user) {
    res.status(404).json({ error: 'User not found' });
    return;
  }

  const card = db.prepare('SELECT card_id FROM cards WHERE id = ?').get(matchedCard.id) as any;

  const txRows = db.prepare(
    'SELECT id, type, amount_sats, description, created_at FROM transactions WHERE user_id = ? ORDER BY created_at DESC LIMIT 20'
  ).all(matchedCard.user_id) as any[];

  const lnRows = db.prepare(
    'SELECT id, amount_sats, ln_address, status, description, created_at FROM ln_payouts WHERE user_id = ? ORDER BY created_at DESC LIMIT 20'
  ).all(matchedCard.user_id) as any[];

  const lnMapped = lnRows.map((r: any) => ({
    id: `ln_${r.id}`,
    type: 'ln_payout',
    amount_sats: r.amount_sats,
    description: r.description ?? r.ln_address,
    status: r.status,
    created_at: r.created_at,
  }));

  const transactions = [...txRows, ...lnMapped]
    .sort((a, b) => b.created_at - a.created_at)
    .slice(0, 20);

  res.json({
    display_name: user.display_name,
    balance_sats: user.balance_sats,
    card_id: card?.card_id ?? null,
    division: user.division ?? null,
    tsk_level: user.tsk_level ?? null,
    jc_level: user.jc_level ?? null,
    transactions,
  });
});

export default router;
