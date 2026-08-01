import { expect, test } from '@playwright/test';

test('boots: title, canvas, "boot ok", no console errors', async ({ page }) => {
  const consoleErrors: string[] = [];
  let sawBootOk = false;

  page.on('console', (msg) => {
    if (msg.text().includes('boot ok')) {
      sawBootOk = true;
    }
    if (msg.type() === 'error') {
      consoleErrors.push(msg.text());
    }
  });
  page.on('pageerror', (err) => {
    consoleErrors.push(err.message);
  });

  await page.goto('/');

  await expect(page).toHaveTitle('Battle City');
  await expect(page.locator('canvas#game')).toHaveCount(1);
  expect(sawBootOk, 'expected "boot ok" in the console').toBe(true);
  expect(consoleErrors, 'expected no console/page errors').toEqual([]);
});
