<?php

namespace App\Http\Controllers;

use App\Services\AccessLog;
use App\Support\Csrf;
use App\Support\Firebase;
use App\Support\RateLimit;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;

/**
 * 登入稽核 — 對應 api/log-login.js
 *
 * POST /api/log-login
 *   { success: true }                                ← 必須 Bearer Firebase token
 *   { success: false, attempted_email, error_code }  ← 無 auth；以 IP / email rate-limit
 */
class LogLoginController extends Controller
{
    public function handle(Request $request): JsonResponse
    {
        if ($request->boolean('healthCheck')) {
            return response()->json(['ok' => true, 'service' => 'log-login']);
        }

        if (!Csrf::check($request)) {
            return response()->json(['error' => '禁止：非法來源'], 403);
        }

        $meta = AccessLog::extractClientMeta($request);
        $success = $request->input('success');

        if ($success === true) {
            // —— 成功登入：必須帶 token ——
            $authHeader = (string) $request->header('authorization');
            if (!str_starts_with($authHeader, 'Bearer ')) {
                return response()->json(['error' => '未經授權：缺少登入憑證'], 401);
            }
            try {
                $verified = Firebase::auth()->verifyIdToken(substr($authHeader, 7));
                $actor = [
                    'uid'   => $verified->claims()->get('sub'),
                    'email' => $verified->claims()->get('email'),
                ];
            } catch (\Throwable $e) {
                return response()->json(['error' => '未經授權：登入憑證無效或已過期'], 401);
            }

            if (!RateLimit::check("log-login:{$actor['uid']}", 10)) {
                return response()->json(['error' => '請求過於頻繁'], 429);
            }

            AccessLog::write([
                'actor'  => $actor,
                'action' => 'login',
                'target' => ['kind' => 'auth', 'id' => $actor['uid']],
                'fields' => [],
                'ip'     => $meta['ip'],
                'ua'     => $meta['ua'],
                'extra'  => null,
            ]);
            return response()->json(['ok' => true]);
        }

        // —— 登入失敗：無 auth；雙軌 rate-limit ——
        $ipKey = $meta['ip'] ?: 'unknown';
        if (!RateLimit::check("log-login-fail-ip:{$ipKey}", 10)) {
            return response()->json(['error' => '請求過於頻繁'], 429);
        }

        $attemptedEmail = $request->input('attempted_email');
        $errorCode = $request->input('error_code');
        $safeEmail = is_string($attemptedEmail) ? mb_substr($attemptedEmail, 0, 200) : null;
        $safeCode = is_string($errorCode) ? mb_substr($errorCode, 0, 100) : null;

        if ($safeEmail) {
            // 不告訴呼叫者具體原因 — 避免攻擊者推測哪個 email 存在
            if (!RateLimit::check('log-login-fail-email:' . strtolower($safeEmail), 5)) {
                return response()->json(['error' => '請求過於頻繁'], 429);
            }
        }

        AccessLog::write([
            'actor'  => ['uid' => null, 'email' => null],
            'action' => 'login-failure',
            'target' => ['kind' => 'auth', 'id' => null],
            'fields' => [],
            'ip'     => $meta['ip'],
            'ua'     => $meta['ua'],
            'extra'  => ['attempted_email' => $safeEmail, 'error_code' => $safeCode],
        ]);
        return response()->json(['ok' => true]);
    }
}
