import { Router } from 'express';
import { db } from '../db/index.js';

const router = Router();

const DOMAIN = () => process.env.DOMAIN!;

// ── GET /api/user/:magic_token ────────────────────────────────────────────────
//
// Powers the read-only user view page (magic link).

router.get('/:magic_token', (req, res) => {
  const { magic_token } = req.params;
  const user = db
    .prepare('SELECT id, username, display_name, balance_sats, ln_address_enabled FROM users WHERE magic_token = ?')
    .get(magic_token) as any;

  if (!user) {
    res.status(404).json({ error: 'Not found' });
    return;
  }

  const transactions = db
    .prepare('SELECT id, type, amount_sats, description, created_at FROM transactions WHERE user_id = ? ORDER BY created_at DESC LIMIT 20')
    .all(user.id);

  const card = db
    .prepare('SELECT programmed_at, wiped_at, enabled, setup_token FROM cards WHERE user_id = ?')
    .get(user.id) as any;

  let card_status: 'active' | 'disabled' | 'awaiting' | 'wiped' | null = null;
  if (card) {
    if (card.setup_token || !card.programmed_at) card_status = 'awaiting';
    else if (card.wiped_at) card_status = 'wiped';
    else if (!card.enabled) card_status = 'disabled';
    else card_status = 'active';
  }

  res.json({
    username: user.username,
    display_name: user.display_name,
    balance_sats: user.balance_sats,
    ln_address: user.ln_address_enabled ? `${user.username}@${DOMAIN()}` : null,
    card_status,
    transactions,
  });
});

export default router;
