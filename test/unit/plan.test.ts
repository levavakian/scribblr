import { describe, expect, it } from 'vitest';
import { levelWeights, planBoth, planChunks } from '../../src/content/plan';
import { segmentText } from '../../src/content/segment';
import { seededRandom } from '../../src/shared/hash';

const ARTICLE = [
  'The cow is a large domesticated mammal, raised on farms around the world for milk, meat and leather.',
  'Cows are social animals: they form close bonds with each other, and they recognise familiar faces.',
  'A typical dairy cow spends about eight hours a day eating, and around twelve hours lying down.',
  'Despite their calm reputation, cows can run surprisingly fast when something frightens them.',
  'In many cultures, cows hold a special place in stories, festivals and everyday life.',
].join(' ');

function translatedShare(text: string, fraction: number, sizeLevel: number, seed: number) {
  const seg = segmentText(text, 'en');
  const chunks = planChunks(seg, { fraction, sizeLevel, random: seededRandom(seed) });
  const covered = chunks.reduce((n, c) => n + seg.units.slice(c.startUnit, c.endUnit).filter((u) => u.translatable).length, 0);
  return { share: covered / seg.units.filter((u) => u.translatable).length, chunks, seg };
}

describe('planChunks', () => {
  it('translates a single word about `fraction` of the time', () => {
    for (const fraction of [0.2, 0.4, 0.75]) {
      let translated = 0;
      const trials = 4000;
      for (let seed = 0; seed < trials; seed++) translated += translatedShare('Subscribe', fraction, 1, seed).share;
      expect(translated / trials).toBeCloseTo(fraction, 1);
    }
  });

  it('translates a short element whole or not at all at paragraph size', () => {
    let whole = 0;
    const trials = 4000;
    for (let seed = 0; seed < trials; seed++) {
      const { share } = translatedShare('Learn more about cows', 0.4, 4, seed);
      expect([0, 1]).toContain(share);
      whole += share;
    }
    expect(whole / trials).toBeCloseTo(0.4, 1);
  });

  it('lands near `fraction` of the words in a long text', () => {
    for (const sizeLevel of [0, 1, 2]) {
      const shares = Array.from({ length: 300 }, (_, seed) => translatedShare(ARTICLE, 0.4, sizeLevel, seed).share);
      const mean = shares.reduce((a, b) => a + b, 0) / shares.length;
      expect(mean).toBeGreaterThan(0.36);
      expect(mean).toBeLessThan(0.44);
      // Filling up to the target keeps every single text close to the slider, too. At clause size
      // the mix occasionally includes a whole-paragraph chunk, which is all or nothing.
      const within = shares.filter((s) => Math.abs(s - 0.4) < 0.15).length / shares.length;
      expect(within).toBeGreaterThan(sizeLevel < 2 ? 0.99 : 0.85);
    }
  });

  it('makes bigger chunks as the size slider goes up', () => {
    const meanChunkLength = (sizeLevel: number) => {
      let units = 0;
      let count = 0;
      for (let seed = 0; seed < 200; seed++) {
        for (const c of translatedShare(ARTICLE, 0.3, sizeLevel, seed).chunks) {
          units += c.endUnit - c.startUnit;
          count++;
        }
      }
      return units / count;
    };
    const lengths = [0, 1, 2, 3, 4].map(meanChunkLength);
    for (let i = 1; i < lengths.length; i++) expect(lengths[i]).toBeGreaterThan(lengths[i - 1]!);
    expect(lengths[0]).toBeLessThan(2);
    expect(lengths[4]).toBeGreaterThan(15);
  });

  it('never ends a chunk on an article that belongs to the next word', () => {
    const text = 'Cows are raised on farms around the world for milk, and a cow can see almost all the way around her.';
    for (const sizeLevel of [0, 1, 2]) {
      for (let seed = 0; seed < 300; seed++) {
        const { chunks, seg } = translatedShare(text, 0.5, sizeLevel, seed);
        for (const c of chunks) {
          const last = seg.units[c.endUnit - 1]!;
          expect(['the', 'a']).not.toContain(text.slice(last.start, last.end));
        }
      }
    }
  });

  it('never crosses a line break, even at paragraph size', () => {
    const text = 'One two three four five\nsix seven eight nine ten';
    const seg = segmentText(text, 'en', [], [text.indexOf('\n')]);
    for (let seed = 0; seed < 200; seed++) {
      for (const c of planChunks(seg, { fraction: 1, sizeLevel: 4, random: seededRandom(seed) })) {
        const hasBreak = seg.lineEnd.slice(c.startUnit, c.endUnit - 1).some(Boolean);
        expect(hasBreak).toBe(false);
      }
    }
  });

  it('covers everything at 100% and nothing at 0%', () => {
    expect(translatedShare(ARTICLE, 1, 1, 7).share).toBe(1);
    expect(translatedShare(ARTICLE, 0, 1, 7).chunks).toEqual([]);
  });

  it('is deterministic for a seed', () => {
    expect(translatedShare(ARTICLE, 0.4, 1, 42).chunks).toEqual(translatedShare(ARTICLE, 0.4, 1, 42).chunks);
    expect(translatedShare(ARTICLE, 0.4, 1, 42).chunks).not.toEqual(translatedShare(ARTICLE, 0.4, 1, 43).chunks);
  });

  it('centres the size distribution on the slider', () => {
    const weights = levelWeights(1);
    expect(weights.indexOf(Math.max(...weights))).toBe(1);
    expect(weights[0]).toBeGreaterThan(weights[3]!);
  });
});

