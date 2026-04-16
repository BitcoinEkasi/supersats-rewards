import { Router } from 'express';
import { db } from '../db/index.js';

const router = Router();

const PASSCODE = 'tskbolt';

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
           u.division, u.tsk_level, u.jc_level,
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
    };
  });

  res.json(users);
});

router.get('/:id/transactions', (req, res) => {
  if (!checkPasscode(req, res)) return;

  const userId = Number(req.params.id);
  if (!userId) { res.status(400).json({ error: 'Invalid id' }); return; }

  const user = db.prepare('SELECT id, display_name, balance_sats FROM users WHERE id = ? AND username != ?').get(userId, 'tsk00000') as any;
  if (!user) { res.status(404).json({ error: 'User not found' }); return; }

  const txRows = db.prepare(
    'SELECT id, type, amount_sats, description, created_at FROM transactions WHERE user_id = ? ORDER BY created_at DESC LIMIT 50'
  ).all(userId) as any[];

  const lnRows = db.prepare(
    'SELECT id, amount_sats, ln_address, status, description, created_at FROM ln_payouts WHERE user_id = ? ORDER BY created_at DESC LIMIT 50'
  ).all(userId) as any[];

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
    .slice(0, 50);

  res.json({ display_name: user.display_name, balance_sats: user.balance_sats, transactions });
});

export default router;
