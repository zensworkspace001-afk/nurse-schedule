<?php

namespace App\Services;

use App\Support\Firebase;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\DB;

/**
 * 敏感欄位存取稽核日誌 — 對應 api/_lib/accessLog.js
 *
 * 混合儲存：ACCESS_LOG_BACKEND = firestore（預設）| mysql | both（雙寫過渡期）。
 * 原則不變：fire-and-forget（寫入失敗不可阻擋業務）、不記明文、含 IP/UA。
 *
 * 註：readAccessLogs 屬於 admin-user.js（非綠色批次），等移植該端點時再補。
 */
class AccessLog
{
    private static function backend(): string
    {
        return strtolower(env('ACCESS_LOG_BACKEND', 'firestore'));
    }

    private static function useMysql(): bool
    {
        $b = self::backend();
        return $b === 'mysql' || $b === 'both';
    }

    private static function useFirestore(): bool
    {
        $b = self::backend();
        return $b === 'firestore' || $b === 'both';
    }

    /** @param array{actor?:array,action?:string,target?:array,fields?:array,ip?:?string,ua?:?string,extra?:mixed} $entry */
    public static function write(array $entry): void
    {
        if (self::useFirestore()) {
            self::writeFirestore($entry);
        }
        if (self::useMysql()) {
            self::writeMysql($entry);
        }
    }

    private static function writeFirestore(array $e): void
    {
        try {
            Firebase::firestore()->collection('access_logs')->add([
                'ts'     => (new \DateTimeImmutable())->format(\DateTimeInterface::ATOM),
                'actor'  => $e['actor'] ?? ['uid' => null, 'email' => null],
                'action' => $e['action'] ?? 'unknown',
                'target' => $e['target'] ?? ['kind' => null, 'id' => null],
                'fields' => is_array($e['fields'] ?? null) ? $e['fields'] : [],
                'ip'     => $e['ip'] ?? null,
                'ua'     => $e['ua'] ?? null,
                'extra'  => $e['extra'] ?? null,
            ]);
        } catch (\Throwable $err) {
            logger()->warning('⚠️ access log (firestore) 寫入失敗（不阻擋業務）: ' . $err->getMessage());
        }
    }

    private static function writeMysql(array $e): void
    {
        try {
            DB::table('access_logs')->insert([
                'ts'          => now(),
                'actor_uid'   => $e['actor']['uid'] ?? null,
                'actor_email' => $e['actor']['email'] ?? null,
                'action'      => $e['action'] ?? 'unknown',
                'target_kind' => $e['target']['kind'] ?? null,
                'target_id'   => $e['target']['id'] ?? null,
                'fields'      => json_encode(is_array($e['fields'] ?? null) ? $e['fields'] : []),
                'ip'          => $e['ip'] ?? null,
                'ua'          => $e['ua'] ?? null,
                'extra'       => isset($e['extra']) && $e['extra'] !== null ? json_encode($e['extra']) : null,
            ]);
        } catch (\Throwable $err) {
            logger()->warning('⚠️ access log (mysql) 寫入失敗（不阻擋業務）: ' . $err->getMessage());
        }
    }

    /** @return array{ip:?string,ua:?string} */
    public static function extractClientMeta(Request $request): array
    {
        $ua = $request->userAgent();
        $xff = $request->header('x-forwarded-for');
        $ip = null;
        if (is_string($xff) && $xff !== '') {
            $ip = trim(explode(',', $xff)[0]);
        }
        $ip = $ip ?: ($request->header('x-real-ip') ?: $request->ip());
        return ['ip' => $ip, 'ua' => $ua];
    }
}
