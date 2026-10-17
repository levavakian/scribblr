import { describe, expect, it } from 'vitest';
import { segmentText } from '../../src/content/segment';

const words = (text: string, seg: ReturnType<typeof segmentText>) => seg.units.map((u) => text.slice(u.start, u.end));

describe('segmentText', () => {
  it('finds words, sentences and clause boundaries', () => {
    const text = 'Cows are great. They have big friendly eyes, and they love people.';
    const seg = segmentText(text, 'en');
    expect(words(text, seg)).toEqual(['Cows', 'are', 'great', 'They', 'have', 'big', 'friendly', 'eyes', 'and', 'they', 'love', 'people']);
    expect(seg.sentence).toEqual([0, 0, 0, 1, 1, 1, 1, 1, 1, 1, 1, 1]);
    // Clause ends after "great" (sentence end), "eyes" (comma) and "people" (end of text).
    expect(seg.clauseEnd.flatMap((end, i) => (end ? [i] : []))).toEqual([2, 7, 11]);
  });

  it('keeps hyphenated words and abbreviations whole', () => {
    const text = "A well-known U.S. author's work";
    expect(words(text, segmentText(text, 'en'))).toEqual(['A', 'well-known', 'U.S', "author's", 'work']);
  });

  it('merges words covered by a link into one unit', () => {
    const text = 'Read the docs today';
    const seg = segmentText(text, 'en', [[5, 13]]);
    expect(words(text, seg)).toEqual(['Read', 'the docs', 'today']);
  });

  it('extends an atomic range over words that overlap it', () => {
    const text = "Google's search";
    // A link around "Google" only; the word "Google's" overlaps it, so they become one unit.
    expect(words(text, segmentText(text, 'en', [[0, 6]]))).toEqual(["Google's", 'search']);
  });

  it('marks numbers as not translatable', () => {
    const seg = segmentText('Since 2024 we', 'en');
    expect(seg.units.map((u) => u.translatable)).toEqual([true, false, true]);
  });

  it('treats hard line breaks as boundaries but ignores source newlines', () => {
    const text = 'First line\nsecond line';
    const soft = segmentText(text, 'en');
    expect(soft.sentence).toEqual([0, 0, 0, 0]);
    expect(soft.lineEnd.slice(0, 3)).toEqual([false, false, false]);

    const hard = segmentText(text, 'en', [], [10]);
    expect(hard.sentence[1]).not.toBe(hard.sentence[2]);
    expect(hard.lineEnd[1]).toBe(true);
    expect(hard.clauseEnd[1]).toBe(true);
  });

  it('marks articles that lean on the next word', () => {
    const en = 'Around the world, my cows';
    expect(segmentText(en, 'en').joinsNext).toEqual([false, true, false, true, false]);
    const es = 'Alrededor del mundo, mis vacas';
    expect(segmentText(es, 'es').joinsNext).toEqual([false, true, false, true, false]);
    expect(segmentText(en, 'ja').joinsNext.every((j) => !j)).toBe(true);
  });

  it('segments languages without spaces', () => {
    const text = '私は猫が好きです。';
    const seg = segmentText(text, 'ja');
    expect(seg.units.length).toBeGreaterThan(2);
    expect(seg.units.every((u) => u.translatable)).toBe(true);
  });
});
