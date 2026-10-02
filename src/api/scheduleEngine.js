// ============================================================================
// 排班引擎（Cloud Run：main1.py + cpsat_service.py）的 API 呼叫
// ============================================================================
// VITE_SCHEDULE_ENGINE_URL 指向 Cloud Run 上的 CP-SAT 引擎（人力試算 / 預假 / 直接指派排班）。
// 舊的 SA 排班仍走 VITE_CPSAT_URL（Render），兩者分開，切換前互不影響。
// 新增外部網址時記得同步 vercel.json 的 CSP connect-src。
import { auth } from './database';

const DEFAULT_ENGINE_URL = 'https://nurse-schedule-engine-273758593077.asia-east1.run.app';

export const engineUrl = () =>
  (import.meta.env.VITE_SCHEDULE_ENGINE_URL || DEFAULT_ENGINE_URL).replace(/\/+$/, '');

const post = async (path, body) => {
  const token = await auth.currentUser?.getIdToken();
  if (!token) throw new Error('登入逾期，請重新登入');
  let res;
  try {
    res = await fetch(`${engineUrl()}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    });
  } catch {
    throw new Error('無法連線到排班引擎，請稍後再試');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const detail = Array.isArray(data.detail) ? data.detail.map(d => d.msg).join('；') : data.detail;
    const err = new Error(detail || `排班引擎回應 ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return data;
};

// 人力試算（admin）：{ min, max, recommended, gray, ok, note, participants, default_quota, ... }
export const estimateStaffing = ({ year, month, reqs }) =>
  post('/cpsat/staffing_estimate', { year, month, reqs });

// 員工送出預假（days 為 1-indexed 日期）；額滿 / 排不出來會丟 409 並附原因
export const submitLeaveWish = (days) =>
  post('/leave_wishes/submit', { days });

// CP-SAT 直接指派排班（admin）；已登記預假為硬約束
export const generateCpsatSchedule = ({ year, month, reqs, timeLimit = 120, hint = null }) =>
  post('/cpsat/generate_schedule', { year, month, reqs, time_limit: timeLimit, hint, use_wishes: true });
