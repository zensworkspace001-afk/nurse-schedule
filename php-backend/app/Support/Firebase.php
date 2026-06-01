<?php

namespace App\Support;

use Google\Cloud\Firestore\FirestoreClient;
use Kreait\Firebase\Contract\Auth;
use Kreait\Firebase\Factory;

/**
 * Firebase Admin SDK 入口 — 對應各 api/*.js 開頭的 admin.initializeApp(...)
 *
 * Auth 走 kreait（HTTP）；Firestore 直接 new FirestoreClient（kreait 8.x 的
 * createFirestore() 不會把 service account 傳給底層 FirestoreClient，後者就
 * fallback 到 ADC 失敗）。兩者共用同一份 service account 設定。
 *
 * 私鑰處理與 Node 一致：去掉前後雙引號、把字面 \n 還原成換行。
 */
class Firebase
{
    private static ?Factory $factory = null;
    private static ?FirestoreClient $firestore = null;

    private static function serviceAccount(): array
    {
        $pk = env('FIREBASE_PRIVATE_KEY');
        if ($pk) {
            $pk = preg_replace('/^"|"$/', '', $pk);
            $pk = str_replace('\\n', "\n", $pk);
        }
        return [
            'type'         => 'service_account',
            'project_id'   => env('FIREBASE_PROJECT_ID'),
            'client_email' => env('FIREBASE_CLIENT_EMAIL'),
            'private_key'  => $pk,
        ];
    }

    public static function factory(): Factory
    {
        if (self::$factory !== null) {
            return self::$factory;
        }
        return self::$factory = (new Factory())->withServiceAccount(self::serviceAccount());
    }

    public static function auth(): Auth
    {
        return self::factory()->createAuth();
    }

    /**
     * 繞過 kreait wrapper 直接構造 FirestoreClient，並把 keyFile 明確帶進去，
     * 否則底層會去找 GOOGLE_APPLICATION_CREDENTIALS / gcloud ADC 然後爆掉。
     */
    public static function firestore(): FirestoreClient
    {
        if (self::$firestore !== null) {
            return self::$firestore;
        }
        $sa = self::serviceAccount();
        // google-cloud-firestore v2 用 'credentials'（v1 的 'keyFile' 已不支援）
        // transport：Windows ZTS PHP 的 grpc DLL 不穩（會 ACCESS_VIOLATION），
        // 預設走 REST；Linux 生產環境可設 FIRESTORE_TRANSPORT=grpc 換更快的 HTTP/2+protobuf
        return self::$firestore = new FirestoreClient([
            'projectId'   => $sa['project_id'],
            'credentials' => $sa,
            'transport'   => env('FIRESTORE_TRANSPORT', 'rest'),
        ]);
    }
}
