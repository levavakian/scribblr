import type { Settings } from '../../src/shared/settings';
import { expect, stored, test } from './fixtures';

test('asks for a key, checks it, and saves it', async ({ context, extensionId, gemini, worker }) => {
  await worker.evaluate((apiBase) => chrome.storage.local.set({ apiBase }), gemini.url);
  const popup = await context.newPage();
  await popup.setViewportSize({ width: 360, height: 700 });
  await popup.goto(`chrome-extension://${extensionId}/popup.html`);
  await expect(popup.locator('#key-form')).toBeVisible();
  await popup.screenshot({ path: 'test-results/screenshots/popup-no-key.png' });

  await popup.fill('#api-key', 'AIza-test-key-1234');
  await popup.click('#save-key');
  await expect(popup.locator('#key-message')).toHaveText('Key works.');
  await expect.poll(() => stored(worker, 'apiKey')).toBe('AIza-test-key-1234');
  // The check made one tiny call on a Flash-Lite model, which has the biggest free quota.
  expect(gemini.requests.map((r) => r.model)).toEqual(['gemini-3.5-flash-lite']);
  await expect(popup.locator('#key-summary')).toBeVisible();
  await expect(popup.locator('#key-mask')).toHaveText('••••1234');
});

test('shows and saves settings', async ({ configure, context, extensionId, worker }) => {
  await configure({ percent: 40, chunkSize: 30 });
  const popup = await context.newPage();
  await popup.setViewportSize({ width: 360, height: 600 });
  await popup.goto(`chrome-extension://${extensionId}/popup.html`);
  await expect(popup.locator('#percent-out')).toHaveText('40% of words');
  await expect(popup.locator('#size-out')).toHaveText('Mostly phrases');
  await expect(popup.locator('#model-line')).toHaveText('Translating with Gemini 3.8 Flash.');
  await popup.waitForTimeout(800); // let the logo finish flipping
  await popup.screenshot({ path: 'test-results/screenshots/popup.png' });

  await popup.selectOption('#target-lang', 'fr');
  await expect.poll(async () => (await stored<Settings>(worker, 'settings')).targetLang).toBe('fr');
  await popup.locator('#percent').fill('70');
  await expect(popup.locator('#percent-out')).toHaveText('70% of words');
  await expect.poll(async () => (await stored<Settings>(worker, 'settings')).percent).toBe(70);
  await popup.locator('#chunk-size').fill('100');
  await expect(popup.locator('#size-out')).toHaveText('Mostly paragraphs');
  await popup.click('#swap');
  await expect.poll(async () => (await stored<Settings>(worker, 'settings')).sourceLang).toBe('fr');
  expect((await stored<Settings>(worker, 'settings')).targetLang).toBe('en');
  await popup.click('#enabled');
  await expect.poll(async () => (await stored<Settings>(worker, 'settings')).enabled).toBe(false);
});

test('opens the settings page after installing', async ({ context, extensionId }) => {
  await expect.poll(() => context.pages().some((p) => p.url() === `chrome-extension://${extensionId}/options.html`)).toBe(true);
  const options = context.pages().find((p) => p.url().endsWith('options.html'))!;
  await options.setViewportSize({ width: 900, height: 800 });
  await expect(options.locator('body')).toHaveClass(/page/);
  await options.screenshot({ path: 'test-results/screenshots/options.png' });
});
