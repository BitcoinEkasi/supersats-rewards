import { db } from '../db/index.js';
import { getZarPerSat } from './zarPrice.js';

export class DebitError extends Error {}

// Takes sats off a participant's balance and returns them to the reserve (they
// stay in the Blink wallet; no Lightning payment is made). Used for repayments
// and corrections. Never lets a balance go negative.
export async function debitUser(userId: number, amountSats: number, reason: string): Promise<number> {
  if (!Number.isInteger(amountSats) || amountSats <= 0) {
    throw new DebitError('amount_sats must be a positive integer');
  }
  const why = reason?.trim();
  if (!why) throw new DebitError('A reason is required for a debit');

  const zarPerSat = await getZarPerSat();

  return db.transaction(() => {
    const user = db.prepare('SELECT balance_sats FROM users WHERE id = ?').get(userId) as { balance_sats: number } | undefined;
    if (!user) throw new DebitError('User not found');
    if (amountSats > user.balance_sats) {
      throw new DebitError(`Exceeds balance — only ${user.balance_sats.toLocaleString()} sats available`);
    }

    db.prepare('UPDATE users SET balance_sats = balance_sats - ? WHERE id = ?').run(amountSats, userId);
    db.prepare('INSERT INTO transactions (user_id, type, amount_sats, description, zar_per_sat) VALUES (?, ?, ?, ?, ?)').run(
      userId, 'debit', amountSats, why, zarPerSat
    );
    db.prepare('INSERT INTO card_events (user_id, event, description) VALUES (?, ?, ?)').run(
      userId, 'debited', `${amountSats} sats — ${why}`
    );
    return user.balance_sats - amountSats;
  })();
}
