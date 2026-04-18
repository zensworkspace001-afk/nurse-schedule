import { expect } from '@playwright/test';

export const creds = {
  staff: {
    id: process.env.TEST_STAFF_ID,
    pw: process.env.TEST_STAFF_PW,
  },
  admin: {
    id: process.env.TEST_ADMIN_ID,
    pw: process.env.TEST_ADMIN_PW,
  },
};

export function hasCreds(role) {
  const c = creds[role];
  return Boolean(c?.id && c?.pw);
}

export async function login(page, role) {
  const c = creds[role];
  if (!c?.id || !c?.pw) throw new Error(`Missing credentials for ${role}`);

  await page.goto('/');
  await page.getByPlaceholder(/請輸入工號/).fill(c.id);
  await page.getByPlaceholder(/請輸入密碼/).fill(c.pw);
  await page.getByRole('button', { name: /登入系統|驗證中/ }).click();

  await expect(page.getByPlaceholder(/請輸入工號/)).toBeHidden({
    timeout: 20_000,
  });
}
