import { Router } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { db } from '../db/index.js';
import { generateKeys } from '../services/crypto.js';

const router = Router();

interface CardRow {
  id: number;
  user_id: number;
  k0: string;
  k1: string;
  k2: string;
  k3: string;
  k4: string;
  setup_token: string | null;
  wipe_token: string | null;
  programmed_at: number | null;
  enabled: number;
}

// ── GET /api/card/setup/:token ────────────────────────────────────────────────
//
// Programming endpoint consumed by the Boltcard Programmer app.
// Returns card keys. Token stays valid so retries work if NFC write fails.
// Token is only invalidated when Reprogram is called (generating new keys).

router.get('/setup/:token', (req, res) => {
  const { token } = req.params;
  const DOMAIN = process.env.DOMAIN!;

  const card = db
    .prepare('SELECT * FROM cards WHERE setup_token = ?')
    .get(token) as CardRow | undefined;

  if (!card) {
    res.status(404).json({ error: 'Setup token not found or already used' });
    return;
  }

  // Mark as programmed on first fetch (idempotent)
  if (!card.programmed_at) {
    db.prepare('UPDATE cards SET programmed_at = unixepoch() WHERE id = ?').run(card.id);
  }

  res.json({
    protocol_name: 'create_bolt_card_response',
    protocol_version: 2,
    card_name: 'BoltCard',
    lnurlw_base: `lnurlw://${DOMAIN}/lnurlw`,
    uid_privacy: 'Y',
    k0: card.k0,
    k1: card.k1,
    k2: card.k2,
    k3: card.k3,
    k4: card.k4,
  });
});

// ── GET /api/card/wipe/:token ─────────────────────────────────────────────────
//
// Wipe endpoint consumed by the Boltcard Programmer app.
// Returns current keys so the app can restore card to factory defaults.
// Immediately regenerates new keys + setup_token so card can be re-programmed.

router.get('/wipe/:token', (req, res) => {
  const { token } = req.params;
  const DOMAIN = process.env.DOMAIN!;

  const card = db
    .prepare('SELECT * FROM cards WHERE wipe_token = ?')
    .get(token) as CardRow | undefined;

  if (!card) {
    res.status(404).json({ error: 'Wipe token not found' });
    return;
  }

  // Capture current keys to return to programmer app
  const currentKeys = { k0: card.k0, k1: card.k1, k2: card.k2, k3: card.k3, k4: card.k4 };

  // Generate fresh keys + setup token so card can be re-programmed after wipe
  const newKeys = generateKeys();
  const newSetupToken = uuidv4().replace(/-/g, '');

  db.prepare(`
    UPDATE cards
    SET k0=?, k1=?, k2=?, k3=?, k4=?,
        setup_token=?, wipe_token=NULL,
        programmed_at=NULL, uid=NULL, counter=-1
    WHERE id=?
  `).run(newKeys.k0, newKeys.k1, newKeys.k2, newKeys.k3, newKeys.k4, newSetupToken, card.id);

  const proto = DOMAIN.startsWith('localhost') ? 'http' : 'https';

  res.json({
    protocol_name: 'create_bolt_card_response',
    protocol_version: 2,
    card_name: 'BoltCard',
    lnurlw_base: `lnurlw://${DOMAIN}/lnurlw`,
    uid_privacy: 'Y',
    // Return current (old) keys so programmer app can wipe them from the card
    k0: currentKeys.k0,
    k1: currentKeys.k1,
    k2: currentKeys.k2,
    k3: currentKeys.k3,
    k4: currentKeys.k4,
    // Include new setup URL so programmer app can offer immediate re-programming
    new_setup_url: `${proto}://${DOMAIN}/api/card/setup/${newSetupToken}`,
  });
});

export default router;
