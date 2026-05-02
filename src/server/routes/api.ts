import { Router } from 'express';
import { v4 as uuidv4 } from 'uuid';
import QRCode from 'qrcode';
import { db } from '../db/index.js';
import { requireApiKey } from '../middleware/apiKeyAuth.js';
import { generateKeys } from '../services/crypto.js';
import { createInvoice, payInvoice, getBalance } from '../services/blink.js';
import { resolveLnAddress } from '../services/lnurl.js';

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
    .prepare('SELECT id, username, display_name, balance_sats, ln_address_enabled, ln_payout_address, magic_token, created_at FROM users WHERE id = ?')
    .get(userId) as any;
  if (!user) { res.status(404).json({ error: 'User not found' }); return; }

  const card = db
    .prepare('SELECT id, card_id, programmed_at, enabled, uid, tx_max_sats, day_max_sats FROM cards WHERE user_id = ?')
    .get(userId) as any;

  const txRows = db
    .prepare('SELECT id, type, amount_sats, description, created_at FROM transactions WHERE user_id = ? ORDER BY created_at DESC LIMIT 20')
    .all(userId) as any[];

  const lnPayoutRows = db
    .prepare('SELECT id, amount_sats, ln_address, status, description, created_at FROM ln_payouts WHERE user_id = ? ORDER BY created_at DESC LIMIT 20')
    .all(userId) as any[];

  const lnPayoutsMapped = lnPayoutRows.map(r => ({
    id: r.id,
    type: 'ln_payout' as const,
    amount_sats: r.amount_sats,
    description: r.description ?? r.ln_address,
    status: r.status,
    created_at: r.created_at,
  }));

  const transactions = [...txRows, ...lnPayoutsMapped]
    .sort((a, b) => b.created_at - a.created_at)
    .slice(0, 20);

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

// ── PATCH /api/v1/users/:id ───────────────────────────────────────────────────

router.patch('/users/:id', (req, res) => {
  const userId = Number(req.params.id);
  const { ln_payout_address, display_name, division, tsk_level, jc_level } = req.body as {
    ln_payout_address?: string | null;
    display_name?: string;
    division?: string | null;
    tsk_level?: string | null;
    jc_level?: number | null;
  };
  const user = db.prepare('SELECT id FROM users WHERE id = ?').get(userId) as any;
  if (!user) { res.status(404).json({ error: 'User not found' }); return; }
  if (display_name !== undefined) db.prepare('UPDATE users SET display_name = ? WHERE id = ?').run(display_name, userId);
  if (ln_payout_address !== undefined) db.prepare('UPDATE users SET ln_payout_address = ? WHERE id = ?').run(ln_payout_address ?? null, userId);
  if (division !== undefined) db.prepare('UPDATE users SET division = ? WHERE id = ?').run(division ?? null, userId);
  if (tsk_level !== undefined) db.prepare('UPDATE users SET tsk_level = ? WHERE id = ?').run(tsk_level ?? null, userId);
  if (jc_level !== undefined) db.prepare('UPDATE users SET jc_level = ? WHERE id = ?').run(jc_level ?? null, userId);
  res.json({ success: true });
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
  const { memo, payouts, invoice_sats } = req.body as {
    memo?: string;
    invoice_sats?: number;
    payouts?: { user_id: number; amount_sats: number; description?: string; payout_type?: string; ln_address?: string }[];
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
    if (p.payout_type === 'ln_address' && !p.ln_address) {
      res.status(400).json({ error: `ln_address required for user ${p.user_id} with payout_type ln_address` }); return;
    }
  }

  const totalSats = payouts.reduce((sum, p) => sum + p.amount_sats, 0);
  // invoice_sats allows a partial top-up: invoice covers only the shortfall, reserves cover the rest
  const invoiceAmount = (invoice_sats && invoice_sats > 0 && invoice_sats < totalSats) ? invoice_sats : totalSats;
  const batchMemo = memo ?? 'TSK monthly reward payout';

  let invoice: { paymentHash: string; paymentRequest: string };
  try {
    invoice = await createInvoice(invoiceAmount, batchMemo);
  } catch (err: any) {
    res.status(502).json({ error: `Failed to create Lightning invoice: ${err.message}` });
    return;
  }

  const qrBase64 = await QRCode.toDataURL(`lightning:${invoice.paymentRequest}`, {
    width: 400, margin: 2,
    color: { dark: '#000000', light: '#ffffff' },
  }).then((dataUrl: string) => dataUrl.replace(/^data:image\/png;base64,/, ''));

  const batchResult = db.prepare(
    'INSERT INTO payout_batches (payment_hash, payment_request, total_sats, invoice_sats, memo) VALUES (?, ?, ?, ?, ?)'
  ).run(invoice.paymentHash, invoice.paymentRequest, totalSats, invoiceAmount < totalSats ? invoiceAmount : null, batchMemo);

  const batchId = batchResult.lastInsertRowid as number;
  const insertItem = db.prepare(
    'INSERT INTO payout_batch_items (batch_id, user_id, amount_sats, description, payout_type, ln_address) VALUES (?, ?, ?, ?, ?, ?)'
  );
  for (const p of payouts) {
    insertItem.run(batchId, p.user_id, p.amount_sats, p.description ?? null, p.payout_type ?? 'internal', p.ln_address ?? null);
  }

  res.status(201).json({
    batch_id: batchId,
    payment_hash: invoice.paymentHash,
    payment_request: invoice.paymentRequest,
    total_sats: invoiceAmount,
    qr_base64: qrBase64,
  });
});

