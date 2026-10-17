import { collapseWhitespace, parseMarkup, tagSignature } from '../shared/markup';
import type { ChunkSpec, SlotToken } from './chunks';
import { OWN_TAG, originalText, ownTextNodes } from './own';

/** One of our elements, showing (part of) a translated chunk. */
export interface Slot {
  el: HTMLElement;
  from: string;
  to: string;
}

/**
 * 'translate': the chunk is shown in the target language; hovering shows the original.
 * 'practice': the chunk stays as it is, for the reader to translate in their head; hovering shows
 * the translation.
 */
export type ChunkMode = 'translate' | 'practice';

/** What the tooltip shows for a chunk. */
export interface Hover {
  label: string;
  text: string;
}

export interface AppliedChunk {
  id: string;
  mode: ChunkMode;
  hover: Hover;
  slots: Slot[];
}

export interface AppliedBlock {
  /** Page text nodes we shortened → their original text. */
  edits: Map<Text, string>;
  /** Nodes we inserted, all removed again on revert. */
  inserted: Node[];
  chunks: AppliedChunk[];
}

type Placement =
  | { kind: 'slot'; token: SlotToken; to: string }
  | { kind: 'insert'; where: 'before' | 'prepend' | 'after'; el: Element; to: string };

/**
 * Splits a translation along the chunk's tags and decides where each piece goes. Returns null when
 * the model mangled the tags of a chunk containing a link or kept element, which would otherwise be
 * lost or duplicated.
 */
export function placeTranslation(spec: ChunkSpec, translation: string): Placement[] | null {
  const tokens = parseMarkup(translation.trim());
  const slots = spec.skeleton.filter((t): t is SlotToken => t.kind === 'slot');

  if (tagSignature(tokens) !== tagSignature(spec.skeleton)) {
    if (spec.locked || !slots.length) return null;
    // Only styling tags were lost: put the whole translation where the chunk starts.
    const text = tokens.map((t) => (t.kind === 'text' ? t.text : '')).join('');
    return slots.map((token, i) => ({ kind: 'slot', token, to: i === 0 ? text : '' }));
  }

  // Tags split both the skeleton and the translation into the same number of regions.
  const tags = spec.skeleton.filter((t) => t.kind !== 'slot');
  const regionTexts = [''];
  for (const t of tokens) {
    if (t.kind === 'text') regionTexts[regionTexts.length - 1] += t.text;
    else regionTexts.push('');
  }
  const regionSlots: SlotToken[][] = [[]];
  for (const t of spec.skeleton) {
    if (t.kind === 'slot') regionSlots[regionSlots.length - 1]!.push(t);
    else regionSlots.push([]);
  }

  const placements: Placement[] = [];
  regionSlots.forEach((regionSlot, r) => {
    const text = regionTexts[r] ?? '';
    if (regionSlot.length) {
      regionSlot.forEach((token, i) => placements.push({ kind: 'slot', token, to: i === 0 ? text : '' }));
      return;
    }
    if (!text.trim()) return;
    // No page text in this region to replace, so insert ours next to the neighbouring tag's element.
    if (r === 0) {
      placements.push({ kind: 'insert', where: 'before', el: tags[0]!.el, to: text });
    } else {
      const prev = tags[r - 1]!;
      placements.push({ kind: 'insert', where: prev.kind === 'open' ? 'prepend' : 'after', el: prev.el, to: text });
    }
  });
  return placements;
}

/** A translation as plain text, with each kept element's own text in its place. */
export function plainTranslation(spec: ChunkSpec, translation: string): string {
  const kept = new Map(spec.skeleton.flatMap((t) => (t.kind === 'self' ? [[t.n, t.el.textContent ?? ''] as const] : [])));
  const text = parseMarkup(translation)
    .map((t) => (t.kind === 'text' ? t.text : t.kind === 'self' ? (kept.get(t.n) ?? '') : ''))
    .join('');
  return collapseWhitespace(text).trim();
}

/** Practice chunks keep their own text: every slot simply shows what it showed before. */
function practicePlacements(spec: ChunkSpec): Placement[] {
  return spec.skeleton.flatMap((t) => (t.kind === 'slot' ? [{ kind: 'slot' as const, token: t, to: t.piece.text.slice(t.from, t.to) }] : []));
}

function makeSlotElement(doc: Document, chunkId: string, text: string, mode: ChunkMode): HTMLElement {
  const el = doc.createElement(OWN_TAG);
  el.setAttribute('data-chunk', chunkId);
  if (mode === 'practice') el.setAttribute('data-mode', 'practice');
  el.setAttribute('dir', 'auto');
  el.appendChild(doc.createTextNode(text));
  return el;
}

