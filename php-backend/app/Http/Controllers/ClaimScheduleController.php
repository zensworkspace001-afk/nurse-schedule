<?php

namespace App\Http\Controllers;

use App\Support\Csrf;
use App\Support\Firebase;
use App\Support\RateLimit;
use Google\Cloud\Firestore\FieldValue;
use Google\Cloud\Firestore\Transaction;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;

/**
 * 員工認領班次 — 對應 api/claim-schedule.js
 *
 * POST /api/claim-schedule  (Bearer Firebase ID token — staff)
 *   Body: { year, month, virtualSlotId }
 *
 * 流程：
 *   1. 驗 token → actor.uid 從 email 反推得 staff_id（避免 Firebase 自動 UID 污染 schedule key）
 *   2. Firestore 交易:
 *        - 讀 Schedules/{year_month}.finalizedSchedule
 *        - 確認 virtualSlotId 仍存在（防搶單）
 *        - 確認 actor 還沒認領（防重複）
 *        - 用 dot-path 同時刪除 virtualSlotId、新增 actor.uid 鍵下的 pattern
 *        - 連動寫遮罩過的 SchedulesPublic/{ym}（事假/病假/特休 → OFF）
 *   3. 交易是原子的 — 兩個員工同時搶同一格時，後到者會看到「搶走了」錯誤。
 *
 * 為什麼走後端：firestore.rules 無法阻止惡意員工 diff 同時改其他人的 cell（垂直越權）；
 * rules 收緊成 admin only，員工只能透過此端點。
 *
 * 注意：業務級衝突（已被搶走/已認領）用 sentinel return 而非 throw，
 * 避免 Google Firestore PHP SDK 把它視為可重試的 contention（會白跑 5 次）。
 */
class ClaimScheduleController extends Controller
{
    private const SENSITIVE_LEAVE_TYPES = ['事假', '病假', '特休'];

