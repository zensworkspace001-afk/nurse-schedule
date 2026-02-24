
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/api': {
        target: 'nurse-schedule-bachelor.vercel.app', // 替換為您的 Vercel 網址
        changeOrigin: true,
        secure: false,
      },
    },
  },
})