// ── POST /api/v1/users/:id/ln-payout ─────────────────────────────────────────
// Ad-hoc manual send to a Lightning address. Used by admin for manual retries.

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
      // Extract payment hash from BOLT11 (first 32 bytes after hrp+version — use a simple regex)
      const hashMatch = pr.match(/^ln\w+1[02-9ac-hj-np-z]{6,}([02-9ac-hj-np-z]{64})/i);
      paymentHash = hashMatch?.[1] ?? null;
    }
  } catch (err: any) {
    console.error(`[ln-payout] manual send to ${ln_address} failed:`, err.message);
  }

  db.prepare(
    'INSERT INTO ln_payouts (user_id, amount_sats, ln_address, payment_hash, status, description) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(userId, amount_sats, ln_address, paymentHash, status, description ?? null);

  res.status(status === 'paid' ? 200 : 502).json({ status, ln_address, amount_sats });
});

// ── GET /api/v1/payout/reserve ────────────────────────────────────────────────

router.get('/payout/reserve', async (_req, res) => {
  const { total: totalUserBalance } = db
    .prepare('SELECT COALESCE(SUM(balance_sats), 0) AS total FROM users')
    .get() as { total: number };
  let blinkBalance = 0;
  try {
    blinkBalance = await getBalance();
  } catch (err) {
    console.error('[api] payout/reserve getBalance error:', err);
  }
  res.json({ reserve_sats: blinkBalance - totalUserBalance });
});

// ── POST /api/v1/payout/batch/direct ─────────────────────────────────────────

