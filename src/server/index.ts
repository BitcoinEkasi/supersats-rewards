import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import path from 'path';
import { fileURLToPath } from 'url';
import bcrypt from 'bcryptjs';

import { db } from './db/index.js';
import { startBlinkSubscription, payInvoice } from './services/blink.js';
import { resolveLnAddress } from './services/lnurl.js';

import authRoutes from './routes/auth.js';
import adminRoutes from './routes/admin.js';
import cardRoutes from './routes/card.js';
import lnurlwRoutes from './routes/lnurlw.js';
import lnurlpRoutes from './routes/lnurlp.js';
import apiRoutes from './routes/api.js';
import userRoutes from './routes/user.js';
import balancesRoute from './routes/balances.js';
import balanceCheckRoute from './routes/balanceCheck.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT ?? 3001);
const isProd = process.env.NODE_ENV === 'production';

// ── Admin seed ────────────────────────────────────────────────────────────────

function seedAdmin() {
  const username = process.env.ADMIN_USERNAME;
  const password = process.env.ADMIN_PASSWORD;
  if (!username || !password) return;

  const hash = bcrypt.hashSync(password, 10);
  const existing = db.prepare('SELECT id FROM admins WHERE username = ?').get(username);
  if (existing) {
    db.prepare('UPDATE admins SET password_hash = ? WHERE username = ?').run(hash, username);
    console.log(`[init] Admin password synced from env: ${username}`);
  } else {
    db.prepare('INSERT INTO admins (username, password_hash) VALUES (?, ?)').run(username, hash);
    console.log(`[init] Admin account created: ${username}`);
  }
}

// ── Payment received handler ──────────────────────────────────────────────────

function onPaymentReceived(paymentHash: string, amountSats: number) {
  const now = Math.floor(Date.now() / 1000);
  const pending = db
    .prepare('SELECT * FROM pending_refills WHERE payment_hash = ? AND expires_at > ?')
    .get(paymentHash, now) as
    | { id: number; user_id: number; amount_sats: number }
    | undefined;

  if (pending) {
    db.transaction(() => {
      db.prepare('UPDATE users SET balance_sats = balance_sats + ? WHERE id = ?').run(
        amountSats,
        pending.user_id
      );
      db.prepare(
        'INSERT INTO transactions (user_id, type, amount_sats, payment_hash, description) VALUES (?, ?, ?, ?, ?)'
      ).run(pending.user_id, 'refill', amountSats, paymentHash, 'LN Address payment');
      db.prepare('DELETE FROM pending_refills WHERE payment_hash = ?').run(paymentHash);
    })();
    console.log(`[payment] Credited ${amountSats} sats to user #${pending.user_id}`);
    return;
  }

  // Check payout batches (month-end reward distribution)
  const batch = db
    .prepare("SELECT * FROM payout_batches WHERE payment_hash = ? AND status = 'pending'")
    .get(paymentHash) as any;

  if (batch) {
    const items = db
      .prepare('SELECT * FROM payout_batch_items WHERE batch_id = ?')
      .all(batch.id) as any[];

    // Credit internal (bolt card) items synchronously
    db.transaction(() => {
      for (const item of items) {
        if (item.payout_type === 'ln_address') continue; // handled async below
        db.prepare('UPDATE users SET balance_sats = balance_sats + ? WHERE id = ?')
          .run(item.amount_sats, item.user_id);
        db.prepare('INSERT INTO transactions (user_id, type, amount_sats, description) VALUES (?, ?, ?, ?)')
          .run(item.user_id, 'refill', item.amount_sats, item.description ?? 'Monthly reward payout');
        db.prepare('INSERT INTO card_events (user_id, event, description) VALUES (?, ?, ?)')
          .run(item.user_id, 'credited', `${item.amount_sats} sats — ${batch.memo ?? 'Monthly payout'}`);
      }
      db.prepare("UPDATE payout_batches SET status = 'paid', paid_at = unixepoch() WHERE id = ?")
        .run(batch.id);
    })();

    // Fire outbound LN payments for ln_address items (non-blocking)
    const lnItems = items.filter(i => i.payout_type === 'ln_address' && i.ln_address);
    for (const item of lnItems) {
      (async () => {
        let paymentHash: string | null = null;
        let status = 'failed';
        try {
          const pr = await resolveLnAddress(item.ln_address, item.amount_sats);
          const payStatus = await payInvoice(pr);
          if (payStatus === 'SUCCESS' || payStatus === 'ALREADY_PAID') {
            status = 'paid';
          }
          console.log(`[payment] LN address payout to ${item.ln_address}: ${payStatus}`);
        } catch (err: any) {
          console.error(`[payment] LN address payout to ${item.ln_address} failed:`, err.message);
        }
        db.prepare(
          'INSERT INTO ln_payouts (user_id, amount_sats, ln_address, payment_hash, status, description) VALUES (?, ?, ?, ?, ?, ?)'
        ).run(item.user_id, item.amount_sats, item.ln_address, paymentHash, status, item.description ?? 'Monthly reward payout');
      })();
    }

    const internalCount = items.length - lnItems.length;
    console.log(`[payment] Payout batch #${batch.id} paid — credited ${internalCount} internal, queued ${lnItems.length} LN address`);
  }
}

// ── Express app ───────────────────────────────────────────────────────────────

const app = express();

app.use(
  helmet({
    contentSecurityPolicy: false, // frontend sets its own
    crossOriginEmbedderPolicy: false,
  })
);
app.use(cors());
app.use(express.json());

// Protocol routes (no /api prefix — LNURL spec requires bare paths)
app.use('/lnurlw', lnurlwRoutes);
app.use('/.well-known/lnurlp', lnurlpRoutes);
app.use('/lnurlp', lnurlpRoutes);

// API routes
app.use('/api/auth', authRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/card', cardRoutes);
app.use('/api/v1', apiRoutes);
app.use('/api/user', userRoutes);
app.use('/api/balances', balancesRoute);
app.use('/api/balance-check', balanceCheckRoute);

// ── Static frontend (production) ──────────────────────────────────────────────

if (isProd) {
  const distPath = path.join(__dirname, '../public');
  app.use(express.static(distPath));
  // Return 404 for missing asset files (prevents stale-cache HTML-as-JS errors)
  app.get('/assets/:file', (_req, res) => { res.status(404).end(); });
  // SPA fallback — serve index.html for all non-API routes
  app.get(/^(?!\/api|\/lnurlw|\/lnurlp|\/.well-known).*/, (_req, res) => {
    res.sendFile(path.join(distPath, 'index.html'));
  });
}

// ── Cleanup janitor: delete expired pending records ───────────────────────────

setInterval(() => {
  const now = Math.floor(Date.now() / 1000);
  db.prepare('DELETE FROM pending_withdrawals WHERE expires_at < ?').run(now);
  db.prepare('DELETE FROM pending_refills WHERE expires_at < ?').run(now);
}, 5 * 60 * 1000);

// ── Start ─────────────────────────────────────────────────────────────────────

seedAdmin();

app.listen(PORT, () => {
  console.log(`[server] Listening on port ${PORT}`);
  startBlinkSubscription(onPaymentReceived);
});
