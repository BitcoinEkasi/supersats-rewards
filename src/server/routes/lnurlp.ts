import { Router } from 'express';
import { db } from '../db/index.js';
import { createInvoice } from '../services/blink.js';
import { getReceiveSettings, validateAmount, MIN_RECEIVE_SATS } from '../services/receiveLimits.js';
import { allowInvoiceRequest } from '../services/rateLimit.js';

const router = Router();

const DOMAIN = () => process.env.DOMAIN!;

interface User {
  id: number;
  username: string;
  display_name: string;
  ln_address_enabled: number;
}

// ── GET /.well-known/lnurlp/:username ─────────────────────────────────────────

router.get('/:username', (req, res) => {
  // Usernames are stored lowercase; wallets may send TSK00021@…
  const username = req.params.username.toLowerCase();
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
    maxSendable: getReceiveSettings().maxSats * 1000,
    minSendable: MIN_RECEIVE_SATS * 1000,
    metadata,
  });
});

// ── GET /lnurlp/:username/callback ────────────────────────────────────────────

router.get('/:username/callback', async (req, res) => {
  // Usernames are stored lowercase; wallets may send TSK00021@…
  const username = req.params.username.toLowerCase();
  const amountStr = req.query.amount as string | undefined;
  const limits = getReceiveSettings();

  // Each callback creates a Blink invoice — cap requests per payer IP
  if (!allowInvoiceRequest(req.ip ?? 'unknown', limits.ratePerMin)) {
    res.status(429).json({ status: 'ERROR', reason: 'Too many payment requests. Please wait a minute and try again.' });
    return;
  }

  if (!amountStr) {
    res.json({ status: 'ERROR', reason: 'Missing amount' });
    return;
  }

  const amountError = validateAmount(Number(amountStr), limits.maxSats);
  if (amountError) {
    res.json({ status: 'ERROR', reason: amountError });
    return;
  }
  const amountMsats = Number(amountStr);

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
