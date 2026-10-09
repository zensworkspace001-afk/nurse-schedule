// CI 檢查：StaffPublic 投影只能有一份定義（api/_lib/staffProjection.js）。
// 過去前端、兩支 API、兩支腳本各複製一份，改欄位時漏改任何一份就會讓 StaffPublic 內容依寫入路徑而不同
// （甚至把 PII 帶進全員可讀的 doc）。這裡擋住兩種重新複製的寫法：
//   1. 在別處重新定義 buildStaffPublicProjection / toStaffPublic
//   2. 在別處手寫 { staff_id: s.staff_id, ... avatar_thumb: ... } 這種投影物件
// 用法：node scripts/check-projection-single-source.js（npm run lint 會一併執行）
import fs from 'node:fs';
import path from 'node:path';

const ROOTS = ['src', 'api', 'scripts'];
const CANONICAL = path.normalize('api/_lib/staffProjection.js');
const SELF = path.normalize('scripts/check-projection-single-source.js');
const DEFINE = /(function\s+(buildStaffPublicProjection|toStaffPublic)\b|(const|let|var)\s+(buildStaffPublicProjection|toStaffPublic)\s*=)/;
const INLINE = /staff_id:\s*\w+\.staff_id[\s\S]{0,300}?is_leader:[\s\S]{0,200}?is_active:[\s\S]{0,200}?avatar_thumb:/;

const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => {
  const p = path.join(d, e.name);
  if (e.isDirectory()) return e.name === 'node_modules' ? [] : walk(p);
  return /\.(js|jsx|mjs|cjs)$/.test(e.name) ? [p] : [];
});

const bad = [];
for (const file of ROOTS.filter(fs.existsSync).flatMap(walk)) {
  if (file === CANONICAL || file === SELF) continue;
  const src = fs.readFileSync(file, 'utf8');
  if (DEFINE.test(src)) bad.push(`${file}: 重新定義了投影函式`);
  else if (INLINE.test(src)) bad.push(`${file}: 手寫了 StaffPublic 投影物件`);
}

if (bad.length) {
  console.error('StaffPublic 投影必須 import api/_lib/staffProjection.js，不可另寫一份：');
  bad.forEach((b) => console.error(`  ✗ ${b}`));
  process.exit(1);
}
console.log('✓ StaffPublic 投影只有 api/_lib/staffProjection.js 一份定義');
