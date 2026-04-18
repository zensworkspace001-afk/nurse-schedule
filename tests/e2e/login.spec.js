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
    await page.getByPlaceholder(/請輸入工號/).fill(creds.staff.id);
    await page.getByPlaceholder(/請輸入密碼/).fill('definitely-wrong-pw');
    await page.getByRole('button', { name: /登入系統|驗證中/ }).click();

    await expect(page.getByText(/帳號或密碼錯誤|登入失敗/)).toBeVisible({
      timeout: 20_000,
    });
    await expect(page.getByPlaceholder(/請輸入工號/)).toBeVisible();
  });
});
