// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import { applyTranslations, revertTranslations } from '../../src/content/apply';
import { buildChunk } from '../../src/content/chunks';
import { OWN_TAG } from '../../src/content/own';
import { type ElementStyle, type Run, atomicRanges, hardBreaks, scanRuns } from '../../src/content/scan';

const BLOCK = new Set(['body', 'div', 'p', 'li', 'ul', 'h1', 'h2', 'section', 'article', 'button', 'pre', 'blockquote']);

// jsdom has no layout, so element display comes from the tag name.
const styleOf = (el: Element): ElementStyle => ({
  display: el.hasAttribute('hidden') ? 'none' : BLOCK.has(el.localName) ? 'block' : 'inline',
  visibility: 'visible',
  whiteSpace: el.localName === 'pre' ? 'pre' : 'normal',
  fontFamily: el.classList.contains('material-icons') ? '"Material Icons"' : 'serif',
});

const ARTICLE = `
  <p id="p1">Cows are <b>great</b>. Read <a href="/cows" id="link">the cow docs</a> or run <code>moo --help</code>.<br>New line</p>
  <div id="d">Intro <p>Nested</p> outro</div>
  <button>Learn more</button>
  <div contenteditable="true">Draft text</div>
  <p hidden>Hidden text</p>
  <p>Open <span class="material-icons">home</span> menu</p>
  <script>var x = 1;</script>`;

function runs(): Run[] {
  return scanRuns(document.body, true, styleOf);
}

function runOf(text: string): Run {
  const run = runs().find((r) => r.text.includes(text));
  if (!run) throw new Error(`no run containing ${text}`);
  return run;
}

function chunkOf(run: Run, text: string) {
  const start = run.text.indexOf(text);
  return buildChunk(run, start, start + text.length);
}

/** What the page shows once the flip animation has finished. */
function finishFlips(applied: ReturnType<typeof applyTranslations>['applied']) {
  for (const c of applied.chunks) for (const s of c.slots) s.el.textContent = s.to;
}

beforeEach(() => {
  document.body.innerHTML = ARTICLE;
});

describe('scanRuns', () => {
  it('finds one run per block of text, skipping editors, hidden text and scripts', () => {
    expect(runs().map((r) => r.text.replace(/\s+/g, ' ').trim())).toEqual([
      'Cows are great. Read the cow docs or run moo --help. New line',
      'Intro',
      'Nested',
      'outro',
      'Learn more',
      'Open menu',
    ]);
  });

  it('records links and inline code as atomic, and <br> as a hard break', () => {
    const run = runOf('Cows');
    const ranges = atomicRanges(run).map(([a, b]) => run.text.slice(a, b));
    expect(ranges).toEqual(['the cow docs', 'moo --help']);
    expect(hardBreaks(run).map((i) => run.text[i])).toEqual(['\n']);
  });
});

describe('buildChunk', () => {
  it('wraps fully contained elements in tags', () => {
    const run = runOf('Cows');
    expect(chunkOf(run, 'Cows are great').markup).toBe('Cows are <t1>great</t1>');
    const link = chunkOf(run, 'Read the cow docs or');
    expect(link.markup).toBe('Read <t1>the cow docs</t1> or');
    expect(link.locked).toBe(true);
    expect(chunkOf(run, 'run moo --help').markup).toBe('run <x1>moo --help</x1>');
  });

  it('escapes text', () => {
    document.body.innerHTML = '<p>if a &lt; b &amp;&amp; c</p>';
    expect(chunkOf(runOf('if'), 'a < b && c').markup).toBe('a &lt; b &amp;&amp; c');
  });
});

