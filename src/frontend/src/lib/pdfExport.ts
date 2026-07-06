import { jsPDF } from 'jspdf';
import autoTable from 'jspdf-autotable';
import { formatTs } from './time';
import type { Movement } from '../components/MovementsTable';

export function exportMovementsPdf(movements: Movement[]) {
  const doc = new jsPDF({ orientation: 'landscape', unit: 'pt' });

  doc.setFontSize(14);
  doc.text('BoltCard — Movements', 40, 36);
  doc.setFontSize(9);
  doc.setTextColor(120);
  doc.text(`Generated ${new Date().toLocaleString()} · ${movements.length} movements`, 40, 52);

  autoTable(doc, {
    startY: 66,
    margin: { left: 40, right: 40 },
    styles: { fontSize: 8, cellPadding: 4 },
    headStyles: { fillColor: [30, 30, 30], textColor: 255 },
    columns: [
      { header: 'Date', dataKey: 'date' },
      { header: 'Direction', dataKey: 'direction' },
      { header: 'From', dataKey: 'from' },
      { header: 'To', dataKey: 'to' },
      { header: 'Amount', dataKey: 'amount' },
      { header: 'Note', dataKey: 'note' },
    ],
    body: movements.map((m) => ({
      date: formatTs(m.created_at),
      direction: m.direction === 'in' ? 'In' : 'Out',
      from: m.from,
      to: m.to,
      amount: `${m.direction === 'in' ? '+' : '−'}${m.amount_sats.toLocaleString()} sats`,
      note: m.description ?? '—',
    })),
    didParseCell: (data) => {
      if (data.section === 'body' && data.column.dataKey === 'direction') {
        data.cell.styles.textColor = data.cell.raw === 'In' ? [22, 163, 74] : [220, 38, 38];
      }
    },
  });

  const today = new Date().toISOString().slice(0, 10);
  doc.save(`movements-${today}.pdf`);
}
