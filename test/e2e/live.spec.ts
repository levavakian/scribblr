// The whole extension against the real Gemini API. Opt-in, since it spends quota (about 3 requests):
//   ./shell.sh -c 'set -a; . ~/.envrc; set +a; LIVE_E2E=1 npx playwright test live'
import { expect, test } from './fixtures';

test.skip(!process.env.LIVE_E2E || !process.env.GEMINI_API_KEY, 'set LIVE_E2E=1 and GEMINI_API_KEY to run against the real API');

test('translates a page with the real API', async ({ worker, context, extensionId, openPage }) => {
  test.setTimeout(120_000);
  await worker.evaluate(async () => {
    await chrome.storage.local.set({
      settings: { enabled: true, disabledSites: [], sourceLang: 'en', targetLang: 'es', percent: 40, chunkSize: 40, practicePercent: 25, practiceChunkSize: 30 },
    });
  });
  // Save the key through the popup, like a user: it lists models, then makes one tiny test call.
  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${extensionId}/popup.html`);
  await popup.fill('#api-key', process.env.GEMINI_API_KEY!);
  await popup.click('#save-key');
  await expect(popup.locator('#key-message')).toHaveText('Key works.', { timeout: 30_000 });
  await popup.close();

  const started = Date.now();
  const page = await openPage('article.html');
  await page.locator('scribblr-t[data-flipping]').first().waitFor({ timeout: 60_000 });
  console.log(`first translations after ${Date.now() - started} ms`);
  await page.screenshot({ path: 'test-results/screenshots/live-flipping.png', clip: { x: 0, y: 0, width: 1100, height: 520 } });

  const settled = page.locator('#intro, #links, #code, #learn').locator('scribblr-t:not([data-flipping])').first();
  await expect(settled).toBeVisible({ timeout: 60_000 });
  await page.waitForTimeout(1500);
  await page.screenshot({ path: 'test-results/screenshots/live.png' });

  const chunks = await page.$$eval('scribblr-t', (els) => {
    const byId = new Map<string, string>();
    for (const e of els) byId.set(e.getAttribute('data-chunk')!, (byId.get(e.getAttribute('data-chunk')!) ?? '') + e.textContent);
    return [...byId.values()];
  });
  console.log('translated chunks:\n  ' + chunks.join('\n  '));
  // Real Spanish rather than the original English.
  expect(chunks.join(' ')).toMatch(/[áéíóúñ¿¡]|\b(las?|los?|el|una?|que|de|y|con)\b/i);
  await expect(page.locator('#handbook')).toHaveAttribute('href', '/handbook');

  await settled.hover();
  await expect(page.locator('scribblr-tip .tip')).toHaveClass(/show/);
  await page.waitForTimeout(200);
  await page.screenshot({ path: 'test-results/screenshots/live-hover.png', clip: { x: 0, y: 0, width: 1100, height: 520 } });

  // A practice chunk stays in English; its tooltip has the Spanish.
  const practice = page.locator('#intro, #links, #code, li').locator('scribblr-t[data-mode="practice"]').first();
  await page.mouse.move(5, 5);
  await practice.hover();
  await expect(page.locator('scribblr-tip .label')).toHaveText('Translation');
  const answer = (await page.locator('scribblr-tip .tip div').textContent())!;
  console.log(`practice chunk "${await practice.textContent()}" → hover "${answer}"`);
  expect(answer).not.toBe(await practice.textContent());
  await page.screenshot({ path: 'test-results/screenshots/live-practice.png', clip: { x: 0, y: 0, width: 1100, height: 520 } });

  const { usage, log } = await worker.evaluate(async () => chrome.storage.local.get(['usage', 'log']));
  console.log('requests today:', JSON.stringify(usage));
  for (const e of log as Array<{ model: string; outcome: string; ms: number; chunks: number; detail?: string }>) {
    console.log(`  ${e.model}: ${e.outcome} in ${e.ms} ms (${e.chunks} chunks)${e.detail ? ` — ${e.detail.split('\n')[0]}` : ''}`);
  }
});
