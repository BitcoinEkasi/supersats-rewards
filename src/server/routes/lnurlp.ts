import { Router } from 'express';
import { db } from '../db/index.js';
import { createInvoice } from '../services/blink.js';

const router = Router();

const DOMAIN = () => process.env.DOMAIN!;
const MIN_SENDABLE = 1000;       // msats
const MAX_SENDABLE = 10_000_000; // msats (10,000 sats)

interface User {
  id: number;
  username: string;
  display_name: string;
  ln_address_enabled: number;
}

// ── GET /.well-known/lnurlp/:username ─────────────────────────────────────────

router.get('/:username', (req, res) => {
  const { username } = req.params;
  const user = db
    .prepare('SELECT * FROM users WHERE username = ? AND ln_address_enabled = 1 AND archived_at IS NULL')
    .get(username) as User | undefined;

  if (!user) {
    res.status(404).json({ status: 'ERROR', reason: 'User not found' });
    return;
  }

  const proto = DOMAIN().startsWith('localhost') ? 'http' : 'https';
  const metadata = JSON.stringify([
    ['text/plain', `Pay ${user.display_name}`],
    ['text/identifier', `${user.username}@${DOMAIN()}`],
  ]);

  res.json({
    tag: 'payRequest',
    callback: `${proto}://${DOMAIN()}/lnurlp/${user.username}/callback`,
    maxSendable: MAX_SENDABLE,
    minSendable: MIN_SENDABLE,
    metadata,
  });
});

// ── GET /lnurlp/:username/callback ────────────────────────────────────────────

router.get('/:username/callback', async (req, res) => {
  const { username } = req.params;
  const amountStr = req.query.amount as string | undefined;

  if (!amountStr) {
    res.json({ status: 'ERROR', reason: 'Missing amount' });
    return;
  }

  const amountMsats = parseInt(amountStr, 10);
  if (isNaN(amountMsats) || amountMsats < MIN_SENDABLE || amountMsats > MAX_SENDABLE) {
    res.json({ status: 'ERROR', reason: `Amount must be between ${MIN_SENDABLE} and ${MAX_SENDABLE} msats` });
    return;
  }

  const user = db
    .prepare('SELECT * FROM users WHERE username = ? AND ln_address_enabled = 1 AND archived_at IS NULL')
    .get(username) as User | undefined;

  if (!user) {
    res.json({ status: 'ERROR', reason: 'User not found' });
    return;
  }

  const amountSats = Math.floor(amountMsats / 1000);
  const now = Math.floor(Date.now() / 1000);

  let paymentHash: string;
  let paymentRequest: string;
  try {
    ({ paymentHash, paymentRequest } = await createInvoice(
      amountSats,
      `Refill for ${user.username}@${DOMAIN()}`
    ));
  } catch (err) {
    console.error('[lnurlp] createInvoice error:', err);
    res.json({ status: 'ERROR', reason: 'Failed to create invoice' });
    return;
  }

  db.prepare(
    'INSERT INTO pending_refills (user_id, payment_hash, amount_sats, expires_at) VALUES (?, ?, ?, ?)'
  ).run(user.id, paymentHash, amountSats, now + 3600);

  res.json({
    pr: paymentRequest,
    routes: [],
    successAction: { tag: 'message', message: 'Payment received! Your balance will update shortly.' },
  });
});

export default router;