router.post('/payout/batch/direct', async (req, res) => {
  const { memo, payouts } = req.body as {
    memo?: string;
    payouts?: { user_id: number; amount_sats: number; description?: string; payout_type?: string; ln_address?: string }[];
  };
  if (!payouts || !Array.isArray(payouts) || payouts.length === 0) {
    res.status(400).json({ error: 'payouts array required' });
    return;
  }

  for (const p of payouts) {
    const u = db.prepare('SELECT id FROM users WHERE id = ?').get(p.user_id);
    if (!u) { res.status(400).json({ error: `User ${p.user_id} not found` }); return; }
    if (!p.amount_sats || p.amount_sats <= 0) {
      res.status(400).json({ error: `Invalid amount_sats for user ${p.user_id}` }); return;
    }
    if (p.payout_type === 'ln_address' && !p.ln_address) {
      res.status(400).json({ error: `ln_address required for user ${p.user_id} with payout_type ln_address` }); return;
    }
  }

  const totalSats = payouts.reduce((sum, p) => sum + p.amount_sats, 0);

  // Verify reserve is sufficient
  const { total: totalUserBalance } = db
    .prepare('SELECT COALESCE(SUM(balance_sats), 0) AS total FROM users')
    .get() as { total: number };
  let blinkBalance = 0;
  try {
    blinkBalance = await getBalance();
  } catch (err: any) {
    res.status(502).json({ error: `Failed to fetch balance: ${err.message}` });
    return;
  }
  const reserveSats = blinkBalance - totalUserBalance;
  if (reserveSats < totalSats) {
    res.status(402).json({ error: `Insufficient reserves: ${reserveSats} sats available, ${totalSats} sats required` });
    return;
  }

  const batchMemo = memo ?? 'TSK monthly reward payout (direct)';
  const syntheticHash = 'direct_' + uuidv4().replace(/-/g, '');

  const batchResult = db.prepare(
    "INSERT INTO payout_batches (payment_hash, payment_request, total_sats, memo, source, status, paid_at) VALUES (?, '', ?, ?, 'direct', 'paid', unixepoch())"
  ).run(syntheticHash, totalSats, batchMemo);

  const batchId = batchResult.lastInsertRowid as number;
  const insertItem = db.prepare(
    'INSERT INTO payout_batch_items (batch_id, user_id, amount_sats, description, payout_type, ln_address) VALUES (?, ?, ?, ?, ?, ?)'
  );
  for (const p of payouts) {
    insertItem.run(batchId, p.user_id, p.amount_sats, p.description ?? null, p.payout_type ?? 'internal', p.ln_address ?? null);
  }

  // Credit internal items immediately
  db.transaction(() => {
    for (const p of payouts) {
      if (p.payout_type === 'ln_address') continue;
      db.prepare('UPDATE users SET balance_sats = balance_sats + ? WHERE id = ?').run(p.amount_sats, p.user_id);
      db.prepare('INSERT INTO transactions (user_id, type, amount_sats, description) VALUES (?, ?, ?, ?)').run(
        p.user_id, 'refill', p.amount_sats, p.description ?? 'Monthly reward payout (direct)'
      );
      db.prepare('INSERT INTO card_events (user_id, event, description) VALUES (?, ?, ?)').run(
        p.user_id, 'credited', `${p.amount_sats} sats — ${batchMemo}`
      );
    }
  })();

  // Fire outbound LN payments async for ln_address items
  const lnItems = payouts.filter(p => p.payout_type === 'ln_address' && p.ln_address);
  for (const p of lnItems) {
    (async () => {
      let paymentHash: string | null = null;
      let status = 'failed';
      try {
        const pr = await resolveLnAddress(p.ln_address!, p.amount_sats);
        const payStatus = await payInvoice(pr);
        if (payStatus === 'SUCCESS' || payStatus === 'ALREADY_PAID') status = 'paid';
        console.log(`[direct-payout] LN address payout to ${p.ln_address}: ${payStatus}`);
      } catch (err: any) {
        console.error(`[direct-payout] LN address payout to ${p.ln_address} failed:`, err.message);
      }
      db.prepare(
        'INSERT INTO ln_payouts (user_id, amount_sats, ln_address, payment_hash, status, description) VALUES (?, ?, ?, ?, ?, ?)'
      ).run(p.user_id, p.amount_sats, p.ln_address, paymentHash, status, p.description ?? 'Monthly reward payout (direct)');
    })();
  }

  console.log(`[direct-payout] Batch #${batchId} — credited ${payouts.length - lnItems.length} internal, queued ${lnItems.length} LN address`);
  res.status(201).json({ batch_id: batchId, total_sats: totalSats, status: 'paid' });
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
