export interface Language {
  code: string;
  name: string;
  native: string;
}

export const LANGUAGES: Language[] = [
  { code: 'af', name: 'Afrikaans', native: 'Afrikaans' },
  { code: 'ar', name: 'Arabic', native: 'العربية' },
  { code: 'eu', name: 'Basque', native: 'Euskara' },
  { code: 'bn', name: 'Bengali', native: 'বাংলা' },
  { code: 'bg', name: 'Bulgarian', native: 'Български' },
  { code: 'ca', name: 'Catalan', native: 'Català' },
  { code: 'zh-CN', name: 'Chinese (Simplified)', native: '简体中文' },
  { code: 'zh-TW', name: 'Chinese (Traditional)', native: '繁體中文' },
  { code: 'hr', name: 'Croatian', native: 'Hrvatski' },
  { code: 'cs', name: 'Czech', native: 'Čeština' },
  { code: 'da', name: 'Danish', native: 'Dansk' },
  { code: 'nl', name: 'Dutch', native: 'Nederlands' },
  { code: 'en', name: 'English', native: 'English' },
  { code: 'eo', name: 'Esperanto', native: 'Esperanto' },
  { code: 'et', name: 'Estonian', native: 'Eesti' },
  { code: 'fil', name: 'Filipino', native: 'Filipino' },
  { code: 'fi', name: 'Finnish', native: 'Suomi' },
  { code: 'fr', name: 'French', native: 'Français' },
  { code: 'gl', name: 'Galician', native: 'Galego' },
  { code: 'de', name: 'German', native: 'Deutsch' },
  { code: 'el', name: 'Greek', native: 'Ελληνικά' },
  { code: 'gu', name: 'Gujarati', native: 'ગુજરાતી' },
  { code: 'he', name: 'Hebrew', native: 'עברית' },
  { code: 'hi', name: 'Hindi', native: 'हिन्दी' },
  { code: 'hu', name: 'Hungarian', native: 'Magyar' },
  { code: 'is', name: 'Icelandic', native: 'Íslenska' },
  { code: 'id', name: 'Indonesian', native: 'Bahasa Indonesia' },
  { code: 'ga', name: 'Irish', native: 'Gaeilge' },
  { code: 'it', name: 'Italian', native: 'Italiano' },
  { code: 'ja', name: 'Japanese', native: '日本語' },
  { code: 'kn', name: 'Kannada', native: 'ಕನ್ನಡ' },
  { code: 'ko', name: 'Korean', native: '한국어' },
  { code: 'la', name: 'Latin', native: 'Latina' },
  { code: 'lv', name: 'Latvian', native: 'Latviešu' },
  { code: 'lt', name: 'Lithuanian', native: 'Lietuvių' },
  { code: 'ms', name: 'Malay', native: 'Bahasa Melayu' },
  { code: 'ml', name: 'Malayalam', native: 'മലയാളം' },
  { code: 'mr', name: 'Marathi', native: 'मराठी' },
  { code: 'nb', name: 'Norwegian', native: 'Norsk' },
  { code: 'fa', name: 'Persian', native: 'فارسی' },
  { code: 'pl', name: 'Polish', native: 'Polski' },
  { code: 'pt-BR', name: 'Portuguese (Brazil)', native: 'Português (Brasil)' },
  { code: 'pt-PT', name: 'Portuguese (Portugal)', native: 'Português (Portugal)' },
  { code: 'pa', name: 'Punjabi', native: 'ਪੰਜਾਬੀ' },
  { code: 'ro', name: 'Romanian', native: 'Română' },
  { code: 'ru', name: 'Russian', native: 'Русский' },
  { code: 'sr', name: 'Serbian', native: 'Српски' },
  { code: 'sk', name: 'Slovak', native: 'Slovenčina' },
  { code: 'sl', name: 'Slovenian', native: 'Slovenščina' },
  { code: 'es', name: 'Spanish', native: 'Español' },
  { code: 'sw', name: 'Swahili', native: 'Kiswahili' },
  { code: 'sv', name: 'Swedish', native: 'Svenska' },
  { code: 'ta', name: 'Tamil', native: 'தமிழ்' },
  { code: 'te', name: 'Telugu', native: 'తెలుగు' },
  { code: 'th', name: 'Thai', native: 'ไทย' },
  { code: 'tr', name: 'Turkish', native: 'Türkçe' },
  { code: 'uk', name: 'Ukrainian', native: 'Українська' },
  { code: 'ur', name: 'Urdu', native: 'اردو' },
  { code: 'vi', name: 'Vietnamese', native: 'Tiếng Việt' },
  { code: 'cy', name: 'Welsh', native: 'Cymraeg' },
];

// Legacy or alternative codes that language detectors and `lang` attributes still produce.
const ALIASES: Record<string, string> = {
  iw: 'he',
  in: 'id',
  ji: 'yi',
  jw: 'jv',
  no: 'nb',
  nn: 'nb',
  tl: 'fil',
};

/** The comparable part of a language tag: "en-US" → "en", "iw" → "he", "zh-Hant" → "zh". */
export function primaryLanguage(tag: string): string {
  const primary = tag.trim().toLowerCase().split(/[-_]/)[0] ?? '';
  return ALIASES[primary] ?? primary;
}

export function sameLanguage(a: string, b: string): boolean {
  return primaryLanguage(a) === primaryLanguage(b);
}

export function languageName(code: string): string {
  const exact = LANGUAGES.find((l) => l.code.toLowerCase() === code.toLowerCase());
  if (exact) return exact.name;
  const primary = LANGUAGES.find((l) => primaryLanguage(l.code) === primaryLanguage(code));
  return primary?.name ?? code;
}

/** Picks the supported language closest to a browser locale such as "en-GB" or "pt-BR". */
export function matchLanguage(locale: string): string | undefined {
  const exact = LANGUAGES.find((l) => l.code.toLowerCase() === locale.toLowerCase());
  if (exact) return exact.code;
  return LANGUAGES.find((l) => primaryLanguage(l.code) === primaryLanguage(locale))?.code;
}
