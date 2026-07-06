import { formatTs } from '../lib/time';
import { formatZAR } from '../hooks/usePriceFeed';

export interface Movement {
  id: string;
  created_at: number;
  type: 'spend' | 'refill' | 'card_fee' | 'ln_payout';
  direction: 'in' | 'out';
  amount_sats: number;
  from: string;
  to: string;
  description: string | null;
}

export default function MovementsTable({ movements, zarPerSat }: { movements: Movement[]; zarPerSat: number | null }) {
  return (
    <table>
      <thead>
        <tr>
          <th>Date</th>
          <th>Direction</th>
          <th>From</th>
          <th>To</th>
          <th>Amount</th>
          <th>Note</th>
        </tr>
      </thead>
      <tbody>
        {movements.map((m) => (
          <tr key={m.id}>
            <td className="muted" style={{ whiteSpace: 'nowrap' }}>{formatTs(m.created_at)}</td>
            <td>
              {m.direction === 'in' ? (
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, color: '#4ade80' }}>
                  <svg xmlns="http://www.w3.org/2000/svg" style={{ width: 13, height: 13 }} viewBox="0 0 20 20" fill="currentColor">
                    <path fillRule="evenodd" d="M10 3a1 1 0 01.707.293l6 6a1 1 0 01-1.414 1.414L11 6.414V16a1 1 0 11-2 0V6.414L4.707 10.707a1 1 0 01-1.414-1.414l6-6A1 1 0 0110 3z" clipRule="evenodd" transform="rotate(180 10 10)" />
                  </svg>
                  In
                </span>
              ) : (
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, color: '#f87171' }}>
                  <svg xmlns="http://www.w3.org/2000/svg" style={{ width: 13, height: 13 }} viewBox="0 0 20 20" fill="currentColor">
                    <path fillRule="evenodd" d="M10 3a1 1 0 01.707.293l6 6a1 1 0 01-1.414 1.414L11 6.414V16a1 1 0 11-2 0V6.414L4.707 10.707a1 1 0 01-1.414-1.414l6-6A1 1 0 0110 3z" clipRule="evenodd" />
                  </svg>
                  Out
                </span>
              )}
            </td>
            <td style={{ fontSize: 12 }}><code style={{ color: '#ccc' }}>{m.from}</code></td>
            <td style={{ fontSize: 12 }}><code style={{ color: '#ccc' }}>{m.to}</code></td>
            <td style={{ color: m.direction === 'in' ? '#4ade80' : '#f0f0f0', fontWeight: 500, whiteSpace: 'nowrap' }}>
              {m.direction === 'in' ? '+' : '−'}{m.amount_sats.toLocaleString()} sats
              {zarPerSat && <span className="muted" style={{ marginLeft: 6, fontWeight: 400 }}>({formatZAR(m.amount_sats, zarPerSat)})</span>}
            </td>
            <td className="muted" style={{ maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{m.description ?? '—'}</td>
          </tr>
        ))}
        {movements.length === 0 && (
          <tr><td colSpan={6} className="muted" style={{ textAlign: 'center', padding: 32 }}>No movements</td></tr>
        )}
      </tbody>
    </table>
  );
}
