<?php

namespace App\Services;

use App\Support\Firebase;
use Google\Cloud\Core\Timestamp;

/**
 * 一次性帳號啟用 / 密碼重設 Token — 對應 api/_lib/activationToken.js
 *
 * 明文 token 只在 URL 連結流通；Firestore 端只存 sha256 雜湊。一次性、預設 2h 逾期。
 * Doc：pending_activation/{tokenHash} = { uid, email, purpose, createdAt, expiresAt }
 */
class ActivationToken
{
    private static function ttlSeconds(): int
    {
        $hours = (int) (env('ACTIVATION_TOKEN_TTL_HOURS') ?: 2);
        if ($hours <= 0) {
            $hours = 2;
        }
        return $hours * 60 * 60;
    }

    public static function generatePlainToken(): string
    {
        return bin2hex(random_bytes(32)); // 64 chars
    }

    public static function hashToken(string $plain): string
    {
        return hash('sha256', $plain);
    }

    /** 建立 token 並寫入 Firestore；回傳明文 token（呼叫端用來組信件連結） */
    public static function issueToken(string $uid, string $email, string $purpose): string
    {
        if (!$uid || !$email) {
            throw new \InvalidArgumentException('issueToken 需要 uid 與 email');
        }
        if ($purpose !== 'activation' && $purpose !== 'reset') {
            throw new \InvalidArgumentException("unknown token purpose: {$purpose}");
        }
        $plain = self::generatePlainToken();
        $hash = self::hashToken($plain);
        $now = new \DateTimeImmutable();
        $expires = $now->modify('+' . self::ttlSeconds() . ' seconds');

        Firebase::firestore()
            ->collection('pending_activation')
            ->document($hash)
            ->set([
                'uid'       => $uid,
                'email'     => $email,
                'purpose'   => $purpose,
                'createdAt' => new Timestamp($now),
                'expiresAt' => new Timestamp($expires),
            ]);

        return $plain;
    }

    /** 同一 uid 的舊 token 全部清掉 */
    public static function revokeTokensForUid(string $uid): void
    {
        if (!$uid) {
            return;
        }
        $docs = Firebase::firestore()
            ->collection('pending_activation')
            ->where('uid', '=', $uid)
            ->documents();
        foreach ($docs as $doc) {
            if ($doc->exists()) {
                $doc->reference()->delete();
            }
        }
    }

    /**
     * 驗證明文 token：通過回傳 doc data（含 tokenHash）；不通過 throw 並附原因。
     * @return array
     */
    public static function verifyToken(?string $plainToken, ?string $expectedPurpose = null): array
    {
        if (!is_string($plainToken) || $plainToken === '') {
            throw new \RuntimeException('啟用連結無效');
        }
        $hash = self::hashToken($plainToken);
        $ref = Firebase::firestore()->collection('pending_activation')->document($hash);
        $snap = $ref->snapshot();
        if (!$snap->exists()) {
            throw new \RuntimeException('啟用連結無效或已被使用');
        }
        $data = $snap->data();
        if ($expectedPurpose && ($data['purpose'] ?? null) !== $expectedPurpose) {
            throw new \RuntimeException('啟用連結用途不符');
        }
        $expiresAt = $data['expiresAt'] ?? null;
        $expiresMs = $expiresAt instanceof Timestamp
            ? $expiresAt->get()->getTimestamp() * 1000
            : 0;
        if (time() * 1000 > $expiresMs) {
            try {
                $ref->delete();
            } catch (\Throwable $e) {
                // ignore
            }
            throw new \RuntimeException('啟用連結已逾期，請聯絡管理員重新發送');
        }
        return array_merge($data, ['tokenHash' => $hash]);
    }

    /** 消費（成功完成動作後刪除 doc，達成一次性效果） */
    public static function consumeToken(string $tokenHash): void
    {
        try {
            Firebase::firestore()
                ->collection('pending_activation')
                ->document($tokenHash)
                ->delete();
        } catch (\Throwable $e) {
            // ignore
        }
    }

    /** 密碼強度檢查（與前端 / Node 版規則一致：>=6 碼，需含英文與數字） */
    public static function validatePasswordStrength($pw): array
    {
        if (!is_string($pw)) {
            return ['ok' => false, 'reason' => '密碼格式錯誤'];
        }
        if ($pw === '123456') {
            return ['ok' => false, 'reason' => '密碼不可使用預設值'];
        }
        if (strlen($pw) < 6) {
            return ['ok' => false, 'reason' => '密碼至少 6 碼'];
        }
        if (!preg_match('/^(?=.*[A-Za-z])(?=.*\d)[A-Za-z\d!@#$%^&*()_+\-=]{6,}$/', $pw)) {
            return ['ok' => false, 'reason' => '密碼必須同時包含英文與數字'];
        }
        return ['ok' => true];
    }
}
