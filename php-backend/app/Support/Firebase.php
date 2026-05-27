<?php

namespace App\Support;

use Kreait\Firebase\Contract\Auth;
use Kreait\Firebase\Factory;

/**
 * Firebase Admin SDK 入口 — 對應各 api/*.js 開頭的 admin.initializeApp(...)
 *
 * 用 kreait/firebase-php。Factory 快取為靜態單例（等同 Node 的 admin.apps.length 防重複初始化）。
 * 私鑰處理與 Node 一致：去掉前後雙引號、把字面 \n 還原成換行。
 */
class Firebase
{
    private static ?Factory $factory = null;

    public static function factory(): Factory
    {
        if (self::$factory !== null) {
            return self::$factory;
        }

        $pk = env('FIREBASE_PRIVATE_KEY');
        if ($pk) {
            $pk = preg_replace('/^"|"$/', '', $pk);
            $pk = str_replace('\\n', "\n", $pk);
        }

        return self::$factory = (new Factory())->withServiceAccount([
            'type'         => 'service_account',
            'project_id'   => env('FIREBASE_PROJECT_ID'),
            'client_email' => env('FIREBASE_CLIENT_EMAIL'),
            'private_key'  => $pk,
        ]);
    }

    public static function auth(): Auth
    {
        return self::factory()->createAuth();
    }

    /** @return \Google\Cloud\Firestore\FirestoreClient */
    public static function firestore()
    {
        return self::factory()->createFirestore()->database();
    }
}
