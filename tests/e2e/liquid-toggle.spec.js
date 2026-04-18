import { test, expect } from '@playwright/test';

// /liquid-toggle is a public preview route (main.jsx) — no auth required.
test.describe('liquid toggle', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/liquid-toggle');
  });

  test('renders all three options with Sleep active by default', async ({ page }) => {
    for (const label of ['Sleep', 'Do Not Disturb', 'Personal']) {
      await expect(page.getByRole('button', { name: new RegExp(label) })).toBeVisible();
    }

    const sleepBtn = page.getByRole('button', { name: /Sleep/ });
    await expect(sleepBtn).toHaveClass(/lt__btn--active/);
    await expect(page.locator('.lt__status')).toContainText('Sleep');
  });

  test('clicking a button activates it and updates the status text', async ({ page }) => {
    const dndBtn = page.getByRole('button', { name: /Do Not Disturb/ });
    await dndBtn.click();
    await expect(dndBtn).toHaveClass(/lt__btn--active/);
    await expect(page.locator('.lt__status')).toContainText('Do Not Disturb');

    const personalBtn = page.getByRole('button', { name: /Personal/ });
    await personalBtn.click();
    await expect(personalBtn).toHaveClass(/lt__btn--active/);
    await expect(page.locator('.lt__status')).toContainText('Personal');
    await expect(dndBtn).not.toHaveClass(/lt__btn--active/);
  });

  test('activating a button moves the indicator to its slot', async ({ page }) => {
    const indicator = page.locator('.lt-blob--indicator');
    const startBox = await indicator.boundingBox();
    expect(startBox).not.toBeNull();

    await page.getByRole('button', { name: /Personal/ }).click();
    // Wait for the spring animation to settle.
    await page.waitForTimeout(800);

    const endBox = await indicator.boundingBox();
    expect(endBox).not.toBeNull();
    // Personal is slot 2, so the indicator should have moved down.
    expect(endBox.y).toBeGreaterThan(startBox.y + 50);
  });
});
