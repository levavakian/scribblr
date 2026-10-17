// Calls the real Gemini API: `GEMINI_API_KEY=… npm run test:live`. Spends 1 request of free-tier
// quota on LIVE_MODEL (default: a Flash-Lite model, which has a much bigger daily quota than Flash).
import { describe, expect, it } from 'vitest';
import { DEFAULT_API_BASE, extractTranslations, generateContent, listModels } from '../../src/background/gemini';
import { orderFlashModels } from '../../src/shared/models';
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

// Chunks that tempt a model to translate the whole sentence around them (spec: "What are you
// talking <chunk>about</chunk>" must become "sobre" or "de qué", not "de qué estás hablando").
const fragments: TranslateRequest = {
  sourceLang: 'en',
  targetLang: 'es',
  page: { title: 'Chat', url: 'https://example.com/chat' },
  blocks: [
    { tag: 'p', parts: ['What are you talking ', { chunk: 0, markup: 'about' }, '?'] },
    { tag: 'p', parts: ["I can't ", { chunk: 1, markup: 'wait' }, ' to see you again.'] },
    { tag: 'p', parts: ['Where are you ', { chunk: 2, markup: 'from' }, ' originally?'] },
    { tag: 'p', parts: ['She ', { chunk: 3, markup: 'looked it up' }, ' in the dictionary.'] },
    { tag: 'p', parts: ['The meeting was ', { chunk: 4, markup: 'called off' }, ' because of the storm.'] },
  ],
  chunks: [0, 1, 2, 3, 4].map((id) => ({ id, key: String(id) })),
};

/** Words in a translation, ignoring punctuation. */
const wordCount = (text: string) => text.split(/\s+/).filter((w) => /\p{L}/u.test(w)).length;

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

  it('translates only the words inside each chunk, not the sentence around it', async () => {
    const ids = new Set(fragments.chunks.map((c) => c.id));
    const response = await generateContent(key!, DEFAULT_API_BASE, model, requestBody(fragments, ids, thinkingConfig(model)));
    if (!response.ok) throw new Error(JSON.stringify(response.failure));
    const result = extractTranslations(response.value, ids);
    if (!result.ok) throw new Error(JSON.stringify(result.failure));
    console.log('fragments:', result.value);

    const t = result.value;
    // "about" → "sobre" / "de qué", never "¿De qué estás hablando?"
    expect(t[0]!).not.toMatch(/habla|estás|estas/i);
    expect(wordCount(t[0]!)).toBeLessThanOrEqual(2);
    // "wait" → "esperar", not "no puedo esperar"
    expect(t[1]!).not.toMatch(/\bno\b|puedo/i);
    expect(wordCount(t[1]!)).toBeLessThanOrEqual(2);
    // "from" → "de", not "¿de dónde eres?"
    expect(t[2]!).not.toMatch(/eres|es usted/i);
    expect(wordCount(t[2]!)).toBeLessThanOrEqual(2);
    // "looked it up" → "lo buscó", without "ella" or "en el diccionario"
    expect(t[3]!).not.toMatch(/\bella\b|diccionario/i);
    // "called off" → "cancelada", without "la reunión" or "por la tormenta"
    expect(t[4]!).not.toMatch(/reuni|tormenta/i);
    expect(wordCount(t[4]!)).toBeLessThanOrEqual(2);
  });
});
