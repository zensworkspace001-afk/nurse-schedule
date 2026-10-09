import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import { fileURLToPath } from 'node:url'

/**
 * Dev proxy 策略：
 *   - 預設所有 /api/* 走 Vercel（與 production 一致）。
 *   - 若 .env.local 設了 VITE_API_PROXY_TARGET（如本機 PHP http://localhost:8000），
 *     僅把「已 port 的端點」轉去那邊；其餘端點（hard batch 還沒搬）仍走 Vercel，
 *     讓 UI 整個跑得起來、不會因為某支端點 404 就整頁壞。
 *
 * 已 port 到 PHP 的端點（2026-06）：
 *   sendEmail / activate-account / log-login / complete-profile /
 *   secure-field / auto-settle / cron/check-timeout
 *
 * 還沒 port（仍走 Vercel）：
 *   gemini / analyze-excel / admin-user
 *   （claim-schedule / auto-relay 隨認領流程移除，2026-10）
 */
const PORTED_PATHS = [
  '/api/sendEmail',
  '/api/activate-account',
  '/api/log-login',
  '/api/complete-profile',
  '/api/secure-field',
  '/api/auto-settle',
  '/api/cron/check-timeout',
]

const VERCEL_TARGET = 'https://nurse-schedule-bachelor.vercel.app'

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  const phpTarget = env.VITE_API_PROXY_TARGET // 設了 = 啟用混合路由；空 = 全部走 Vercel

  // Vite 用 path 字串前綴比對，越具體越優先（已 port 的路徑先列、/api catch-all 殿後）。
  const proxy = {}
  if (phpTarget) {
    for (const p of PORTED_PATHS) {
      proxy[p] = { target: phpTarget, changeOrigin: true, secure: false }
    }
  }
  // 後端選擇（神盾計畫階段四）：firebase = 現行 Vercel + Firebase；aegis = 地端 .NET（Aegis.Api）
  // 元件一律 import '@backend'，只有選到的那一個會被打包。
  const backend = env.VITE_BACKEND || 'firebase'
  if (!['firebase', 'aegis'].includes(backend)) throw new Error(`VITE_BACKEND 只能是 firebase 或 aegis，目前是 ${backend}`)
  if (backend === 'aegis') {
    // 地端：/api 與 /hubs 都走本機 Aegis.Api（預設 http://localhost:5080）
    const aegisTarget = env.VITE_AEGIS_API_TARGET || 'http://localhost:5080'
    proxy['/api'] = { target: aegisTarget, changeOrigin: true, secure: false }
    proxy['/hubs'] = { target: aegisTarget, changeOrigin: true, secure: false, ws: true }
  } else {
    proxy['/api'] = { target: VERCEL_TARGET, changeOrigin: true, secure: false }
  }

  return {
    plugins: [react()],
    resolve: {
      alias: { '@backend': fileURLToPath(new URL(`./src/backend/${backend}/index.js`, import.meta.url)) },
    },
    server: {
      // vercel dev injects $PORT and proxies to it; Vite ignores $PORT by default,
      // so without this it stays on 5173 and `vercel dev` fails with
      // "Failed to detect a server running on port <n>". Plain `npm run dev` leaves
      // PORT unset → falls back to 5173 as before. Production build runs no dev server.
      port: process.env.PORT ? Number(process.env.PORT) : 5173,
      strictPort: !!process.env.PORT,
      proxy,
    },
  }
})