describe('planBoth (translated and practice chunks)', () => {
  const plan = (text: string, p1: number, p2: number, seed: number, s1 = 1, s2 = 1) => {
    const seg = segmentText(text, 'en');
    const result = planBoth(
      seg,
      { fraction: p1, sizeLevel: s1, random: seededRandom(seed) },
      { fraction: p2, sizeLevel: s2, random: seededRandom(seed + 7_919) },
    );
    const words = (chunks: Array<{ startUnit: number; endUnit: number }>) =>
      chunks.reduce((n, c) => n + seg.units.slice(c.startUnit, c.endUnit).filter((u) => u.translatable).length, 0);
    const total = seg.units.filter((u) => u.translatable).length;
    return { ...result, seg, translatedShare: words(result.translate) / total, practiceShare: words(result.practice) / total };
  };

  it('never overlaps the two kinds of chunk', () => {
    for (let seed = 0; seed < 300; seed++) {
      const { translate, practice } = plan(ARTICLE, 0.4, 0.4, seed, seed % 5, (seed + 2) % 5);
      const covered = new Set<number>();
      for (const c of translate) for (let i = c.startUnit; i < c.endUnit; i++) covered.add(i);
      for (const c of practice) for (let i = c.startUnit; i < c.endUnit; i++) expect(covered.has(i)).toBe(false);
    }
  });

  it('gives each kind its own share of the words', () => {
    const runs = Array.from({ length: 300 }, (_, seed) => plan(ARTICLE, 0.3, 0.2, seed));
    const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
    expect(mean(runs.map((r) => r.translatedShare))).toBeCloseTo(0.3, 1);
    expect(mean(runs.map((r) => r.practiceShare))).toBeCloseTo(0.2, 1);
  });

  it('makes a single word a practice chunk about `practice` of the time', () => {
    let translated = 0;
    let practiced = 0;
    const trials = 4000;
    for (let seed = 0; seed < trials; seed++) {
      const r = plan('Subscribe', 0.3, 0.2, seed);
      translated += r.translatedShare;
      practiced += r.practiceShare;
    }
    expect(translated / trials).toBeCloseTo(0.3, 1);
    expect(practiced / trials).toBeCloseTo(0.2, 1);
  });

  it('caps practice at whatever the translated chunks leave', () => {
    for (let seed = 0; seed < 50; seed++) {
      const r = plan(ARTICLE, 0.7, 0.6, seed);
      expect(r.translatedShare + r.practiceShare).toBeCloseTo(1, 5);
    }
  });

  it('keeps the translated chunks the same when only the practice settings change', () => {
    for (let seed = 0; seed < 50; seed++) {
      expect(plan(ARTICLE, 0.4, 0.1, seed, 1, 0).translate).toEqual(plan(ARTICLE, 0.4, 0.5, seed, 1, 4).translate);
    }
  });
});
