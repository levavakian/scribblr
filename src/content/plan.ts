import type { Segmentation } from './segment';

// Deciding what to translate in one run of text.
//
// 1. Cut the run into consecutive segments. Each segment's size is drawn from a distribution over
//    five levels (word, phrase, clause, sentence, paragraph) centred on the chunk-size slider, and
//    segments respect clause and sentence boundaries.
// 2. Go through the segments in random order, taking each one that still fits within the word target
//    (fraction × words). Whatever gap remains is smaller than every segment left over, so the smallest
//    leftover is taken with probability gap / its size. The expected number of words translated is
//    exactly the target, and a text lands within one (small) segment of it. A one-word button at 40%
//    is translated in 40% of page views rather than 40% of the word.
// 3. Merge picked segments that touch within one sentence, so the model translates them together.

export interface PlanOptions {
  /** 0–1: the share of words to translate. */
  fraction: number;
  /** 0 (word) … 4 (paragraph): the centre of the chunk-size distribution. */
  sizeLevel: number;
  random: () => number;
}

/** A chunk as a range of units: [startUnit, endUnit). */
export interface PlannedChunk {
  startUnit: number;
  endUnit: number;
}

const LEVELS = 5;
const SPREAD = 0.75;

export function levelWeights(centre: number): number[] {
  return Array.from({ length: LEVELS }, (_, k) => Math.exp(-((k - centre) ** 2) / (2 * SPREAD * SPREAD)));
}

function sampleLevel(weights: number[], random: () => number): number {
  const total = weights.reduce((a, b) => a + b, 0);
  let r = random() * total;
  for (let k = 0; k < weights.length; k++) {
    r -= weights[k]!;
    if (r < 0) return k;
  }
  return weights.length - 1;
}

/** stops[i]: index just past the end of the span (clause, sentence, line) containing unit i. */
function stopsWhere(n: number, endsAfter: (i: number) => boolean): number[] {
  const stops = new Array<number>(n);
  let stop = n;
  for (let i = n - 1; i >= 0; i--) {
    if (endsAfter(i)) stop = i + 1;
    stops[i] = stop;
  }
  return stops;
}

export function segmentRun(seg: Segmentation, sizeLevel: number, random: () => number): Array<[number, number]> {
  const n = seg.units.length;
  const clauseStop = stopsWhere(n, (i) => seg.clauseEnd[i]!);
  const sentenceStop = stopsWhere(n, (i) => i === n - 1 || seg.sentence[i] !== seg.sentence[i + 1] || seg.lineEnd[i]!);
  const lineStop = stopsWhere(n, (i) => seg.lineEnd[i]!);
  const weights = levelWeights(sizeLevel);

  const segments: Array<[number, number]> = [];
  for (let i = 0; i < n; ) {
    let j: number;
    switch (sampleLevel(weights, random)) {
      case 0: // a word
        j = i + 1;
        break;
      case 1: // a phrase: 2–3 words within a clause
        j = Math.min(i + 2 + Math.floor(random() * 2), clauseStop[i]!);
        break;
      case 2: {
        // a clause, or 4–8 words of a long one
        const stop = clauseStop[i]!;
        j = stop - i <= 8 ? stop : i + 4 + Math.floor(random() * 5);
        break;
      }
      case 3: // the rest of the sentence
        j = sentenceStop[i]!;
        break;
      default: // the rest of the paragraph (up to a line break)
        j = lineStop[i]!;
    }
    j = Math.max(i + 1, j);
    // Don't end on an article that belongs to the next word: "around the" takes "world" along.
    while (j < clauseStop[i]! && seg.joinsNext[j - 1]) j++;
    segments.push([i, j]);
    i = j;
  }
  return segments;
}

export function planChunks(seg: Segmentation, options: PlanOptions): PlannedChunk[] {
  const { fraction, sizeLevel, random } = options;
  if (!seg.units.length || fraction <= 0) return [];

  const words = (a: number, b: number) => seg.units.slice(a, b).filter((u) => u.translatable).length;
  const candidates = segmentRun(seg, sizeLevel, random)
    .map(([a, b]) => ({ a, b, size: words(a, b) }))
    .filter((s) => s.size > 0);
  const target = candidates.reduce((n, s) => n + s.size, 0) * Math.min(1, fraction);

  // Fisher–Yates shuffle, then fill up to the target.
  for (let i = candidates.length - 1; i > 0; i--) {
    const r = Math.floor(random() * (i + 1));
    [candidates[i], candidates[r]] = [candidates[r]!, candidates[i]!];
  }
  const chosen: Array<[number, number]> = [];
  let taken = 0;
  let smallestLeftover: (typeof candidates)[number] | undefined;
  for (const s of candidates) {
    if (taken + s.size <= target + 1e-9) {
      chosen.push([s.a, s.b]);
      taken += s.size;
    } else if (!smallestLeftover || s.size < smallestLeftover.size) {
      smallestLeftover = s;
    }
  }
  if (smallestLeftover && random() < (target - taken) / smallestLeftover.size) chosen.push([smallestLeftover.a, smallestLeftover.b]);
  chosen.sort((x, y) => x[0] - y[0]);

  const merged: PlannedChunk[] = [];
  for (const [a, b] of chosen) {
    const last = merged[merged.length - 1];
    if (last && last.endUnit === a && seg.sentence[a - 1] === seg.sentence[a] && !seg.lineEnd[a - 1]) {
      last.endUnit = b;
    } else {
      merged.push({ startUnit: a, endUnit: b });
    }
  }
  return merged;
}
