// Not assertions so much as pictures: what a translated page and the hover look like.
import { expect, test } from './fixtures';

test('translated article and hover', async ({ configure, openPage, gemini }) => {
  gemini.latencyMs = 50;
  await configure({ percent: 45, chunkSize: 35 });
  const page = await openPage('article.html');
  await expect(page.locator('#intro scribblr-t, #links scribblr-t').first()).toBeAttached();
  // Mid-flip.
  await page.waitForTimeout(250);
  await page.screenshot({ path: 'test-results/screenshots/article-flipping.png' });
  await page.waitForTimeout(1500);
  await page.screenshot({ path: 'test-results/screenshots/article.png' });
  await page.locator('scribblr-t').first().hover();
  await expect(page.locator('scribblr-tip .tip')).toHaveClass(/show/);
  await page.waitForTimeout(200);
  await page.screenshot({ path: 'test-results/screenshots/article-hover.png', clip: { x: 0, y: 0, width: 1100, height: 420 } });
});
