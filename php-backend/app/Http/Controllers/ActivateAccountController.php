<?php

namespace App\Http\Controllers;

use App\Services\ActivationToken;
use App\Support\Csrf;
use App\Support\Firebase;
use App\Support\RateLimit;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Kreait\Firebase\Exception\Auth\UserNotFound;

/**
 * 帳號啟用 / 密碼重設 — 對應 api/activate-account.js
 *
 * 公開端點（無需 Firebase 登入），由「token 本身」擔任授權。
 * POST /api/activate-account  { token, newPassword }
 * 防濫用：CSRF + IP rate limit (5/min/IP)。
 */
class ActivateAccountController extends Controller
{
    public function handle(Request $request): JsonResponse
    {
        if ($request->boolean('healthCheck')) {
            try {
                // 強制觸發一次 API 請求（kreait listUsers 為 lazy generator）
                foreach (Firebase::auth()->listUsers(1) as $_) {
                    break;
                }
                return response()->json(['ok' => true, 'service' => 'activate-account']);
            } catch (\Throwable $err) {
                return response()->json(['ok' => false, 'service' => 'activate-account', 'error' => $err->getMessage()], 503);
            }
        }

        if (!Csrf::check($request)) {
            return response()->json(['error' => '禁止：非法來源'], 403);
        }

        $ip = $this->clientIp($request);
        if (!RateLimit::check("activate:{$ip}", 5)) {
            return response()->json(['error' => '請求過於頻繁，請稍候再試'], 429);
        }

        $token = $request->input('token');
        $newPassword = $request->input('newPassword');

        // 1. 密碼強度先檢（避免無效請求也消耗一次 token 查詢）
        $pwCheck = ActivationToken::validatePasswordStrength($newPassword);
        if (!$pwCheck['ok']) {
            return response()->json(['error' => $pwCheck['reason']], 400);
        }

        // 2. 驗 token
        try {
            $tokenData = ActivationToken::verifyToken($token);
        } catch (\Throwable $err) {
            return response()->json(['error' => $err->getMessage()], 400);
        }

        // 3. 套用變更
        try {
            $updates = ['password' => $newPassword];
            if (($tokenData['purpose'] ?? null) === 'activation') {
                $updates['disabled'] = false;
            }
            Firebase::auth()->updateUser($tokenData['uid'], $updates);
            // 撤銷既有 refresh token — 舊 session 全部作廢
            Firebase::auth()->revokeRefreshTokens($tokenData['uid']);
        } catch (UserNotFound $err) {
            // token 對應的帳號被刪了 → 把孤兒 token 一併清掉
            ActivationToken::consumeToken($tokenData['tokenHash']);
            return response()->json(['error' => '帳號不存在，請聯絡管理員'], 400);
        } catch (\Throwable $err) {
            logger()->error('啟用 / 重設失敗: ' . $err->getMessage());
            return response()->json(['error' => '伺服器處理失敗，請稍後再試'], 500);
        }

        // 4. 一次性消化
        ActivationToken::consumeToken($tokenData['tokenHash']);

        return response()->json([
            'ok'      => true,
            'purpose' => $tokenData['purpose'],
            'message' => ($tokenData['purpose'] === 'activation') ? '帳號啟用成功' : '密碼已重設',
        ]);
    }

    private function clientIp(Request $request): string
    {
        $xff = $request->header('x-forwarded-for');
        if (is_string($xff) && $xff !== '') {
            return trim(explode(',', $xff)[0]);
        }
        return $request->header('x-real-ip') ?: ($request->ip() ?: 'unknown');
    }
}
