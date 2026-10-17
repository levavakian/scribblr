// Calls the real Gemini API: `GEMINI_API_KEY=… npm run test:live`. Spends 1 request of free-tier
// quota on LIVE_MODEL (default: a Flash-Lite model, which has a much bigger daily quota than Flash).
import { describe, expect, it } from 'vitest';
import { DEFAULT_API_BASE, extractTranslations, generateContent, listModels } from '../../src/background/gemini';
import { orderFlashModels } from '../../src/background/models';
import { requestBody, thinkingConfig } from '../../src/background/prompt';
import { parseMarkup, tagSignature } from '../../src/shared/markup';
import type { TranslateRequest } from '../../src/shared/messages';

const key = process.env.GEMINI_API_KEY;
const model = process.env.LIVE_MODEL ?? 'gemini-3.5-flash-lite';

const request: TranslateRequest = {
  sourceLang: 'en',
  targetLang: 'es',
  page: { title: 'All about cows', url: 'https://example.com/cows' },
  blocks: [
    { tag: 'h1', parts: ['All about cows'] },
    { tag: 'p', parts: ['Cows are great. ', { chunk: 0, markup: 'They have big friendly eyes, and' }, ' they love to be around people.'] },
    { tag: 'button', parts: [{ chunk: 1, markup: 'Learn more' }, ' about cows?'] },
    {
      tag: 'p',
      parts: [
        { chunk: 2, markup: 'Read <t1>the cow handbook</t1> before' },
        ' you visit the farm, and run ',
        { chunk: 3, markup: '<x2>moo --help</x2> to see' },
        ' every option.',
      ],
    },
  ],
  chunks: [0, 1, 2, 3].map((id) => ({ id, key: String(id) })),
};

describe.skipIf(!key)(`Gemini, live (${model})`, () => {
  it('lists the Flash models this key can use', async () => {
    const result = await listModels(key!);
    if (!result.ok) throw new Error(JSON.stringify(result.failure));
    const chain = orderFlashModels(result.value);
    console.log('model chain:', chain.join(' → '));
    expect(chain.length).toBeGreaterThan(0);
    expect(chain).toContain(model);
  });

  it('translates annotated chunks in context and keeps their tags', async () => {
    const ids = new Set(request.chunks.map((c) => c.id));
    const started = Date.now();
    const response = await generateContent(key!, DEFAULT_API_BASE, model, requestBody(request, ids, thinkingConfig(model)));
    if (!response.ok) throw new Error(JSON.stringify(response.failure));
    const result = extractTranslations(response.value, ids);
    if (!result.ok) throw new Error(JSON.stringify(result.failure));
    console.log(`translated in ${Date.now() - started} ms:`, result.value);

    const t = result.value;
    expect(Object.keys(t).sort()).toEqual(['0', '1', '2', '3']);
    expect(t[0]!.toLowerCase()).not.toContain('friendly');
    expect(t[1]!.toLowerCase()).not.toBe('learn more');
    expect(tagSignature(parseMarkup(t[2]!))).toBe('o1 c1');
    expect(tagSignature(parseMarkup(t[3]!))).toBe('s2');
  });
});
