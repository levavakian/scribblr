import { ELEMENT_NODE, OWN_TAG, TEXT_NODE, TOOLTIP_TAG, isOwnElement, originalText, ownTextNodes } from './own';

// A run is a stretch of text that reads as one unit: the inline content of a block-level element
// (a paragraph, a list item, a button, a tweet's text…) between any nested block-level elements.
// Its pieces record where each character came from, so a chunk of the run can be mapped back onto
// the DOM.

export interface TextPiece {
  kind: 'text';
  node: Text;
  /** The node's original text (before we shortened it). */
  text: string;
  start: number;
  end: number;
}

/** Start of an inline element. `close` is the index of its ClosePiece, or -1 if the element was
 *  split by a nested block (then it is treated as plain styling). */
export interface OpenPiece {
  kind: 'open';
  el: Element;
  /** Links and similar elements: a chunk takes them whole or not at all. */
  atomic: boolean;
  pos: number;
  close: number;
}

export interface ClosePiece {
  kind: 'close';
  el: Element;
  pos: number;
  open: number;
}

/** An element kept as-is (inline code, an image, an icon). Its text, if any, is context only. */
export interface OpaquePiece {
  kind: 'opaque';
  el: Element;
  text: string;
  start: number;
  end: number;
}

/** A hard line break (<br>). */
export interface BreakPiece {
  kind: 'break';
  el: Element;
  start: number;
  end: number;
}

export type Piece = TextPiece | OpenPiece | ClosePiece | OpaquePiece | BreakPiece;

export interface Run {
  container: Element;
  pieces: Piece[];
  text: string;
  /** Newlines in text nodes are real line breaks (white-space: pre-wrap and friends). */
  preformatted: boolean;
}

export interface ElementStyle {
  display: string;
  visibility: string;
  whiteSpace: string;
  fontFamily: string;
}

export type StyleOf = (el: Element) => ElementStyle;

export const computedStyleOf: StyleOf = (el) => {
  const cs = getComputedStyle(el);
  return { display: cs.display, visibility: cs.visibility, whiteSpace: cs.whiteSpace, fontFamily: cs.fontFamily };
};

type Kind =
  | { kind: 'skip' } // not rendered, or ours: ignore it entirely
  | { kind: 'barrier' } // rendered but never translated, and it splits the surrounding text
  | { kind: 'block' }
  | { kind: 'inline'; atomic: boolean }
  | { kind: 'opaque'; keepText: boolean }
  | { kind: 'break' };

const SKIP = new Set([
  'script', 'style', 'noscript', 'template', 'head', 'title', 'meta', 'link', 'base', 'rt', 'rp',
  'option', 'optgroup', 'datalist', 'frameset', 'frame', 'noembed', 'noframes', 'param', 'source',
  'track', 'map', 'area', 'wbr', 'slot',
]);
/** Never translated; split the text around them when they are block-level. */
const BARRIER = new Set(['pre', 'textarea']);
/** Kept as-is inside text: their text is shown to the model as context. */
const OPAQUE_WITH_TEXT = new Set(['code', 'kbd', 'samp', 'var', 'tt']);
/** Kept as-is inside text: no translatable text. */
const OPAQUE = new Set([
  'img', 'picture', 'video', 'audio', 'canvas', 'iframe', 'object', 'embed', 'input', 'select', 'meter',
  'progress',
]);
const ATOMIC = new Set(['a', 'abbr', 'acronym', 'time', 'button']);
const HTML_NS = 'http://www.w3.org/1999/xhtml';
const ICON_FONT = /icon|symbols|awesome|glyph/i;

function classify(el: Element, styleOf: StyleOf): Kind {
  const tag = el.localName;
  if (SKIP.has(tag) || isOwnElement(el)) return { kind: 'skip' };
  if (el.namespaceURI !== HTML_NS) return tag === 'svg' || tag === 'math' ? { kind: 'opaque', keepText: false } : { kind: 'skip' };
  if (tag === 'br') return { kind: 'break' };

  const style = styleOf(el);
  if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse') return { kind: 'skip' };
  if (style.display === 'contents') return { kind: 'inline', atomic: false };
  const inline = style.display === 'inline' || style.display.startsWith('ruby');

  const editable = ['', 'true', 'plaintext-only'].includes(el.getAttribute('contenteditable') ?? 'false') || el.getAttribute('role') === 'textbox';
  const noTranslate = el.getAttribute('translate') === 'no' || el.classList.contains('notranslate');
  const decorative = el.getAttribute('aria-hidden') === 'true' || ICON_FONT.test(style.fontFamily);
  if (BARRIER.has(tag) || editable || noTranslate || decorative || OPAQUE.has(tag) || OPAQUE_WITH_TEXT.has(tag)) {
    if (!inline) return { kind: 'barrier' };
    return { kind: 'opaque', keepText: OPAQUE_WITH_TEXT.has(tag) || noTranslate };
  }
  if (!inline) return { kind: 'block' };
  return { kind: 'inline', atomic: ATOMIC.has(tag) };
}

function isPreformatted(whiteSpace: string): boolean {
  return /^(pre|pre-wrap|pre-line|break-spaces)$/.test(whiteSpace) || /preserve|break-spaces/.test(whiteSpace);
}

