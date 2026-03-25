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
