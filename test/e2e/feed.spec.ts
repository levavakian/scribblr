import { expect, test } from './fixtures';

declare global {
  interface Window {
    loadMore: (count?: number) => void;
  }
}

test('translates posts that arrive after the page loaded, batched into follow-up requests', async ({ configure, openPage, gemini }) => {
  await configure({ percent: 100 });
  const page = await openPage('feed.html');
  await expect(page.locator('article')).toHaveCount(4);
  await expect.poll(() => page.locator('article:not(:has(scribblr-t))').count(), { timeout: 15_000 }).toBe(0);
  // One request for the heading at load, one for the four posts that arrived later.
  expect(gemini.requests).toHaveLength(2);
  const posts = gemini.requests[1]!;
  expect(Object.keys(posts.chunks)).toHaveLength(4);
  // The heading is context for the posts.
  expect(posts.prompt).toContain('<block tag="h1">Farm news</block>');

  // More posts scroll in: one more request for all of them.
  await page.evaluate(() => window.loadMore(4));
  await expect(page.locator('article')).toHaveCount(8);
  await expect.poll(() => page.locator('article:not(:has(scribblr-t))').count(), { timeout: 15_000 }).toBe(0);
  expect(gemini.requests).toHaveLength(3);
});
