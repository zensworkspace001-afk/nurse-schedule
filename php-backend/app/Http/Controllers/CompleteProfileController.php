<?php

namespace App\Http\Controllers;

use App\Services\AccessLog;
use App\Services\FieldCrypto;
use App\Support\Csrf;
use App\Support\Firebase;
use App\Support\RateLimit;
use Google\Cloud\Firestore\Transaction;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;

/**
 * 員工個人資料 — 對應 api/complete-profile.js
 *
 * 兩種模式（由 body.mode 切換）：
 *   - 預設 / 'first'：首登完善個資；PII 必填且加密；profile_completed=true；
 *                      寫 access_logs action=encrypt。
 *   - 'update'      ：已啟用後自助更新基本資料 + 頭貼；不動 PII；profile_completed
 *                      維持原值；寫 access_logs action=update-profile。
 *
 * 共通：員工只能改自己（actor.uid === staff_id）；admin 不可走此端點。
 * 三層 doc 一致：NurseApp/Staff（管） + NurseApp/StaffPublic（同事看的精簡投影） +
 *              StaffPrivate/{id}（員工自己的完整 row）。
 */
class CompleteProfileController extends Controller
{
    /** 台灣銀行代碼白名單 — 與 api/complete-profile.js / src/constants/banks.js 同步 */
    private const TAIWAN_BANK_CODES = [
        '700', '004', '005', '006', '007', '008', '009', '011', '012', '013',
        '016', '017', '050', '052', '053', '081', '102', '103', '108', '147',
        '803', '805', '806', '807', '808', '809', '810', '812', '816', '822',
    ];

    private const AVATAR_MAX_BYTES  = 200 * 1024;   // 主圖 200 KB（220x220 webp 綽綽有餘）
    private const THUMB_MAX_BYTES   = 30 * 1024;    // 縮圖 30 KB（64x64 webp 約 3-5 KB）
    private const AVATAR_MIME_REGEX = '/^data:image\/(webp|jpeg|png);base64,/i';

