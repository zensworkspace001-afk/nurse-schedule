import { test, expect } from '@playwright/test';
import { creds, hasCreds } from './helpers/auth.js';

test.describe('login → sphere-drop transition', () => {
  test.skip(!hasCreds('staff'), 'TEST_STAFF_ID / TEST_STAFF_PW env vars required');

  test('successful staff login plays the sphere-drop and lands on dashboard', async ({ page }) => {
    test.setTimeout(120_000);

    const pageErrors = [];
    page.on('pageerror', (err) => pageErrors.push(err.message));

    await page.goto('/');
    await page.getByPlaceholder(/請輸入工號/).fill(creds.staff.id);
    await page.getByPlaceholder(/請輸入密碼/).fill(creds.staff.pw);
    await page.getByRole('button', { name: /登入系統|驗證中/ }).click();

    // The sphere-drop overlay should mount after Firebase accepts the credentials.
    const overlay = page.getByTestId('sphere-drop-transition');
    await expect(overlay).toBeVisible({ timeout: 20_000 });
    await expect(overlay.locator('canvas')).toBeVisible();

    // Dashboard renders underneath while spheres still fall.
    await expect(page.getByText(/嗨，/)).toBeVisible({ timeout: 30_000 });

    // Overlay cleans itself up once the fall-out completes.
    await expect(overlay).toHaveCount(0, { timeout: 30_000 });

    expect(pageErrors, `page errors: ${pageErrors.join('\n')}`).toEqual([]);
  });

  test('wrong password does not trigger the transition', async ({ page }) => {
    await page.goto('/');
    await page.getByPlaceholder(/請輸入工號/).fill(creds.staff.id);
    await page.getByPlaceholder(/請輸入密碼/).fill('definitely-wrong-pw');
    await page.getByRole('button', { name: /登入系統|驗證中/ }).click();

    await expect(page.getByText(/帳號或密碼錯誤|登入失敗/)).toBeVisible({ timeout: 20_000 });
    // Overlay must never have appeared.
    await expect(page.getByTestId('sphere-drop-transition')).toHaveCount(0);
  });
});
