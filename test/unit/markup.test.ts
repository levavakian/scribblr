import { describe, expect, it } from 'vitest';
import { escapeText, parseMarkup, stripTags, tagSignature, unescapeText } from '../../src/shared/markup';

describe('markup', () => {
  it('escapes and unescapes text', () => {
    const text = 'a < b && c > d';
    expect(escapeText(text)).toBe('a &lt; b &amp;&amp; c &gt; d');
    expect(unescapeText(escapeText(text))).toBe(text);
    expect(unescapeText('it&#39;s &quot;fine&quot;')).toBe('it\'s "fine"');
  });

  it('parses tags and text', () => {
    expect(parseMarkup('Lee <t1>la documentación</t1> hoy <x2/>.')).toEqual([
      { kind: 'text', text: 'Lee ' },
      { kind: 'open', n: 1 },
      { kind: 'text', text: 'la documentación' },
      { kind: 'close', n: 1 },
      { kind: 'text', text: ' hoy ' },
      { kind: 'self', n: 2 },
      { kind: 'text', text: '.' },
    ]);
  });

  it('treats <xN>…</xN> as an element kept as-is, dropping its content', () => {
    expect(parseMarkup('ejecuta <x1>npm install</x1> primero')).toEqual([
      { kind: 'text', text: 'ejecuta ' },
      { kind: 'self', n: 1 },
      { kind: 'text', text: ' primero' },
    ]);
  });

  it('leaves other angle brackets as text', () => {
    expect(parseMarkup('usa <div> y &lt;span&gt;')).toEqual([{ kind: 'text', text: 'usa <div> y <span>' }]);
  });

  it('compares tag structure', () => {
    expect(tagSignature(parseMarkup('a <t1>b</t1> <x2/>'))).toBe('o1 c1 s2');
    expect(tagSignature(parseMarkup('<x2/> a <t1>b</t1>'))).toBe('s2 o1 c1');
  });

  it('strips tags but keeps their content', () => {
    expect(stripTags('Read <t1>the docs</t1>, run <x2>npm &amp; co</x2> <x3/>')).toBe('Read the docs, run npm &amp; co ');
  });
});
