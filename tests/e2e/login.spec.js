import { test, expect } from '@playwright/test';
import { creds, hasCreds } from './helpers/auth.js';

// Credentials come from env so real Firebase accounts never live in the repo.
// Set before running: TEST_STAFF_ID=n001 TEST_STAFF_PW=... npx playwright test
test.describe('login smoke', () => {
  test.skip(!hasCreds('staff'), 'TEST_STAFF_ID / TEST_STAFF_PW env vars required');

  test('staff can log in and land on the dashboard', async ({ page }) => {
    await page.goto('/');

    const idInput = page.getByPlaceholder(/請輸入工號/);
    const pwInput = page.getByPlaceholder(/請輸入密碼/);
    await expect(idInput).toBeVisible();

    await idInput.fill(creds.staff.id);
    await pwInput.fill(creds.staff.pw);
    await page.getByRole('button', { name: /登入系統|驗證中/ }).click();

    await expect(page.getByText(/嗨，/)).toBeVisible({ timeout: 20_000 });
    await expect(idInput).toBeHidden();
  });

  test('wrong password shows an error and stays on login', async ({ page }) => {
    await page.goto('/');
    // 用不存在的工號：拿真的測試帳號故意輸錯，失敗次數會累積到 Firebase 暫時鎖住該帳號
    // （auth/too-many-requests），之後所有用它登入的測試都會失敗。登入頁對「帳號不存在」與
    // 「密碼錯誤」顯示同一句訊息（防帳號列舉），所以斷言不變。
    await page.getByPlaceholder(/請輸入工號/).fill('e2e-no-such-user');
    await page.getByPlaceholder(/請輸入密碼/).fill('definitely-wrong-pw');
    await page.getByRole('button', { name: /登入系統|驗證中/ }).click();

    await expect(page.getByText(/帳號或密碼錯誤|登入失敗/)).toBeVisible({
      timeout: 20_000,
    });
    await expect(page.getByPlaceholder(/請輸入工號/)).toBeVisible();
  });
});
