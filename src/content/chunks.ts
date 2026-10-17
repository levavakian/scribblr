import { collapseWhitespace, escapeText } from '../shared/markup';
import type { ClosePiece, Run, TextPiece } from './scan';

// A chunk's skeleton lists, in order, the page text it covers (slots) and the elements fully inside
// it (tags). The model sees the same structure as markup, e.g. `Read <t1>the docs</t1> now`, and
// must return the same tags. Each piece of the translation then goes back where it came from, so
// links keep working and bold text stays bold.

export type SkeletonToken =
  | { kind: 'slot'; piece: TextPiece; from: number; to: number }
  | { kind: 'open'; n: number; el: Element }
  | { kind: 'close'; n: number; el: Element }
  | { kind: 'self'; n: number; el: Element };

export type SlotToken = Extract<SkeletonToken, { kind: 'slot' }>;

export interface ChunkSpec {
  /** Range of the run's text. */
  start: number;
  end: number;
  /** What the model sees: escaped text with inline tags. */
  markup: string;
  /** The original text, shown when hovering the translation. */
  original: string;
  skeleton: SkeletonToken[];
  /** Contains a link or an element kept as-is, so its tags must survive translation. */
  locked: boolean;
}

export function buildChunk(run: Run, start: number, end: number): ChunkSpec {
  const skeleton: SkeletonToken[] = [];
  const tagOfOpen = new Map<number, number>();
  let next = 1;
  let markup = '';
  let locked = false;

  run.pieces.forEach((p, index) => {
    switch (p.kind) {
      case 'text': {
        const from = Math.max(start, p.start) - p.start;
        const to = Math.min(end, p.end) - p.start;
        if (to > from) {
          skeleton.push({ kind: 'slot', piece: p, from, to });
          markup += escapeText(p.text.slice(from, to));
        }
        break;
      }
      case 'open': {
        if (p.close < 0) break;
        const close = run.pieces[p.close] as ClosePiece;
        if (p.pos >= start && close.pos <= end && close.pos > p.pos) {
          const n = next++;
          tagOfOpen.set(index, n);
          skeleton.push({ kind: 'open', n, el: p.el });
          markup += `<t${n}>`;
          if (p.atomic) locked = true;
        }
        break;
      }
      case 'close': {
        const n = tagOfOpen.get(p.open);
        if (n !== undefined) {
          skeleton.push({ kind: 'close', n, el: p.el });
          markup += `</t${n}>`;
        }
        break;
      }
      case 'opaque': {
        const inside = p.end > p.start ? p.start >= start && p.end <= end : p.start > start && p.start < end;
        if (inside) {
          const n = next++;
          skeleton.push({ kind: 'self', n, el: p.el });
          markup += p.text ? `<x${n}>${escapeText(p.text)}</x${n}>` : `<x${n}/>`;
          locked = true;
        }
        break;
      }
      case 'break':
        break;
    }
  });

  return {
    start,
    end,
    markup: collapseWhitespace(markup).trim(),
    original: collapseWhitespace(run.text.slice(start, end)).trim(),
    skeleton,
    locked,
  };
}
