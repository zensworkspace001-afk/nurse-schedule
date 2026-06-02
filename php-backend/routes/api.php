<?php

use App\Http\Controllers\ActivateAccountController;
use App\Http\Controllers\AutoSettleController;
use App\Http\Controllers\ClaimScheduleController;
use App\Http\Controllers\CompleteProfileController;
use App\Http\Controllers\CronCheckTimeoutController;
use App\Http\Controllers\LogLoginController;
use App\Http\Controllers\SecureFieldController;
use App\Http\Controllers\SendEmailController;
use Illuminate\Support\Facades\Route;

/*
 * 綠色批次（已移植）。Laravel 會自動把 routes/api.php 前綴成 /api，
 * 所以路徑與 Vercel 端 /api/sendEmail 等一致。
 *
 * 注意：CSRF / auth / rate-limit 全部在 controller 內處理（與 Node 版 1:1），
 * 而非 route middleware —— 因為 healthCheck 必須在這些檢查之前放行。
 */
Route::post('/sendEmail', [SendEmailController::class, 'handle']);
Route::post('/activate-account', [ActivateAccountController::class, 'handle']);
Route::post('/log-login', [LogLoginController::class, 'handle']);

// 中批次（員工個資 + PII 加密）
Route::post('/complete-profile', [CompleteProfileController::class, 'handle']);

// 加解密 / 稽核閘道（<EncryptedField> 元件呼叫）
Route::post('/secure-field', [SecureFieldController::class, 'handle']);

// 班次認領（Firestore 交易 — 員工從虛擬空缺認領自己的整月 pattern）
Route::post('/claim-schedule', [ClaimScheduleController::class, 'handle']);

// 月底自動結算（cron 觸發 / admin 手動 force）
Route::post('/auto-settle', [AutoSettleController::class, 'handle']);

// 巡邏機器人（cron 每日觸發 — agentic turn 24h 逾時跳過 + 個資保留期掃除）
Route::post('/cron/check-timeout', [CronCheckTimeoutController::class, 'handle']);