/**
 * Finds the runs of `root` (treated as a block container). With `recurse`, also the runs of every
 * block-level element inside it; without, nested blocks only split root's own runs.
 */
export function scanRuns(root: Element, recurse: boolean, styleOf: StyleOf = computedStyleOf): Run[] {
  const runs: Run[] = [];
  scanContainer(root, recurse, styleOf, runs);
  return runs;
}

function scanContainer(container: Element, recurse: boolean, styleOf: StyleOf, out: Run[]): void {
  const preformatted = isPreformatted(styleOf(container).whiteSpace);
  let run: Run = { container, pieces: [], text: '', preformatted };
  const flush = () => {
    if (run.pieces.some((p) => p.kind === 'text' && /\S/.test(p.text))) out.push(run);
    run = { container, pieces: [], text: '', preformatted };
  };

  const visit = (parent: Node) => {
    for (let child = parent.firstChild; child; child = child.nextSibling) {
      if (child.nodeType === TEXT_NODE) {
        if (ownTextNodes.has(child)) continue;
        const node = child as Text;
        const text = originalText.get(node) ?? node.data;
        if (!text) continue;
        run.pieces.push({ kind: 'text', node, text, start: run.text.length, end: run.text.length + text.length });
        run.text += text;
        continue;
      }
      if (child.nodeType !== ELEMENT_NODE) continue;
      const el = child as Element;
      const c = classify(el, styleOf);
      switch (c.kind) {
        case 'skip':
          break;
        case 'barrier':
          flush();
          break;
        case 'block':
          flush();
          if (recurse) scanContainer(el, recurse, styleOf, out);
          break;
        case 'break': {
          const start = run.text.length;
          run.pieces.push({ kind: 'break', el, start, end: start + 1 });
          run.text += '\n';
          break;
        }
        case 'opaque': {
          const text = c.keepText ? (el.textContent ?? '') : '';
          const start = run.text.length;
          run.pieces.push({ kind: 'opaque', el, text, start, end: start + text.length });
          run.text += text;
          break;
        }
        case 'inline': {
          const opened = run;
          const openIndex = opened.pieces.length;
          const open: OpenPiece = { kind: 'open', el, atomic: c.atomic, pos: opened.text.length, close: -1 };
          opened.pieces.push(open);
          visit(el);
          // If a nested block split the element across runs, it stays "unclosed" and is treated as styling.
          if (run === opened) {
            open.close = opened.pieces.length;
            opened.pieces.push({ kind: 'close', el, pos: opened.text.length, open: openIndex });
          }
          break;
        }
      }
    }
  };

  visit(container);
  flush();
}

/** Ranges of the run's text that a chunk must take whole or not at all. */
export function atomicRanges(run: Run): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  for (const p of run.pieces) {
    if (p.kind === 'open' && p.atomic && p.close >= 0) {
      const close = run.pieces[p.close] as ClosePiece;
      if (close.pos > p.pos) ranges.push([p.pos, close.pos]);
    } else if (p.kind === 'opaque' && p.end > p.start) {
      ranges.push([p.start, p.end]);
    }
  }
  return ranges;
}

/** Positions of hard line breaks, which chunks never cross. */
export function hardBreaks(run: Run): number[] {
  const breaks: number[] = [];
  for (const p of run.pieces) {
    if (p.kind === 'break') breaks.push(p.start);
    else if (p.kind === 'text' && run.preformatted) {
      for (let i = p.text.indexOf('\n'); i >= 0; i = p.text.indexOf('\n', i + 1)) breaks.push(p.start + i);
    }
  }
  return breaks;
}

function isInlineDisplay(display: string): boolean {
  return display === 'inline' || display === 'contents' || display.startsWith('ruby');
}

/** The block-level element that `node`'s text belongs to. */
export function blockContainerOf(node: Node, styleOf: StyleOf = computedStyleOf): Element | null {
  let el = node.nodeType === ELEMENT_NODE ? (node as Element) : node.parentElement;
  while (el && el !== el.ownerDocument.body && el !== el.ownerDocument.documentElement) {
    if (!isInlineDisplay(styleOf(el).display)) return el;
    el = el.parentElement;
  }
  return el;
}

const EXCLUDED = [
  '[contenteditable]:not([contenteditable="false"])', '[role="textbox"]', 'pre', 'textarea', 'script', 'style',
  'noscript', 'template', '[aria-hidden="true"]', '[translate="no"]', '.notranslate', 'svg', 'math', 'code',
  OWN_TAG, TOOLTIP_TAG,
].join(',');

/** True if `el` is (inside) an element whose text must never change: an editor, code, hidden text… */
export function isExcluded(el: Element): boolean {
  if (el.closest(EXCLUDED)) return true;
  return typeof el.checkVisibility === 'function' && !el.checkVisibility();
}

/** Runs inside a newly added element. Its inline text belongs to the surrounding block, which is
 *  rescanned separately, so only block-level descendants are scanned here. */
export function scanAddedSubtree(el: Element, styleOf: StyleOf = computedStyleOf): Run[] {
  const c = classify(el, styleOf);
  if (c.kind === 'block') return scanRuns(el, true, styleOf);
  if (c.kind !== 'inline') return [];
  return [...el.children].flatMap((child) => scanAddedSubtree(child, styleOf));
}
