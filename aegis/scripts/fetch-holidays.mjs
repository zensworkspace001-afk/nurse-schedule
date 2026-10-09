// 下載國定假日資料，放進地端前端的 /holidays/{year}.json（隔離網路連不到 CDN）。
// 在「可連網的機器」上部署前執行一次；階段五的打包會把 public/holidays 一起放進前端映像。
//
//   node aegis/scripts/fetch-holidays.mjs 2026 2027 [--out public/holidays]
//
// 資料來源：github.com/ruyut/TaiwanCalendar（整理自行政院人事行政總處「政府行政機關辦公日曆表」）。
// 該 repo 沒有宣告授權，所以不放進本 repo，由部署者自行下載；也可改用 data.gov.tw 的原始開放資料（政府資料開放授權條款）。
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const outIdx = args.indexOf('--out');
const out = outIdx >= 0 ? args[outIdx + 1] : 'public/holidays';
const years = args.filter((a, i) => /^\d{4}$/.test(a) && !(outIdx >= 0 && i === outIdx + 1));   // --out 後面那個是路徑，不是年份
if (years.length === 0) { console.error('用法：node aegis/scripts/fetch-holidays.mjs 2026 2027 [--out public/holidays]'); process.exit(1); }

fs.mkdirSync(out, { recursive: true });
for (const y of years) {
  const res = await fetch(`https://cdn.jsdelivr.net/gh/ruyut/TaiwanCalendar/data/${y}.json`);
  if (!res.ok) { console.error(`✗ ${y}：HTTP ${res.status}`); process.exitCode = 1; continue; }
  const data = await res.json();
  if (!Array.isArray(data) || !data[0]?.date) { console.error(`✗ ${y}：格式不符`); process.exitCode = 1; continue; }
  const file = path.join(out, `${y}.json`);
  fs.writeFileSync(file, JSON.stringify(data));
  console.log(`✓ ${y}：${data.length} 天、其中放假 ${data.filter((d) => d.isHoliday).length} 天 → ${file}`);
}
