import { test, expect } from '@playwright/test';

// Bug-hunting harness for the sphere-drop transition demo.
// Checks: no console errors, transition fires, canvas gets cleaned up.
test.describe('sphere-drop transition demo', () => {
  let consoleErrors;
  let pageErrors;

  test.beforeEach(async ({ page }) => {
    consoleErrors = [];
    pageErrors = [];
    page.on('console', (msg) => {
      if (msg.type() === 'error') consoleErrors.push(msg.text());
    });
    page.on('pageerror', (err) => pageErrors.push(err.message));
    await page.goto('/sphere-drop.html');
  });

  test('loads cleanly with no runtime errors', async ({ page }) => {
    await expect(page.getByRole('heading', { name: 'Page A' })).toBeVisible();
    // Give the importmap + modules a moment to resolve.
    await page.waitForTimeout(1500);
    expect(pageErrors, `page errors: ${pageErrors.join('\n')}`).toEqual([]);
    expect(consoleErrors, `console errors: ${consoleErrors.join('\n')}`).toEqual([]);
  });

  test('click triggers transition, fills screen, and swaps content', async ({ page }) => {
    const filledLogs = [];
    page.on('console', (msg) => {
      if (msg.text().includes('Transition happens here')) filledLogs.push(msg.text());
    });

    // Wait for modules to boot before clicking.
    await page.waitForTimeout(1000);
    const vp = page.viewportSize();
    await page.mouse.click(vp.width / 2, vp.height / 2);

    // A canvas should mount under the transition container.
    const canvas = page.locator('#transition-canvas-container canvas');
    await expect(canvas).toBeVisible({ timeout: 10_000 });

    // onScreenFilled must fire within a reasonable window.
    await expect.poll(() => filledLogs.length, { timeout: 20_000 }).toBeGreaterThan(0);

    // Content should have swapped to Page B during the pause.
    await expect(page.getByRole('heading', { name: 'Page B' })).toBeVisible({ timeout: 15_000 });

    // Canvas should be removed after cleanup.
    await expect(canvas).toHaveCount(0, { timeout: 20_000 });

    // No runtime errors throughout the run.
    expect(pageErrors, `page errors: ${pageErrors.join('\n')}`).toEqual([]);
    expect(consoleErrors, `console errors: ${consoleErrors.join('\n')}`).toEqual([]);
  });

  test('second click replays the transition', async ({ page }) => {
    test.setTimeout(120_000);
    await page.waitForTimeout(1000);
    const vp = page.viewportSize();

    // First run → Page B.
    await page.mouse.click(vp.width / 2, vp.height / 2);
    await expect(page.getByRole('heading', { name: 'Page B' })).toBeVisible({ timeout: 25_000 });
    await expect(page.locator('#transition-canvas-container canvas')).toHaveCount(0, { timeout: 25_000 });

    // Second run → Page A.
    await page.mouse.click(vp.width / 2, vp.height / 2);
    await expect(page.locator('#transition-canvas-container canvas')).toBeVisible({ timeout: 10_000 });
    await expect(page.getByRole('heading', { name: 'Page A' })).toBeVisible({ timeout: 25_000 });
    await expect(page.locator('#transition-canvas-container canvas')).toHaveCount(0, { timeout: 25_000 });

    expect(pageErrors, `page errors: ${pageErrors.join('\n')}`).toEqual([]);
    expect(consoleErrors, `console errors: ${consoleErrors.join('\n')}`).toEqual([]);
  });
});
