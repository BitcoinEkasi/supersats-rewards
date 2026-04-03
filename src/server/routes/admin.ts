import { Router } from 'express';
import { createHash, randomBytes } from 'crypto';
import { v4 as uuidv4 } from 'uuid';
import QRCode from 'qrcode';
import { db } from '../db/index.js';
import { requireAdmin } from '../middleware/adminAuth.js';
import { generateKeys } from '../services/crypto.js';
import { getBalance } from '../services/blink.js';

const router = Router();
router.use(requireAdmin);

const DOMAIN = () => process.env.DOMAIN!;

// ── Dashboard ─────────────────────────────────────────────────────────────────

router.get('/dashboard', async (_req, res) => {
  const users = db.prepare(`
    SELECT u.id, u.username, u.display_name, u.balance_sats, u.created_at,
           c.id AS card_id, c.card_id AS card_number, c.programmed_at, c.enabled AS card_enabled, c.uid,
           c.wiped_at, c.setup_token
    FROM users u
    LEFT JOIN cards c ON c.user_id = u.id
    ORDER BY u.created_at DESC
  `).all();

  let systemBalance = 0;
  try {
    systemBalance = await getBalance();
  } catch (err) {
    console.error('[admin] getBalance error:', err);
  }

  res.json({ users, systemBalance });
});

// ── Users ─────────────────────────────────────────────────────────────────────

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
  try {
    const result = db
      .prepare(
        'INSERT INTO users (username, display_name, magic_token) VALUES (?, ?, ?)'
      )
      .run(username, display_name, magicToken);

    const proto = DOMAIN().startsWith('localhost') ? 'http' : 'https';
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

router.get('/users/:id', (req, res) => {
  const userId = Number(req.params.id);
  const user = db
    .prepare('SELECT * FROM users WHERE id = ?')
    .get(userId) as any;
  if (!user) { res.status(404).json({ error: 'User not found' }); return; }

  // Card info — redact keys from response
  const card = db
    .prepare('SELECT id, user_id, card_id, uid, counter, tx_max_sats, day_max_sats, day_spent_sats, setup_token, wipe_token, programmed_at, wiped_at, previous_card_id, replaced_at, enabled, created_at FROM cards WHERE user_id = ?')
    .get(userId) as any;

  const transactions = db
    .prepare('SELECT * FROM transactions WHERE user_id = ? ORDER BY created_at DESC LIMIT 50')
    .all(userId);

  const cardEvents = db
    .prepare('SELECT id, event, description, created_at FROM card_events WHERE user_id = ? ORDER BY created_at DESC')
    .all(userId);

  const proto = DOMAIN().startsWith('localhost') ? 'http' : 'https';
  res.json({
    ...user,
    magic_link_url: `${proto}://${DOMAIN()}/u/${user.magic_token}`,
    card: card ?? null,
    transactions,
    cardEvents,
  });
});

// ── Credit balance ────────────────────────────────────────────────────────────

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

  const user = db.prepare('SELECT id, balance_sats FROM users WHERE id = ?').get(userId) as any;
  if (!user) { res.status(404).json({ error: 'User not found' }); return; }

  db.transaction(() => {
    db.prepare('UPDATE users SET balance_sats = balance_sats + ? WHERE id = ?').run(amount_sats, userId);
    db.prepare('INSERT INTO transactions (user_id, type, amount_sats, description) VALUES (?, ?, ?, ?)').run(
      userId, 'refill', amount_sats, description ?? 'Manual credit'
    );
  })();

  const updated = db.prepare('SELECT balance_sats FROM users WHERE id = ?').get(userId) as any;
  res.json({ balance_sats: updated.balance_sats });
});

// ── Withdraw all ──────────────────────────────────────────────────────────────

router.post('/users/:id/withdraw-all', (req, res) => {
  const userId = Number(req.params.id);
  const user = db.prepare('SELECT id, balance_sats FROM users WHERE id = ?').get(userId) as any;
  if (!user) { res.status(404).json({ error: 'User not found' }); return; }
  if (user.balance_sats <= 0) { res.status(400).json({ error: 'Balance is already zero' }); return; }

  const amount = user.balance_sats;
  db.transaction(() => {
    db.prepare('UPDATE users SET balance_sats = 0 WHERE id = ?').run(userId);
    db.prepare('INSERT INTO transactions (user_id, type, amount_sats, description) VALUES (?, ?, ?, ?)').run(
      userId, 'spend', amount, 'Admin withdrawal'
    );
  })();

  res.json({ withdrawn_sats: amount, balance_sats: 0 });
});

