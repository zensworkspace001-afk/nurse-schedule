<?php

namespace App\Http\Controllers;

use App\Support\Firebase;
use Google\Cloud\Core\Timestamp;
use Google\Cloud\Firestore\FieldValue;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Http;

/**
 * 巡邏機器人 — 對應 api/cron/check-timeout.js
 *
 * POST /api/cron/check-timeout  (Bearer ${CRON_SECRET}，僅供 cron 觸發)
 *
 * 每日做兩件事：
 *   1. 個資保留期掃除（access_logs / AI_Decision_Logs / archive_reports / pending_activation）—
 *      PDPA §11/§19/§27 要求個資「達成目的後應主動刪除」。
 *   2. 檢查 SelectionTurn 是否有逾時 24h 的 active staff；逾時就強制跳過 + 觸發 auto-relay
 *      + 寄信通知 admin。
 *
 * Cross-backend HTTP：auto-relay / sendEmail 透過 INTERNAL_API_BASE 呼叫。
 * 預設指 Vercel（原 Node 後端）— 若日後 auto-relay 也 port 完畢，把 env 改成 PHP 自己即可。
 *
 * 不檢查 CSRF（與 JS 版一致）；CRON_SECRET 已是充分授權。
 */
class CronCheckTimeoutController extends Controller
{
    private const DEFAULT_INTERNAL_BASE   = 'https://nurse-schedule-bachelor.vercel.app';
    private const DEFAULT_ADMIN_EMAIL     = 'zensworkspace001@gmail.com';
    private const BATCH_LIMIT             = 400;   // Firestore batch 上限 500，留 buffer
    private const TIMEOUT_HOURS           = 24;

