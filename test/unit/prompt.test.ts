import { describe, expect, it } from 'vitest';
import { requestBody, systemInstruction, thinkingConfig, userPrompt } from '../../src/background/prompt';
import type { TranslateRequest } from '../../src/shared/messages';

const request: TranslateRequest = {
  sourceLang: 'en',
  targetLang: 'es',
  page: { title: 'All about <cows>', url: 'https://example.com/cows' },
  blocks: [
    { tag: 'p', parts: ['Cows are great. ', { chunk: 0, markup: 'They have big friendly eyes, and' }, ' they love to be around people.'] },
    { tag: '', parts: [] },
    { tag: 'button', parts: [{ chunk: 1, markup: 'Learn <t1>more</t1>' }, ' about cows?'] },
  ],
  chunks: [
    { id: 0, key: 'a' },
    { id: 1, key: 'b' },
  ],
};

describe('userPrompt', () => {
  it('annotates the chunks to translate within the page text', () => {
    const prompt = userPrompt(request, new Set([0, 1]));
    expect(prompt).toContain('Page title: All about &lt;cows&gt;');
    expect(prompt).toContain('<block tag="p">Cows are great. <chunk id="0">They have big friendly eyes, and</chunk> they love to be around people.</block>');
    expect(prompt).toContain('<block>…</block>');
    expect(prompt).toContain('<block tag="button"><chunk id="1">Learn <t1>more</t1></chunk> about cows?</block>');
    expect(prompt).toMatch(/Translate chunks 0, 1 into Spanish\.$/);
  });

  it('shows already-cached chunks as plain context', () => {
    const prompt = userPrompt(request, new Set([0]));
    expect(prompt).toContain('<block tag="button">Learn more about cows?</block>');
    expect(prompt).toMatch(/Translate chunk 0 into Spanish\.$/);
  });
});

describe('systemInstruction', () => {
  it('insists on translating only the chunk, with the example from the spec', () => {
    const system = systemInstruction('en', 'es');
    expect(system).toContain('Translate only the words inside each chunk');
    expect(system).toContain('"What are you talking <chunk id="0">about</chunk>?"');
    expect(system).toContain('never "¿De qué estás hablando?"');
    // It comes first, before every other rule.
    expect(system.indexOf('Translate only the words')).toBeLessThan(system.indexOf("Don't add words"));
  });
});

describe('requestBody', () => {
  it('asks for structured JSON output', () => {
    const body = requestBody(request, new Set([0, 1]), thinkingConfig('gemini-3.8-flash')) as {
      generationConfig: Record<string, unknown>;
    };
    expect(body.generationConfig.responseMimeType).toBe('application/json');
    expect(body.generationConfig.thinkingConfig).toEqual({ thinkingLevel: 'minimal' });
  });

  it('chooses thinking settings per model family', () => {
    expect(thinkingConfig('gemini-2.5-flash')).toEqual({ thinkingBudget: 0 });
    expect(thinkingConfig('gemini-2.5-flash-lite')).toBeUndefined();
    expect(thinkingConfig('gemini-3.5-flash-lite')).toEqual({ thinkingLevel: 'minimal' });
  });
});
