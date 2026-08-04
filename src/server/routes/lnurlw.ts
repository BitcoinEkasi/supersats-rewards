import { Router } from 'express';
import { v4 as uuidv4 } from 'uuid';
// @ts-ignore — bolt11 has no reliable types
import bolt11 from 'bolt11';
import { db } from '../db/index.js';
import { decryptP, verifyCmac } from '../services/crypto.js';
import { payInvoice } from '../services/blink.js';
import { getZarPerSat } from '../services/zarPrice.js';

const router = Router();

const DOMAIN = () => process.env.DOMAIN!;
const WITHDRAW_EXPIRY_SECS = 30;

// ── Types ─────────────────────────────────────────────────────────────────────

interface Card {
  id: number;
  user_id: number;
  k1: string;
  k2: string;
  uid: string | null;
  counter: number;
  tx_max_sats: number;
  day_max_sats: number;
  day_spent_sats: number;
  day_reset_at: number;
  enabled: number;
}

interface User {
  id: number;
  balance_sats: number;
}

interface PendingWithdrawal {
  k1_token: string;
  card_id: number;
  max_sats: number;
  expires_at: number;
}

// ── GET /lnurlw — initial card tap ────────────────────────────────────────────

router.get('/', (req, res) => {
  const settings = db.prepare(
    'SELECT cards_enabled, velocity_max_taps, velocity_window_secs FROM system_settings WHERE id = 1'
  ).get() as { cards_enabled: number; velocity_max_taps: number; velocity_window_secs: number };
  if (!settings.cards_enabled) {
    res.json({ status: 'ERROR', reason: 'Card payments are temporarily unavailable — please try again later.' });
    return;
  }

  const { p, c } = req.query as { p?: string; c?: string };

  if (!p || !c || p.length !== 32 || c.length !== 16) {
    res.json({ status: 'ERROR', reason: 'Missing or invalid p/c parameters' });
    return;
  }

  // Load all enabled cards and find the one whose K1 decrypts p correctly
  const cards = db
    .prepare('SELECT * FROM cards WHERE enabled = 1')
    .all() as Card[];

  let matchedCard: Card | null = null;
  let uid = '';
  let counter = 0;

  for (const card of cards) {
    try {
      const result = decryptP(card.k1, p);
      uid = result.uid;
      counter = result.counter;
      matchedCard = card;
      break;
    } catch {
      // Magic byte mismatch or decryption error — try next card
    }
  }

  if (!matchedCard) {
    res.json({ status: 'ERROR', reason: 'Card not recognized' });
    return;
  }

  // Replay prevention: counter must be strictly increasing
  if (matchedCard.uid !== null) {
    if (uid !== matchedCard.uid) {
      res.json({ status: 'ERROR', reason: 'UID mismatch' });
      return;
    }
    if (counter <= matchedCard.counter) {
      res.json({ status: 'ERROR', reason: 'Replayed tap (counter not increasing)' });
      return;
    }
  } else {
    // First tap — any counter ≥ 0 is acceptable
    if (counter < 0) {
      res.json({ status: 'ERROR', reason: 'Invalid counter' });
      return;
    }
  }

  // Verify CMAC
  if (!verifyCmac(matchedCard.k2, uid, counter, c)) {
    res.json({ status: 'ERROR', reason: 'CMAC verification failed' });
    return;
  }

  // Velocity check: too many taps in a short window auto-disables the card
  // (protects a lost/stolen card from being drained — there's no PIN on the NFC tap itself)
  const nowSecs = Math.floor(Date.now() / 1000);
  const windowStart = nowSecs - settings.velocity_window_secs;
  db.prepare('INSERT INTO card_taps (card_id, created_at) VALUES (?, ?)').run(matchedCard.id, nowSecs);
  db.prepare('DELETE FROM card_taps WHERE card_id = ? AND created_at <= ?').run(matchedCard.id, windowStart);
  const tapCount = (db.prepare(
    'SELECT COUNT(*) AS n FROM card_taps WHERE card_id = ? AND created_at > ?'
  ).get(matchedCard.id, windowStart) as { n: number }).n;

  if (tapCount >= settings.velocity_max_taps) {
    db.transaction(() => {
      db.prepare('UPDATE cards SET enabled = 0 WHERE id = ?').run(matchedCard!.id);
      db.prepare('INSERT INTO card_events (user_id, event, description) VALUES (?, ?, ?)').run(
        matchedCard!.user_id, 'auto_disabled',
        `Velocity limit: ${tapCount} taps within ${settings.velocity_window_secs}s`
      );
    })();
    res.json({ status: 'ERROR', reason: 'Card disabled — unusual tap activity detected. Contact an administrator.' });
    return;
  }

  // Get user balance
  const user = db
    .prepare('SELECT id, balance_sats FROM users WHERE id = ?')
    .get(matchedCard.user_id) as User | undefined;

  if (!user || user.balance_sats <= 0) {
    res.json({ status: 'ERROR', reason: 'Insufficient balance' });
    return;
  }

  // Reset daily spend if it's a new day
  const todayStart = Math.floor(new Date().setHours(0, 0, 0, 0) / 1000);
  const daySpent =
    matchedCard.day_reset_at < todayStart ? 0 : matchedCard.day_spent_sats;

  // Compute max withdrawable
  const maxSats = Math.min(
    matchedCard.tx_max_sats,
    user.balance_sats,
    matchedCard.day_max_sats - daySpent
  );

  if (maxSats <= 0) {
    res.json({ status: 'ERROR', reason: 'Daily limit reached or zero balance' });
    return;
  }

  const k1Token = uuidv4();
  const now = Math.floor(Date.now() / 1000);

  // Atomically update counter (replay guard) and insert pending withdrawal
  db.transaction(() => {
    if (matchedCard!.uid === null) {
      db.prepare('UPDATE cards SET uid = ?, counter = ?, day_spent_sats = ?, day_reset_at = ? WHERE id = ?').run(
        uid,
        counter,
        daySpent,
        matchedCard!.day_reset_at < todayStart ? todayStart : matchedCard!.day_reset_at,
        matchedCard!.id
      );
    } else {
      db.prepare('UPDATE cards SET counter = ?, day_spent_sats = ?, day_reset_at = ? WHERE id = ?').run(
        counter,
        daySpent,
        matchedCard!.day_reset_at < todayStart ? todayStart : matchedCard!.day_reset_at,
        matchedCard!.id
      );
    }
    db.prepare(
      'INSERT INTO pending_withdrawals (k1_token, card_id, max_sats, expires_at) VALUES (?, ?, ?, ?)'
    ).run(k1Token, matchedCard!.id, maxSats, now + WITHDRAW_EXPIRY_SECS);
  })();

  const proto = DOMAIN().startsWith('localhost') ? 'http' : 'https';
  res.json({
    tag: 'withdrawRequest',
    callback: `${proto}://${DOMAIN()}/lnurlw/callback`,
    k1: k1Token,
    defaultDescription: 'BoltCard Payment',
    minWithdrawable: 1000,
    maxWithdrawable: maxSats * 1000,
  });
});

