import { matchLanguage, primaryLanguage } from './languages';

export interface Settings {
  /** Master switch. */
  enabled: boolean;
  /** Hostnames where the extension stays off. */
  disabledSites: string[];
  /** The language the user reads; only text detected in this language gets translated. */
  sourceLang: string;
  /** The language the user is learning. */
  targetLang: string;
  /** 0–100: the share of words to translate. */
  percent: number;
  /** 0–100: the typical chunk size, from single words (0) to whole paragraphs (100). */
  chunkSize: number;
}

export function defaultSettings(uiLocale = safeUiLocale()): Settings {
  const sourceLang = matchLanguage(uiLocale) ?? 'en';
  return {
    enabled: true,
    disabledSites: [],
    sourceLang,
    targetLang: primaryLanguage(sourceLang) === 'es' ? 'en' : 'es',
    percent: 30,
    chunkSize: 30,
  };
}

function safeUiLocale(): string {
  try {
    return chrome.i18n.getUILanguage();
  } catch {
    return 'en';
  }
}

export function withDefaults(stored: Partial<Settings> | undefined): Settings {
  return { ...defaultSettings(), ...stored };
}

export function isSiteDisabled(settings: Settings, hostname: string): boolean {
  return settings.disabledSites.includes(hostname);
}

export const CHUNK_SIZE_LABELS = ['Word', 'Phrase', 'Clause', 'Sentence', 'Paragraph'] as const;

/** The size level (0 = word … 4 = paragraph) at the centre of the chunk-size distribution. */
export function chunkSizeLevel(chunkSize: number): number {
  return (Math.min(100, Math.max(0, chunkSize)) / 100) * (CHUNK_SIZE_LABELS.length - 1);
}

export function chunkSizeLabel(chunkSize: number): string {
  return CHUNK_SIZE_LABELS[Math.round(chunkSizeLevel(chunkSize))] ?? 'Phrase';
}
