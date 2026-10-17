import { unescapeText, stripTags } from '../../src/shared/markup';
import { expect, pageStats, scrollThrough, test, translatedTexts } from './fixtures';

test('translates part of an article with one request for the screen and one for the rest', async ({ configure, openPage, gemini }) => {
  await configure({ percent: 40 });
  const page = await openPage('article.html');

  await expect.poll(async () => (await translatedTexts(page)).length).toBeGreaterThan(2);
  await expect(page.locator('scribblr-t').first()).toHaveCSS('text-decoration-style', 'dashed');

  await expect.poll(() => gemini.requests.length).toBe(2);
  await page.waitForTimeout(1500);
  expect(gemini.requests).toHaveLength(2);
  expect(gemini.requests.map((r) => r.model)).toEqual(['gemini-3.8-flash', 'gemini-3.8-flash']);

  // The first request only asks for chunks of text that is on screen. (Compared case-insensitively:
  // by now the page shows the mock's upper-cased "translations".)
  const onScreen = await page.$$eval('h1, p, li, button', (els) =>
    els.filter((e) => e.getBoundingClientRect().top < window.innerHeight).map((e) => e.textContent!.replace(/\s+/g, ' ').toLowerCase()),
  );
  const offScreenChunks = Object.values(gemini.requests[1]!.chunks).map((m) => unescapeText(stripTags(m)).toLowerCase());
  expect(offScreenChunks.some((text) => text.includes('thank you') || text.includes('oldest') || text.includes('smell') || text.includes('sleep'))).toBe(true);
  for (const markup of Object.values(gemini.requests[0]!.chunks)) {
    const text = unescapeText(stripTags(markup)).toLowerCase();
    expect(onScreen.some((block) => block.includes(text))).toBe(true);
  }
  // …but both carry the whole page as context.
  for (const r of gemini.requests) {
    const text = r.prompt.replace(/<\/?chunk[^>]*>/g, '');
    expect(text).toContain('All about cows');
    expect(text).toContain('remember to say hello to the cows');
  }
});

test('leaves other languages, editors and code alone', async ({ configure, openPage }) => {
  await configure({ percent: 100 });
  const page = await openPage('article.html');
  await expect(page.locator('#intro scribblr-t').first()).toBeAttached();
  await page.waitForTimeout(1500);
  await expect(page.locator('#spanish scribblr-t')).toHaveCount(0);
  await expect(page.locator('#editor scribblr-t')).toHaveCount(0);
  await expect(page.locator('#pre scribblr-t')).toHaveCount(0);
  await expect(page.locator('#editor')).toHaveText('This text is being edited by the user and must never change.');
  await expect(page.locator('#code code')).toHaveText('moo --help');
});

test('keeps links, formatting and inline code in place inside translated chunks', async ({ configure, openPage }) => {
  await configure({ percent: 100, chunkSize: 100 });
  const page = await openPage('article.html');
  const link = page.locator('#handbook');
  await expect(link).toHaveText('THE COW HANDBOOK');
  await expect(link).toHaveAttribute('href', '/handbook');
  await expect(page.locator('#links b')).toHaveText('COMFORTABLE BOOTS');
  await expect(page.locator('#links')).toHaveText(/^IF YOU WANT TO LEARN MORE, READ THE COW HANDBOOK BEFORE/);
  await expect(page.locator('#code')).toHaveText(/TYPE moo --help INTO THE TERMINAL/);
  await expect(page.locator('#learn')).toHaveText('LEARN MORE ABOUT COWS');
  // The link is still the page's own element, so the page's click handlers keep working.
  expect(await link.evaluate((a) => a.isConnected && a.parentElement?.id)).toBe('links');
});

test('shows the original text on hover', async ({ configure, openPage }) => {
  await configure({ percent: 60 });
  const page = await openPage('article.html');
  const chunk = page.locator('#intro scribblr-t, #links scribblr-t').first();
  await expect(chunk).toBeVisible();
  await page.waitForTimeout(1200); // let the flip finish
  const id = await chunk.getAttribute('data-chunk');
  const translated = (await page.locator(`scribblr-t[data-chunk="${id}"]`).allTextContents()).join('').replace(/\s+/g, ' ').trim();

  await chunk.hover();
  const tip = page.locator('scribblr-tip .tip');
  await expect(tip).toHaveClass(/show/);
  const original = (await tip.locator('div').textContent())!.trim();
  // The mock "translates" by upper-casing, so the original is the same text in its original case.
  expect(original.toUpperCase()).toBe(translated);
  expect(original).not.toBe(translated);
  await expect(chunk).toHaveAttribute('data-hover', '');

  await page.mouse.move(5, 5);
  await expect(tip).not.toHaveClass(/show/);
});

test("translates about the slider's share of words", async ({ configure, openPage, worker }) => {
  await configure({ percent: 40, chunkSize: 25 });
  const page = await openPage('article.html');
  await page.waitForTimeout(1500);
  await scrollThrough(page);
  await page.waitForTimeout(1500);
  const stats = await pageStats(worker, page);
  expect(stats.state).toBe('active');
  const share = stats.translatedWords / stats.words;
  expect(share).toBeGreaterThan(0.3);
  expect(share).toBeLessThan(0.5);
});

test('reloads come from the cache without new requests', async ({ configure, openPage, gemini }) => {
  await configure({ percent: 40 });
  const page = await openPage('article.html');
  await expect.poll(() => gemini.requests.length).toBe(2);
  await page.waitForTimeout(2000);
  const before = await translatedTexts(page);
  expect(before.length).toBeGreaterThan(2);
  await page.reload();
  await expect.poll(async () => (await translatedTexts(page)).length).toBeGreaterThanOrEqual(before.length);
  await page.waitForTimeout(1000);
  expect(gemini.requests).toHaveLength(2);
  expect(await translatedTexts(page)).toEqual(before);
});

test('turning the site off restores the page', async ({ configure, openPage, worker }) => {
  await configure({ percent: 60 });
  const page = await openPage('article.html');
  const original = await page.locator('#intro').textContent();
  await expect(page.locator('scribblr-t').first()).toBeAttached();
  await worker.evaluate(async () => {
    const { settings } = (await chrome.storage.local.get('settings')) as { settings: object };
    await chrome.storage.local.set({ settings: { ...settings, disabledSites: ['127.0.0.1'] } });
  });
  await expect(page.locator('scribblr-t')).toHaveCount(0);
  await expect(page.locator('#intro')).toHaveText(original!);
});
