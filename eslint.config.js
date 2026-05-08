import js from '@eslint/js'
import globals from 'globals'
import react from 'eslint-plugin-react'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import { defineConfig, globalIgnores } from 'eslint/config'

export default defineConfig([
  // server/ 是 legacy local Express dev server (CLAUDE.md 標明不再使用)
  // skills/、.qoder/ 是 Claude Code 工具相關檔案 (非專案程式碼)
  // src/backup.js 是 App.jsx 的歷史備份 (有重複宣告，僅作 git history 追溯用)
  globalIgnores(['dist', 'dist-electron', 'server', 'skills', '.qoder', 'src/backup.js']),
  {
    files: ['**/*.{js,jsx}'],
    extends: [
      js.configs.recommended,
      reactHooks.configs['recommended-latest'],
      reactRefresh.configs.vite,
    ],
    languageOptions: {
      ecmaVersion: 2020,
      globals: globals.browser,
      parserOptions: {
        ecmaVersion: 'latest',
        ecmaFeatures: { jsx: true },
        sourceType: 'module',
      },
    },
    plugins: { react },
    rules: {
      // 讓 ESLint 認得 JSX 中的 import — 沒這條時 <motion.div> 會被誤判為 motion 未使用，
      // 上一次 lint 清理就因此誤刪了 framer-motion 的 motion import 導致 runtime error。
      'react/jsx-uses-vars': 'error',
      'react/jsx-uses-react': 'error',
      'no-unused-vars': ['error', {
        varsIgnorePattern: '^[A-Z_]',
        argsIgnorePattern: '^_',
        caughtErrorsIgnorePattern: '^_',
      }],
    },
  },
  // Node 環境：API serverless functions、scripts、設定檔、Playwright 測試
  {
    files: [
      'api/**/*.js',
      'scripts/**/*.js',
      'tests/**/*.{js,jsx}',
      'electron-main.js',
      'playwright.config.js',
      'vite.config.js',
    ],
    languageOptions: {
      globals: { ...globals.node },
    },
  },
])
