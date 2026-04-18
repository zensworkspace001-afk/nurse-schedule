import { test, expect } from '@playwright/test';
import { login, hasCreds } from './helpers/auth.js';

test.describe('staff dashboard', () => {
  test.skip(!hasCreds('staff'), 'TEST_STAFF_ID / TEST_STAFF_PW env vars required');

  test('dashboard greeting and password-change modal render', async ({ page }) => {
    await login(page, 'staff');

    // Greeting "嗨，{name}" renders regardless of whether the staff has claimed.
    await expect(page.getByText(/嗨，/)).toBeVisible({ timeout: 20_000 });

    // 修改密碼 button opens the password modal.
    await page.getByRole('button', { name: /修改密碼/ }).click();
    await expect(page.getByRole('heading', { name: /修改密碼/ })).toBeVisible();
    await expect(page.getByText(/舊密碼/)).toBeVisible();
    await expect(page.getByRole('button', { name: /儲存修改|驗證中/ })).toBeVisible();
  });
});
