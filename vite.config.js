
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    // vercel dev injects $PORT and proxies to it; Vite ignores $PORT by default,
    // so without this it stays on 5173 and `vercel dev` fails with
    // "Failed to detect a server running on port <n>". Plain `npm run dev` leaves
    // PORT unset → falls back to 5173 as before. Production build runs no dev server.
    port: process.env.PORT ? Number(process.env.PORT) : 5173,
    strictPort: !!process.env.PORT,
    proxy: {
      '/api': {
        target: 'https://nurse-schedule-bachelor.vercel.app', // 替換為您的 Vercel 網址
        changeOrigin: true,
        secure: false,
      },
    },
  },
})