import type { Movement } from '../components/MovementsTable';

function csvField(value: string | number): string {
  const s = String(value);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function exportMovementsCsv(movements: Movement[]) {
  const header = ['Date', 'Direction', 'From', 'To', 'Amount (sats)', 'Note'];
  const rows = movements.map((m) => [
    new Date(m.created_at * 1000).toISOString(),
    m.direction === 'in' ? 'In' : 'Out',
    m.from,
    m.to,
    m.direction === 'in' ? m.amount_sats : -m.amount_sats,
    m.description ?? '',
  ]);

  const csv = [header, ...rows].map((row) => row.map(csvField).join(',')).join('\r\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  const today = new Date().toISOString().slice(0, 10);
  a.href = url;
  a.download = `movements-${today}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}
