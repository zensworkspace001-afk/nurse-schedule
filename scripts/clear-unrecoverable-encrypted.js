// scripts/clear-unrecoverable-encrypted.js
//
// 清掉「目前金鑰解不開」的加密欄位（舊金鑰已遺失時用）。
//
// 背景：Vercel 的 FIELD_ENC_KEY 在 2026-06-02 約 07:04–07:17 UTC 之間被換掉，之前加密的欄位
// 解密會得到「Unsupported state or unable to authenticate data」。舊金鑰找不回來時，這些密文
// 永遠解不開，留著只會讓每次解密都報錯、員工也無法覆寫 → 清成 null，請當事人 / 管理員重新輸入。
// 若之後找回舊金鑰，請改用 scripts/reencrypt-from-old-key.js（本腳本的備份檔留有原始密文）。
//
// 判斷方式：逐一呼叫正式環境 /api/secure-field decrypt（目前金鑰）；只有回 AES-GCM 驗證失敗的才清，
// 解得開的欄位不動。不印出任何明文。
//
// 需要（.env.local 或環境變數）：ADMIN_PASSWORD（或 TEST_ADMIN_PW）、VITE_FIREBASE_API_KEY、VITE_FIREBASE_PROJECT_ID
//
// 用法：
//   node scripts/clear-unrecoverable-encrypted.js            # dry-run：列出會被清掉的欄位
//   node scripts/clear-unrecoverable-encrypted.js --commit   # 先備份原始密文到 ~/nurse-schedule-backups/，再清成 null
//
// 寫入期間請關掉管理端頁面（避免自動存檔用舊的 staffData 蓋回去）。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const COMMIT = process.argv.includes('--commit');
const SITE = process.env.SITE_URL || 'https://nurse-schedule-bachelor.vercel.app';
const PII_FIELDS = ['idNumber', 'bankAccount', 'phone'];
const GCM_FAIL = /unable to authenticate data|Unsupported state/i;

