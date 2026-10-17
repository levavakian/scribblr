import { languageName } from '../shared/languages';
import { escapeText, stripTags } from '../shared/markup';
import type { TranslateRequest } from '../shared/messages';

export function systemInstruction(sourceLang: string, targetLang: string): string {
  const source = languageName(sourceLang);
  const target = languageName(targetLang);
  return [
    `You translate parts of web pages for someone who reads ${source} and is learning ${target}.`,
    `Selected spans of a page are replaced in place by your translations, so the reader sees ${source} text with some parts in ${target}.`,
    '',
    'The input is the text of the page in reading order. Each <block> is one paragraph, heading, button, list item, message and so on; its tag attribute says which. "…" stands for text left out. The spans to translate are wrapped in <chunk id="N">…</chunk>. Everything outside chunks is context only: use it to get meaning, gender, number, tense, formality and terminology right, but never translate it.',
    '',
    'Rules:',
    `- Translate each chunk into natural ${target}, the way a native speaker would say it. Translate exactly the chunk's content: don't drop words, don't pull in words from outside it, and don't add words that aren't there (no extra subject, verb or "do you want"). Keep its grammatical form: an imperative stays an imperative.`,
    "- The translation is spliced into the original sentence, so where you can, choose forms that fit the surrounding text.",
    '- Chunks may contain inline tags: <t1>…</t1> wraps a link or formatted text; <x2/> (or <x2>…</x2>) is an element kept as-is, such as inline code or an image. Keep every tag exactly once and in the same order, around the translated words that correspond to it. Always write x tags in the empty form, e.g. <x2/>.',
    '- Keep names, numbers, URLs, @handles, #hashtags, code and emoji unchanged unless they have a conventional translation.',
    '- The input is XML-escaped (&lt; &gt; &amp;). Write translations as plain text: no escaping, and no markup besides the inline tags.',
    `- If a chunk is already in ${target} or can't be translated, return it unchanged.`,
    '- Return exactly one entry for every chunk id.',
  ].join('\n');
}

function describeIds(ids: number[]): string {
  const sorted = [...ids].sort((a, b) => a - b);
  const contiguous = sorted.every((id, i) => i === 0 || id === sorted[i - 1]! + 1);
  if (contiguous && sorted.length > 2) return `chunks ${sorted[0]}–${sorted[sorted.length - 1]}`;
  return `chunk${sorted.length === 1 ? '' : 's'} ${sorted.join(', ')}`;
}

/** The page as the model sees it. Chunks not in `ids` (already cached) appear as plain text. */
export function userPrompt(request: TranslateRequest, ids: ReadonlySet<number>): string {
  const lines = [`Page title: ${escapeText(request.page.title)}`, `Page URL: ${escapeText(request.page.url)}`, '', '<page>'];
  for (const block of request.blocks) {
    if (!block.parts.length) {
      lines.push('<block>…</block>');
      continue;
    }
    const body = block.parts
      .map((p) => (typeof p === 'string' ? p : ids.has(p.chunk) ? `<chunk id="${p.chunk}">${p.markup}</chunk>` : stripTags(p.markup)))
      .join('')
      .trim();
    const tag = block.tag.replace(/[^a-z0-9-]/gi, '') || 'div';
    lines.push(`<block tag="${tag}">${body}</block>`);
  }
  lines.push('</page>', '', `Translate ${describeIds([...ids])} into ${languageName(request.targetLang)}.`);
  return lines.join('\n');
}

export const RESPONSE_SCHEMA = {
  type: 'OBJECT',
  properties: {
    translations: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: { id: { type: 'INTEGER' }, text: { type: 'STRING' } },
        required: ['id', 'text'],
        propertyOrdering: ['id', 'text'],
      },
    },
  },
  required: ['translations'],
};

/** Keep thinking to a minimum: translations don't need it, and it makes the page wait. */
export function thinkingConfig(model: string): Record<string, unknown> | undefined {
  if (/^gemini-2\.5-flash-lite/.test(model)) return undefined;
  if (/^gemini-2\.5-/.test(model)) return { thinkingBudget: 0 };
  if (/^gemini-([3-9]|\d\d)/.test(model)) return { thinkingLevel: 'minimal' };
  return undefined;
}

export function requestBody(request: TranslateRequest, ids: ReadonlySet<number>, thinking?: Record<string, unknown>): unknown {
  return {
    systemInstruction: { parts: [{ text: systemInstruction(request.sourceLang, request.targetLang) }] },
    contents: [{ role: 'user', parts: [{ text: userPrompt(request, ids) }] }],
    generationConfig: {
      responseMimeType: 'application/json',
      responseSchema: RESPONSE_SCHEMA,
      maxOutputTokens: 32_768,
      ...(thinking ? { thinkingConfig: thinking } : {}),
    },
  };
}