    public function handle(Request $request): JsonResponse
    {
        // healthCheck（CSRF / auth 之前放行）
        if ($request->boolean('healthCheck')) {
            try {
                Firebase::firestore()->document('NurseApp/Settings')->snapshot();
                return response()->json(['ok' => true, 'service' => 'claim-schedule']);
            } catch (\Throwable $err) {
                return response()->json([
                    'ok' => false, 'service' => 'claim-schedule', 'error' => $err->getMessage(),
                ], 503);
            }
        }

        if (!Csrf::check($request)) {
            return response()->json(['error' => '禁止：非法來源'], 403);
        }

        // ── Bearer token ──
        $authHeader = (string) $request->header('authorization');
        if (!str_starts_with($authHeader, 'Bearer ')) {
            return response()->json(['error' => '未經授權：缺少登入憑證'], 401);
        }
        try {
            $verified = Firebase::auth()->verifyIdToken(substr($authHeader, 7));
        } catch (\Throwable $e) {
            return response()->json(['error' => '未經授權：登入憑證無效或已過期'], 401);
        }

        // 從 email 反推 staff_id（與 complete-profile 同一個 convention，避免 Firebase 自動 UID）
        $firebaseUid = (string) $verified->claims()->get('sub');
        $email       = (string) ($verified->claims()->get('email') ?? '');
        $staffId     = preg_match('/^([^@]+)@hospital\.com$/i', $email, $m)
            ? strtoupper($m[1])
            : $firebaseUid;
        $actor = ['uid' => $staffId, 'email' => $email];

        // admin 不該透過此端點認領（admin 沒有自己的班次格子）
        if ($actor['email'] === 'admin@hospital.com') {
            return response()->json(['error' => '管理員請使用排班工作桌'], 403);
        }

        if (!RateLimit::check("claim:{$actor['uid']}", 20)) {
            return response()->json(['error' => '請求過於頻繁，請稍候再試'], 429);
        }

        // ── 輸入驗證 ──
        $year          = $request->input('year');
        $month         = $request->input('month');
        $virtualSlotId = $request->input('virtualSlotId');

        if (!$year || !$month || !$virtualSlotId) {
            return response()->json(['error' => '缺少必要參數 year / month / virtualSlotId'], 400);
        }
        if (!is_string($virtualSlotId) || !str_starts_with($virtualSlotId, 'D')) {
            return response()->json(['error' => 'virtualSlotId 必須是虛擬空缺鍵（D 開頭）'], 400);
        }

        $docId       = "{$year}_{$month}";
        $firestore   = Firebase::firestore();
        $scheduleRef = $firestore->document("Schedules/{$docId}");
        $publicRef   = $firestore->document("SchedulesPublic/{$docId}");
        $actorUid    = $actor['uid'];

        try {
            $result = $firestore->runTransaction(
                function (Transaction $tx) use ($scheduleRef, $publicRef, $actorUid, $virtualSlotId) {
                    $snap = $tx->snapshot($scheduleRef);
                    if (!$snap->exists()) {
                        // sentinel return（非 throw）— 不要讓 SDK 把業務級錯誤當 contention 重試
                        return ['err_status' => 404, 'err_msg' => '找不到該月份的班表'];
                    }
                    $data      = $snap->data();
                    $finalized = is_array($data['finalizedSchedule'] ?? null) ? $data['finalizedSchedule'] : [];

                    if (!array_key_exists($virtualSlotId, $finalized)) {
                        return ['err_status' => 409, 'err_msg' => '此班表已被別人選走，請選擇其他班表'];
                    }
                    if (array_key_exists($actorUid, $finalized)) {
                        return ['err_status' => 409, 'err_msg' => '您本月已認領過班表，無法重複認領'];
                    }

                    $claimedPattern = $finalized[$virtualSlotId];

                    // 用 dot-path 同時刪除 virtualSlotId、新增 actor.uid 鍵 — 保持原子性
                    $tx->update($scheduleRef, [
                        ['path' => "finalizedSchedule.{$virtualSlotId}", 'value' => FieldValue::deleteField()],
                        ['path' => "finalizedSchedule.{$actorUid}",      'value' => $claimedPattern],
                    ]);

                    // 算後快照（給前端 optimistic UI 同步）+ 遮罩公開版
                    $updated = $finalized;
                    unset($updated[$virtualSlotId]);
                    $updated[$actorUid] = $claimedPattern;

                    $masked = self::buildSchedulePublicMasked($updated);
                    $tx->set($publicRef, ['finalizedSchedule' => $masked]);

                    return ['err_status' => null, 'updated' => $updated];
                }
            );

            if (($result['err_status'] ?? null) !== null) {
                return response()->json(['error' => $result['err_msg']], $result['err_status']);
            }

            return response()->json([
                'ok'                => true,
                'message'           => '認領成功',
                'finalizedSchedule' => $result['updated'],
                'claimedBy'         => $actorUid,
            ]);
        } catch (\Throwable $err) {
            logger()->error('claim-schedule 失敗: ' . $err->getMessage());
            return response()->json(['error' => '伺服器處理失敗，請稍後再試'], 500);
        }
    }

    /**
     * 遮罩單一 cell — 事假/病假/特休 改成 OFF，保護同事的醫療隱私。
     * 行為對齊 api/claim-schedule.js sanitizeCell 與 src/api/database.js buildSchedulePublicProjection。
     */
    private static function sanitizeCell($cell)
    {
        if ($cell === null) {
            return null;
        }
        if (is_string($cell)) {
            return in_array($cell, self::SENSITIVE_LEAVE_TYPES, true) ? 'OFF' : $cell;
        }
        if (is_array($cell)) {
            if (isset($cell['type']) && in_array($cell['type'], self::SENSITIVE_LEAVE_TYPES, true)) {
                $cell['type'] = 'OFF';
            }
            return $cell;
        }
        return $cell;
    }

    /** 對整個 finalizedSchedule 套用遮罩，回傳 SchedulesPublic 用的精簡版。 */
    private static function buildSchedulePublicMasked($finalized): array
    {
        if (!is_array($finalized)) {
            return [];
        }
        $out = [];
        foreach ($finalized as $key => $dayCells) {
            if (!is_array($dayCells)) {
                continue;
            }
            $sanitized = [];
            foreach ($dayCells as $day => $cell) {
                $sanitized[$day] = self::sanitizeCell($cell);
            }
            $out[$key] = $sanitized;
        }
        return $out;
    }
}
