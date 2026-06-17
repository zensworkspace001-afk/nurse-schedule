// api/_lib/resetOtp.js
//
// 自助「忘記密碼」OTP 工具。與 activationToken.js（連結式重設）並存，但路徑不同：
//   - activationToken.js：admin 觸發 → 寄連結 → 使用者點連結直接設新密碼。
//   - resetOtp.js：員工自助 → 寄 6 位驗證碼 → 驗證碼換暫時密碼 → 強制改密。
//
// 安全設計：
//   1. Firestore 只存驗證碼的 sha256 雜湊；明文驗證碼只出現在 Email 與使用者輸入。
//   2. 每個 staff_id 同時只有一筆有效 OTP（doc id = staffId 小寫，後申請覆蓋前一筆）。
//   3. 預設 10 分鐘逾期（RESET_OTP_TTL_MIN 可調）。
//   4. 最多 5 次輸入錯誤即作廢，避免暴力猜 6 位碼。
//   5. 驗證碼只是「換暫時密碼」的鑰匙；暫時密碼換得後立即 consume（一次性）。
//
// Doc 結構：password_reset_otp/{staffIdLower}
//   { codeHash, uid, staffId, email, attempts, createdAt, expiresAt }
//
// firestore.rules 對 password_reset_otp 全面 deny（僅 Admin SDK 可存取）。
import crypto from 'node:crypto';
import admin from 'firebase-admin';

const OTP_TTL_MIN = Number(process.env.RESET_OTP_TTL_MIN) || 10;
const OTP_TTL_MS = OTP_TTL_MIN * 60 * 1000;
const MAX_ATTEMPTS = 5;
const COLLECTION = 'password_reset_otp';

function sha256Hex(input) {
  return crypto.createHash('sha256').update(String(input)).digest('hex');
}

function docId(staffId) {
  return String(staffId).trim().toLowerCase();
}

export const otpTtlMinutes = OTP_TTL_MIN;

// crypto 強度的 6 位數字驗證碼（含前導零）
export function generateOtpCode() {
  return String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
}

// 暫時密碼：保證同時含大小寫英文與數字、共 10 碼，必過 validatePasswordStrength。
// 排除易混淆字元（0/O/1/l/I）方便使用者手抄。
export function generateTempPassword() {
  const upper = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  const lower = 'abcdefghijkmnpqrstuvwxyz';
  const digits = '23456789';
  const all = upper + lower + digits;
  const pick = (set) => set[crypto.randomInt(set.length)];
  const chars = [pick(upper), pick(lower), pick(digits)];
  for (let i = 0; i < 7; i++) chars.push(pick(all));
  // Fisher-Yates 洗牌（crypto 隨機），讓保證字元的位置不固定
  for (let i = chars.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }
  return chars.join('');
}

// 為指定員工建立 OTP 並寫入 Firestore；回傳明文驗證碼（呼叫端寄信用）。
export async function issueResetOtp({ uid, staffId, email }) {
  if (!uid || !staffId) throw new Error('issueResetOtp 需要 uid 與 staffId');
  const code = generateOtpCode();
  const now = admin.firestore.Timestamp.now();
  const expiresAt = admin.firestore.Timestamp.fromMillis(Date.now() + OTP_TTL_MS);
  await admin.firestore().collection(COLLECTION).doc(docId(staffId)).set({
    codeHash: sha256Hex(code),
    uid,
    staffId: docId(staffId),
    email: email || null,
    attempts: 0,
    createdAt: now,
    expiresAt,
  });
  return code;
}

// 驗證 OTP：通過回傳 { uid, email }；否則 throw（附帶可給使用者看的原因）。
// 錯誤會累加 attempts，達上限即作廢。
export async function verifyResetOtp(staffId, code) {
  const ref = admin.firestore().collection(COLLECTION).doc(docId(staffId));
  const snap = await ref.get();
  if (!snap.exists) throw new Error('驗證碼無效或已過期，請重新申請');
  const data = snap.data();

  if (Date.now() > (data.expiresAt?.toMillis?.() ?? 0)) {
    await ref.delete().catch(() => {});
    throw new Error('驗證碼已過期，請重新申請');
  }
  if ((data.attempts || 0) >= MAX_ATTEMPTS) {
    await ref.delete().catch(() => {});
    throw new Error('驗證碼錯誤次數過多，請重新申請');
  }
  if (sha256Hex(code) !== data.codeHash) {
    await ref.update({ attempts: (data.attempts || 0) + 1 }).catch(() => {});
    const left = MAX_ATTEMPTS - ((data.attempts || 0) + 1);
    throw new Error(left > 0 ? `驗證碼錯誤，還可嘗試 ${left} 次` : '驗證碼錯誤次數過多，請重新申請');
  }
  return { uid: data.uid, email: data.email };
}

// 一次性消化：暫時密碼發出後刪除 OTP doc。
export async function consumeResetOtp(staffId) {
  await admin.firestore().collection(COLLECTION).doc(docId(staffId)).delete().catch(() => {});
}