    public function handle(Request $request): JsonResponse
    {
        // healthCheck 必須在 CSRF / auth 之前放行（與 Node 版一致）
        if ($request->boolean('healthCheck')) {
            try {
                foreach (Firebase::auth()->listUsers(1) as $_) {
                    break; // 強制觸發一次 API 請求（kreait listUsers 為 lazy generator）
                }
                return response()->json(['ok' => true, 'service' => 'complete-profile']);
            } catch (\Throwable $err) {
                return response()->json([
                    'ok' => false, 'service' => 'complete-profile', 'error' => $err->getMessage(),
                ], 503);
            }
        }

        if (!Csrf::check($request)) {
            return response()->json(['error' => '禁止：非法來源'], 403);
        }

        // ── Bearer token 驗證 ──
        $authHeader = (string) $request->header('authorization');
        if (!str_starts_with($authHeader, 'Bearer ')) {
            return response()->json(['error' => '未經授權：缺少登入憑證'], 401);
        }
        try {
            $verified = Firebase::auth()->verifyIdToken(substr($authHeader, 7));
        } catch (\Throwable $e) {
            return response()->json(['error' => '未經授權：登入憑證無效或已過期'], 401);
        }

        // 從 email 反推 staff_id（與 claim-schedule / Node 版邏輯一致，
        // 避免 Firebase 自動 UID 污染 staffData）
        $firebaseUid = (string) $verified->claims()->get('sub');
        $email       = (string) ($verified->claims()->get('email') ?? '');
        $staffId     = preg_match('/^([^@]+)@hospital\.com$/i', $email, $m)
            ? strtoupper($m[1])
            : $firebaseUid;
        $actor = ['uid' => $staffId, 'email' => $email, 'firebaseUid' => $firebaseUid];

        // admin 不應透過此端點寫入（admin 沒有對應的 staffData 列）
        if ($actor['email'] === 'admin@hospital.com') {
            return response()->json(['error' => '管理員請使用員工管理頁面'], 403);
        }

        $body = $request->all();
        $mode = (($body['mode'] ?? null) === 'update') ? 'update' : 'first';

        if (!RateLimit::check("complete-profile:{$actor['uid']}:{$mode}", 10)) {
            return response()->json(['error' => '請求過於頻繁，請稍候再試'], 429);
        }

        $v = ($mode === 'update') ? $this->validateUpdate($body) : $this->validateFirst($body);
        if (!$v['ok']) {
            return response()->json(['error' => implode('；', $v['errors'])], 400);
        }

        $meta      = AccessLog::extractClientMeta($request);
        $firestore = Firebase::firestore();
        $staffRef  = $firestore->document('NurseApp/Staff');

        try {
            $snap = $staffRef->snapshot();
            if (!$snap->exists()) {
                return response()->json(['error' => '員工資料表不存在'], 500);
            }
            $data      = $snap->data();
            $staffData = array_values(is_array($data['staffData'] ?? null) ? $data['staffData'] : []);

            $idx = null;
            foreach ($staffData as $i => $row) {
                if (strtolower((string) ($row['staff_id'] ?? '')) === strtolower($actor['uid'])) {
                    $idx = $i;
                    break;
                }
            }
            if ($idx === null) {
                return response()->json(['error' => '找不到您的員工資料，請聯絡管理員'], 404);
            }

            // 構建 updated row
            if ($mode === 'first') {
                $serverTime        = (new \DateTimeImmutable())->format(\DateTimeInterface::ATOM);
                $pdpaConsentedAt   = $v['cleaned']['pdpa_consented_at'] ?: $serverTime;
                $pdpaNoticeVersion = $v['cleaned']['pdpa_notice_version'] ?: 'v1';

                $updatedRow = array_merge($staffData[$idx], [
                    'name'                   => $v['cleaned']['name'],
                    'gender'                 => $v['cleaned']['gender'],
                    'tenure_years'           => $v['cleaned']['tenure_years'],
                    'is_pregnant_or_nursing' => $v['cleaned']['is_pregnant_or_nursing'],
                    'can_night_shift'        => $v['cleaned']['can_night_shift'],
                    // 加密 PII（伺服器端做，不再繞 secure-field）
                    'idNumber'               => FieldCrypto::encrypt($v['cleaned']['idNumber']),
                    'bankAccount'            => FieldCrypto::encrypt($v['cleaned']['bankAccount']),
                    'phone'                  => FieldCrypto::encrypt($v['cleaned']['phone']),
                    'profile_completed'      => true,
                    'profile_completed_at'   => $serverTime,
                    // PDPA §8 留證欄位：若前端沒送則 server 兜底，這是審計欄位原則上必有
                    'pdpa_consented_at'      => $pdpaConsentedAt,
                    'pdpa_notice_version'    => $pdpaNoticeVersion,
                ]);
                $changedFields = ['idNumber', 'bankAccount', 'phone', 'pdpa_consent'];
            } else {
                // mode === 'update'：只 patch 實際提交的欄位；PII / profile_completed 維持原值
                $current = $staffData[$idx];
                $next    = $current;
                $changed = [];

                foreach ($v['cleaned'] as $key => $newVal) {
                    // 頭貼類：'' 視為「移除」，存 null 比空字串乾淨
                    if (($key === 'avatar' || $key === 'avatar_thumb') && $newVal === '') {
                        if (!empty($current[$key])) {
                            $next[$key] = null;
                            $changed[]  = $key;
                        }
                    } elseif (($current[$key] ?? null) !== $newVal) {
                        $next[$key] = $newVal;
                        $changed[]  = $key;
                    }
                }

                if (count($changed) === 0) {
                    return response()->json(['ok' => true, 'message' => '沒有變更', 'changed' => []]);
                }

                $next['profile_updated_at'] = (new \DateTimeImmutable())->format(\DateTimeInterface::ATOM);
                $updatedRow    = $next;
                $changedFields = $changed;
            }

            $staffData[$idx] = $updatedRow;

            // StaffPublic 精簡投影 — 必須與 src/api/database.js buildStaffPublicProjection
            // 以及 scripts/migrate-staff-public.js / restore-staff-from-private.js 保持一致
            $publicList = array_map(static function ($s) {
                return [
                    'staff_id'     => $s['staff_id'] ?? null,
                    'name'         => $s['name'] ?? null,
                    'level'        => $s['level'] ?? null,
                    'is_leader'    => !empty($s['is_leader']),
                    'is_active'    => ($s['is_active'] ?? null) !== false,
                    'avatar_thumb' => $s['avatar_thumb'] ?? null,
                ];
            }, $staffData);

            // 三層 doc 原子寫入 — google/cloud-firestore v2 拿掉了 batch() 方法，改用
            // runTransaction 達成同樣的「all-or-nothing」語意(write-only transaction 在
            // v2 SDK 是允許的，底層 RPC 走 commit batch)。
            // Staff merge(只動 staffData 欄位) / Public+Private 整 doc 覆寫。
            $publicRef  = $firestore->document('NurseApp/StaffPublic');
            $privateRef = $firestore->document('StaffPrivate/' . $updatedRow['staff_id']);

            $firestore->runTransaction(
                function (Transaction $tx) use ($staffRef, $publicRef, $privateRef, $staffData, $publicList, $updatedRow) {
                    $tx->set($staffRef,   ['staffData' => $staffData], ['merge' => true]);
                    $tx->set($publicRef,  ['staffData' => $publicList]);
                    $tx->set($privateRef, $updatedRow);
                }
            );

            // 稽核（fire-and-forget，AccessLog::write 內部已吞例外）
            AccessLog::write([
                'actor'  => ['uid' => $actor['uid'], 'email' => $actor['email']],
                'action' => ($mode === 'first') ? 'encrypt' : 'update-profile',
                'target' => ['kind' => 'staff', 'id' => $actor['uid']],
                'fields' => $changedFields,
                'ip'     => $meta['ip'],
                'ua'     => $meta['ua'],
                'extra'  => ['source' => 'complete-profile', 'mode' => $mode],
            ]);

            return response()->json([
                'ok'      => true,
                'message' => ($mode === 'first') ? '個人資料儲存成功' : '更新成功',
                'changed' => $changedFields,
            ]);
        } catch (\Throwable $err) {
            logger()->error('complete-profile 失敗: ' . $err->getMessage());
            return response()->json(['error' => '伺服器處理失敗，請稍後再試'], 500);
        }
    }

