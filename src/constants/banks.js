// 台灣銀行三碼代碼清單，與 parse / format / lookup 工具函式。
// ProfileWizard 與 EncryptedField (kind="bank-account") 共用。

export const TAIWAN_BANKS = [
  { code: '700', name: '中華郵政' },
  { code: '004', name: '臺灣銀行' },
  { code: '005', name: '土地銀行' },
  { code: '006', name: '合作金庫' },
  { code: '007', name: '第一銀行' },
  { code: '008', name: '華南銀行' },
  { code: '009', name: '彰化銀行' },
  { code: '011', name: '上海商銀' },
  { code: '012', name: '台北富邦' },
  { code: '013', name: '國泰世華' },
  { code: '016', name: '高雄銀行' },
  { code: '017', name: '兆豐國際' },
  { code: '050', name: '臺灣中小企銀' },
  { code: '052', name: '渣打國際' },
  { code: '053', name: '台中商銀' },
  { code: '081', name: '滙豐(台灣)' },
  { code: '102', name: '華泰商銀' },
  { code: '103', name: '臺灣新光商銀' },
  { code: '108', name: '陽信商銀' },
  { code: '147', name: '三信商銀' },
  { code: '803', name: '聯邦銀行' },
  { code: '805', name: '遠東銀行' },
  { code: '806', name: '元大銀行' },
  { code: '807', name: '永豐銀行' },
  { code: '808', name: '玉山銀行' },
  { code: '809', name: '凱基銀行' },
  { code: '810', name: '星展(台灣)' },
  { code: '812', name: '台新銀行' },
  { code: '816', name: '安泰銀行' },
  { code: '822', name: '中國信託' },
];

// "008-1234567890" → { code: '008', account: '1234567890' }
// 也容忍純數字輸入（舊資料）：只回 { code: '', account: 原字串 }
export function parseBankAccount(raw) {
  if (typeof raw !== 'string') return { code: '', account: '' };
  const m = raw.match(/^(\d{3})-(\d+)$/);
  if (m) return { code: m[1], account: m[2] };
  // 沒符合「###-#######」格式，當成舊資料整段塞進 account
  return { code: '', account: raw.replace(/[^\d]/g, '') };
}

// { code, account } → "008-1234567890"
export function formatBankAccount(code, account) {
  if (!code || !account) return '';
  return `${code}-${account}`;
}

// '008' → '華南銀行'  /  unknown code → null
export function lookupBankName(code) {
  if (!code) return null;
  const hit = TAIWAN_BANKS.find(b => b.code === code);
  return hit ? hit.name : null;
}

// "008-1234567890" → "008 華南銀行 / 1234567890"  (顯示用)
// 找不到代碼就退回原字串
export function displayBankAccount(raw) {
  const { code, account } = parseBankAccount(raw);
  if (!code) return raw || '';
  const name = lookupBankName(code);
  return name ? `${code} ${name} / ${account}` : `${code} / ${account}`;
}

// "008-1234567890" → "008 華*** ***90"  (遮罩用 — 只露銀行 + 末 2 碼)
export function maskBankAccount(raw) {
  const { code, account } = parseBankAccount(raw);
  if (!code && !account) return '';
  const name = lookupBankName(code);
  const acctMasked = account.length <= 4
    ? '*'.repeat(account.length)
    : '*'.repeat(account.length - 2) + account.slice(-2);
  return name ? `${code} ${name} / ${acctMasked}` : `${code || ''} / ${acctMasked}`;
}
