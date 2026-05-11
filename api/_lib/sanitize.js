// HTML 清理：移除 <script>、事件屬性 (onerror, onclick 等)、javascript: URL
// 保留安全的排版標籤 (p, br, b, strong, h3, a[href] 等)

const ALLOWED_TAGS = new Set([
  'p', 'br', 'b', 'i', 'em', 'strong', 'u', 'h1', 'h2', 'h3', 'h4',
  'ul', 'ol', 'li', 'a', 'span', 'div', 'table', 'tr', 'td', 'th', 'thead', 'tbody',
]);

/**
 * 清理 HTML 字串，移除危險內容
 * @param {string} html
 * @returns {string}
 */
export function sanitizeHtml(html) {
  if (!html || typeof html !== 'string') return '';

  return html
    // 移除 <script>...</script> (含多行)
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    // 移除 <style>...</style>
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    // 移除所有事件屬性 (on*)
    .replace(/\s+on\w+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, '')
    // 移除 javascript: / vbscript: / data: URL
    .replace(/(?:href|src|action)\s*=\s*(?:"(?:javascript|vbscript|data):[^"]*"|'(?:javascript|vbscript|data):[^']*')/gi, '')
    // 移除 <iframe>, <object>, <embed>, <form>, <input>, <meta>, <link>, <base>
    .replace(/<\/?(iframe|object|embed|form|input|textarea|meta|link|base|svg)[\s\S]*?>/gi, '');
}

/**
 * 驗證 prompt 長度限制，防止超長 prompt 耗費 API 配額
 * @param {string} prompt
 * @param {number} maxLength
 * @returns {{ valid: boolean, message?: string }}
 */
export function validatePromptLength(prompt, maxLength = 50000) {
  if (!prompt || typeof prompt !== 'string') {
    return { valid: false, message: '未提供 prompt' };
  }
  if (prompt.length > maxLength) {
    return { valid: false, message: `prompt 超過長度限制 (${maxLength} 字元)` };
  }
  return { valid: true };
}

/**
 * 偵測 prompt 內是否含台灣身分證字號 / 手機號等高敏 PII。
 * 個資法 §8 跨境傳輸 + 醫療法 §72 / 護理人員法 §28 — 員工 ID 號 / 電話絕對不該
 * 直接送到 Google US 端的 Gemini。caller 應在送 AI 前先呼叫此函式，發現命中時
 * 回 400 並寫 access_logs 留軌跡。
 *
 * 偵測項目：
 *   - rocId: 1 個英文字母 + 1 或 2 + 8 個數字（如 A123456789）
 *   - twMobile: 09 開頭 + 8 個數字（可含一個 dash/space，如 0912-345678）
 *
 * @param {string} text
 * @returns {{ hasPii: boolean, hits: string[] }}
 */
export function detectSensitivePii(text) {
  if (!text || typeof text !== 'string') return { hasPii: false, hits: [] };
  const hits = [];
  // 中華民國身分證字號
  if (/\b[A-Z][12]\d{8}\b/.test(text)) hits.push('rocId');
  // 台灣手機（允許一個分隔符）
  if (/\b09\d{2}[-\s]?\d{6}\b/.test(text)) hits.push('twMobile');
  return { hasPii: hits.length > 0, hits };
}