    // ─────────── validators ───────────

    /** 把可能是 array/object 的 body 值安全轉成字串（非 scalar → ''） */
    private static function asString($v): string
    {
        return is_scalar($v) ? (string) $v : '';
    }

    /** 首登：所有 PII 欄位必填 */
    private function validateFirst(array $body): array
    {
        $errors = [];

        $name = trim(self::asString($body['name'] ?? null));
        if ($name === '') {
            $errors[] = '姓名不可為空';
        } elseif (mb_strlen($name) > 50) {
            $errors[] = '姓名長度過長';
        }

        $gender = self::asString($body['gender'] ?? null);
        if ($gender !== '男' && $gender !== '女') {
            $errors[] = '性別格式錯誤';
        }

        $tenureRaw = $body['tenure_years'] ?? null;
        $tenure    = is_numeric($tenureRaw) ? (float) $tenureRaw : NAN;
        if (!is_finite($tenure) || $tenure < 0 || $tenure > 60) {
            $errors[] = '年資需為 0–60 之間的整數';
        }

        $idNumber = trim(self::asString($body['idNumber'] ?? null));
        if ($idNumber === '') {
            $errors[] = '身分證 / 居留證號不可為空';
        } elseif (strlen($idNumber) < 4 || strlen($idNumber) > 20) {
            $errors[] = '身分證號長度異常';
        }

        $bankAccount = trim(self::asString($body['bankAccount'] ?? null));
        if ($bankAccount === '') {
            $errors[] = '銀行帳號不可為空';
        } elseif (!preg_match('/^(\d{3})-(\d{6,16})$/', $bankAccount, $bm)) {
            $errors[] = '銀行帳號格式錯誤（需為「銀行三碼-帳號」如 008-1234567890）';
        } elseif (!in_array($bm[1], self::TAIWAN_BANK_CODES, true)) {
            $errors[] = "銀行代碼 {$bm[1]} 不在合法清單內";
        }

        $phone = trim(self::asString($body['phone'] ?? null));
        if ($phone === '') {
            $errors[] = '手機號碼不可為空';
        } elseif (!preg_match('/^09\d{8}$/', $phone)) {
            $errors[] = '手機需為 09 開頭共 10 碼';
        }

        // PDPA 留證（optional —— 給有則驗、沒給則 server 端 fallback）
        $pdpaConsentedAt   = null;
        $pdpaNoticeVersion = null;
        if (array_key_exists('pdpa_consented_at', $body) && $body['pdpa_consented_at'] !== null) {
            $val = trim(self::asString($body['pdpa_consented_at']));
            if ($val !== '' && strtotime($val) !== false) {
                $pdpaConsentedAt = $val;
            }
        }
        if (array_key_exists('pdpa_notice_version', $body) && $body['pdpa_notice_version'] !== null) {
            $pdpaNoticeVersion = mb_substr(self::asString($body['pdpa_notice_version']), 0, 16);
        }

        return [
            'ok'      => count($errors) === 0,
            'errors'  => $errors,
            'cleaned' => [
                'name'                   => $name,
                'gender'                 => $gender,
                'tenure_years'           => (int) floor(is_finite($tenure) ? $tenure : 0),
                'is_pregnant_or_nursing' => (bool) ($body['is_pregnant_or_nursing'] ?? false),
                'can_night_shift'        => ($body['can_night_shift'] ?? null) !== false,
                'idNumber'               => $idNumber,
                'bankAccount'            => $bankAccount,
                'phone'                  => $phone,
                'pdpa_consented_at'      => $pdpaConsentedAt,
                'pdpa_notice_version'    => $pdpaNoticeVersion,
            ],
        ];
    }

