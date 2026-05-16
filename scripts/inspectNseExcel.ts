// One-shot inspector for the NSE symbol Excel. Prints sheet names,
// columns, row count, and a small preview so we can wire the loader
// to the correct column.
import * as XLSX from 'xlsx';

const path = 'C:\\Users\\pranj\\Downloads\\nse_stocks_list.xlsx';
const wb = XLSX.readFile(path);

console.log('Sheets:', wb.SheetNames);

for (const name of wb.SheetNames) {
  const ws = wb.Sheets[name];
  const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(ws, { defval: null });
  console.log(`\n── Sheet "${name}" ──`);
  console.log('Row count:', rows.length);
  if (rows.length > 0) {
    console.log('Columns :', Object.keys(rows[0]));
    console.log('First 5 :');
    for (const r of rows.slice(0, 5)) console.log('  ', r);
    console.log('Last  3 :');
    for (const r of rows.slice(-3)) console.log('  ', r);
  }
}
