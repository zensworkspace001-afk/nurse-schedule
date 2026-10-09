// 神盾計畫階段二 — Node ↔ C# 欄位加密 / 密碼雜湊對照向量
// 直接 import 正式的 api/_lib/crypto.js 與 passwordHistory.js 的演算法（不另寫一份），確保比的是線上行為。
//
//   node aegis/baseline/crypto_vectors.mjs generate <out.json>   產生向量（Node 加密 → C# 必須解得開）
//   node aegis/baseline/crypto_vectors.mjs decrypt  <in.json>    解 C# 產生的密文（C# 加密 → Node 必須解得開），輸出 JSON 結果
//
// 只用測試金鑰（固定位元組），不碰正式 FIELD_ENC_KEY。
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const CRYPTO_JS = pathToFileURL(path.join(ROOT, 'api', '_lib', 'crypto.js')).href;

export const KEY_A = Buffer.from(Array.from({ length: 32 }, (_, i) => i)).toString('base64');        // 目前金鑰
export const KEY_B = Buffer.from(Array.from({ length: 32 }, (_, i) => 255 - i)).toString('base64');  // 舊金鑰

// crypto.js 會快取金鑰環 → 每種金鑰設定用不同 query 重新載入模組
let n = 0;
async function withKeys(current, previous = '') {
  process.env.FIELD_ENC_KEY = current;
  process.env.FIELD_ENC_KEYS_PREVIOUS = previous;
  return import(`${CRYPTO_JS}?k=${n++}`);
}

// = passwordHistory.js scryptHash（N=16384, r=8, p=1 預設值；salt 是 hex 字串本身的 UTF-8 位元組）
const scryptHash = (plain, salt) => crypto.scryptSync(String(plain), salt, 32).toString('hex');

// 用原始金鑰解出 { t, v } 信封的原始字串（C# 要逐位元組產生相同的信封）
function envelopeOf(blob, keyB64) {
  const d = crypto.createDecipheriv('aes-256-gcm', Buffer.from(keyB64, 'base64'), Buffer.from(blob.iv, 'base64'));
  d.setAuthTag(Buffer.from(blob.tag, 'base64'));
  return Buffer.concat([d.update(Buffer.from(blob.ct, 'base64')), d.final()]).toString('utf8');
}

const VALUES = [null, 0, 42, -7, 3.14159, 40000, 1e21, 0.1, true, false, '', 'A123456789', '008-1234567890',
  '0912345678', '中文🙂 "quoted" \\ back\nline', { a: 1, b: [1, 'x', null], c: { d: true } }, [1, 2, 3]];

async function generate(out) {
  const a = await withKeys(KEY_A);
  const plain = VALUES.map((v) => {
    const blob = a.encryptField(v);
    return { value: v, blob, envelope: envelopeOf(blob, KEY_A) };
  });
  // 舊金鑰時代的密文（沒有 kid）與 kid 指向舊金鑰的密文 → 目前金鑰 A + 舊金鑰 B 都要解得開
  const b = await withKeys(KEY_B);
  const legacy = b.encryptField('legacy-no-kid'); delete legacy.kid;
  const oldKid = b.encryptField('old-kid');
  const tampered = { ...plain[11].blob, tag: Buffer.from(Buffer.from(plain[11].blob.tag, 'base64').map((x, i) => (i === 0 ? x ^ 1 : x))).toString('base64') };
  const unknownKid = { ...plain[11].blob, kid: 'deadbeef' };
  const ring = await withKeys(KEY_A, KEY_B);
  const errorOf = (blob) => { try { ring.decryptField(blob); return null; } catch (e) { return e.message; } };
  const vectors = {
    keys: { current: KEY_A, previous: KEY_B, currentKid: ring.currentKeyId(), previousKid: (await withKeys(KEY_B)).currentKeyId() },
    plain,
    rotation: [
      { name: 'legacy-no-kid（舊金鑰、沒有 kid）', blob: legacy, value: 'legacy-no-kid' },
      { name: 'old-kid（kid 指向舊金鑰）', blob: oldKid, value: 'old-kid' },
    ],
    errors: [
      { name: 'tampered（tag 被改）', blob: tampered, error: errorOf(tampered) },
      { name: 'unknown-kid（環境沒有這把金鑰）', blob: unknownKid, error: errorOf(unknownKid) },
    ],
    // 數字格式最容易漂移：JSON.stringify 的輸出就是標準答案
    numbers: [1e16, 1e15, 123456789012345680000, 1e21, 1.5e21, 1e-6, 1e-7, 1.23e-7, 0.000001, 5e-324, 1.7976931348623157e308,
      0.1 + 0.2, 100, 1234.5678, -0.5, 2 ** 53, 2 ** 53 + 2, 9007199254740993, 4.35, 0.3, 1 / 3, 25e-5, 33333.333333333336, -0]
      .map((x) => ({ x, json: JSON.stringify({ t: 'num', v: x }) })),
    scrypt: [['n00112345666', 'a3f1c2d4e5f60718293a4b5c6d7e8f90'], ['', '00'], ['密碼🙂', 'ffffffffffffffffffffffffffffffff'], ['abc12345', '0123456789abcdef0123456789abcdef']]
      .map(([plainText, salt]) => ({ plain: plainText, salt, hash: scryptHash(plainText, salt) })),
  };
  fs.writeFileSync(out, JSON.stringify(vectors, null, 1));
  console.log(`寫入 ${out}：${plain.length} 筆明文、${vectors.rotation.length} 筆輪替、${vectors.errors.length} 筆錯誤、${vectors.scrypt.length} 筆 scrypt`);
}

// C# 加密的密文 → 用 Node 正式程式解 → 回報值與信封
async function decrypt(inp) {
  const items = JSON.parse(fs.readFileSync(inp, 'utf8'));
  const ring = await withKeys(KEY_A, KEY_B);
  const res = items.map((it) => {
    try { return { ok: true, value: ring.decryptField(it.blob), envelope: envelopeOf(it.blob, KEY_A) }; }
    catch (e) { return { ok: false, error: e.message }; }
  });
  process.stdout.write(JSON.stringify(res));
}

const [mode, file] = process.argv.slice(2);
if (mode === 'generate') await generate(file);
else if (mode === 'decrypt') await decrypt(file);
else { console.error('用法：generate <out.json> | decrypt <in.json>'); process.exit(1); }