    /** 自助更新：所有欄位 optional；不動 PII。三狀態：未提供（不改）、''（移除頭貼）、有值（覆寫） */
    private function validateUpdate(array $body): array
    {
        $errors  = [];
        $cleaned = [];

        if (array_key_exists('name', $body) && $body['name'] !== null) {
            $name = trim(self::asString($body['name']));
            if ($name === '') {
                $errors[] = '姓名不可為空';
            } elseif (mb_strlen($name) > 50) {
                $errors[] = '姓名長度過長';
            } else {
                $cleaned['name'] = $name;
            }
        }

        if (array_key_exists('gender', $body) && $body['gender'] !== null) {
            $gender = self::asString($body['gender']);
            if ($gender !== '男' && $gender !== '女') {
                $errors[] = '性別格式錯誤';
            } else {
                $cleaned['gender'] = $gender;
            }
        }

        if (array_key_exists('tenure_years', $body) && $body['tenure_years'] !== null) {
            $t = is_numeric($body['tenure_years']) ? (float) $body['tenure_years'] : NAN;
            if (!is_finite($t) || $t < 0 || $t > 60) {
                $errors[] = '年資需為 0–60 之間的整數';
            } else {
                $cleaned['tenure_years'] = (int) floor($t);
            }
        }

        if (array_key_exists('is_pregnant_or_nursing', $body)) {
            $cleaned['is_pregnant_or_nursing'] = (bool) $body['is_pregnant_or_nursing'];
        }

        if (array_key_exists('can_night_shift', $body)) {
            $cleaned['can_night_shift'] = $body['can_night_shift'] !== false;
        }

        if (array_key_exists('avatar', $body)) {
            $r = $this->validateAvatarField($body['avatar'], self::AVATAR_MAX_BYTES);
            if (!$r['ok']) {
                $errors[] = '頭貼' . $r['err'];
            } else {
                $cleaned['avatar'] = $r['cleaned'];
            }
        }
        if (array_key_exists('avatar_thumb', $body)) {
            $r = $this->validateAvatarField($body['avatar_thumb'], self::THUMB_MAX_BYTES);
            if (!$r['ok']) {
                $errors[] = '頭貼縮圖' . $r['err'];
            } else {
                $cleaned['avatar_thumb'] = $r['cleaned'];
            }
        }

        return ['ok' => count($errors) === 0, 'errors' => $errors, 'cleaned' => $cleaned];
    }

    /**
     * 頭貼欄位驗證：
     *   null / '' → 視為「移除」（cleaned=''，controller 端再轉成 null 寫進 doc）
     *   data URL  → 驗 MIME + 大小上限後保留
     *
     * @return array{ok:bool,cleaned?:string,err?:string}
     */
    private function validateAvatarField($value, int $maxBytes): array
    {
        if ($value === '' || $value === null) {
            return ['ok' => true, 'cleaned' => ''];
        }
        if (!is_string($value)) {
            return ['ok' => false, 'err' => '格式錯誤'];
        }
        if (!preg_match(self::AVATAR_MIME_REGEX, $value)) {
            return ['ok' => false, 'err' => '格式錯誤（僅接受 PNG / JPEG / WebP data URL）'];
        }
        if (strlen($value) > $maxBytes) {
            return ['ok' => false, 'err' => '檔案過大（限 ' . (int) round($maxBytes / 1024) . ' KB 以內）'];
        }
        return ['ok' => true, 'cleaned' => $value];
    }
}