// Delete user (requires zero balance; also removes card and transactions)
router.delete('/users/:id', (req, res) => {
  const userId = Number(req.params.id);
  const user = db.prepare('SELECT id, balance_sats FROM users WHERE id = ?').get(userId) as any;
  if (!user) { res.status(404).json({ error: 'User not found' }); return; }
  if (user.balance_sats > 0) {
    res.status(400).json({ error: 'Withdraw all funds before deleting this user' });
    return;
  }
  db.transaction(() => {
    db.prepare('DELETE FROM transactions WHERE user_id = ?').run(userId);
    db.prepare('DELETE FROM cards WHERE user_id = ?').run(userId);
    db.prepare('DELETE FROM users WHERE id = ?').run(userId);
  })();
  res.json({ deleted: true });
});

// ── Cards ─────────────────────────────────────────────────────────────────────

router.post('/users/:id/card', (req, res) => {
  const userId = Number(req.params.id);
  const user = db.prepare('SELECT id FROM users WHERE id = ?').get(userId) as any;
  if (!user) { res.status(404).json({ error: 'User not found' }); return; }

  const existing = db.prepare('SELECT id FROM cards WHERE user_id = ?').get(userId) as any;
  if (existing) { res.status(409).json({ error: 'User already has a card' }); return; }

  const keys = generateKeys();
  const setupToken = uuidv4().replace(/-/g, '');

  const result = db.prepare(`
    INSERT INTO cards (user_id, k0, k1, k2, k3, k4, setup_token, tx_max_sats, day_max_sats)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(userId, keys.k0, keys.k1, keys.k2, keys.k3, keys.k4, setupToken, 999999999, 999999999);

  db.prepare('INSERT INTO card_events (user_id, event) VALUES (?, ?)').run(userId, 'created');
  res.status(201).json({ id: result.lastInsertRowid, setup_token: setupToken });
});

router.get('/users/:id/card/qr', async (req, res) => {
  const userId = Number(req.params.id);
  const card = db
    .prepare('SELECT setup_token, programmed_at FROM cards WHERE user_id = ?')
    .get(userId) as { setup_token: string | null; programmed_at: number | null } | undefined;

  if (!card) { res.status(404).json({ error: 'No card for this user' }); return; }
  if (!card.setup_token) {
    res.status(400).json({ error: 'Card already programmed or setup token consumed' });
    return;
  }

  const proto = DOMAIN().startsWith('localhost') ? 'http' : 'https';
  const setupUrl = `${proto}://${DOMAIN()}/api/card/setup/${card.setup_token}`;

  const qrPng = await QRCode.toBuffer(setupUrl, { type: 'png', width: 400 });
  res.set('Content-Type', 'image/png');
  res.send(qrPng);
});

// Regenerate setup token + new keys (reprogram / replace card)
router.post('/users/:id/card/reprogram', (req, res) => {
  const userId = Number(req.params.id);
  const existing = db.prepare('SELECT id, card_id FROM cards WHERE user_id = ?').get(userId) as any;
  if (!existing) { res.status(404).json({ error: 'No card found' }); return; }

  const keys = generateKeys();
  const setupToken = uuidv4().replace(/-/g, '');

  db.prepare(`
    UPDATE cards SET k0=?, k1=?, k2=?, k3=?, k4=?, setup_token=?, programmed_at=NULL, uid=NULL, counter=-1,
    previous_card_id=?, replaced_at=unixepoch(), wiped_at=NULL
    WHERE user_id=?
  `).run(keys.k0, keys.k1, keys.k2, keys.k3, keys.k4, setupToken, existing.card_id ?? null, userId);

  db.prepare('INSERT INTO card_events (user_id, event, description) VALUES (?, ?, ?)').run(userId, 'replaced', existing.card_id ? `Previous card: ${existing.card_id}` : null);
  res.json({ setup_token: setupToken });
});

// Update spending limits
router.patch('/users/:id/card/limits', (req, res) => {
  const userId = Number(req.params.id);
  const { tx_max_sats, day_max_sats } = req.body as { tx_max_sats?: number; day_max_sats?: number };
  if (!tx_max_sats && !day_max_sats) {
    res.status(400).json({ error: 'Provide tx_max_sats and/or day_max_sats' });
    return;
  }
  const existing = db.prepare('SELECT id, tx_max_sats, day_max_sats FROM cards WHERE user_id = ?').get(userId) as any;
  if (!existing) { res.status(404).json({ error: 'No card found' }); return; }

  const newTx = tx_max_sats ?? existing.tx_max_sats;
  const newDay = day_max_sats ?? existing.day_max_sats;
  db.prepare('UPDATE cards SET tx_max_sats=?, day_max_sats=? WHERE user_id=?').run(newTx, newDay, userId);
  res.json({ tx_max_sats: newTx, day_max_sats: newDay });
});

router.delete('/users/:id/card', (req, res) => {
  const userId = Number(req.params.id);
  const deleted = db.prepare('DELETE FROM cards WHERE user_id = ?').run(userId);
  if (deleted.changes === 0) { res.status(404).json({ error: 'No card found' }); return; }
  res.json({ deleted: true });
});

// Update card number (card_id label assigned from TSK or manually)
router.patch('/users/:id/card/card-id', (req, res) => {
  const userId = Number(req.params.id);
  const { card_id } = req.body as { card_id?: string };
  const existing = db.prepare('SELECT id FROM cards WHERE user_id = ?').get(userId) as any;
  if (!existing) { res.status(404).json({ error: 'No card found' }); return; }
  db.prepare('UPDATE cards SET card_id = ? WHERE user_id = ?').run(card_id?.trim() || null, userId);
  res.json({ card_id: card_id?.trim() || null });
});

// Generate a wipe QR payload: JSON with current card keys so programmer app can wipe the card
router.post('/users/:id/card/wipe', (req, res) => {
  const userId = Number(req.params.id);
  const card = db.prepare('SELECT id, k0, k1, k2, k3, k4 FROM cards WHERE user_id = ?').get(userId) as any;
  if (!card) { res.status(404).json({ error: 'No card found' }); return; }

  const wipePayload = JSON.stringify({
    protocol_name: 'create_bolt_card_wipe_response',
    version: 1,
    action: 'wipe',
    k0: card.k0,
    k1: card.k1,
    k2: card.k2,
    k3: card.k3,
    k4: card.k4,
  });
  db.prepare('UPDATE cards SET wipe_token = ?, wiped_at = unixepoch() WHERE user_id = ?').run(wipePayload, userId);
  db.prepare('INSERT INTO card_events (user_id, event, description) VALUES (?, ?, ?)').run(userId, 'wiped', card.card_id ? `Card: ${card.card_id}` : null);
  res.json({ ok: true });
});

router.get('/users/:id/card/wipe/qr', async (req, res) => {
  const userId = Number(req.params.id);
  const card = db
    .prepare('SELECT wipe_token FROM cards WHERE user_id = ?')
    .get(userId) as { wipe_token: string | null } | undefined;

  if (!card) { res.status(404).json({ error: 'No card for this user' }); return; }
  if (!card.wipe_token) {
    res.status(400).json({ error: 'No wipe token — generate one first' });
    return;
  }

  const qrPng = await QRCode.toBuffer(card.wipe_token, { type: 'png', width: 400 });
  res.set('Content-Type', 'image/png');
  res.send(qrPng);
});

router.post('/users/:id/card/enable', (req, res) => {
  const userId = Number(req.params.id);
  const updated = db.prepare('UPDATE cards SET enabled = 1 WHERE user_id = ?').run(userId);
  if (updated.changes === 0) { res.status(404).json({ error: 'No card found' }); return; }
  db.prepare('INSERT INTO card_events (user_id, event) VALUES (?, ?)').run(userId, 'enabled');
  res.json({ enabled: true });
});

router.post('/users/:id/card/disable', (req, res) => {
  const userId = Number(req.params.id);
  const updated = db.prepare('UPDATE cards SET enabled = 0 WHERE user_id = ?').run(userId);
  if (updated.changes === 0) { res.status(404).json({ error: 'No card found' }); return; }
  db.prepare('INSERT INTO card_events (user_id, event) VALUES (?, ?)').run(userId, 'disabled');
  res.json({ enabled: false });
});

// ── API Keys ──────────────────────────────────────────────────────────────────

router.post('/api-keys', (req, res) => {
  const { description } = req.body as { description?: string };
  const plaintext = randomBytes(32).toString('hex');
  const hash = createHash('sha256').update(plaintext).digest('hex');
  const result = db
    .prepare('INSERT INTO api_keys (key_hash, description) VALUES (?, ?)')
    .run(hash, description ?? null);
  res.status(201).json({ id: result.lastInsertRowid, key: plaintext, description });
});

router.delete('/api-keys/:id', (req, res) => {
  const id = Number(req.params.id);
  const deleted = db.prepare('DELETE FROM api_keys WHERE id = ?').run(id);
  if (deleted.changes === 0) { res.status(404).json({ error: 'API key not found' }); return; }
  res.json({ deleted: true });
});

export default router;
