import { Router } from 'express';
import { createHash, randomBytes } from 'crypto';
import { v4 as uuidv4 } from 'uuid';
import QRCode from 'qrcode';
import { db } from '../db/index.js';
import { requireAdmin } from '../middleware/adminAuth.js';
import { generateKeys } from '../services/crypto.js';
import { getBalance, payInvoice, getTransactions } from '../services/blink.js';
import { resolveLnAddress } from '../services/lnurl.js';
import { getZarPerSat } from '../services/zarPrice.js';
import { blinkCounterPartyByPaymentHash, txToMovement, lnPayoutToMovement } from '../services/movements.js';

const router = Router();
router.use(requireAdmin);

const DOMAIN = () => process.env.DOMAIN!;

// ── Dashboard ─────────────────────────────────────────────────────────────────

router.get('/dashboard', async (_req, res) => {
  const users = db.prepare(`
    SELECT u.id, u.username, u.display_name, u.balance_sats, u.ln_payout_address, u.created_at,
           u.tsk_group, u.ac,
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

  const settings = db.prepare(
    'SELECT cards_enabled, velocity_max_taps, velocity_window_secs FROM system_settings WHERE id = 1'
  ).get() as { cards_enabled: number; velocity_max_taps: number; velocity_window_secs: number };

  res.json({
    users, systemBalance, cardsEnabled: !!settings.cards_enabled,
    velocityMaxTaps: settings.velocity_max_taps, velocityWindowSecs: settings.velocity_window_secs,
  });
});

router.get('/blink-transactions', async (req, res) => {
  const after = typeof req.query.after === 'string' ? req.query.after : undefined;
  try {
    const page = await getTransactions(50, after);
    res.json(page);
  } catch (err: any) {
    res.status(502).json({ error: err.message });
  }
});

// ── Internal movements (from/to across cards, reserve, and LN addresses) ──────

router.get('/movements', async (_req, res) => {
  const txRows = db.prepare(`
    SELECT t.id, t.type, t.amount_sats, t.payment_hash, t.description, t.created_at, t.zar_per_sat,
           u.display_name, c.card_id AS card_number
    FROM transactions t
    JOIN users u ON u.id = t.user_id
    LEFT JOIN cards c ON c.user_id = u.id
    ORDER BY t.created_at DESC
    LIMIT 300
  `).all() as {
    id: number; type: 'spend' | 'refill' | 'card_fee'; amount_sats: number;
    payment_hash: string | null; description: string | null; created_at: number; zar_per_sat: number | null;
    display_name: string; card_number: string | null;
  }[];

  let blinkCounterParties = new Map<string, string>();
  if (txRows.some((t) => t.type === 'spend' && t.payment_hash)) {
    try {
      blinkCounterParties = await blinkCounterPartyByPaymentHash();
    } catch (err) {
      console.error('[admin] movements: failed to fetch Blink counterparties:', err);
    }
  }

  const lnPayoutRows = db.prepare(`
    SELECT lp.id, lp.amount_sats, lp.ln_address, lp.status, lp.description, lp.created_at, lp.zar_per_sat,
           u.display_name
    FROM ln_payouts lp
    JOIN users u ON u.id = lp.user_id
    ORDER BY lp.created_at DESC
    LIMIT 300
  `).all() as {
    id: number; amount_sats: number; ln_address: string; status: string;
    description: string | null; created_at: number; zar_per_sat: number | null; display_name: string;
  }[];

  const movements = [
    ...txRows.map((t) => txToMovement(t, `Card ${t.card_number ?? '?'} — ${t.display_name}`, blinkCounterParties)),
    ...lnPayoutRows.map((p) => lnPayoutToMovement(p, p.display_name)),
  ]
    .sort((a, b) => b.created_at - a.created_at)
    .slice(0, 300);

  res.json(movements);
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

router.get('/users/:id', async (req, res) => {
  const userId = Number(req.params.id);
  const user = db
    .prepare('SELECT * FROM users WHERE id = ?')
    .get(userId) as any;
  if (!user) { res.status(404).json({ error: 'User not found' }); return; }

  // Card info — redact keys from response
  const card = db
    .prepare('SELECT id, user_id, card_id, uid, counter, tx_max_sats, day_max_sats, day_spent_sats, setup_token, wipe_token, programmed_at, wiped_at, previous_card_id, replaced_at, enabled, created_at FROM cards WHERE user_id = ?')
    .get(userId) as any;

  const txRows = db
    .prepare('SELECT id, type, amount_sats, payment_hash, description, created_at, zar_per_sat FROM transactions WHERE user_id = ? ORDER BY created_at DESC LIMIT 50')
    .all(userId) as {
      id: number; type: 'spend' | 'refill' | 'card_fee'; amount_sats: number;
      payment_hash: string | null; description: string | null; created_at: number; zar_per_sat: number | null;
    }[];

  let blinkCounterParties = new Map<string, string>();
  if (txRows.some((t) => t.type === 'spend' && t.payment_hash)) {
    try {
      blinkCounterParties = await blinkCounterPartyByPaymentHash();
    } catch (err) {
      console.error('[admin] user detail: failed to fetch Blink counterparties:', err);
    }
  }

  const lnRows = db
    .prepare('SELECT id, amount_sats, ln_address, status, description, created_at, zar_per_sat FROM ln_payouts WHERE user_id = ? ORDER BY created_at DESC LIMIT 50')
    .all(userId) as {
      id: number; amount_sats: number; ln_address: string; status: string;
      description: string | null; created_at: number; zar_per_sat: number | null;
    }[];

  const cardLabel = `Card ${card?.card_id ?? '?'} — ${user.display_name}`;
  const transactions = [
    ...txRows.map((t) => txToMovement(t, cardLabel, blinkCounterParties)),
    ...lnRows.map((p) => lnPayoutToMovement(p, user.display_name)),
  ]
    .sort((a, b) => b.created_at - a.created_at)
    .slice(0, 50);

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

router.post('/users/:id/credit', async (req, res) => {
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

  const zarPerSat = await getZarPerSat();
  db.transaction(() => {
    db.prepare('UPDATE users SET balance_sats = balance_sats + ? WHERE id = ?').run(amount_sats, userId);
    db.prepare('INSERT INTO transactions (user_id, type, amount_sats, description, zar_per_sat) VALUES (?, ?, ?, ?, ?)').run(
      userId, 'refill', amount_sats, description ?? 'Manual credit', zarPerSat
    );
  })();

  const updated = db.prepare('SELECT balance_sats FROM users WHERE id = ?').get(userId) as any;
  res.json({ balance_sats: updated.balance_sats });
});

// ── Withdraw all ──────────────────────────────────────────────────────────────

router.post('/users/:id/withdraw-all', async (req, res) => {
  const userId = Number(req.params.id);
  const user = db.prepare('SELECT id, balance_sats FROM users WHERE id = ?').get(userId) as any;
  if (!user) { res.status(404).json({ error: 'User not found' }); return; }
  if (user.balance_sats <= 0) { res.status(400).json({ error: 'Balance is already zero' }); return; }

  const amount = user.balance_sats;
  const zarPerSat = await getZarPerSat();
  db.transaction(() => {
    db.prepare('UPDATE users SET balance_sats = 0 WHERE id = ?').run(userId);
    db.prepare('INSERT INTO transactions (user_id, type, amount_sats, description, zar_per_sat) VALUES (?, ?, ?, ?, ?)').run(
      userId, 'spend', amount, 'Admin withdrawal', zarPerSat
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
router.post('/users/:id/card/reprogram', async (req, res) => {
  const userId = Number(req.params.id);
  const { replacement_type } = req.body as { replacement_type?: string };
  if (!replacement_type || !['technical', 'lost_damaged'].includes(replacement_type)) {
    res.status(400).json({ error: 'replacement_type must be "technical" or "lost_damaged"' }); return;
  }

  const existing = db.prepare('SELECT id, card_id FROM cards WHERE user_id = ?').get(userId) as any;
  if (!existing) { res.status(404).json({ error: 'No card found' }); return; }

  const keys = generateKeys();
  const setupToken = uuidv4().replace(/-/g, '');
  const isLostDamaged = replacement_type === 'lost_damaged';
  const REPLACEMENT_FEE_SATS = 2500;

  if (isLostDamaged) {
    const user = db.prepare('SELECT balance_sats FROM users WHERE id = ?').get(userId) as any;
    if (!user || user.balance_sats < REPLACEMENT_FEE_SATS) {
      res.status(402).json({
        error: `Insufficient balance. Participant needs at least 2,500 sats to cover the replacement fee (current balance: ${user?.balance_sats ?? 0} sats).`
      });
      return;
    }
  }

  const zarPerSat = isLostDamaged ? await getZarPerSat() : null;
  db.transaction(() => {
    db.prepare(`
      UPDATE cards SET k0=?, k1=?, k2=?, k3=?, k4=?, setup_token=?, programmed_at=NULL, uid=NULL, counter=-1,
      previous_card_id=?, replaced_at=unixepoch(), wiped_at=NULL
      WHERE user_id=?
    `).run(keys.k0, keys.k1, keys.k2, keys.k3, keys.k4, setupToken, existing.card_id ?? null, userId);

    const eventDesc = [
      existing.card_id ? `Previous card: ${existing.card_id}` : null,
      isLostDamaged ? 'Lost/damaged — fee charged' : 'Technical replacement — no charge',
    ].filter(Boolean).join(' | ');
    db.prepare('INSERT INTO card_events (user_id, event, description) VALUES (?, ?, ?)').run(userId, 'replaced', eventDesc);

    if (isLostDamaged) {
      db.prepare('UPDATE users SET balance_sats = balance_sats - ? WHERE id = ?').run(REPLACEMENT_FEE_SATS, userId);
      db.prepare('INSERT INTO transactions (user_id, type, amount_sats, description, zar_per_sat) VALUES (?, ?, ?, ?, ?)').run(
        userId, 'card_fee', REPLACEMENT_FEE_SATS, 'Card replacement fee (lost/damaged)', zarPerSat
      );
    }
  })();

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

// Overwrite spending limits for every currently-active (enabled) card at once
router.patch('/cards/limits/bulk', async (req, res) => {
  const { tx_max_sats, day_max_sats } = req.body as { tx_max_sats?: number; day_max_sats?: number };
  if (!tx_max_sats && !day_max_sats) {
    res.status(400).json({ error: 'Provide tx_max_sats and/or day_max_sats' });
    return;
  }
  if ((tx_max_sats != null && tx_max_sats <= 0) || (day_max_sats != null && day_max_sats <= 0)) {
    res.status(400).json({ error: 'Limits must be positive' });
    return;
  }

  const zarPerSat = await getZarPerSat();

  const updated = db.transaction(() => {
    const affected = db.prepare('SELECT user_id FROM cards WHERE enabled = 1').all() as { user_id: number }[];
    db.prepare(
      'UPDATE cards SET tx_max_sats = COALESCE(?, tx_max_sats), day_max_sats = COALESCE(?, day_max_sats) WHERE enabled = 1'
    ).run(tx_max_sats ?? null, day_max_sats ?? null);

    const desc = `Bulk admin update: ${tx_max_sats ? tx_max_sats + ' sats/tap' : 'tap limit unchanged'}, ${day_max_sats ? day_max_sats + ' sats/day' : 'day limit unchanged'}`;
    const insertEvent = db.prepare('INSERT INTO card_events (user_id, event, description) VALUES (?, ?, ?)');
    for (const { user_id } of affected) insertEvent.run(user_id, 'limits_updated', desc);

    db.prepare(
      'INSERT INTO bulk_limit_events (tx_max_sats, day_max_sats, affected_count, zar_per_sat) VALUES (?, ?, ?, ?)'
    ).run(tx_max_sats ?? null, day_max_sats ?? null, affected.length, zarPerSat);

    return affected.length;
  })();

  res.json({ updated, tx_max_sats, day_max_sats });
});

router.get('/cards/limits/bulk/history', (_req, res) => {
  const history = db.prepare(
    'SELECT id, tx_max_sats, day_max_sats, affected_count, zar_per_sat, created_at FROM bulk_limit_events ORDER BY created_at DESC LIMIT 20'
  ).all();
  res.json({ history });
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

// ── Global emergency stop — freezes card-tap spending for every card ─────────

router.post('/system-settings/cards-enabled', (req, res) => {
  const { enabled } = req.body as { enabled?: boolean };
  if (typeof enabled !== 'boolean') {
    res.status(400).json({ error: 'enabled (boolean) required' });
    return;
  }
  db.prepare('UPDATE system_settings SET cards_enabled = ? WHERE id = 1').run(enabled ? 1 : 0);
  res.json({ enabled });
});

// ── Velocity-limit (rapid-tap auto-disable) settings ─────────────────────────

router.post('/system-settings/velocity-limit', (req, res) => {
  const { max_taps, window_secs } = req.body as { max_taps?: number; window_secs?: number };
  if (!max_taps || !window_secs || max_taps <= 0 || window_secs <= 0) {
    res.status(400).json({ error: 'max_taps and window_secs must be positive' });
    return;
  }
  db.prepare('UPDATE system_settings SET velocity_max_taps = ?, velocity_window_secs = ? WHERE id = 1').run(max_taps, window_secs);
  res.json({ velocity_max_taps: max_taps, velocity_window_secs: window_secs });
});

// ── POST /api/admin/users/:id/ln-payout ──────────────────────────────────────
// Manual ad-hoc Lightning address payment (called from admin dashboard UI)

router.post('/users/:id/ln-payout', async (req, res) => {
  const userId = Number(req.params.id);
  const { ln_address, amount_sats, description } = req.body as {
    ln_address?: string;
    amount_sats?: number;
    description?: string;
  };
  if (!ln_address || !amount_sats || amount_sats <= 0) {
    res.status(400).json({ error: 'ln_address and amount_sats (positive) required' });
    return;
  }
  const user = db.prepare('SELECT id FROM users WHERE id = ?').get(userId) as any;
  if (!user) { res.status(404).json({ error: 'User not found' }); return; }

  let paymentHash: string | null = null;
  let status = 'failed';
  try {
    const pr = await resolveLnAddress(ln_address, amount_sats);
    const payStatus = await payInvoice(pr);
    if (payStatus === 'SUCCESS' || payStatus === 'ALREADY_PAID') {
      status = 'paid';
    }
    console.log(`[ln-payout] manual send to ${ln_address}: ${payStatus}`);
  } catch (err: any) {
    console.error(`[ln-payout] manual send to ${ln_address} failed:`, err.message);
  }

  const zarPerSat = await getZarPerSat();
  db.prepare(
    'INSERT INTO ln_payouts (user_id, amount_sats, ln_address, payment_hash, status, description, zar_per_sat) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ).run(userId, amount_sats, ln_address, paymentHash, status, description ?? null, zarPerSat);

  res.status(status === 'paid' ? 200 : 502).json({ status, ln_address, amount_sats });
});

// ── Balance summary ───────────────────────────────────────────────────────────

router.get('/balance-summary', async (_req, res) => {
  const { total: totalUserBalance } = db
    .prepare('SELECT COALESCE(SUM(balance_sats), 0) AS total FROM users')
    .get() as { total: number };
  let blinkBalance = 0;
  try {
    blinkBalance = await getBalance();
  } catch (err) {
    console.error('[admin] balance-summary getBalance error:', err);
  }
  res.json({ blinkBalance, totalUserBalance, reserveSats: blinkBalance - totalUserBalance });
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
