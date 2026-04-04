import { Router } from 'express';
import { v4 as uuidv4 } from 'uuid';
import QRCode from 'qrcode';
import { db } from '../db/index.js';
import { requireApiKey } from '../middleware/apiKeyAuth.js';
import { generateKeys } from '../services/crypto.js';
import { createInvoice } from '../services/blink.js';

const router = Router();
router.use(requireApiKey);

const DOMAIN = () => process.env.DOMAIN!;

// ── POST /api/v1/users ────────────────────────────────────────────────────────

router.post('/users', (req, res) => {
  const { username, display_name } = req.body as {
    username?: string;
    display_name?: string;
  };
  if (!username || !display_name) {
    res.status(400).json({ error: 'username and display_name required' });
    return;
  }
  if (!/^[a-z0-9_.-]+$/.test(username)) {
    res.status(400).json({ error: 'username may only contain a-z, 0-9, _, -, .' });
    return;
  }

  const magicToken = uuidv4().replace(/-/g, '');
  const proto = DOMAIN().startsWith('localhost') ? 'http' : 'https';
  try {
    const result = db
      .prepare('INSERT INTO users (username, display_name, magic_token) VALUES (?, ?, ?)')
      .run(username, display_name, magicToken);
    res.status(201).json({
      id: result.lastInsertRowid,
      username,
      display_name,
      magic_link_url: `${proto}://${DOMAIN()}/u/${magicToken}`,
    });
  } catch (err: any) {
    if (err?.message?.includes('UNIQUE')) {
      res.status(409).json({ error: 'Username already taken' });
    } else {
      throw err;
    }
  }
});

// ── GET /api/v1/users/:id ─────────────────────────────────────────────────────

router.get('/users/:id', (req, res) => {
  const userId = Number(req.params.id);
  const user = db
    .prepare('SELECT id, username, display_name, balance_sats, ln_address_enabled, magic_token, created_at FROM users WHERE id = ?')
    .get(userId) as any;
  if (!user) { res.status(404).json({ error: 'User not found' }); return; }

  const card = db
    .prepare('SELECT id, card_id, programmed_at, enabled, uid, tx_max_sats, day_max_sats FROM cards WHERE user_id = ?')
    .get(userId) as any;

  const transactions = db
    .prepare('SELECT id, type, amount_sats, description, created_at FROM transactions WHERE user_id = ? ORDER BY created_at DESC LIMIT 20')
    .all(userId);

  const proto = DOMAIN().startsWith('localhost') ? 'http' : 'https';

  res.json({
    ...user,
    ln_address: user.ln_address_enabled ? `${user.username}@${DOMAIN()}` : null,
    magic_link_url: `${proto}://${DOMAIN()}/u/${user.magic_token}`,
    card: card
      ? {
          id: card.id,
          card_id: card.card_id,
          programmed: !!card.programmed_at,
          enabled: !!card.enabled,
          uid: card.uid,
          tx_max_sats: card.tx_max_sats,
          day_max_sats: card.day_max_sats,
        }
      : null,
    transactions,
  });
});

// ── POST /api/v1/users/:id/card ──────────────────────────────────────────────