    public function handle(Request $request): JsonResponse
    {
        // healthCheck（query string）
        if ($request->query('healthCheck') === 'true') {
            try {
                Firebase::firestore()->document('NurseApp/Settings')->snapshot();
                return response()->json(['ok' => true, 'service' => 'cron/check-timeout']);
            } catch (\Throwable $err) {
                return response()->json([
                    'ok' => false, 'service' => 'cron/check-timeout', 'error' => $err->getMessage(),
                ], 503);
            }
        }

        // —— 安全鎖：只認 CRON_SECRET ——
        $authHeader = (string) $request->header('authorization');
        $cronSecret = env('CRON_SECRET');
        $expected   = is_string($cronSecret) && $cronSecret !== '' ? 'Bearer ' . $cronSecret : null;
        if ($expected === null || !hash_equals($expected, $authHeader)) {
            return response()->json(['error' => 'Unauthorized'], 401);
        }

        try {
            logger()->info('🤖 [巡邏機器人] 啟動巡邏...');

            // ── Step 0：個資保留期掃除（失敗不擋主流程，cron 沒人在等）──
            $this->runRetentionSweep();

            $firestore   = Firebase::firestore();
            $now         = new \DateTimeImmutable('now', new \DateTimeZone('UTC'));
            $year        = (int) $now->format('Y');
            $month       = (int) $now->format('n');
            $ym          = "{$year}_{$month}";

            $turnRef     = $firestore->document("SelectionTurn/{$ym}");
            $turnSnap    = $turnRef->snapshot();

            if (!$turnSnap->exists()) {
                return response()->json(['message' => '目前無人排隊，引擎待機中。']);
            }
            $turnData       = $turnSnap->data() ?: [];
            $activeStaffId  = $turnData['active_staff_id'] ?? null;
            if (!$activeStaffId) {
                return response()->json(['message' => '目前無人排隊，引擎待機中。']);
            }

            // ── 防呆：若 active 早已在 submitted_staff，turn 殘留是上游 bug，自動歸位 ──
            $progressRef  = $firestore->document("SelectionProgress/{$ym}");
            $progressSnap = $progressRef->snapshot();
            $submitted    = $progressSnap->exists() && is_array($progressSnap->data()['submitted_staff'] ?? null)
                ? $progressSnap->data()['submitted_staff']
                : [];
            $normalized = strtoupper(trim((string) $activeStaffId));
            $alreadySubmitted = false;
            foreach ($submitted as $sid) {
                if (strtoupper(trim((string) $sid)) === $normalized) {
                    $alreadySubmitted = true;
                    break;
                }
            }
            if ($alreadySubmitted) {
                $reset = [
                    'active_staff_id' => null,
                    'year'            => $year,
                    'month'           => $month,
                    'updatedAt'       => FieldValue::serverTimestamp(),
                ];
                $turnRef->set($reset);
                $firestore->document('SelectionTurn/latest')->set($reset);
                logger()->info("🧹 {$activeStaffId} 已在 submitted_staff 名單中，turn 殘留為上游 bug，自動清空");
                return response()->json([
                    'message' => "{$activeStaffId} 已選完但 turn 未被清空，已歸位。",
                ]);
            }

            // ── 卡住時間檢查 ──
            $updatedAt = $turnData['updatedAt'] ?? null;
            $lastMs    = $this->timestampToMillis($updatedAt);
            if ($lastMs === null) {
                return response()->json([
                    'message' => "active_staff_id={$activeStaffId} 但 updatedAt 缺失或格式異常，跳過本輪檢查",
                ]);
            }
            $hoursDiff = ((int) ($now->format('U')) * 1000 + (int) $now->format('v') - $lastMs) / 3600000;
            if ($hoursDiff < self::TIMEOUT_HOURS) {
                $msg = "目前輪到 {$activeStaffId}，才過了 " . number_format($hoursDiff, 1) . " 小時，繼續等待。";
                return response()->json(['message' => $msg]);
            }

            logger()->warning("🚨 警告：{$activeStaffId} 已逾時 " . number_format($hoursDiff, 1) . " 小時！執行強制跳過...");

            // ── A. 打入冷宮 ──
            $progressRef->set(
                ['submitted_staff' => FieldValue::arrayUnion([$activeStaffId])],
                ['merge' => true]
            );

            // ── B. 清空雷達 ──
            $turnRef->set([
                'active_staff_id' => null,
                'updatedAt'       => FieldValue::serverTimestamp(),
            ]);

            // ── C. 呼叫 auto-relay 選下一位 ──
            $baseUrl      = $this->internalApiBase();
            $scheduleRef  = $firestore->document("Schedules/{$ym}");
            $scheduleSnap = $scheduleRef->snapshot();
            $finalized    = $scheduleSnap->exists() && is_array($scheduleSnap->data()['finalizedSchedule'] ?? null)
                ? $scheduleSnap->data()['finalizedSchedule']
                : new \stdClass();  // 強制空物件 JSON 化（{} 而非 []）

            $relayData = [];
            try {
                $relayRes = Http::withToken($cronSecret)
                    ->acceptJson()
                    ->timeout(60)  // auto-relay 內部會打 Gemini，可能 30s+
                    ->post("{$baseUrl}/api/auto-relay", [
                        'year'            => $year,
                        'month'           => $month,
                        'currentSchedule' => $finalized,
                    ]);
                $relayData = $relayRes->json() ?: [];
            } catch (\Throwable $e) {
                logger()->warning('auto-relay 呼叫失敗（不擋通知信流程）: ' . $e->getMessage());
            }
            $selectedStaffId = $relayData['selected_staff_id'] ?? '尋找中';

            // ── D. 通知 admin ──
            $adminEmail = env('ADMIN_NOTIFY_EMAIL') ?: self::DEFAULT_ADMIN_EMAIL;
            try {
                Http::withToken($cronSecret)
                    ->acceptJson()
                    ->timeout(20)
                    ->post("{$baseUrl}/api/sendEmail", [
                        'to'      => $adminEmail,
                        'subject' => "🚨 AI 系統回報：已強制跳過逾時員工 {$activeStaffId}",
                        'html'    => "<p>護理長您好：</p><p>員工 <b>{$activeStaffId}</b> 已經超過 24 小時未選班。<br/>"
                                   . "系統已自動將其跳過，並已自動啟動 AI 接力將發球權交給下一位同仁：<b>{$selectedStaffId}</b>。</p>",
                    ]);
            } catch (\Throwable $e) {
                logger()->warning('sendEmail 通知失敗（主流程已完成）: ' . $e->getMessage());
            }

            return response()->json([
                'success' => true,
                'message' => "已成功跳過 {$activeStaffId} 並自動交棒給 {$selectedStaffId}。",
            ]);
        } catch (\Throwable $err) {
            logger()->error('巡邏機器人發生錯誤: ' . $err->getMessage());
            return response()->json(['error' => '巡邏機器人發生錯誤'], 500);
        }
    }

