import type { KeyStatus, ModelList, RateState } from '../../src/shared/storage';
import { nextPacificMidnight } from '../../src/shared/time';
import { expect, stored, test } from './fixtures';
import { MODELS } from './mock-gemini';

test('pauses after a per-minute limit, then carries on with the same model', async ({ configure, openPage, gemini, worker }) => {
  gemini.script('gemini-3.8-flash', 'minute');
  await configure({ percent: 50 });
  const page = await openPage('article.html');
  await expect.poll(async () => (await stored<RateState>(worker, 'rateState'))?.pauseReason).toBe('minute');
  const rate = await stored<RateState>(worker, 'rateState');
  // The mock asked for 2s; we wait that long plus a second.
  expect(rate.pausedUntil - Date.now()).toBeLessThan(3500);

  await expect(page.locator('#intro scribblr-t, #links scribblr-t').first()).toBeAttached({ timeout: 15_000 });
  expect(gemini.requests[0]!.behavior).toBe('minute');
  expect(gemini.requests.slice(1).every((r) => r.model === 'gemini-3.8-flash' && r.behavior === 'ok')).toBe(true);
  // While paused, the background didn't call the API at all.
  expect(gemini.requests[1]!.at - gemini.requests[0]!.at).toBeGreaterThan(2500);
});

test('moves to the next model when the daily quota runs out', async ({ configure, openPage, gemini, worker }) => {
  gemini.always('gemini-3.8-flash', 'daily');
  await configure({ percent: 50 });
  const page = await openPage('article.html');
  await expect(page.locator('scribblr-t').first()).toBeAttached({ timeout: 15_000 });
  await expect.poll(() => gemini.requests.length).toBeGreaterThanOrEqual(3);
  const models = gemini.requests.map((r) => r.model);
  expect(models[0]).toBe('gemini-3.8-flash');
  // The exhausted model isn't tried again today.
  expect(models.slice(1).every((m) => m === 'gemini-3.7-flash')).toBe(true);
  const rate = await stored<RateState>(worker, 'rateState');
  expect(rate.exhausted['gemini-3.8-flash']).toBe(nextPacificMidnight());
  expect(rate.pausedUntil).toBeLessThan(Date.now());
});

test('pauses until midnight Pacific once every model has used up its daily quota', async ({ configure, openPage, gemini, worker }) => {
  gemini.always('*', 'daily');
  await configure({ percent: 50 });
  const page = await openPage('article.html');
  await expect.poll(async () => (await stored<RateState>(worker, 'rateState'))?.pauseReason).toBe('daily');
  const rate = await stored<RateState>(worker, 'rateState');
  expect(rate.pausedUntil).toBe(nextPacificMidnight());
  // Each model was tried exactly once.
  expect(gemini.requests.map((r) => r.model).sort()).toEqual([...MODELS].sort());

  await page.reload();
  await page.waitForTimeout(2500);
  expect(gemini.requests).toHaveLength(MODELS.length);
});

test('stops and explains when the key’s project is out of credit or over its spend cap', async ({ configure, openPage, gemini, worker, context, extensionId }) => {
  gemini.always('*', 'billing');
  await configure({ percent: 50 });
  const page = await openPage('article.html');
  await expect.poll(async () => (await stored<KeyStatus>(worker, 'keyStatus'))?.state).toBe('invalid');
  expect((await stored<KeyStatus>(worker, 'keyStatus')).message).toMatch(/credits are used up/);
  await page.waitForTimeout(2500);
  expect(gemini.requests).toHaveLength(1);

  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${extensionId}/popup.html`);
  await expect(popup.locator('#key-message')).toContainText('credits are used up');
  await expect(popup.locator('#key-form')).toBeVisible();
});

test('skips a model that is no longer available and remembers it', async ({ configure, openPage, gemini, worker }) => {
  gemini.script('gemini-3.8-flash', 'not-found');
  await configure({ percent: 50 });
  const page = await openPage('article.html');
  await expect(page.locator('scribblr-t').first()).toBeAttached({ timeout: 15_000 });
  expect(gemini.requests.map((r) => r.model).slice(0, 2)).toEqual(['gemini-3.8-flash', 'gemini-3.7-flash']);
  const models = await stored<ModelList>(worker, 'models');
  expect(models.unavailable).toEqual(['gemini-3.8-flash']);
  expect(models.list[0]).toBe('gemini-3.7-flash');
});

test('steps up to the next thinking level a model accepts, and remembers it', async ({ configure, openPage, gemini, worker }) => {
  gemini.rejectMinimalThinking.add('gemini-3.8-flash');
  await configure({ percent: 50 });
  const page = await openPage('article.html');
  await expect(page.locator('scribblr-t').first()).toBeAttached({ timeout: 15_000 });
  const [rejected, retried] = gemini.requests;
  expect(rejected).toMatchObject({ model: 'gemini-3.8-flash', behavior: 'thinking-rejected', thinking: { thinkingLevel: 'minimal' } });
  // "low", not dropping the setting: without one the model thinks at length and pages wait ~15s.
  expect(retried).toMatchObject({ model: 'gemini-3.8-flash', behavior: 'ok', thinking: { thinkingLevel: 'low' } });
  expect(await stored(worker, 'thinking')).toEqual({ 'gemini-3.8-flash': { thinkingLevel: 'low' } });
  // Later requests go straight to "low".
  await expect.poll(() => gemini.requests.length).toBeGreaterThanOrEqual(3);
  expect(gemini.requests.slice(2).every((r) => r.thinking?.thinkingLevel === 'low')).toBe(true);
});

test('a server error on one model falls through to the next', async ({ configure, openPage, gemini }) => {
  gemini.script('gemini-3.8-flash', 'overloaded');
  await configure({ percent: 50 });
  const page = await openPage('article.html');
  await expect(page.locator('scribblr-t').first()).toBeAttached({ timeout: 15_000 });
  expect(gemini.requests.map((r) => r.model).slice(0, 2)).toEqual(['gemini-3.8-flash', 'gemini-3.7-flash']);
});
