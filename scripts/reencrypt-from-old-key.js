// scripts/reencrypt-from-old-key.js
//
// 用「舊的 FIELD_ENC_KEY」救回加密欄位：本機用舊金鑰解密 → 經正式環境 /api/secure-field 用目前金鑰重新加密 → 寫回 Firestore。
//
// 背景：Vercel 的 FIELD_ENC_KEY 在 2026-06-02 約 07:04–07:17 UTC 之間被換掉，之前加密的欄位
// （Settings.baseSalary、部分員工的 idNumber / bankAccount / phone）用目前金鑰解密會得到
// 「Unsupported state or unable to authenticate data」。只要找回舊金鑰，就能完整救回。
//
// 需要（放 .env.local 或環境變數，不要打在指令列上）：
//   OLD_FIELD_ENC_KEY   舊金鑰（base64，32 bytes）
//   ADMIN_PASSWORD      admin@hospital.com 的密碼（或 TEST_ADMIN_PW）
//   VITE_FIREBASE_API_KEY / VITE_FIREBASE_PROJECT_ID（.env.local 本來就有）
//
// 用法：
//   node scripts/reencrypt-from-old-key.js            # dry-run：只列出能救回的欄位，不寫入
//   node scripts/reencrypt-from-old-key.js --commit   # 實際寫入（先把原始密文備份到 ~/nurse-schedule-backups/，不放進 repo）
//
// 寫入期間請關掉管理端頁面：App 的自動存檔可能用舊的 staffData 蓋回去。
// 不會印出任何明文；目前金鑰本機不需要（重新加密走正式環境 API）。

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const COMMIT = process.argv.includes('--commit');
const SITE = process.env.SITE_URL || 'https://nurse-schedule-bachelor.vercel.app';
const PII_FIELDS = ['idNumber', 'bankAccount', 'phone'];

