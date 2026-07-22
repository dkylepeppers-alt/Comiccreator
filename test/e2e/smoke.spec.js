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
  test('navigates to the Settings page via App.navigate()', async ({ page }) => {
    await page.goto('/');

    // Use the SPA router directly to navigate
    await page.evaluate(() => App.navigate('settings'));

    // Settings heading should appear
    await expect(
      page
        .locator('#content h2, #content h3')
        .filter({ hasText: /settings/i })
        .first(),
    ).toBeVisible();
  });

  test('navigates to the Library page via App.navigate()', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('#content h2').filter({ hasText: /settings/i })).toBeVisible();

    await page.evaluate(() => App.navigate('library'));

    await expect(
      page
        .locator('#content h2, #content h3')
        .filter({ hasText: /my comics/i })
        .first(),
    ).toBeVisible();
  });

  test('navigates to the Characters page via bottom nav', async ({ page }) => {
    await page.goto('/');

    // Click the Characters button in the bottom navigation bar
    await page.click('button[data-page="characters"]');

    await expect(
      page
        .locator('#content h2, #content h3')
        .filter({ hasText: /character builder/i })
        .first(),
    ).toBeVisible();
  });

  test('world references open from a newly saved parent world', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('#content h2').filter({ hasText: /settings/i })).toBeVisible();
    await page.evaluate(() => App.navigate('worlds', 'new'));
    await page.locator('#world-name').fill('Field Atlas');
    await page.locator('#world-desc').fill('A rain-cut industrial district.');
    await page.locator('[data-action="saveWorld"]').click();

    await expect(page.locator('.reference-workspace')).toBeVisible();
    await expect(page.getByText('Reference Library')).toBeVisible();
    await expect(page.getByText('World / Locations')).toBeVisible();
    await expect(page.locator('.reference-workspace select')).toHaveCount(0);
  });

  test('read-only comic exposes view, export, and delete only', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('#content h2').filter({ hasText: /settings/i })).toBeVisible();
    await page.evaluate(async () => {
      const database = await new Promise((resolve, reject) => {
        const request = indexedDB.open('ComicCreatorDB', 5);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      await new Promise((resolve, reject) => {
        const transaction = database.transaction(['comics', 'pages'], 'readwrite');
        transaction.objectStore('comics').put({
          id: 'legacy-comic-0001',
          title: 'Archive Issue',
          genre: 'noir',
          referenceSchemaVersion: 1,
          pageCount: 1,
        });
        transaction.objectStore('pages').put({
          id: 'legacy-page-0001',
          comicId: 'legacy-comic-0001',
          pageNum: 1,
          data: { panels: [] },
        });
        transaction.oncomplete = () => resolve();
        transaction.onerror = () => reject(transaction.error);
      });
    });

    await page.evaluate(() => App.navigate('library', 'legacy-comic-0001'));
    await expect(page.getByText('Read-only legacy snapshot')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Export PDF' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Delete' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Continue Story' })).toHaveCount(0);
  });
});
