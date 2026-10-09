import { useEffect, useState } from 'react';
import { features } from '@backend';

// 後端支援哪些功能（Firebase 版全開；地端版由伺服器 GET /api/features 回報）。
// 初值由各後端提供（Firebase 全開；地端全關，等伺服器回報再打開），避免畫面閃一下又消失。
const DEFAULTS = { selfServiceReset: false, ai: false, weather: false, autoSettleTest: false, ...(features.initial || {}) };
let cache = null;

export function useFeatures() {
  const [f, setF] = useState(cache || DEFAULTS);
  useEffect(() => {
    if (cache) return;
    let alive = true;
    features.load().then((v) => { cache = { ...DEFAULTS, ...v }; if (alive) setF(cache); }).catch(() => {});
    return () => { alive = false; };
  }, []);
  return f;
}