/**
 * Puts translations into the page. Every new element starts out showing the original text, so
 * nothing changes visually until the flip animation runs.
 */
export function applyTranslations(
  doc: Document,
  items: Array<{ id: string; spec: ChunkSpec; translation: string; mode?: ChunkMode }>,
): { applied: AppliedBlock; skipped: string[] } {
  const applied: AppliedBlock = { edits: new Map(), inserted: [], chunks: [] };
  const skipped: string[] = [];
  const cuts = new Map<Text, Array<{ from: number; to: number; el: HTMLElement; original: string }>>();
  const inserts: Array<{ where: 'before' | 'prepend' | 'after'; at: Element; el: HTMLElement; lead: string; trail: string }> = [];

  for (const item of items) {
    const mode = item.mode ?? 'translate';
    const placements = mode === 'practice' ? practicePlacements(item.spec) : placeTranslation(item.spec, item.translation);
    if (!placements) {
      skipped.push(item.id);
      continue;
    }
    const hover: Hover =
      mode === 'practice'
        ? { label: 'Translation', text: plainTranslation(item.spec, item.translation) }
        : { label: 'Original', text: item.spec.original };
    const chunk: AppliedChunk = { id: item.id, mode, hover, slots: [] };
    for (const p of placements) {
      if (p.kind === 'slot') {
        // A space at the edge of a slot stays page text when the translation has one there too, so
        // the underline only covers words.
        let { from: start, to: end } = p.token;
        let to = p.to;
        const text = p.token.piece.text;
        if (text.slice(start, end).trim()) {
          if (/^\s/.test(text.slice(start, end)) && /^\s/.test(to)) {
            while (/\s/.test(text[start]!)) start++;
            to = to.trimStart();
          }
          if (/\s$/.test(text.slice(start, end)) && /\s$/.test(to)) {
            while (/\s/.test(text[end - 1]!)) end--;
            to = to.trimEnd();
          }
        }
        const from = text.slice(start, end);
        const el = makeSlotElement(doc, item.id, from, mode);
        const list = cuts.get(p.token.piece.node) ?? [];
        list.push({ from: start, to: end, el, original: text });
        cuts.set(p.token.piece.node, list);
        chunk.slots.push({ el, from, to });
      } else {
        const el = makeSlotElement(doc, item.id, '', mode);
        const core = p.to.trim();
        inserts.push({ where: p.where, at: p.el, el, lead: /^\s*/.exec(p.to)![0], trail: core ? /\s*$/.exec(p.to)![0] : '' });
        chunk.slots.push({ el, from: '', to: core });
      }
    }
    applied.chunks.push(chunk);
  }

  for (const [node, list] of cuts) {
    list.sort((a, b) => a.from - b.from);
    const original = list[0]!.original;
    applied.edits.set(node, original);
    originalText.set(node, original);
    // The page's node stays where it is and keeps the text before the first cut.
    node.data = original.slice(0, list[0]!.from);
    let after: Node = node;
    list.forEach((cut, i) => {
      after.parentNode!.insertBefore(cut.el, after.nextSibling);
      applied.inserted.push(cut.el);
      after = cut.el;
      const keep = original.slice(cut.to, list[i + 1]?.from ?? original.length);
      if (keep) {
        const rest = doc.createTextNode(keep);
        ownTextNodes.add(rest);
        after.parentNode!.insertBefore(rest, after.nextSibling);
        applied.inserted.push(rest);
        after = rest;
      }
    });
  }

  for (const ins of inserts) {
    // Spaces around inserted text are plain text nodes, outside the underline.
    const nodes: Node[] = [];
    for (const [text, node] of [[ins.lead, null], ['', ins.el], [ins.trail, null]] as const) {
      if (node) {
        nodes.push(node);
      } else if (text) {
        const space = doc.createTextNode(text);
        ownTextNodes.add(space);
        nodes.push(space);
      }
    }
    if (ins.where === 'before') ins.at.before(...nodes);
    else if (ins.where === 'prepend') ins.at.prepend(...nodes);
    else ins.at.after(...nodes);
    applied.inserted.push(...nodes);
  }

  return { applied, skipped };
}

/**
 * Undoes applyTranslations. Nodes in `changedByPage` were rewritten by the page itself; their new
 * text is kept.
 */
export function revertTranslations(applied: AppliedBlock, changedByPage?: ReadonlySet<Node>): void {
  for (const node of applied.inserted) node.parentNode?.removeChild(node);
  for (const [node, original] of applied.edits) {
    originalText.delete(node);
    if (!changedByPage?.has(node) && node.data !== original) node.data = original;
  }
}
