import type { Settings } from '../../src/shared/settings';
import { expect, pageStats, stored, test } from './fixtures';

test('practice chunks stay in the reader’s language, underlined in blue, with the translation on hover', async ({ configure, openPage, gemini, worker }) => {
  await configure({ percent: 30, practicePercent: 30 });
  const page = await openPage('article.html');
  const practice = page.locator('#intro, #links, #code, li').locator('scribblr-t[data-mode="practice"]').first();
  await expect(practice).toBeVisible({ timeout: 15_000 });
  await page.waitForTimeout(1000); // let the underline fade in

  // Unchanged text (the mock "translates" by upper-casing), marked with the practice underline.
  const id = await practice.getAttribute('data-chunk');
  const own = (await page.locator(`scribblr-t[data-chunk="${id}"]`).allTextContents()).join('').replace(/\s+/g, ' ').trim();
  expect(own).not.toBe(own.toUpperCase());
  await expect(practice).toHaveCSS('text-decoration-color', 'rgba(47, 128, 237, 0.85)');
  await expect(practice).toHaveCSS('text-decoration-style', 'dashed');

  await practice.hover();
  const tip = page.locator('scribblr-tip .tip');
  await expect(tip).toHaveClass(/show/);
  await expect(tip.locator('.label')).toHaveText('Translation');
  expect((await tip.locator('div').textContent())!.trim()).toBe(own.toUpperCase());
  await page.screenshot({ path: 'test-results/screenshots/practice-hover.png', clip: { x: 0, y: 0, width: 1100, height: 520 } });

  // Translated chunks are there too, and both kinds went in the same two requests.
  await expect(page.locator('scribblr-t:not([data-mode])').first()).toBeAttached();
  expect(gemini.requests).toHaveLength(2);
  const stats = await pageStats(worker, page);
  expect(stats.practiceChunks).toBeGreaterThan(0);
  expect(stats.translatedChunks).toBeGreaterThan(0);
});

test('practice only: nothing changes on the page, but chunks are marked to try', async ({ configure, openPage }) => {
  await configure({ percent: 0, practicePercent: 40 });
  const page = await openPage('article.html');
  const original = await page.locator('#intro').textContent();
  await expect(page.locator('scribblr-t[data-mode="practice"]').first()).toBeAttached({ timeout: 15_000 });
  await page.waitForTimeout(1000);
  await expect(page.locator('scribblr-t:not([data-mode])')).toHaveCount(0);
  await expect(page.locator('#intro')).toHaveText(original!);
});

test('the popup has separate sliders for practice chunks', async ({ configure, context, extensionId, worker }) => {
  await configure({ percent: 70, practicePercent: 50 });
  const popup = await context.newPage();
  await popup.setViewportSize({ width: 360, height: 760 });
  await popup.goto(`chrome-extension://${extensionId}/popup.html`);
  await expect(popup.locator('.mode-title').first()).toHaveText('Shown in Spanish');
  await expect(popup.locator('#shown-hint')).toHaveText('hover for English');
  await expect(popup.locator('.mode-title').nth(1)).toHaveText('Left in English to practice');
  await expect(popup.locator('#practice-hint')).toHaveText('hover for Spanish');
  await expect(popup.locator('#practice-out')).toHaveText('50% of words');
  // 70% translated leaves only 30% to practice on.
  await expect(popup.locator('#practice-note')).toBeVisible();
  await expect(popup.locator('#practice-note')).toContainText('Only 30% of words are left');

  await popup.locator('#practice-percent').fill('20');
  await expect(popup.locator('#practice-note')).toBeHidden();
  await popup.locator('#practice-size').fill('75');
  await expect(popup.locator('#practice-size-out')).toHaveText('Mostly sentences');
  await expect.poll(async () => (await stored<Settings>(worker, 'settings')).practicePercent).toBe(20);
  await expect.poll(async () => (await stored<Settings>(worker, 'settings')).practiceChunkSize).toBe(75);
  await popup.waitForTimeout(600);
  await popup.screenshot({ path: 'test-results/screenshots/popup-practice.png' });

  // Swapping languages swaps the titles.
  await popup.click('#swap');
  await expect(popup.locator('.mode-title').first()).toHaveText('Shown in English');
  await expect(popup.locator('.mode-title').nth(1)).toHaveText('Left in Spanish to practice');
});
