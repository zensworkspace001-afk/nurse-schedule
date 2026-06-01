<?php

namespace App\Http\Controllers;

use App\Services\AccessLog;
use App\Services\FieldCrypto;
use App\Support\Csrf;
use App\Support\Firebase;
use App\Support\RateLimit;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;

/**
 * 統一加密 / 解密 / 稽核閘道 — 對應 api/secure-field.js
 *
 * 6 個 action：
 *   encrypt       — admin only。加密 payload，回傳 {ct,iv,tag,v} blob。
 *   decrypt       — admin OR 員工本人。解密單一密文，回傳 {value}。
 *   batchDecrypt  — admin OR 員工本人。陣列 payload，逐筆回 {idx, value|error}。
 *   logAiAccess   — admin only。前端把敏感資料送 Gemini 前留痕（action=ai-access）。
 *   logRelock     — admin OR 員工本人。前端清明文時留痕（action=relock）。
 *   logAdminRead  — admin only。admin 訂閱 Staff 全集合留痕（action=admin-read）。
 *
 * 安全層：CSRF (Origin) + Bearer token + Rate limit (60/min/uid) + 成功時 Audit log。
 *
 * 注意：actor.uid 用 Firebase decoded uid（sync-accounts 把 uid 綁成 staff_id），
 * 而非 complete-profile 那邊「從 email 反推」 — 此處沿用 Node 版邏輯，與
 * canStaffAccessTarget(target.id ≡ uid) 的判斷對齊。
 */
class SecureFieldController extends Controller
{
    private const ADMIN_EMAIL = 'admin@hospital.com';

