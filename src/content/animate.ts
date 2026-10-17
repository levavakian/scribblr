import type { Slot } from './apply';

// The split-flap effect: characters start flipping left to right, cycle through random glyphs, and
// settle on the translation. Spaces settle immediately so words keep their shape while they flip.

const STAGGER_MAX_MS = 28;
const SWEEP_MS = 650;
const SPIN_MS = 260;
const TICK_MS = 55;
const FALLBACK_GLYPHS = [...'abcdefghijklmnopqrstuvwxyz'];

function setText(el: HTMLElement, text: string): void {
  const node = el.firstChild;
  if (node && node.nodeType === 3) {
    if ((node as Text).data !== text) (node as Text).data = text;
  } else {
    el.textContent = text;
  }
}

/** A glyph that changes every tick, differently for each character position. */
function pick(glyphs: string[], position: number, tick: number): string {
  let h = Math.imul(position + 1, 0x9e3779b1) ^ Math.imul(tick + 1, 0x85ebca77);
  h ^= h >>> 15;
  return glyphs[(h >>> 0) % glyphs.length]!;
}

function glyphPool(slots: Slot[]): string[] {
  const chars = [...new Set([...slots.map((s) => s.to + s.from).join('')].filter((c) => /\S/.test(c)))];
  return chars.length >= 4 ? chars : FALLBACK_GLYPHS;
}

/** Animates every slot of a chunk from its original text to its translation. Returns a cancel function. */
export function flip(slots: Slot[], options: { instant?: boolean; onDone?: () => void } = {}): () => void {
  const finish = () => {
    for (const s of slots) {
      setText(s.el, s.to);
      s.el.removeAttribute('data-flipping');
    }
    options.onDone?.();
  };
  if (options.instant || slots.every((s) => s.from === s.to)) {
    finish();
    return () => {};
  }

  const chars = slots.map((s) => ({ from: [...s.from], to: [...s.to] }));
  const total = chars.reduce((n, c) => n + Math.max(c.from.length, c.to.length), 0);
  const stagger = Math.min(STAGGER_MAX_MS, SWEEP_MS / Math.max(1, total));
  const glyphs = glyphPool(slots);
  let start = 0;
  let frame = 0;
  for (const s of slots) s.el.setAttribute('data-flipping', '');

  const step = (now: number) => {
    if (!start) start = now;
    const elapsed = now - start;
    const tick = Math.floor(elapsed / TICK_MS);
    let offset = 0;
    let done = true;
    chars.forEach((c, k) => {
      const len = Math.max(c.from.length, c.to.length);
      let out = '';
      for (let j = 0; j < len; j++) {
        const begin = (offset + j) * stagger;
        const from = c.from[j] ?? '';
        const to = c.to[j] ?? '';
        if (elapsed >= begin + SPIN_MS) {
          out += to;
        } else if (elapsed < begin) {
          out += from;
          done = false;
        } else {
          done = false;
          out += /\s/.test(to) ? to : pick(glyphs, offset + j, tick);
        }
      }
      setText(slots[k]!.el, out);
      offset += len;
    });
    if (done) finish();
    else frame = requestAnimationFrame(step);
  };
  frame = requestAnimationFrame(step);

  return () => {
    cancelAnimationFrame(frame);
    finish();
  };
}
