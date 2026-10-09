// 地端版排班引擎（Aegis.Api 內建 C# CP-SAT）：與 src/backend/firebase/scheduleEngine.js 同簽章、同回傳
import { http } from './http';
import { on, ensureConnected } from './realtime';

export const engineUrl = () => '';

// 人力試算（admin）：{ min, max, recommended, gray, ok, note, participants, default_quota, ... }
export const estimateStaffing = async ({ year, month, reqs }) =>
  (await http.post('/api/engine/staffing-estimate', { year, month, reqs })).data;

// 員工送出預假（days 為 1-indexed）；額滿 / 排不出來 → 409 並附原因（err.message）
export const submitLeaveWish = async (days) => (await http.post('/api/leave-wishes', { days })).data;

// 排班 = 背景工作：送出 → 拿工作 ID → 等 SignalR 推送完成（推送沒到就每 3 秒查一次）→ 回傳與 Cloud Run 相同的結果
const CLIENT_TIMEOUT_MS = 180_000;
export const generateCpsatSchedule = async ({ year, month, reqs, timeLimit = 120, hint = null }) => {
  await ensureConnected();
  const { jobId } = (await http.post('/api/engine/schedule-jobs', { year, month, reqs, timeLimit, hint, useWishes: true })).data;
  const job = await new Promise((resolve, reject) => {
    let done = false;
    const finish = (j) => { if (!done && (j.state === 'Succeeded' || j.state === 'Failed')) { done = true; cleanup(); resolve(j); } };
    const off = on('ScheduleJobChanged', (j) => { if (j.id === jobId) finish(j); });
    const poll = setInterval(() => http.get(`/api/engine/schedule-jobs/${jobId}`).then((r) => finish(r.data)).catch(() => {}), 3000);
    const timer = setTimeout(() => {
      if (done) return;
      done = true; cleanup();
      const e = new Error('排班超過 3 分鐘沒有完成，已停止等待。請稍後再試一次');
      e.status = 504;
      reject(e);
    }, CLIENT_TIMEOUT_MS);
    function cleanup() { off(); clearInterval(poll); clearTimeout(timer); }
  });
  if (job.state === 'Failed') {
    const e = new Error(job.error || '排班失敗');
    e.status = job.errorKind || 500;
    throw e;
  }
  return job.result;
};
