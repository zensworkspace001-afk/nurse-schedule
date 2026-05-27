<?php

namespace App\Services;

/**
 * 欄位級加密 — 對應 api/_lib/crypto.js
 *
 * AES-256-GCM，金鑰來自 FIELD_ENC_KEY（base64 後 32 bytes）。
 * Firestore 上的密文格式：{ ct, iv, tag, v }
 *
 * ⚠️ 跨語言相容關鍵：加密前會先把值包成一層 JSON 信封 {t, v}
 *    （與 Node 端 serialize() 完全一致），否則無法解開 Node 寫進去的現有密文。
 *    GCM 本身跨語言相容，「信封格式」才是會弄壞資料的地方。
 */
class FieldCrypto
{
    private const ALGO = 'aes-256-gcm';
    private const IV_LEN = 12;   // GCM 建議 12 bytes
    private const TAG_LEN = 16;
    private const VERSION = 1;

    private static ?string $cachedKey = null;

    private static function key(): string
    {
        if (self::$cachedKey !== null) {
            return self::$cachedKey;
        }
        $raw = env('FIELD_ENC_KEY');
        if (!$raw) {
            throw new \RuntimeException('FIELD_ENC_KEY 環境變數未設定，無法執行欄位加密');
        }
        $buf = base64_decode($raw, true);
        if ($buf === false || strlen($buf) !== 32) {
            $len = $buf === false ? 'invalid base64' : strlen($buf);
            throw new \RuntimeException("FIELD_ENC_KEY 長度錯誤：base64 解碼後必須是 32 bytes，目前 {$len}");
        }
        return self::$cachedKey = $buf;
    }

    /** 把任意值轉成可加密的字串（保留型別資訊以便還原）— 對應 Node serialize() */
    private static function serialize($plaintext): string
    {
        if ($plaintext === null) {
            return json_encode(['t' => 'null']);
        }
        if (is_bool($plaintext)) {
            return json_encode(['t' => 'bool', 'v' => $plaintext]);
        }
        if (is_int($plaintext) || is_float($plaintext)) {
            return json_encode(['t' => 'num', 'v' => $plaintext]);
        }
        if (is_string($plaintext)) {
            return json_encode(['t' => 'str', 'v' => $plaintext], JSON_UNESCAPED_UNICODE);
        }
        return json_encode(['t' => 'json', 'v' => $plaintext], JSON_UNESCAPED_UNICODE);
    }

    /** 對應 Node deserialize() */
    private static function deserialize(string $str)
    {
        $obj = json_decode($str, true);
        if (($obj['t'] ?? null) === 'null') {
            return null;
        }
        return $obj['v'] ?? null;
    }

    /** @return array{ct:string,iv:string,tag:string,v:int} */
    public static function encrypt($plaintext): array
    {
        $key = self::key();
        $iv = random_bytes(self::IV_LEN);
        $tag = '';
        $ct = openssl_encrypt(
            self::serialize($plaintext),
            self::ALGO,
            $key,
            OPENSSL_RAW_DATA,
            $iv,
            $tag,
            '',
            self::TAG_LEN
        );
        if ($ct === false) {
            throw new \RuntimeException('加密失敗');
        }
        return [
            'ct'  => base64_encode($ct),
            'iv'  => base64_encode($iv),
            'tag' => base64_encode($tag),
            'v'   => self::VERSION,
        ];
    }

    public static function decrypt($blob)
    {
        if (!is_array($blob)) {
            throw new \RuntimeException('密文格式無效：需為物件');
        }
        if (($blob['v'] ?? null) !== self::VERSION) {
            throw new \RuntimeException('密文版本不相容：期望 v=' . self::VERSION . '，實際 v=' . ($blob['v'] ?? 'null'));
        }
        $key = self::key();
        $iv  = base64_decode($blob['iv'] ?? '');
        $tag = base64_decode($blob['tag'] ?? '');
        $ct  = base64_decode($blob['ct'] ?? '');
        if (strlen($iv) !== self::IV_LEN) {
            throw new \RuntimeException('IV 長度錯誤');
        }
        if (strlen($tag) !== self::TAG_LEN) {
            throw new \RuntimeException('Auth tag 長度錯誤');
        }
        $pt = openssl_decrypt($ct, self::ALGO, $key, OPENSSL_RAW_DATA, $iv, $tag);
        if ($pt === false) {
            throw new \RuntimeException('解密失敗（金鑰或密文不符）');
        }
        return self::deserialize($pt);
    }

    /** 判斷某欄位是否已加密 */
    public static function isEncrypted($value): bool
    {
        return is_array($value)
            && is_string($value['ct'] ?? null)
            && is_string($value['iv'] ?? null)
            && is_string($value['tag'] ?? null)
            && is_int($value['v'] ?? null);
    }
}
