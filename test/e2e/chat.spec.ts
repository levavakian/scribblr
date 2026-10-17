import { expect, test, translatedTexts } from './fixtures';

declare global {
  interface Window {
    streamReply: (paragraphs: string[], delay?: number) => Promise<HTMLElement>;
    liveChat: (lines: string[], delay?: number) => Promise<void>;
    streamDone: boolean;
  }
}

const REPLY = [
  'Cows have nearly panoramic vision, so they can see almost all the way around themselves without turning their heads.',
  'They also have a very good memory and can remember the faces of people and other cows for many years.',
  'Finally, cows are surprisingly good swimmers when they need to cross a river or a flooded field.',
];

test('waits for a streaming reply to finish, then translates it in one request', async ({ configure, openPage, gemini }) => {
  await configure({ percent: 100 });
  const page = await openPage('chat.html');
  await expect(page.locator('.user scribblr-t').first()).toBeAttached();
  const before = gemini.requests.length;

  // About 60 words at 60 ms each: the reply streams in for ~3.5 seconds.
  await page.evaluate((reply) => void window.streamReply(reply, 60), REPLY);
  await expect.poll(() => page.locator('.bot p').count()).toBeGreaterThan(0);
  while (!(await page.evaluate(() => window.streamDone))) {
    // Nothing in the reply is touched while words keep arriving.
    expect(await page.locator('.bot scribblr-t').count()).toBe(0);
    await page.waitForTimeout(100);
  }

  await expect(page.locator('.bot p').first()).toHaveText(REPLY[0]!.toUpperCase(), { timeout: 15_000 });
  await expect(page.locator('.bot p')).toHaveText(REPLY.map((p) => p.toUpperCase()));
  const replyRequests = gemini.requests.slice(before).filter((r) => r.prompt.includes('panoramic'));
  expect(replyRequests).toHaveLength(1);
  expect(Object.values(replyRequests[0]!.chunks).join(' ')).toMatch(/swimmers/);
});

test('steps aside when the page rewrites text it translated, then translates the new text', async ({ configure, openPage }) => {
  await configure({ percent: 100 });
  const page = await openPage('chat.html');
  await page.evaluate((reply) => window.streamReply(reply, 1), [REPLY[0]!]);
  const p = page.locator('.bot p');
  await expect(p).toHaveText(REPLY[0]!.toUpperCase(), { timeout: 15_000 });

  // Like React re-rendering a streamed message: the page sets new text on the node it owns.
  const longer = `${REPLY[0]} They rarely sleep standing up, despite the old myth.`;
  await page.evaluate((text) => {
    (document.querySelector('.bot p')!.firstChild as Text).data = text;
  }, longer);
  await expect(p.locator('scribblr-t')).toHaveCount(0);
  await expect(p).toHaveText(longer);

  await expect(p).toHaveText(longer.toUpperCase(), { timeout: 15_000 });
});

test('never touches the message being typed', async ({ configure, openPage }) => {
  await configure({ percent: 100 });
  const page = await openPage('chat.html');
  await expect(page.locator('.user scribblr-t').first()).toBeAttached();
  await page.locator('#composer').click();
  await page.keyboard.press('End');
  await page.keyboard.type(' And what do cows dream about at night?');
  await page.waitForTimeout(3000);
  await expect(page.locator('#composer scribblr-t')).toHaveCount(0);
  await expect(page.locator('#composer')).toHaveText(
    'I am typing a new question about farm animals here. And what do cows dream about at night?',
  );
});

test('batches a live chat instead of sending every message', async ({ configure, openPage, gemini }) => {
  await configure({ percent: 100 });
  const page = await openPage('chat.html');
  await expect(page.locator('.user scribblr-t').first()).toBeAttached();
  const before = gemini.requests.length;
  const lines = Array.from({ length: 12 }, (_, i) => `Message number ${i + 1}: the cows in the north field are walking towards the barn again.`);
  await page.evaluate((l) => window.liveChat(l, 300), lines);

  // Every message ends up translated (numbers on their own are never chunks, so a line may be two)…
  await expect(page.locator('.live')).toHaveText(
    lines.map((l) => l.toUpperCase()),
    { timeout: 20_000 },
  );
  expect((await translatedTexts(page, '.live')).length).toBeGreaterThanOrEqual(12);
  // …in a handful of requests rather than one per message.
  expect(gemini.requests.length - before).toBeLessThanOrEqual(3);
});
