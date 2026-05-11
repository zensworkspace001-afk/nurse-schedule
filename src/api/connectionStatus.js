// 全域連線狀態事件中心
//
// 目的：把分散在 database.js 各個 onSnapshot 的 onError callback 收斂到一處，
// 讓 UI 可以集中顯示「離線 / 權限失敗 / 雲端無回應」等 banner，
// 不必每個 component 都自己處理 try/catch。
//
// 用法：
//   - database.js 內部訂閱出錯時呼叫 reportFirestoreError(err)
//   - App.jsx 用 subscribeToConnectionEvents(callback) 訂閱事件
//
// 事件不會 persist — 只在訂閱期間活著。

const listeners = new Set();

export function subscribeToConnectionEvents(callback) {
  listeners.add(callback);
  return () => listeners.delete(callback);
}

function emit(event) {
  for (const cb of listeners) {
    try { cb(event); } catch { /* listener 自己壞掉不影響其他 listener */ }
  }
}

// Firestore 訂閱 onError 觸發時呼叫
export function reportFirestoreError(err, source) {
  emit({
    type: 'firestore-error',
    code: err?.code || 'unknown',
    message: err?.message || String(err),
    source: source || 'unknown',
    ts: Date.now(),
  });
}

// 訂閱第一次成功收到 callback 時呼叫（用來把 banner 從錯誤狀態清掉）
export function reportFirestoreHealthy(source) {
  emit({
    type: 'firestore-healthy',
    source: source || 'unknown',
    ts: Date.now(),
  });
}
