import { Router } from 'express';
import { db } from '../db/index.js';

const router = Router();

const PASSCODE = 'tskbolt';

router.get('/', (req, res) => {
  if (req.headers['x-passcode'] !== PASSCODE) {
    res.status(401).json({ error: 'Invalid passcode' });
    return;
  }

  const rows = db.prepare(`
    SELECT u.id, u.display_name, u.username, u.balance_sats,
           u.division, u.tsk_level, u.jc_level,
           c.card_id, c.programmed_at, c.enabled, c.setup_token, c.wiped_at
    FROM users u
    LEFT JOIN cards c ON c.user_id = u.id
    WHERE u.username != 'test'
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

export default router;
