import { test, expect } from '@playwright/test';
import { creds, hasCreds } from './helpers/auth.js';

// 地端版（E2E_BACKEND=aegis：Aegis.Api + VITE_BACKEND=aegis）才有的行為：SignalR 即時推送、同時編輯保護、背景排班工作。
// 需要 dotnet run -- --seed-demo 的示範資料（N001–N014 + admin）。
const AEGIS = process.env.E2E_BACKEND === 'aegis';

async function login(browser, who) {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  page.dialogs = [];
  page.on('dialog', (d) => { page.dialogs.push(d.message()); d.accept(); });
  await page.goto('/');
  await page.getByPlaceholder(/請輸入工號/).fill(who.id);
  await page.getByPlaceholder(/請輸入密碼/).fill(who.pw);
  await page.getByRole('button', { name: /登入系統|驗證中/ }).click();
  await expect(page.getByPlaceholder(/請輸入工號/)).toBeHidden({ timeout: 20_000 });
  return page;
}

// 員工管理表格裡某工號那一列的「姓名」欄（工號是唯讀文字，姓名是該列第一個文字輸入框）
function staffRow(page, staffId) {
  return page.locator('tr.staff-mgmt__row', { has: page.locator('.staff-mgmt__readonly', { hasText: new RegExp(`^${staffId}$`) }) });
}
const nameInput = (page, staffId) => staffRow(page, staffId).locator('input[type="text"]').first();

async function openStaffTab(page) {
  await page.getByRole('link', { name: /員工管理/ }).click();
  await expect(staffRow(page, 'N001')).toBeVisible({ timeout: 15_000 });
}

test.describe('地端版（Aegis）', () => {
  test.skip(!AEGIS, '只在 E2E_BACKEND=aegis 時執行');
  test.skip(!hasCreds('staff') || !hasCreds('admin'), '需要 TEST_STAFF_* 與 TEST_ADMIN_*');

  test('即時推送：管理員改員工姓名，員工畫面不重新整理就更新', async ({ browser }) => {
    const staff = await login(browser, creds.staff);
    await expect(staff.getByText(/嗨，/).first()).toBeVisible({ timeout: 20_000 });
    const admin = await login(browser, creds.admin);
    await openStaffTab(admin);
    const newName = `即時${Date.now() % 100000}`;
    await nameInput(admin, creds.staff.id.toUpperCase()).fill(newName);
    await admin.getByRole('button', { name: /儲存變更/ }).click();
    await expect(staff.getByText(new RegExp(`嗨，${newName}`))).toBeVisible({ timeout: 15_000 });
  });

  test('同時編輯：C 編輯中、A 先存 → C 存檔時不覆蓋 A，提示並載入最新版', async ({ browser }) => {
    const a = await login(browser, creds.admin);
    const c = await login(browser, creds.admin);
    await openStaffTab(a);
    await openStaffTab(c);
    const tag = Date.now() % 100000;
    await nameInput(c, 'N011').fill(`C改的${tag}`);                // C 編輯中（尚未存）
    await nameInput(a, 'N010').fill(`A改的${tag}`);
    await a.getByRole('button', { name: /儲存變更/ }).click();     // A 先存 → 自動存檔 → 推送到 C
    await c.waitForTimeout(5000);
    c.dialogs.length = 0;
    await c.getByRole('button', { name: /儲存變更/ }).click();     // C 用舊副本存
    await expect.poll(() => c.dialogs.join('|'), { timeout: 10_000 }).toMatch(/其他管理員剛更新了員工資料/);
    await a.reload();
    await openStaffTab(a);
    await expect(nameInput(a, 'N010')).toHaveValue(`A改的${tag}`);   // A 的修改沒有被蓋掉
    await expect(nameInput(a, 'N011')).not.toHaveValue(`C改的${tag}`);
  });

  test('排班工作桌：CP-SAT 背景排班，完成後結果放進草稿', async ({ browser }) => {
    test.setTimeout(240_000);
    const admin = await login(browser, creds.admin);
    await admin.getByRole('link', { name: /排班工作桌/ }).click();
    await admin.getByRole('button', { name: /CP-SAT/ }).first().click();
    const done = admin.locator('.schedule-panel__chat-bubble--assistant', { hasText: /法遵硬約束違規：0|排班失敗/ });
    await expect(done).toBeVisible({ timeout: 200_000 });
    await expect(done).toContainText('法遵硬約束違規：0');
  });
});
