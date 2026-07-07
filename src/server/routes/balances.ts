import { Router } from 'express';
import { db } from '../db/index.js';
import { blinkCounterPartyByPaymentHash, txToMovement, lnPayoutToMovement } from '../services/movements.js';

const router = Router();

const PASSCODE = process.env.BALANCES_PASSCODE ?? '';

function checkPasscode(req: any, res: any): boolean {
  if (req.headers['x-passcode'] !== PASSCODE) {
    res.status(401).json({ error: 'Invalid passcode' });
    return false;
  }
  return true;
}

router.get('/', (req, res) => {
  if (!checkPasscode(req, res)) return;

  const rows = db.prepare(`
    SELECT u.id, u.display_name, u.username, u.balance_sats,
           u.division, u.tsk_level, u.jc_level, u.tsk_group, u.ac,
           c.card_id, c.programmed_at, c.enabled, c.setup_token, c.wiped_at
    FROM users u
    LEFT JOIN cards c ON c.user_id = u.id
    WHERE u.username != 'tsk00000'
    ORDER BY u.balance_sats DESC, u.display_name ASC
  `).all() as any[];

  const users = rows.map((r) => {
    let card_status: string = 'none';
    if (r.programmed_at || r.setup_token) {
      if (r.wiped_at) card_status = 'wiped';
      else if (r.setup_token) card_status = 'awaiting';
      else if (!r.enabled) card_status = 'disabled';
      else card_status = 'active';
    }
    return {
      id: r.id,
      display_name: r.display_name,
      balance_sats: r.balance_sats,
      card_id: r.card_id ?? null,
      card_status,
      division: r.division ?? null,
      tsk_level: r.tsk_level ?? null,
      jc_level: r.jc_level ?? null,
      tsk_group: r.tsk_group ?? null,
      ac: !!r.ac,
    };
  });

  res.json(users);
});

router.get('/:id/transactions', async (req, res) => {
  if (!checkPasscode(req, res)) return;

  const userId = Number(req.params.id);
  if (!userId) { res.status(400).json({ error: 'Invalid id' }); return; }

  const user = db.prepare('SELECT id, display_name, balance_sats FROM users WHERE id = ? AND username != ?').get(userId, 'tsk00000') as any;
  if (!user) { res.status(404).json({ error: 'User not found' }); return; }

  const card = db.prepare('SELECT card_id FROM cards WHERE user_id = ?').get(userId) as { card_id: string | null } | undefined;
  const cardLabel = `Card ${card?.card_id ?? '?'} — ${user.display_name}`;

  const txRows = db.prepare(
    'SELECT id, type, amount_sats, payment_hash, description, created_at, zar_per_sat FROM transactions WHERE user_id = ? ORDER BY created_at DESC LIMIT 50'
  ).all(userId) as {
    id: number; type: 'spend' | 'refill' | 'card_fee'; amount_sats: number;
    payment_hash: string | null; description: string | null; created_at: number; zar_per_sat: number | null;
  }[];

  let blinkCounterParties = new Map<string, string>();
  if (txRows.some((t) => t.type === 'spend' && t.payment_hash)) {
    try {
      blinkCounterParties = await blinkCounterPartyByPaymentHash();
    } catch (err) {
      console.error('[balances] failed to fetch Blink counterparties:', err);
    }
  }

  const lnRows = db.prepare(
    'SELECT id, amount_sats, ln_address, status, description, created_at, zar_per_sat FROM ln_payouts WHERE user_id = ? ORDER BY created_at DESC LIMIT 50'
  ).all(userId) as {
    id: number; amount_sats: number; ln_address: string; status: string;
    description: string | null; created_at: number; zar_per_sat: number | null;
  }[];

  const transactions = [
    ...txRows.map((t) => txToMovement(t, cardLabel, blinkCounterParties)),
    ...lnRows.map((p) => lnPayoutToMovement(p, user.display_name)),
  ]
    .sort((a, b) => b.created_at - a.created_at)
    .slice(0, 50);

  res.json({ display_name: user.display_name, balance_sats: user.balance_sats, transactions });
});

export default router;
