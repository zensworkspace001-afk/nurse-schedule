import React, { useEffect, useState, useRef } from 'react';
import {
  WifiOff, ShieldAlert, AlertCircle, CheckCircle2, RefreshCcw, LogIn,
} from 'lucide-react';
import { subscribeToConnectionEvents } from '../api/connectionStatus';
import './ConnectionStatusBanner.css';

// 頂部 slide-down banner：偵測四種狀態
//   1. offline       — navigator.onLine 變 false
//   2. perm-denied   — Firestore rules 拒讀（要重新登入）
//   3. unavailable   — Firestore quota / 暫時無回應（auto-retry）
//   4. recovered     — 從錯誤狀態回到正常，顯示 3s 後自動消失
//
// 透過 src/api/connectionStatus.js 的 pub/sub 收 Firestore 事件，
// 透過 window 'online'/'offline' 事件收瀏覽器網路狀態。
// Banner 是 slide-down 半透明條，不擋滑鼠互動。

const HEALTHY_FLASH_MS = 3000;
const HEARTBEAT_INTERVAL_MS = 10000; // 每 10 秒打一次
const HEARTBEAT_TIMEOUT_MS = 4000;   // 4 秒沒回應算 fail
const HEARTBEAT_FAILS_TO_OFFLINE = 2; // 連續失敗 2 次才宣告 offline

const ConnectionStatusBanner = () => {
  const [isOnline, setIsOnline] = useState(
    typeof navigator !== 'undefined' ? navigator.onLine : true,
  );
  // status: null=隱藏, {kind, code, source, ts}
  const [status, setStatus] = useState(null);
  const [closing, setClosing] = useState(false);
  const healthyTimerRef = useRef(null);
  const errorSourcesRef = useRef(new Set());
  const failCountRef = useRef(0);

  // 瀏覽器網路狀態 — navigator.onLine 在 Chrome DevTools 切 offline 時不一定觸發，
  // 真正可靠的訊號是下面那個 fetch heartbeat。這裡只是輔助。
  useEffect(() => {
    const onOnline = () => { setIsOnline(true); failCountRef.current = 0; };
    const onOffline = () => setIsOnline(false);
    window.addEventListener('online', onOnline);
    window.addEventListener('offline', onOffline);
    return () => {
      window.removeEventListener('online', onOnline);
      window.removeEventListener('offline', onOffline);
    };
  }, []);

  // 主動 fetch heartbeat — 比 navigator.onLine 可靠（後者在 DevTools Network → Offline
  // 切換時常常不會更新）。打 /favicon.ico + cache-busting query；本來就會被瀏覽器要，
  // payload < 1KB，影響可忽略。連續 2 次失敗才宣告 offline，避免單次抖動誤判。
  useEffect(() => {
    let cancelled = false;
    const probe = async () => {
      if (cancelled) return;
      const controller = new AbortController();
      const tid = setTimeout(() => controller.abort(), HEARTBEAT_TIMEOUT_MS);
      try {
        const res = await fetch(`/favicon.ico?_hb=${Date.now()}`, {
          method: 'HEAD',
          signal: controller.signal,
          cache: 'no-store',
        });
        clearTimeout(tid);
        if (cancelled) return;
        if (res.ok || res.status === 304) {
          // 任何 2xx / 304 都算 OK（favicon 可能 304）
          if (failCountRef.current > 0 || !isOnline) {
            failCountRef.current = 0;
            setIsOnline(true);
          }
        } else {
          // 4xx/5xx 仍是「網路通」，不算 offline
          failCountRef.current = 0;
          if (!isOnline) setIsOnline(true);
        }
      } catch {
        clearTimeout(tid);
        if (cancelled) return;
        failCountRef.current += 1;
        if (failCountRef.current >= HEARTBEAT_FAILS_TO_OFFLINE && isOnline) {
          setIsOnline(false);
        }
      }
    };
    probe(); // 立即打一次
    const interval = setInterval(probe, HEARTBEAT_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [isOnline]);

  // Firestore 事件
  useEffect(() => {
    return subscribeToConnectionEvents((evt) => {
      if (evt.type === 'firestore-error') {
        errorSourcesRef.current.add(evt.source);
        if (healthyTimerRef.current) {
          clearTimeout(healthyTimerRef.current);
          healthyTimerRef.current = null;
        }
        // 依 code 分類
        let kind = 'unavailable';
        if (evt.code === 'permission-denied') kind = 'perm-denied';
        else if (evt.code === 'unauthenticated') kind = 'perm-denied';
        else if (evt.code === 'cancelled') return; // 主動取消，不顯示
        setStatus({ kind, code: evt.code, source: evt.source, ts: evt.ts });
      } else if (evt.type === 'firestore-healthy') {
        errorSourcesRef.current.delete(evt.source);
        // 全部都恢復後才 flash recovered
        if (errorSourcesRef.current.size === 0 && status && status.kind !== 'recovered') {
          setStatus({ kind: 'recovered', ts: Date.now() });
          if (healthyTimerRef.current) clearTimeout(healthyTimerRef.current);
          healthyTimerRef.current = setTimeout(() => {
            setClosing(true);
            setTimeout(() => {
              setStatus(null);
              setClosing(false);
            }, 280);
          }, HEALTHY_FLASH_MS);
        }
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status?.kind]);

  // 離線優先：browser offline 蓋過 Firestore 任何狀態（離線本來就會讓 Firestore 連不上）
  const effective = !isOnline
    ? { kind: 'offline' }
    : status;

  if (!effective) return null;

  const config = renderConfig(effective);

  return (
    <div className={`conn-banner conn-banner--${effective.kind}${closing ? ' conn-banner--closing' : ''}`}>
      <div className="conn-banner__inner">
        <span className="conn-banner__icon">{config.icon}</span>
        <span className="conn-banner__text">{config.text}</span>
        {config.action && (
          <button className="conn-banner__action" onClick={config.action.onClick}>
            {config.action.icon}
            <span>{config.action.label}</span>
          </button>
        )}
      </div>
    </div>
  );
};

function renderConfig(state) {
  switch (state.kind) {
    case 'offline':
      return {
        icon: <WifiOff size={16} />,
        text: '目前離線 — 雲端同步暫停，連線恢復後系統會自動補抓最新資料',
        action: null,
      };
    case 'perm-denied':
      return {
        icon: <ShieldAlert size={16} />,
        text: '雲端權限驗證失敗（可能是登入過期），請重新登入',
        action: {
          icon: <LogIn size={14} />,
          label: '重新登入',
          onClick: () => window.location.reload(),
        },
      };
    case 'unavailable':
      return {
        icon: <AlertCircle size={16} />,
        text: '雲端服務暫時無回應 — 系統正在自動重試',
        action: {
          icon: <RefreshCcw size={14} />,
          label: '手動重整',
          onClick: () => window.location.reload(),
        },
      };
    case 'recovered':
      return {
        icon: <CheckCircle2 size={16} />,
        text: '連線已恢復',
        action: null,
      };
    default:
      return { icon: <AlertCircle size={16} />, text: '未知連線狀態', action: null };
  }
}

export default ConnectionStatusBanner;