function loadEnvLocal() {
  const p = path.resolve('.env.local');
  if (!fs.existsSync(p)) return {};
  return Object.fromEntries(fs.readFileSync(p, 'utf8').split('\n')
    .filter(l => /^[A-Z0-9_]+=/.test(l))
    .map(l => { const i = l.indexOf('='); return [l.slice(0, i), l.slice(i + 1).trim().replace(/^["']|["']$/g, '')]; }));
}
const env = { ...loadEnvLocal(), ...process.env };
const need = (k, alt) => { const v = env[k] || (alt && env[alt]); if (!v) { console.error(`缺少 ${k}${alt ? ` 或 ${alt}` : ''}`); process.exit(1); } return v; };
const API_KEY = need('VITE_FIREBASE_API_KEY');
const PROJECT = need('VITE_FIREBASE_PROJECT_ID');
const ADMIN_PW = need('ADMIN_PASSWORD', 'TEST_ADMIN_PW');
const FS = `https://firestore.googleapis.com/v1/projects/${PROJECT}/databases/(default)/documents`;

const blobFromTyped = (t) => {
  const f = t?.mapValue?.fields; if (!f?.ct) return null;
  return { ct: f.ct.stringValue, iv: f.iv.stringValue, tag: f.tag.stringValue, v: Number(f.v?.integerValue ?? f.v?.doubleValue) };
};
const NULL = { nullValue: null };

let token;
const auth = () => ({ Authorization: `Bearer ${token}` });
async function signIn() {
  const r = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${API_KEY}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'admin@hospital.com', password: ADMIN_PW, returnSecureToken: true }),
  });
  const j = await r.json();
  if (!j.idToken) throw new Error(`admin 登入失敗：${j.error?.message || r.status}`);
  token = j.idToken;
}
async function getDoc(p) {
  const r = await fetch(`${FS}/${p}`, { headers: auth() });
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`讀取 ${p} 失敗：${r.status}`);
  return r.json();
}
async function patchDoc(p, fields, mask) {
  const qs = mask.map(m => `updateMask.fieldPaths=${encodeURIComponent(m)}`).join('&');
  const r = await fetch(`${FS}/${p}?${qs}`, {
    method: 'PATCH', headers: { ...auth(), 'Content-Type': 'application/json' }, body: JSON.stringify({ fields }),
  });
  if (!r.ok) throw new Error(`寫入 ${p} 失敗：${r.status} ${(await r.text()).slice(0, 200)}`);
}
// true = 目前金鑰解不開（要清）；false = 解得開（不動）；其他錯誤直接拋出，不猜
async function isUnrecoverable(blob, target, field) {
  const r = await fetch(`${SITE}/api/secure-field`, {
    method: 'POST',
    headers: { ...auth(), 'Content-Type': 'application/json', Origin: SITE, Referer: `${SITE}/` },
    body: JSON.stringify({ action: 'decrypt', payload: blob, target, fields: [field] }),
  });
  if (r.ok) return false;
  const j = await r.json().catch(() => ({}));
  if (GCM_FAIL.test(j.error || '')) return true;
  throw new Error(`檢查 ${target.kind}:${target.id}.${field} 失敗：${j.error || r.status}`);
}

async function main() {
  await signIn();
  const plan = [];

  const settings = await getDoc('NurseApp/Settings');
  const sb = blobFromTyped(settings?.fields?.baseSalary);
  if (sb && await isUnrecoverable(sb, { kind: 'settings', id: null }, 'baseSalary')) plan.push({ label: 'Settings.baseSalary', doc: 'settings' });

  const staffDoc = await getDoc('NurseApp/Staff');
  const rows = staffDoc?.fields?.staffData?.arrayValue?.values || [];
  for (let idx = 0; idx < rows.length; idx++) {
    const f = rows[idx].mapValue?.fields || {};
    const sid = f.staff_id?.stringValue;
    for (const field of PII_FIELDS) {
      const b = blobFromTyped(f[field]);
      if (b && await isUnrecoverable(b, { kind: 'staff', id: sid }, field)) plan.push({ label: `${sid}.${field}`, doc: 'staff', idx, sid, field });
    }
  }

  console.log(`目前金鑰解不開、會被清成 null：${plan.length} 個欄位`);
  plan.forEach(p => console.log(`  ✗ ${p.label}`));
  if (!plan.length) return;
  if (!COMMIT) { console.log('\n（dry-run，沒有寫入。確認後加 --commit）'); return; }

  // 備份原始密文（不含明文）
  const privates = {};
  for (const sid of new Set(plan.filter(p => p.sid).map(p => p.sid))) privates[sid] = await getDoc(`StaffPrivate/${sid}`);
  const dir = path.join(os.homedir(), 'nurse-schedule-backups');
  fs.mkdirSync(dir, { recursive: true });
  const backupPath = path.join(dir, `unrecoverable-encrypted-${Date.now()}.json`);
  fs.writeFileSync(backupPath, JSON.stringify({
    at: new Date().toISOString(), cleared: plan.map(p => p.label),
    'NurseApp/Settings.baseSalary': settings?.fields?.baseSalary ?? null,
    'NurseApp/Staff.staffData': staffDoc?.fields?.staffData ?? null,
    StaffPrivate: Object.fromEntries(Object.entries(privates).map(([k, v]) => [k, v?.fields ?? null])),
  }, null, 2));
  console.log(`\n原始密文已備份：${backupPath}`);

  if (plan.some(p => p.doc === 'settings')) await patchDoc('NurseApp/Settings', { baseSalary: NULL }, ['baseSalary']);
  const staffPlan = plan.filter(p => p.doc === 'staff');
  if (staffPlan.length) {
    for (const p of staffPlan) rows[p.idx].mapValue.fields[p.field] = NULL;   // 其他欄位原樣保留型別
    await patchDoc('NurseApp/Staff', { staffData: { arrayValue: { values: rows } } }, ['staffData']);
    for (const [sid, d] of Object.entries(privates)) {
      if (!d) continue;
      const mine = staffPlan.filter(p => p.sid === sid).map(p => p.field);
      await patchDoc(`StaffPrivate/${sid}`, Object.fromEntries(mine.map(f => [f, NULL])), mine);
    }
  }
  console.log(`已清除 ${plan.length} 個欄位。受影響的員工請重新填寫；底薪請到「結算與歷史」重新設定並儲存。`);
}

main().catch(e => { console.error('失敗：', e.message); process.exit(1); });
