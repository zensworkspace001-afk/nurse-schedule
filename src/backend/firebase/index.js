// 後端：Firebase + Vercel（現行正式環境）。元件一律 import '@backend'，由 vite.config.js 的 alias 依
// VITE_BACKEND 決定指向這裡或 src/backend/aegis/（地端）；打包只會包含選到的那一個。
export * from './database';
export * from './secureField';
export * from './scheduleEngine';
export * from './services';
