import { test, expect } from '@playwright/test';
import { login, hasCreds } from './helpers/auth.js';

// Admin creds are separate — usually admin / <admin-pw>.
// Set before running: TEST_ADMIN_ID=admin TEST_ADMIN_PW=... npx playwright test
test.describe('admin smoke', () => {
  test.skip(!hasCreds('admin'), 'TEST_ADMIN_ID / TEST_ADMIN_PW env vars required');

  test('admin sees the manager tab bar after login', async ({ page }) => {
    await login(page, 'admin');

    // ManagerInterface renders six tabs via react-router NavLinks.
    for (const label of ['人力需求', '員工管理', '排班工作桌', '發布與認領', '結算與歷史', '統計報表']) {
      await expect(page.getByRole('link', { name: new RegExp(label) })).toBeVisible();
    }
  });

  test('admin can navigate between tabs', async ({ page }) => {
    await login(page, 'admin');

    await page.getByRole('link', { name: /員工管理/ }).click();
    await expect(page).toHaveURL(/\/staff/);

    await page.getByRole('link', { name: /發布與認領/ }).click();
    await expect(page).toHaveURL(/\/publish/);

    await page.getByRole('link', { name: /統計報表/ }).click();
    await expect(page).toHaveURL(/\/statistics/);
  });
});
