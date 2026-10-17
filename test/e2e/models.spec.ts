import type { Settings } from '../../src/shared/settings';
import type { RateState } from '../../src/shared/storage';
import { expect, stored, test } from './fixtures';
import { MODELS } from './mock-gemini';

test('the popup lists models in order, and saves switches and moves', async ({ configure, context, extensionId, worker }) => {
  await configure({});
  const popup = await context.newPage();
  await popup.setViewportSize({ width: 360, height: 900 });
  await popup.goto(`chrome-extension://${extensionId}/popup.html`);
  await popup.click('#models summary');
  const rows = popup.locator('.model-row');
  await expect(rows).toHaveCount(MODELS.length + 1);
  await expect(rows.locator('.model-name')).toHaveText([
    'Gemini 3.8 Flash',
    'Gemini 3.7 Flash',
    'Gemini 3.6 Flash',
    'Gemini 3.5 Flash',
    'Gemini 2.5 Flash',
    'Gemini 3.5 Flash-Lite',
    'Gemini 3.1 Flash-Lite',
    'Gemini 3 Flash (preview)',
  ]);
  // Previews start switched off.
  await expect(rows.last().locator('input')).not.toBeChecked();
  await expect(popup.locator('#models-summary')).toHaveText('3.8 Flash first, 7 on');

  // Switch the newest model off and move Flash-Lite to the top.
  await rows.first().locator('input').uncheck();
  await expect.poll(async () => (await stored<Settings>(worker, 'settings')).models.off).toEqual(['gemini-3.8-flash']);
  const lite = popup.locator('.model-row[data-model="gemini-3.5-flash-lite"]');
  for (let i = 0; i < 5; i++) await lite.getByRole('button', { name: /up$/ }).click();
  await expect(rows.first()).toHaveAttribute('data-model', 'gemini-3.5-flash-lite');
  // Focus stays on the button, so the keyboard can keep moving it.
  await expect(lite.getByRole('button', { name: /down$/ })).toBeEnabled();
  expect((await stored<Settings>(worker, 'settings')).models.order.slice(0, 2)).toEqual(['gemini-3.5-flash-lite', 'gemini-3.8-flash']);
  await expect(popup.locator('#models-summary')).toHaveText('3.5 Flash-Lite first, 6 on');
  await expect(popup.locator('#model-line')).toHaveText('Translating with Gemini 3.5 Flash-Lite.');
  await popup.screenshot({ path: 'test-results/screenshots/popup-models.png', fullPage: true });

  await popup.click('#models-reset');
  await expect(rows.first()).toHaveAttribute('data-model', 'gemini-3.8-flash');
  await expect(rows.first().locator('input')).toBeChecked();
  expect((await stored<Settings>(worker, 'settings')).models).toEqual({ order: [], off: [], on: [] });
});

test('translations use the first model in your order that is switched on', async ({ configure, openPage, gemini }) => {
  await configure({ percent: 50, models: { order: ['gemini-3.5-flash-lite', 'gemini-3.8-flash'], off: ['gemini-3.8-flash'], on: [] } });
  const page = await openPage('article.html');
  await expect(page.locator('scribblr-t').first()).toBeAttached({ timeout: 15_000 });
  expect(new Set(gemini.requests.map((r) => r.model))).toEqual(new Set(['gemini-3.5-flash-lite']));
});

test('when its quota runs out, the next model in your order takes over', async ({ configure, openPage, gemini }) => {
  gemini.always('gemini-3.6-flash', 'daily');
  await configure({ percent: 50, models: { order: ['gemini-3.6-flash', 'gemini-3.1-flash-lite'], off: [], on: [] } });
  const page = await openPage('article.html');
  await expect(page.locator('scribblr-t').first()).toBeAttached({ timeout: 15_000 });
  expect(gemini.requests.map((r) => r.model).slice(0, 2)).toEqual(['gemini-3.6-flash', 'gemini-3.1-flash-lite']);
});

test('switching a model on lifts a pause caused by every other model running out', async ({ configure, openPage, gemini, worker }) => {
  for (const model of MODELS) gemini.always(model, 'daily');
  await configure({ percent: 50 });
  const page = await openPage('article.html');
  await expect.poll(async () => (await stored<RateState>(worker, 'rateState'))?.pauseReason).toBe('daily');

  // The preview model has its own quota.
  await worker.evaluate(async () => {
    const { settings } = (await chrome.storage.local.get('settings')) as { settings: Settings };
    await chrome.storage.local.set({ settings: { ...settings, models: { ...settings.models, on: ['gemini-3-flash-preview'] } } });
  });
  await expect.poll(async () => (await stored<RateState>(worker, 'rateState')).pausedUntil).toBe(0);
  await page.reload();
  await expect(page.locator('scribblr-t').first()).toBeAttached({ timeout: 15_000 });
  expect(gemini.requests.at(-1)!.model).toBe('gemini-3-flash-preview');
});

test('with every model switched off, nothing is sent and the popup says why', async ({ configure, openPage, gemini, context, extensionId }) => {
  await configure({ percent: 50, models: { order: [], off: [...MODELS], on: [] } });
  const page = await openPage('article.html');
  await page.waitForTimeout(2500);
  expect(gemini.requests).toHaveLength(0);
  await expect(page.locator('scribblr-t')).toHaveCount(0);

  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${extensionId}/popup.html`);
  await expect(popup.locator('#model-line')).toHaveText('Every model is switched off.');
  await popup.click('#models summary');
  await expect(popup.locator('#models-warning')).toBeVisible();
  await expect(popup.locator('#models-summary')).toHaveText('all switched off');
});
