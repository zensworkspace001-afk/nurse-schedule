<?php

namespace App\Support;

use Illuminate\Http\Request;

/**
 * CSRF / 來源驗證 — 對應 api/_lib/csrf.js
 *
 * Bearer token 不會被瀏覽器自動附帶（不像 cookie），CSRF 風險本就較低；
 * 這裡加上 Origin 檢查作為縱深防禦。沒帶 Origin 時，必須是帶 CRON_SECRET 的
 * server-to-server 呼叫才放行（避免任何 curl/Postman 直接繞過）。
 */
class Csrf
{
    private const ALLOWED_ORIGINS = [
        'https://nurse-schedule-bachelor.vercel.app',
        'http://localhost:5173',
        'http://localhost:3000',
    ];

    // Vercel preview deployment：用 regex 而非寫死，避免每開 PR 都要改這支
    private const PREVIEW_ORIGIN_PATTERN =
        '/^https:\/\/nurse-schedule-bachelor(?:-[a-z0-9-]+)?\.vercel\.app$/';

    public static function check(Request $request): bool
    {
        $origin = $request->header('origin') ?: $request->header('referer');

        if ($origin) {
            $normalized = rtrim($origin, '/');
            // 嚴格白名單先比，preview pattern 後比
            if (in_array($normalized, self::ALLOWED_ORIGINS, true)) {
                return true;
            }
            return (bool) preg_match(self::PREVIEW_ORIGIN_PATTERN, $normalized);
        }

        // 沒 Origin → 必須是 cron / server-to-server 呼叫
        return $request->header('authorization') === 'Bearer ' . env('CRON_SECRET');
    }
}
