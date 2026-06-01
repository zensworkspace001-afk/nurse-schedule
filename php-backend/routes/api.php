<?php

use App\Http\Controllers\ActivateAccountController;
use App\Http\Controllers\CompleteProfileController;
use App\Http\Controllers\LogLoginController;
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
