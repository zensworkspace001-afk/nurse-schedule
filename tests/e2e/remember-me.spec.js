import { test, expect } from '@playwright/test';
import { creds, hasCreds } from './helpers/auth.js';

// 驗證「記住我」開關確實切換 Firebase Auth 的 persistence 層：
//   勾選 → browserLocalPersistence  → token 落在 localStorage（關瀏覽器仍登入）
//   不勾 → browserSessionPersistence → token 落在 sessionStorage（關閉即登出）
// （此版 Firebase SDK 的 LOCAL persistence 寫 localStorage，非 IndexedDB——已用 storage dump 確認。）
// 整條鏈路不碰 cookie，所以也順手斷言 document.cookie 沒有 Firebase 痕跡。
test.describe('remember me persistence', () => {
  test.skip(!hasCreds('staff'), 'TEST_STAFF_ID / TEST_STAFF_PW env vars required');

  function localStorageAuthKey(page) {
    return page.evaluate(
      () => Object.keys(localStorage).find((k) => k.startsWith('firebase:authUser')) || null,
    );
  }

  function sessionStorageAuthKey(page) {
    return page.evaluate(
      () => Object.keys(sessionStorage).find((k) => k.startsWith('firebase:authUser')) || null,
    );
  }

  async function doLogin(page, { remember }) {
    await page.goto('/');
    await page.getByPlaceholder(/請輸入工號/).fill(creds.staff.id);
    await page.getByPlaceholder(/請輸入密碼/).fill(creds.staff.pw);

    // 預設已勾選；只有要測「不勾」時才取消
    const remember_cb = page.locator('.login-panel__remember-checkbox');
    await expect(remember_cb).toBeChecked();
    if (!remember) await remember_cb.uncheck();

    await page.getByRole('button', { name: /登入系統|驗證中/ }).click();
    await expect(page.getByPlaceholder(/請輸入工號/)).toBeHidden({ timeout: 20_000 });
    // 給 Firebase 一點時間把 token 寫進儲存層
    await page.waitForTimeout(1500);
  }

  test('勾選 → token 落在 localStorage（持久），不在 sessionStorage', async ({ page }) => {
    await doLogin(page, { remember: true });

    expect(await localStorageAuthKey(page), 'localStorage 應有 firebase:authUser').toBeTruthy();
    expect(await sessionStorageAuthKey(page), 'sessionStorage 不應有 firebase:authUser').toBeNull();

    // 偏好旗標
    expect(await page.evaluate(() => localStorage.getItem('remember_me'))).not.toBe('false');

    // 不碰 cookie
    expect(await page.evaluate(() => document.cookie)).not.toMatch(/firebase|authUser/i);
  });

  test('不勾 → token 落在 sessionStorage（關閉即逝），不在 localStorage', async ({ page }) => {
    await doLogin(page, { remember: false });

    expect(await sessionStorageAuthKey(page), 'sessionStorage 應有 firebase:authUser').toBeTruthy();
    expect(await localStorageAuthKey(page), 'localStorage 不應有 firebase:authUser').toBeNull();

    expect(await page.evaluate(() => localStorage.getItem('remember_me'))).toBe('false');
  });

  test('勾選 → 新分頁（共用 storage state）仍維持登入', async ({ page, context }) => {
    await doLogin(page, { remember: true });

    // 同一 context 開新分頁，模擬「關掉這個分頁、之後再開」——LOCAL persistence 下仍登入
    const page2 = await context.newPage();
    await page2.goto('/');
    await expect(page2.getByPlaceholder(/請輸入工號/)).toBeHidden({ timeout: 20_000 });
    await page2.close();
  });
});