// ── GET /lnurlw/callback — payment callback ───────────────────────────────────

router.get('/callback', async (req, res) => {
  const settings = db.prepare('SELECT cards_enabled FROM system_settings WHERE id = 1').get() as { cards_enabled: number };
  if (!settings.cards_enabled) {
    res.json({ status: 'ERROR', reason: 'Card payments are temporarily unavailable — please try again later.' });
    return;
  }

  const { k1, pr } = req.query as { k1?: string; pr?: string };

  if (!k1 || !pr) {
    res.json({ status: 'ERROR', reason: 'Missing k1 or pr' });
    return;
  }

  const now = Math.floor(Date.now() / 1000);
  const pending = db
    .prepare('SELECT * FROM pending_withdrawals WHERE k1_token = ?')
    .get(k1) as PendingWithdrawal | undefined;

  if (!pending) {
    res.json({ status: 'ERROR', reason: 'Unknown or expired withdrawal request' });
    return;
  }

  if (pending.expires_at < now) {
    db.prepare('DELETE FROM pending_withdrawals WHERE k1_token = ?').run(k1);
    res.json({ status: 'ERROR', reason: 'Withdrawal request expired' });
    return;
  }

  // Decode invoice to check amount
  let invoiceAmountSats: number;
  let paymentHash: string | null;
  try {
    const decoded = bolt11.decode(pr) as {
      satoshis?: number;
      millisatoshis?: string;
      tagsObject: { payment_hash?: string };
    };
    if (decoded.satoshis != null) {
      invoiceAmountSats = decoded.satoshis;
    } else if (decoded.millisatoshis != null) {
      invoiceAmountSats = Math.ceil(Number(decoded.millisatoshis) / 1000);
    } else {
      res.json({ status: 'ERROR', reason: 'Invoice has no amount' });
      return;
    }
    paymentHash = decoded.tagsObject.payment_hash ?? null;
  } catch {
    res.json({ status: 'ERROR', reason: 'Invalid invoice' });
    return;
  }

  if (invoiceAmountSats > pending.max_sats) {
    res.json({ status: 'ERROR', reason: 'Invoice amount exceeds allowed maximum' });
    return;
  }

  // Get card + user
  const card = db
    .prepare('SELECT user_id FROM cards WHERE id = ?')
    .get(pending.card_id) as { user_id: number } | undefined;

  if (!card) {
    res.json({ status: 'ERROR', reason: 'Card not found' });
    return;
  }

  const user = db
    .prepare('SELECT id, balance_sats FROM users WHERE id = ?')
    .get(card.user_id) as User | undefined;

  if (!user || user.balance_sats < invoiceAmountSats) {
    res.json({ status: 'ERROR', reason: 'Insufficient balance' });
    return;
  }

  // Pay via Blink
  let status: string;
  try {
    status = await payInvoice(pr);
  } catch (err) {
    console.error('[lnurlw] payInvoice error:', err);
    res.json({ status: 'ERROR', reason: 'Payment failed' });
    return;
  }

  if (status === 'FAILURE') {
    res.json({ status: 'ERROR', reason: 'Lightning payment failed' });
    return;
  }

  // Deduct balance, record transaction, update daily spend, remove pending withdrawal
  const zarPerSat = await getZarPerSat();
  db.transaction(() => {
    db.prepare('UPDATE users SET balance_sats = balance_sats - ? WHERE id = ?').run(
      invoiceAmountSats,
      user.id
    );
    db.prepare(
      'INSERT INTO transactions (user_id, type, amount_sats, payment_hash, description, zar_per_sat) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(user.id, 'spend', invoiceAmountSats, paymentHash, 'BoltCard payment', zarPerSat);
    db.prepare(
      'UPDATE cards SET day_spent_sats = day_spent_sats + ? WHERE id = ?'
    ).run(invoiceAmountSats, pending.card_id);
    db.prepare('DELETE FROM pending_withdrawals WHERE k1_token = ?').run(k1);
  })();

  res.json({ status: 'OK' });
});

export default router;