describe('applyTranslations', () => {
  it('swaps in a translation without moving or removing page nodes, and reverts exactly', () => {
    const p = document.getElementById('p1')!;
    const link = document.getElementById('link')!;
    const before = p.innerHTML;
    const pageNodes = [...p.childNodes];
    const linkText = link.firstChild;

    const run = runOf('Cows');
    const spec = chunkOf(run, 'Read the cow docs or');
    const { applied, skipped } = applyTranslations(document, [{ id: 'c1', spec, translation: 'Lee <t1>los documentos de vacas</t1> o' }]);
    expect(skipped).toEqual([]);

    // Every page node is still in place; the link is the same element with the same href.
    for (const node of pageNodes) expect(node.parentNode).toBe(p);
    expect(link.parentNode).toBe(p);
    expect(link.getAttribute('href')).toBe('/cows');
    expect(linkText?.parentNode).toBe(link);
    // Our elements start out showing the original text, so nothing jumps before the animation.
    expect(p.textContent).toBe('Cows are great. Read the cow docs or run moo --help.New line');

    finishFlips(applied);
    expect(p.textContent).toBe('Cows are great. Lee los documentos de vacas o run moo --help.New line');
    expect(link.textContent).toBe('los documentos de vacas');
    expect(link.querySelectorAll(OWN_TAG)).toHaveLength(1);

    // Scanning again still sees the original text.
    expect(runOf('Cows').text).toBe(run.text);

    revertTranslations(applied);
    expect(p.innerHTML).toBe(before);
  });

  it('inserts text where the page had none to replace', () => {
    const run = runOf('Cows');
    const spec = chunkOf(run, 'the cow docs or');
    const { applied } = applyTranslations(document, [{ id: 'c1', spec, translation: 'o <t1>los documentos</t1>' }]);
    finishFlips(applied);
    const link = document.getElementById('link')!;
    // "o" goes right before the link, with its trailing space outside the underlined element.
    expect(link.previousSibling?.textContent).toBe(' ');
    expect(link.previousElementSibling?.localName).toBe(OWN_TAG);
    expect(link.previousElementSibling?.textContent).toBe('o');
    expect(document.getElementById('p1')!.textContent).toBe('Cows are great. Read o los documentos run moo --help.New line');
  });

  it('skips a chunk with a link when the model drops its tags', () => {
    const spec = chunkOf(runOf('Cows'), 'Read the cow docs or');
    const { applied, skipped } = applyTranslations(document, [{ id: 'c1', spec, translation: 'Lee los documentos o' }]);
    expect(skipped).toEqual(['c1']);
    expect(applied.inserted).toHaveLength(0);
  });

  it('puts the whole translation in the first slot when only styling tags were lost', () => {
    const spec = chunkOf(runOf('Cows'), 'Cows are great');
    const { applied, skipped } = applyTranslations(document, [{ id: 'c1', spec, translation: 'Las vacas son geniales' }]);
    expect(skipped).toEqual([]);
    finishFlips(applied);
    expect(document.getElementById('p1')!.textContent?.startsWith('Las vacas son geniales. Read')).toBe(true);
  });

  it('applies several chunks inside one text node', () => {
    document.body.innerHTML = '<p id="p">one two three four five</p>';
    const run = runOf('one');
    const { applied } = applyTranslations(document, [
      { id: 'a', spec: chunkOf(run, 'two'), translation: 'dos' },
      { id: 'b', spec: chunkOf(run, 'four'), translation: 'cuatro' },
    ]);
    finishFlips(applied);
    expect(document.getElementById('p')!.textContent).toBe('one dos three cuatro five');
    revertTranslations(applied);
    expect(document.getElementById('p')!.innerHTML).toBe('one two three four five');
  });

  it("keeps the page's own text when the page rewrote a node we had shortened", () => {
    document.body.innerHTML = '<p id="p">Streaming reply so far</p>';
    const p = document.getElementById('p')!;
    const node = p.firstChild as Text;
    const { applied } = applyTranslations(document, [{ id: 'a', spec: chunkOf(runOf('Streaming'), 'reply'), translation: 'respuesta' }]);
    // The page (say, React streaming more tokens) overwrites the node it owns.
    node.data = 'Streaming reply so far, and more';
    revertTranslations(applied, new Set([node]));
    expect(p.innerHTML).toBe('Streaming reply so far, and more');
  });
});