    /**
     * 個資法保留期限掃除。每個 collection 獨立 try/catch — 一個失敗不擋其它。
     *
     * 為什麼用 BATCH_LIMIT = 400：Firestore batch 上限 500，留 buffer；每次最多刪 400，
     * 下一輪 cron（24h 後）會繼續清，避免單次跑太久 timeout。
     */
    private function runRetentionSweep(): void
    {
        $accessDays  = (int) (env('ACCESS_LOG_RETENTION_DAYS') ?: 180);
        $aiDays      = (int) (env('AI_DECISION_LOG_RETENTION_DAYS') ?: 180);
        $archiveDays = (int) (env('ARCHIVE_REPORT_RETENTION_DAYS') ?: 2555);  // ~7 年

        $now    = new \DateTimeImmutable('now', new \DateTimeZone('UTC'));
        $nowMs  = (int) ((float) $now->format('U.v') * 1000);

        // access_logs：ts 是 JS toISOString() 字串，PHP 端產同格式（毫秒精度 + Z 後綴）做比較
        $accessCutoff = (new \DateTimeImmutable("@" . ($nowMs / 1000 - $accessDays * 86400), new \DateTimeZone('UTC')))
            ->format('Y-m-d\TH:i:s.v\Z');
        // AI / pending_activation：用 Firestore Timestamp 比對
        $aiCutoff      = new Timestamp(new \DateTimeImmutable("@" . ($nowMs / 1000 - $aiDays * 86400), new \DateTimeZone('UTC')));
        $pendingCutoff = new Timestamp(new \DateTimeImmutable("@" . ($nowMs / 1000 - 7 * 86400), new \DateTimeZone('UTC')));
        // archive_reports：用 doc id (YYYY_M) 字典序 + 數值比，避免依賴 timestamp 欄位
        $archiveCutoffDate = new \DateTimeImmutable("@" . ($nowMs / 1000 - $archiveDays * 86400), new \DateTimeZone('UTC'));
        $archiveCutoffYm   = (int) $archiveCutoffDate->format('Y') * 100 + (int) $archiveCutoffDate->format('n');

        $firestore = Firebase::firestore();

        $this->sweepBatched(
            $firestore->collection('access_logs')->where('ts', '<', $accessCutoff)->limit(self::BATCH_LIMIT)->documents(),
            "access_logs（>{$accessDays} 天）"
        );

        $this->sweepBatched(
            $firestore->collection('AI_Decision_Logs')->where('timestamp', '<', $aiCutoff)->limit(self::BATCH_LIMIT)->documents(),
            "AI_Decision_Logs（>{$aiDays} 天）"
        );

        // archive_reports：collection 小（每月 1 筆），全讀 + in-memory 篩
        try {
            $expired = [];
            foreach ($firestore->collection('archive_reports')->documents() as $doc) {
                if (!preg_match('/^(\d{4})_(\d{1,2})$/', $doc->id(), $m)) {
                    continue;
                }
                $ym = (int) $m[1] * 100 + (int) $m[2];
                if ($ym < $archiveCutoffYm) {
                    $expired[] = $doc->reference();
                }
                if (count($expired) >= self::BATCH_LIMIT) {
                    break;
                }
            }
            if (count($expired) > 0) {
                $batch = $firestore->batch();
                foreach ($expired as $ref) {
                    $batch->delete($ref);
                }
                $batch->commit();
                logger()->info('🗑 retention: 已刪除 ' . count($expired) . " 筆超過 {$archiveDays} 天的 archive_reports");
            }
        } catch (\Throwable $err) {
            logger()->warning('archive_reports retention sweep 失敗: ' . $err->getMessage());
        }

        $this->sweepBatched(
            $firestore->collection('pending_activation')->where('createdAt', '<', $pendingCutoff)->limit(self::BATCH_LIMIT)->documents(),
            'pending_activation（>7 天）'
        );
    }

    /** 通用批次刪除 helper — 接收一個 documents() generator，逐筆塞進 batch 再 commit。 */
    private function sweepBatched(iterable $docs, string $label): void
    {
        try {
            $firestore = Firebase::firestore();
            $batch     = $firestore->batch();
            $count     = 0;
            foreach ($docs as $doc) {
                $batch->delete($doc->reference());
                $count++;
            }
            if ($count > 0) {
                $batch->commit();
                logger()->info("🗑 retention: 已刪除 {$count} 筆 {$label}");
            }
        } catch (\Throwable $err) {
            logger()->warning("{$label} retention sweep 失敗: " . $err->getMessage());
        }
    }

    /** 把 Firestore Timestamp / DateTimeImmutable / int(ms or s) 統一轉成 millis，失敗回 null。 */
    private function timestampToMillis($value): ?int
    {
        if ($value === null) {
            return null;
        }
        if ($value instanceof Timestamp) {
            // Google\Cloud\Core\Timestamp::get() 回 \DateTimeImmutable
            $dt = $value->get();
            return (int) ((float) $dt->format('U.v') * 1000);
        }
        if ($value instanceof \DateTimeInterface) {
            return (int) ((float) $value->format('U.v') * 1000);
        }
        if (is_int($value)) {
            // 大數視為 ms，小數視為 s
            return $value > 9999999999 ? $value : $value * 1000;
        }
        return null;
    }

    private function internalApiBase(): string
    {
        $base = env('INTERNAL_API_BASE');
        return is_string($base) && $base !== '' ? rtrim($base, '/') : self::DEFAULT_INTERNAL_BASE;
    }
}