    public function handle(Request $request): JsonResponse
    {
        // healthCheck：實際做一次 encrypt + decrypt round-trip，
        // 證金鑰存在且可用 —— 在 CSRF / auth 之前放行
        if ($request->boolean('healthCheck')) {
            try {
                $probe = FieldCrypto::encrypt('healthcheck');
                $back  = FieldCrypto::decrypt($probe);
                $ok    = ($back === 'healthcheck');
                return response()->json(['ok' => $ok, 'service' => 'secure-field'], $ok ? 200 : 503);
            } catch (\Throwable $err) {
                return response()->json([
                    'ok' => false, 'service' => 'secure-field', 'error' => $err->getMessage(),
                ], 503);
            }
        }

        if (!Csrf::check($request)) {
            return response()->json(['error' => '禁止：非法來源'], 403);
        }

        // Bearer token
        $authHeader = (string) $request->header('authorization');
        if (!str_starts_with($authHeader, 'Bearer ')) {
            return response()->json(['error' => '未經授權：缺少登入憑證'], 401);
        }
        try {
            $verified = Firebase::auth()->verifyIdToken(substr($authHeader, 7));
            $actor = [
                'uid'   => (string) $verified->claims()->get('sub'),
                'email' => (string) ($verified->claims()->get('email') ?? ''),
            ];
        } catch (\Throwable $e) {
            return response()->json(['error' => '未經授權：登入憑證無效或已過期'], 401);
        }

        // Rate limit：60/min（解密熱點，admin 批量解時要夠用）
        if (!RateLimit::check($actor['uid'], 60)) {
            return response()->json(['error' => '請求過於頻繁，請稍候再試'], 429);
        }

        $body    = $request->all();
        $action  = $body['action'] ?? null;
        $payload = $body['payload'] ?? null;
        // target / fields 缺省值與 Node 版一致：{kind:null,id:null} 與 []
        $target  = is_array($body['target'] ?? null) ? $body['target'] : ['kind' => null, 'id' => null];
        $fields  = is_array($body['fields'] ?? null) ? $body['fields'] : [];
        $extra   = $body['extra'] ?? null;
        $isAdmin = ($actor['email'] === self::ADMIN_EMAIL);
        $meta    = AccessLog::extractClientMeta($request);

        try {
            switch ($action) {
                case 'encrypt':
                    if (!$isAdmin) {
                        return response()->json(['error' => '權限不足：只有管理員能執行加密'], 403);
                    }
                    $blob = FieldCrypto::encrypt($payload);
                    AccessLog::write([
                        'actor'  => $actor, 'action' => 'encrypt',
                        'target' => $target, 'fields' => $fields,
                        'ip'     => $meta['ip'], 'ua' => $meta['ua'], 'extra' => null,
                    ]);
                    return response()->json(['blob' => $blob]);

                case 'decrypt':
                    if (!FieldCrypto::isEncrypted($payload)) {
                        return response()->json(['error' => '無效的密文格式'], 400);
                    }
                    if (!$isAdmin && !$this->canStaffAccessTarget($actor, $target)) {
                        return response()->json(['error' => '權限不足：無法解密此目標'], 403);
                    }
                    $value = FieldCrypto::decrypt($payload);
                    AccessLog::write([
                        'actor'  => $actor, 'action' => 'decrypt',
                        'target' => $target, 'fields' => $fields,
                        'ip'     => $meta['ip'], 'ua' => $meta['ua'], 'extra' => null,
                    ]);
                    return response()->json(['value' => $value]);

                case 'batchDecrypt':
                    if (!is_array($payload)) {
                        return response()->json(['error' => '批次解密需要陣列 payload'], 400);
                    }
                    if (!$isAdmin && !$this->canStaffAccessTarget($actor, $target)) {
                        return response()->json(['error' => '權限不足：無法批次解密此目標'], 403);
                    }
                    $values = [];
                    // array_values 確保 idx 從 0 連續（即便客戶端送 assoc array）
                    foreach (array_values($payload) as $idx => $blob) {
                        if (!FieldCrypto::isEncrypted($blob)) {
                            $values[] = ['idx' => $idx, 'error' => '非密文格式'];
                            continue;
                        }
                        try {
                            $values[] = ['idx' => $idx, 'value' => FieldCrypto::decrypt($blob)];
                        } catch (\Throwable $e) {
                            $values[] = ['idx' => $idx, 'error' => $e->getMessage()];
                        }
                    }
                    AccessLog::write([
                        'actor'  => $actor, 'action' => 'decrypt',
                        'target' => $target, 'fields' => $fields,
                        'ip'     => $meta['ip'], 'ua' => $meta['ua'],
                        'extra'  => ['batchSize' => count($payload)],
                    ]);
                    return response()->json(['values' => $values]);

                case 'logAiAccess':
                    if (!$isAdmin) {
                        return response()->json(['error' => '權限不足'], 403);
                    }
                    AccessLog::write([
                        'actor'  => $actor, 'action' => 'ai-access',
                        'target' => $target, 'fields' => $fields,
                        'ip'     => $meta['ip'], 'ua' => $meta['ua'],
                        'extra'  => $extra,
                    ]);
                    return response()->json(['ok' => true]);

                case 'logRelock':
                    // 不執行任何加解密 —— 純稽核軌跡（誰、何時、用什麼方式上鎖）
                    if (!$isAdmin && !$this->canStaffAccessTarget($actor, $target)) {
                        return response()->json(['error' => '權限不足'], 403);
                    }
                    AccessLog::write([
                        'actor'  => $actor, 'action' => 'relock',
                        'target' => $target, 'fields' => $fields,
                        'ip'     => $meta['ip'], 'ua' => $meta['ua'],
                        'extra'  => $extra,
                    ]);
                    return response()->json(['ok' => true]);

                case 'logAdminRead':
                    // §6 特種個資的存取應可追溯（個資法 §27 安全維護義務）
                    if (!$isAdmin) {
                        return response()->json(['error' => '權限不足'], 403);
                    }
                    // target 未提供時，與 Node 版同樣 fallback 成 staff-collection
                    if (($target['kind'] ?? null) === null && ($target['id'] ?? null) === null) {
                        $target = ['kind' => 'staff-collection', 'id' => null];
                    }
                    AccessLog::write([
                        'actor'  => $actor, 'action' => 'admin-read',
                        'target' => $target, 'fields' => $fields,
                        'ip'     => $meta['ip'], 'ua' => $meta['ua'],
                        'extra'  => $extra,
                    ]);
                    return response()->json(['ok' => true]);

                default:
                    return response()->json([
                        'error' => '未知的 action：' . (is_scalar($action) ? (string) $action : ''),
                    ], 400);
            }
        } catch (\Throwable $err) {
            logger()->error('secure-field 失敗: ' . $err->getMessage());
            return response()->json(['error' => $err->getMessage() ?: '伺服器錯誤'], 500);
        }
    }

    /**
     * 員工 staff 自己解自己。
     *   target.kind === 'staff' && target.id (case-insensitive) === actor.uid
     * sync-accounts.js 已把 Firebase uid 綁成 staff_id（如 'N001'），所以 uid 直接拿來比。
     */
    private function canStaffAccessTarget(array $actor, array $target): bool
    {
        if (($target['kind'] ?? null) !== 'staff') {
            return false;
        }
        $tid = $target['id'] ?? null;
        if (!is_string($tid) || $tid === '') {
            return false;
        }
        return strtolower($tid) === strtolower($actor['uid']);
    }
}
