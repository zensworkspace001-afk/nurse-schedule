// CI 檢查：前端會連的排班引擎網址必須出現在 vercel.json 的 CSP connect-src。
// 少了它，本機一切正常（dev server 不套 CSP），上線後瀏覽器卻靜默擋掉 fetch。
// 檢查對象：src/api/scheduleEngine.js 的 DEFAULT_ENGINE_URL，以及 CI / 本機環境若設了
// VITE_SCHEDULE_ENGINE_URL（非 localhost）也一併檢查。
// 用法：node scripts/check-csp-engine-url.js（npm run lint 會一併執行）
import fs from 'node:fs';

const vercel = JSON.parse(fs.readFileSync('vercel.json', 'utf8'));
const csp = (vercel.headers || [])
  .flatMap((h) => h.headers || [])
  .find((h) => h.key.toLowerCase() === 'content-security-policy')?.value || '';
const connectSrc = (csp.match(/connect-src([^;]*)/)?.[1] || '').trim().split(/\s+/);

const engineSrc = fs.readFileSync('src/api/scheduleEngine.js', 'utf8');
const urls = [engineSrc.match(/DEFAULT_ENGINE_URL\s*=\s*'([^']+)'/)?.[1]];
const envUrl = process.env.VITE_SCHEDULE_ENGINE_URL;
if (envUrl && !/localhost|127\.0\.0\.1/.test(envUrl)) urls.push(envUrl);

const origin = (u) => new URL(u).origin;
const allowed = (u) => connectSrc.some((src) => {
  if (src === origin(u)) return true;
  const m = src.match(/^https:\/\/\*\.(.+)$/);   // 萬用字元子網域
  return !!m && new URL(u).hostname.endsWith(`.${m[1]}`);
});

if (!urls[0]) {
  console.error('找不到 src/api/scheduleEngine.js 的 DEFAULT_ENGINE_URL');
  process.exit(1);
}
const missing = urls.filter((u) => !allowed(u));
if (missing.length) {
  console.error('排班引擎網址不在 vercel.json CSP connect-src，正式環境會被瀏覽器擋下：');
  missing.forEach((u) => console.error(`  ✗ ${origin(u)}`));
  process.exit(1);
}
console.log(`✓ 排班引擎網址已在 CSP connect-src（${urls.map(origin).join(', ')}）`);
