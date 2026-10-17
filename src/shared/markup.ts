// Chunk markup is page text with `&`, `<` and `>` escaped, plus inline tags that stand for page elements:
//   <tN>…</tN>  an element inside the chunk whose text gets translated (a link, bold text, …)
//   <xN/>       an element that is kept as-is (inline code, an image, …); `<xN>text</xN>` is accepted too
// Translations must contain the same tags in the same order, so each translated piece can be put back
// into the element it came from.

export type MarkupToken =
  | { kind: 'text'; text: string }
  | { kind: 'open'; n: number }
  | { kind: 'close'; n: number }
  | { kind: 'self'; n: number };

export function escapeText(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function unescapeText(text: string): string {
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

const TAG = /<(\/?)([tx])(\d+)\s*(\/?)>/g;

export function parseMarkup(markup: string): MarkupToken[] {
  const tokens: MarkupToken[] = [];
  let last = 0;
  let skipUntilClose: number | null = null; // inside <xN>…</xN>: the content is dropped
  const pushText = (raw: string) => {
    if (skipUntilClose !== null || !raw) return;
    const text = unescapeText(raw);
    const prev = tokens[tokens.length - 1];
    if (prev?.kind === 'text') prev.text += text;
    else tokens.push({ kind: 'text', text });
  };
  for (const m of markup.matchAll(TAG)) {
    pushText(markup.slice(last, m.index));
    last = m.index + m[0].length;
    const [, slash, letter, digits, selfClosing] = m;
    const n = Number(digits);
    if (letter === 'x') {
      if (selfClosing) {
        if (skipUntilClose === null) tokens.push({ kind: 'self', n });
      } else if (!slash) {
        if (skipUntilClose === null) {
          tokens.push({ kind: 'self', n });
          skipUntilClose = n;
        }
      } else if (skipUntilClose === n) {
        skipUntilClose = null;
      }
      continue;
    }
    if (skipUntilClose !== null) continue;
    if (selfClosing) {
      tokens.push({ kind: 'open', n }, { kind: 'close', n });
    } else {
      tokens.push({ kind: slash ? 'close' : 'open', n });
    }
  }
  pushText(markup.slice(last));
  return tokens;
}

/** The tag structure of a token list, for checking a translation kept every tag in order. */
export function tagSignature(tokens: Array<{ kind: string; n?: number }>): string {
  return tokens
    .filter((t) => t.kind !== 'text' && t.kind !== 'slot')
    .map((t) => `${t.kind[0]}${t.n}`)
    .join(' ');
}

/** Removes inline tags but keeps their (still escaped) content. */
export function stripTags(markup: string): string {
  return markup.replace(TAG, '');
}

export function collapseWhitespace(text: string): string {
  return text.replace(/\s+/g, ' ');
}
