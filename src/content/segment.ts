// Splits a run's text into units (words, or whole links / inline code) and finds the clause and
// sentence boundaries between them. Chunks are always made of whole units.

export interface Unit {
  start: number;
  end: number;
  /** Contains letters. Units that are only numbers or symbols don't count as words to translate. */
  translatable: boolean;
}

export interface Segmentation {
  units: Unit[];
  /** Sentence index of each unit. Hard line breaks also start a new sentence. */
  sentence: number[];
  /** clauseEnd[i]: a clause boundary (punctuation, sentence end, line break) follows unit i. */
  clauseEnd: boolean[];
  /** lineEnd[i]: a hard line break follows unit i. Chunks never cross one. */
  lineEnd: boolean[];
  /** joinsNext[i]: unit i is an article or similar that belongs with the next word, so a chunk
   *  shouldn't end on it ("around the | world"). */
  joinsNext: boolean[];
}

// Articles, possessives and demonstratives: words that lean on the word after them.
const LEADING_WORDS: Record<string, string> = {
  en: 'a an the this that these those my your his her its our their some any every each no to',
  es: 'el la los las un una unos unas lo al del mi mis tu tus su sus nuestro nuestra nuestros nuestras este esta estos estas ese esa esos esas cada',
  fr: "le la les un une des du au aux l' mon ma mes ton ta tes son sa ses notre nos votre vos leur leurs ce cet cette ces chaque",
  de: 'der die das den dem des ein eine einen einem einer eines kein keine mein meine dein deine sein seine ihr ihre unser unsere euer eure jeder jede jedes zum zur',
  it: "il lo la i gli le un uno una un' l' del dello della dei degli delle al allo alla ai agli alle mio mia miei mie tuo tua suo sua nostro nostra ogni",
  pt: 'o a os as um uma uns umas do da dos das no na nos nas ao à aos às meu minha meus minhas seu sua seus suas este esta esse essa cada',
  nl: 'de het een mijn jouw je zijn haar ons onze hun deze dit die dat elk elke',
};
const leadingWordSets = new Map<string, Set<string>>();

function leadingWords(lang: string): Set<string> {
  const primary = lang.toLowerCase().split(/[-_]/)[0] ?? '';
  let set = leadingWordSets.get(primary);
  if (!set) {
    set = new Set((LEADING_WORDS[primary] ?? '').split(' ').filter(Boolean));
    leadingWordSets.set(primary, set);
  }
  return set;
}

interface Segmenters {
  word: Intl.Segmenter;
  sentence: Intl.Segmenter;
}

const segmenterCache = new Map<string, Segmenters>();

function segmentersFor(lang: string): Segmenters {
  let s = segmenterCache.get(lang);
  if (!s) {
    let locale: string | undefined = lang;
    try {
      new Intl.Segmenter(locale);
    } catch {
      locale = undefined;
    }
    s = {
      word: new Intl.Segmenter(locale, { granularity: 'word' }),
      sentence: new Intl.Segmenter(locale, { granularity: 'sentence' }),
    };
    segmenterCache.set(lang, s);
  }
  return s;
}

/** Characters joining two words into one ("well-known", "U.S", "l'eau"). */
const JOINER = /^[-‐‑'’.·]$/;
const CLAUSE_PUNCTUATION = /[,;:()[\]{}"“”«»„‹›–—…|/•·、，；：（）「」『』]|\s-\s|\.\.\./;

export function segmentText(
  text: string,
  lang: string,
  atomic: ReadonlyArray<readonly [number, number]> = [],
  breaks: readonly number[] = [],
): Segmentation {
  const breakSet = new Set(breaks);
  // Same length as `text`, so offsets line up: formatting whitespace (newlines in the HTML source)
  // becomes plain spaces, and only real line breaks stay newlines.
  const normalized = text.replace(/\s/g, (_: string, offset: number) => (breakSet.has(offset) ? '\n' : ' '));
  const { word, sentence } = segmentersFor(lang);

  type Interval = { start: number; end: number; atomic: boolean };
  const intervals: Interval[] = [];
  for (const s of word.segment(normalized)) {
    if (!s.isWordLike) continue;
    const prev = intervals[intervals.length - 1];
    if (prev && JOINER.test(normalized.slice(prev.end, s.index)) && !breakSet.has(prev.end)) {
      prev.end = s.index + s.segment.length;
      continue;
    }
    intervals.push({ start: s.index, end: s.index + s.segment.length, atomic: false });
  }
  for (const [start, end] of atomic) if (end > start) intervals.push({ start, end, atomic: true });
  intervals.sort((a, b) => a.start - b.start || b.end - a.end);

  const units: Unit[] = [];
  let current: Interval | null = null;
  const push = (iv: Interval) => units.push({ start: iv.start, end: iv.end, translatable: /\p{L}/u.test(text.slice(iv.start, iv.end)) });
  for (const iv of intervals) {
    if (current && iv.start < current.end) {
      current.end = Math.max(current.end, iv.end);
      current.atomic ||= iv.atomic;
      continue;
    }
    if (current) push(current);
    current = { ...iv };
  }
  if (current) push(current);

  const sentenceStarts: number[] = [];
  for (const s of sentence.segment(normalized)) if (s.index > 0) sentenceStarts.push(s.index);
  for (const b of breaks) sentenceStarts.push(b + 1);
  sentenceStarts.sort((a, b) => a - b);

  const sentenceOf: number[] = [];
  const clauseEnd: boolean[] = [];
  const lineEnd: boolean[] = [];
  let boundary = 0;
  units.forEach((u, i) => {
    while (boundary < sentenceStarts.length && sentenceStarts[boundary]! <= u.start) boundary++;
    sentenceOf.push(boundary);
    if (i > 0) {
      const prev = units[i - 1]!;
      lineEnd[i - 1] = breaks.some((b) => b >= prev.end && b < u.start);
      clauseEnd[i - 1] = sentenceOf[i - 1] !== boundary || lineEnd[i - 1]! || CLAUSE_PUNCTUATION.test(text.slice(prev.end, u.start));
    }
  });
  if (units.length) {
    clauseEnd[units.length - 1] = true;
    lineEnd[units.length - 1] = true;
  }
  const leading = leadingWords(lang);
  const joinsNext = units.map((u) => leading.has(text.slice(u.start, u.end).toLowerCase().replace(/’/g, "'")));
  return { units, sentence: sentenceOf, clauseEnd, lineEnd, joinsNext };
}