router.post('/users/:id/card', (req, res) => {
  const userId = Number(req.params.id);
  const user = db.prepare('SELECT id FROM users WHERE id = ?').get(userId) as any;
  if (!user) { res.status(404).json({ error: 'User not found' }); return; }

  const existing = db.prepare('SELECT id FROM cards WHERE user_id = ?').get(userId) as any;
  if (existing) { res.status(409).json({ error: 'User already has a card' }); return; }

  const { card_id } = req.body as { card_id?: string };

  const keys = generateKeys();
  const setupToken = uuidv4().replace(/-/g, '');

  const result = db.prepare(`
    INSERT INTO cards (user_id, k0, k1, k2, k3, k4, setup_token, tx_max_sats, day_max_sats, card_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(userId, keys.k0, keys.k1, keys.k2, keys.k3, keys.k4, setupToken, 999999999, 999999999, card_id ?? null);

  res.status(201).json({ id: result.lastInsertRowid, setup_token: setupToken });
});

// ── DELETE /api/v1/users/:id/card ────────────────────────────────────────────

router.delete('/users/:id/card', (req, res) => {
  const userId = Number(req.params.id);
  const deleted = db.prepare('DELETE FROM cards WHERE user_id = ?').run(userId);
  if (deleted.changes === 0) { res.status(404).json({ error: 'No card found' }); return; }
  res.json({ deleted: true });
});

// ── POST /api/v1/users/:id/credit ─────────────────────────────────────────────

router.post('/users/:id/credit', (req, res) => {
  const userId = Number(req.params.id);
  const { amount_sats, description } = req.body as {
    amount_sats?: number;
    description?: string;
  };
  if (!amount_sats || amount_sats <= 0) {
    res.status(400).json({ error: 'amount_sats must be a positive integer' });
    return;
  }

  const user = db.prepare('SELECT id FROM users WHERE id = ?').get(userId) as any;
  if (!user) { res.status(404).json({ error: 'User not found' }); return; }

  db.transaction(() => {
    db.prepare('UPDATE users SET balance_sats = balance_sats + ? WHERE id = ?').run(amount_sats, userId);
    db.prepare('INSERT INTO transactions (user_id, type, amount_sats, description) VALUES (?, ?, ?, ?)').run(
      userId, 'refill', amount_sats, description ?? 'API credit'
    );
  })();

  const updated = db.prepare('SELECT balance_sats FROM users WHERE id = ?').get(userId) as any;
  res.json({ balance_sats: updated.balance_sats });
});

// ── POST /api/v1/payout/batch ─────────────────────────────────────────────────
// Creates a Lightning invoice for a batch of user credits. Once paid, all
// users are credited automatically via the Blink subscription handler.

router.post('/payout/batch', async (req, res) => {
  const { memo, payouts } = req.body as {
    memo?: string;
    payouts?: { user_id: number; amount_sats: number; description?: string }[];
  };
  if (!payouts || !Array.isArray(payouts) || payouts.length === 0) {
    res.status(400).json({ error: 'payouts array required' });
    return;
  }

  // Validate all user_ids exist
  for (const p of payouts) {
    const u = db.prepare('SELECT id FROM users WHERE id = ?').get(p.user_id);
    if (!u) { res.status(400).json({ error: `User ${p.user_id} not found` }); return; }
    if (!p.amount_sats || p.amount_sats <= 0) {
      res.status(400).json({ error: `Invalid amount_sats for user ${p.user_id}` }); return;
    }
  }

  const totalSats = payouts.reduce((sum, p) => sum + p.amount_sats, 0);
  const batchMemo = memo ?? 'TSK monthly reward payout';

  let invoice: { paymentHash: string; paymentRequest: string };
  try {
    invoice = await createInvoice(totalSats, batchMemo);
  } catch (err: any) {
    res.status(502).json({ error: `Failed to create Lightning invoice: ${err.message}` });
    return;
  }

  const qrBase64 = await QRCode.toDataURL(`lightning:${invoice.paymentRequest}`, {
    width: 400, margin: 2,
    color: { dark: '#000000', light: '#ffffff' },
  }).then((dataUrl: string) => dataUrl.replace(/^data:image\/png;base64,/, ''));

  const batchResult = db.prepare(
    'INSERT INTO payout_batches (payment_hash, payment_request, total_sats, memo) VALUES (?, ?, ?, ?)'
  ).run(invoice.paymentHash, invoice.paymentRequest, totalSats, batchMemo);

  const batchId = batchResult.lastInsertRowid as number;
  const insertItem = db.prepare(
    'INSERT INTO payout_batch_items (batch_id, user_id, amount_sats, description) VALUES (?, ?, ?, ?)'
  );
  for (const p of payouts) {
    insertItem.run(batchId, p.user_id, p.amount_sats, p.description ?? null);
  }

  res.status(201).json({
    batch_id: batchId,
    payment_hash: invoice.paymentHash,
    payment_request: invoice.paymentRequest,
    total_sats: totalSats,
    qr_base64: qrBase64,
  });
});

// ── GET /api/v1/payout/batch/:id ──────────────────────────────────────────────

router.get('/payout/batch/:id', (req, res) => {
  const batchId = Number(req.params.id);
  const batch = db
    .prepare('SELECT id, status, total_sats, paid_at FROM payout_batches WHERE id = ?')
    .get(batchId) as any;
  if (!batch) { res.status(404).json({ error: 'Batch not found' }); return; }
  const itemCount = (db.prepare('SELECT COUNT(*) as n FROM payout_batch_items WHERE batch_id = ?').get(batchId) as any).n;
  res.json({ ...batch, item_count: itemCount });
});

export default router;
