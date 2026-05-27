<?php

namespace App\Support;

use Illuminate\Support\Facades\RateLimiter;

/**
 * Rate Limiter — 對應 api/_lib/rateLimit.js
 *
 * ⚠️ 重要差異：Node 版用「行程內記憶體 Map」計數。PHP-FPM 每個 request 都是
 *    全新行程，記憶體歸零 → 行程內計數形同虛設。因此這裡改用 Laravel 的
 *    RateLimiter facade，背後接 cache（建議多實例用 redis，單機 file 也可）。
 *    語意維持「每 $decaySeconds 秒最多 $max 次」。
 */
class RateLimit
{
    /** @return bool true=放行 false=超限 */
    public static function check(string $key, int $max, int $decaySeconds = 60): bool
    {
        if (RateLimiter::tooManyAttempts($key, $max)) {
            return false;
        }
        RateLimiter::hit($key, $decaySeconds);
        return true;
    }
}