function loadEnvLocal() {
  const p = path.resolve('.env.local');
  if (!fs.existsSync(p)) return {};
  return Object.fromEntries(fs.readFileSync(p, 'utf8').split('\n')
    .filter(l => /^[A-Z0-9_]+=/.test(l))
    .map(l => { const i = l.indexOf('='); return [l.slice(0, i), l.slice(i + 1).trim().replace(/^["']|["']$/g, '')]; }));
}
const env = { ...loadEnvLocal(), ...process.env };
const need = (k, alt) => { const v = env[k] || (alt && env[alt]); if (!v) { console.error(`缺少 ${k}${alt ? ` 或 ${alt}` : ''}`); process.exit(1); } return v; };

const OLD_KEY = Buffer.from(need('OLD_FIELD_ENC_KEY'), 'base64');
if (OLD_KEY.length !== 32) { console.error(`OLD_FIELD_ENC_KEY 長度錯誤：base64 解碼後應為 32 bytes，目前 ${OLD_KEY.length}`); process.exit(1); }
const API_KEY = need('VITE_FIREBASE_API_KEY');
const PROJECT = need('VITE_FIREBASE_PROJECT_ID');
const ADMIN_PW = need('ADMIN_PASSWORD', 'TEST_ADMIN_PW');
const FS = `https://firestore.googleapis.com/v1/projects/${PROJECT}/databases/(default)/documents`;

// 與 api/_lib/crypto.js 相同的格式：AES-256-GCM、明文包成 {t, v} JSON
function decryptWithOldKey(blob) {
  try {
    const d = crypto.createDecipheriv('aes-256-gcm', OLD_KEY, Buffer.from(blob.iv, 'base64'));
    d.setAuthTag(Buffer.from(blob.tag, 'base64'));
    const s = Buffer.concat([d.update(Buffer.from(blob.ct, 'base64')), d.final()]).toString('utf8');
    const o = JSON.parse(s);
    return { ok: true, value: o.t === 'null' ? null : o.v };
  } catch { return { ok: false }; }
}

// Firestore REST 的型別值 ↔ 一般值（只用在密文 blob 這種扁平物件）
const blobFromTyped = (t) => {
  const f = t?.mapValue?.fields; if (!f?.ct) return null;
  return { ct: f.ct.stringValue, iv: f.iv.stringValue, tag: f.tag.stringValue, v: Number(f.v?.integerValue ?? f.v?.doubleValue) };
};
const typedFromBlob = (b) => ({ mapValue: { fields: {
  ct: { stringValue: b.ct }, iv: { stringValue: b.iv }, tag: { stringValue: b.tag }, v: { integerValue: String(b.v) },
} } });

let token;
async function signIn() {
  const r = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${API_KEY}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'admin@hospital.com', password: ADMIN_PW, returnSecureToken: true }),
  });
  const j = await r.json();
  if (!j.idToken) throw new Error(`admin 登入失敗：${j.error?.message || r.status}`);
  token = j.idToken;
}
const auth = () => ({ Authorization: `Bearer ${token}` });
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
async function encryptWithCurrentKey(value, target, field) {
  const r = await fetch(`${SITE}/api/secure-field`, {
    method: 'POST',
    headers: { ...auth(), 'Content-Type': 'application/json', Origin: SITE, Referer: `${SITE}/` },
    body: JSON.stringify({ action: 'encrypt', payload: value, target, fields: [field] }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.blob?.ct) throw new Error(`重新加密 ${target.kind}:${target.id}.${field} 失敗：${j.error || r.status}`);
  return j.blob;
}

async function main() {
  await signIn();
  const plan = [];          // { where, label, apply(newTyped) }
  const notOld = [];        // 舊金鑰也解不開的（多半是目前金鑰加密的，不用處理）
  const backup = { at: new Date().toISOString(), docs: {} };

  // 1) Settings.baseSalary
  const settings = await getDoc('NurseApp/Settings');
  const sb = blobFromTyped(settings?.fields?.baseSalary);
  if (sb) {
    const d = decryptWithOldKey(sb);
    if (d.ok) plan.push({ label: 'Settings.baseSalary', value: d.value, target: { kind: 'settings', id: null }, field: 'baseSalary', doc: 'settings' });
    else notOld.push('Settings.baseSalary');
  }

  // 2) NurseApp/Staff.staffData[*] 與 StaffPrivate/{id}（兩邊都存同一份密文）
  const staffDoc = await getDoc('NurseApp/Staff');
  const rows = staffDoc?.fields?.staffData?.arrayValue?.values || [];
  rows.forEach((row, idx) => {
    const f = row.mapValue?.fields || {};
    const sid = f.staff_id?.stringValue;
    for (const field of PII_FIELDS) {
      const b = blobFromTyped(f[field]);
      if (!b) continue;
      const d = decryptWithOldKey(b);
      if (d.ok) plan.push({ label: `${sid}.${field}`, value: d.value, target: { kind: 'staff', id: sid }, field, doc: 'staff', idx, sid });
      else notOld.push(`${sid}.${field}`);
    }
  });

  console.log(`舊金鑰可解開（需要重新加密）：${plan.length} 個欄位`);
  plan.forEach(p => console.log(`  ✓ ${p.label}`));
  console.log(`舊金鑰解不開（應是目前金鑰加密的，不處理）：${notOld.length} 個欄位`);
  if (!plan.length) return;
  if (!COMMIT) { console.log('\n（dry-run，沒有寫入。確認無誤後加 --commit）'); return; }

  // 備份原始密文文件（不含明文）
  backup.docs['NurseApp/Settings'] = settings?.fields?.baseSalary ?? null;
  backup.docs['NurseApp/Staff'] = staffDoc?.fields?.staffData ?? null;
  const privates = {};
  for (const sid of new Set(plan.filter(p => p.sid).map(p => p.sid))) {
    privates[sid] = await getDoc(`StaffPrivate/${sid}`);
    backup.docs[`StaffPrivate/${sid}`] = privates[sid]?.fields ?? null;
  }
  const backupDir = path.join(os.homedir(), 'nurse-schedule-backups');
  fs.mkdirSync(backupDir, { recursive: true });
  const backupPath = path.join(backupDir, `reencrypt-backup-${Date.now()}.json`);
  fs.writeFileSync(backupPath, JSON.stringify(backup, null, 2));
  console.log(`\n原始密文已備份：${backupPath}`);

  // 重新加密
  for (const p of plan) p.newTyped = typedFromBlob(await encryptWithCurrentKey(p.value, p.target, p.field));

  // 寫回：Settings
  const sp = plan.find(p => p.doc === 'settings');
  if (sp) await patchDoc('NurseApp/Settings', { baseSalary: sp.newTyped }, ['baseSalary']);
  // 寫回：NurseApp/Staff（整個 staffData 陣列，只換掉密文物件，其他欄位原樣保留型別）
  const staffPlan = plan.filter(p => p.doc === 'staff');
  if (staffPlan.length) {
    for (const p of staffPlan) rows[p.idx].mapValue.fields[p.field] = p.newTyped;
    await patchDoc('NurseApp/Staff', { staffData: { arrayValue: { values: rows } } }, ['staffData']);
    // 寫回：StaffPrivate/{id}
    for (const [sid, d] of Object.entries(privates)) {
      if (!d) continue;
      const mine = staffPlan.filter(p => p.sid === sid);
      const fields = Object.fromEntries(mine.map(p => [p.field, p.newTyped]));
      await patchDoc(`StaffPrivate/${sid}`, fields, mine.map(p => p.field));
    }
  }
  console.log(`已重新加密並寫回 ${plan.length} 個欄位。`);
}

main().catch(e => { console.error('失敗：', e.message); process.exit(1); });
