// api/_lib/passwordHistory.js
//
// 密碼重用防護：禁止把密碼改回「先前使用過」的舊密碼。
//
// 為什麼需要自己存：Firebase Auth 把密碼雜湊後保管，後端無法讀回目前或歷史密碼，
// 所以要自行維護一份歷史。存的是「加鹽 scrypt 雜湊」而非明文，也不是 sha256——
// 密碼熵低，sha256 容易被暴力/彩虹表反推；scrypt 是慢雜湊，明顯提高破解成本。
//
// Doc 結構：password_history/{staffIdLower}
//   { staffId, entries: [{ salt, hash, at }], updatedAt }
//   entries 只保留最近 KEEP 筆（預設 5，PASSWORD_HISTORY_SIZE 可調）。
//
// firestore.rules 對 password_history 全面 deny（僅 Admin SDK 可存取，連本人都讀不到）。
import crypto from 'node:crypto';
import admin from 'firebase-admin';

const COLLECTION = 'password_history';
const KEEP = Number(process.env.PASSWORD_HISTORY_SIZE) || 5;
const KEYLEN = 32;

function docId(staffId) {
  return String(staffId).trim().toLowerCase();
}

function scryptHash(plain, salt) {
  return crypto.scryptSync(String(plain), salt, KEYLEN).toString('hex');
}

function makeEntry(plain) {
  const salt = crypto.randomBytes(16).toString('hex');
  return { salt, hash: scryptHash(plain, salt), at: new Date().toISOString() };
}

function entryMatches(plain, entry) {
  if (!entry?.salt || !entry?.hash) return false;
  const candidate = Buffer.from(scryptHash(plain, entry.salt), 'hex');
  const stored = Buffer.from(entry.hash, 'hex');
  return candidate.length === stored.length && crypto.timingSafeEqual(candidate, stored);
}

// 若新密碼與歷史任一筆相同 → throw（err.code = 'password-reused'）。無歷史則直接通過。
export async function assertPasswordNotReused(staffId, plain) {
  const snap = await admin.firestore().collection(COLLECTION).doc(docId(staffId)).get();
  if (!snap.exists) return;
  const entries = Array.isArray(snap.data().entries) ? snap.data().entries : [];
  for (const e of entries) {
    if (entryMatches(plain, e)) {
      const err = new Error('新密碼不可與先前使用過的密碼相同，請改用其他密碼');
      err.code = 'password-reused';
      throw err;
    }
  }
}

// 把新密碼記入歷史（只留最近 KEEP 筆）。在密碼確實設定成功後才呼叫。
export async function recordPassword(staffId, plain) {
  const ref = admin.firestore().collection(COLLECTION).doc(docId(staffId));
  const snap = await ref.get();
  const entries = snap.exists && Array.isArray(snap.data().entries) ? snap.data().entries : [];
  entries.push(makeEntry(plain));
  await ref.set({
    staffId: docId(staffId),
    entries: entries.slice(-KEEP),
    updatedAt: admin.firestore.Timestamp.now(),
  });
}

// 離職時清除歷史（best-effort，PDPA：人走了就別留雜湊）。
export async function clearPasswordHistory(staffId) {
  await admin.firestore().collection(COLLECTION).doc(docId(staffId)).delete().catch(() => {});
}
