import { useEffect, useState, useCallback } from 'react';

// 全域省電 / 效能模式開關。
//
// 啟用時：
//   1. <html> 加上 .perf-mode 類別 → App.refactored.css 內的全域覆蓋會關掉所有
//      backdrop-filter，並把毛玻璃面板換成稍微實心的 rgba 背景。
//   2. App.jsx 不渲染 <ParticleBackground />，省下 Three.js WebGL 場景 + aurora shader
//      + 粒子動畫的 GPU 開銷。
//
// 觸發來源（任一即啟用）：
//   - localStorage 'perfMode' === 'true'（使用者手動勾選 / 點 toggle）
//   - 系統層 `prefers-reduced-motion: reduce`（OS / 瀏覽器設定，無障礙）
//
// 使用者顯式設成 'false' 會壓過 prefers-reduced-motion，讓使用者有最終決定權。

const STORAGE_KEY = 'perfMode';

function readInitial() {
  if (typeof window === 'undefined') return false;
  const stored = window.localStorage.getItem(STORAGE_KEY);
  if (stored === 'true') return true;
  if (stored === 'false') return false; // 顯式關掉 → 壓過 OS 設定
  // 沒有手動設定 → 跟隨 OS
  return window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
}

export function usePerformanceMode() {
  const [enabled, setEnabledState] = useState(readInitial);

  // 同步到 <html> 類別
  useEffect(() => {
    const root = document.documentElement;
    if (enabled) root.classList.add('perf-mode');
    else root.classList.remove('perf-mode');
  }, [enabled]);

  // 跟隨 prefers-reduced-motion 變動（只有在使用者沒手動設定時才會觸發）
  useEffect(() => {
    const mq = window.matchMedia?.('(prefers-reduced-motion: reduce)');
    if (!mq) return;
    const onChange = () => {
      if (window.localStorage.getItem(STORAGE_KEY) === null) {
        setEnabledState(mq.matches);
      }
    };
    mq.addEventListener?.('change', onChange);
    return () => mq.removeEventListener?.('change', onChange);
  }, []);

  const setEnabled = useCallback((next) => {
    const v = typeof next === 'function' ? next(enabled) : !!next;
    window.localStorage.setItem(STORAGE_KEY, v ? 'true' : 'false');
    setEnabledState(v);
  }, [enabled]);

  const toggle = useCallback(() => setEnabled(!enabled), [enabled, setEnabled]);

  return [enabled, { setEnabled, toggle }];
}
