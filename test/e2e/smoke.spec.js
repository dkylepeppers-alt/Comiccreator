// @ts-check
import { test, expect } from '@playwright/test';

/**
 * Smoke tests for AI Comic Creator PWA.
 * Verifies that the app shell loads correctly and core navigation works.
 */

test.describe('App shell', () => {
  test('loads the home page without errors', async ({ page }) => {
    const errors = [];
    page.on('pageerror', (err) => errors.push(err.message));

    await page.goto('/');

    // Title is set
    await expect(page).toHaveTitle(/Comic Creator/i);

    // Sidebar navigation is present
    await expect(page.locator('#sidebar')).toBeAttached();

    // Main content area is present
    await expect(page.locator('#content')).toBeVisible();

    // No uncaught JS errors during load
    expect(errors, `Unexpected page errors: ${errors.join('; ')}`).toHaveLength(0);
  });

  test('shows version number in the sidebar footer', async ({ page }) => {
    await page.goto('/');

    // The sidebar footer should contain the version string
    const footerText = await page.locator('.sidebar-footer').textContent();
    expect(footerText).toMatch(/v\d+\.\d+\.\d+/);
  });
});

test.describe('Core navigation', () => {
  // Helper: wait for app init() to finish its initial navigation.
  // init() always calls navigate() at the end (to 'settings' when no API key is
  // set, which is always the case in E2E). Without this wait, a test that then
  // calls App.navigate() races with init() and the init navigation can win and
  // overwrite the page the test just navigated to.
  async function waitForAppInit(page) {
    await page.waitForFunction(() => {
      const el = document.querySelector('#content h2, #content h3');
      return el !== null && el.textContent.trim().length > 0;
    });
  }

  test('navigates to the Settings page via App.navigate()', async ({ page }) => {
    await page.goto('/');
    await waitForAppInit(page);

    // Use the SPA router directly to navigate
    await page.evaluate(() => App.navigate('settings'));

    // Settings heading should appear
    await expect(page.locator('#content h2, #content h3').filter({ hasText: /settings/i }).first()).toBeVisible();
  });

  test('navigates to the Library page via App.navigate()', async ({ page }) => {
    await page.goto('/');
    await waitForAppInit(page);

    await page.evaluate(() => App.navigate('library'));

    await expect(page.locator('#content h2, #content h3').filter({ hasText: /my comics/i }).first()).toBeVisible();
  });

  test('navigates to the Characters page via bottom nav', async ({ page }) => {
    await page.goto('/');
    await waitForAppInit(page);

    // Click the Characters button in the bottom navigation bar
    await page.click('button[data-page="characters"]');

    await expect(page.locator('#content h2, #content h3').filter({ hasText: /character builder/i }).first()).toBeVisible();
  });
});
