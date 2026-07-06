const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

export function formatTs(unix: number) {
  const d = new Date(unix * 1000);
  const date = `${String(d.getDate()).padStart(2,'0')} ${MONTHS[d.getMonth()]} '${String(d.getFullYear()).slice(-2)}`;
  const time = `${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}:${String(d.getSeconds()).padStart(2,'0')}`;
  return `${date} ${time}`;
}
