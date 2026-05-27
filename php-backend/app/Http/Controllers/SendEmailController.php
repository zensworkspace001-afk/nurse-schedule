<?php

namespace App\Http\Controllers;

use App\Services\Sanitizer;
use App\Support\Csrf;
use App\Support\Firebase;
use App\Support\RateLimit;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;

/**
 * 寄信端點 — 對應 api/sendEmail.js
 *
 * POST /api/sendEmail
 *   { healthCheck: true }                 → 測 Resend 連線
 *   { to, subject, html }                 → 需 Bearer（Firebase token 或 CRON_SECRET）
 */
class SendEmailController extends Controller
{
    public function handle(Request $request): JsonResponse
    {
        // ★ 健康檢查：實際測試 Resend API 連線（在 CSRF / auth 之前）
        if ($request->boolean('healthCheck')) {
            try {
                \Resend::client(env('RESEND_API_KEY'))->apiKeys->list();
                return response()->json(['ok' => true, 'service' => 'sendEmail']);
            } catch (\Throwable $err) {
                return response()->json(['ok' => false, 'service' => 'sendEmail', 'error' => $err->getMessage()], 503);
            }
        }

        // ★ CSRF 防護
        if (!Csrf::check($request)) {
            return response()->json(['error' => '禁止：非法來源'], 403);
        }

        // ★★★ 雙軌驗證：Firebase Token 或 CRON_SECRET ★★★
        $authHeader = (string) $request->header('authorization');
        if (!str_starts_with($authHeader, 'Bearer ')) {
            return response()->json(['error' => '未經授權：缺少登入憑證'], 401);
        }
        $token = substr($authHeader, 7);
        $isCron = $token === env('CRON_SECRET');
        $uid = 'cron';
        if (!$isCron) {
            try {
                $verified = Firebase::auth()->verifyIdToken($token);
                $uid = $verified->claims()->get('sub');
            } catch (\Throwable $e) {
                logger()->warning('⚠️ 攔截到未經授權的寄信請求');
                return response()->json(['error' => '未經授權：登入憑證無效或已過期'], 401);
            }
        }

        // ★ Rate Limiting：每人每分鐘最多 5 封信
        if (!RateLimit::check("email:{$uid}", 5)) {
            return response()->json(['error' => '請求過於頻繁，請稍後再試'], 429);
        }

        $to = $request->input('to');
        $subject = $request->input('subject');
        // ★ HTML 清理
        $safeHtml = Sanitizer::sanitizeHtml($request->input('html'));

        $fromAddress = env('RESEND_FROM_EMAIL') ?: '護理排班系統 <onboarding@resend.dev>';

        try {
            $data = \Resend::client(env('RESEND_API_KEY'))->emails->send([
                'from'    => $fromAddress,
                'to'      => [$to],
                'subject' => $subject,
                'html'    => $safeHtml,
            ]);
            return response()->json(['success' => true, 'data' => $data]);
        } catch (\Throwable $error) {
            logger()->error('寄信發生錯誤: ' . $error->getMessage());
            return response()->json(['success' => false, 'error' => '寄信失敗'], 500);
        }
    }
}
