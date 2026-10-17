// Deciding which language a block of text is in, using Chrome's on-device language detection.
// Short texts (buttons, labels) can't be detected reliably, so they fall back to a declared `lang`
// attribute or the page's language.

const MIN_LETTERS_TO_DETECT = 40;

async function detect(text: string): Promise<{ language: string; reliable: boolean } | null> {
  try {
    const result = await chrome.i18n.detectLanguage(text.slice(0, 4000));
    const top = result.languages[0];
    if (!top || top.language === 'und') return null;
    return { language: top.language, reliable: result.isReliable && top.percentage >= 60 };
  } catch {
    return null;
  }
}

export async function detectPageLanguage(sample: string): Promise<string | null> {
  const detected = sample.trim() ? await detect(sample) : null;
  if (detected?.reliable) return detected.language;
  return document.documentElement.lang || detected?.language || null;
}

/** The language of a block's text, or null when there's no way to tell. */
export async function languageOf(text: string, container: Element, pageLanguage: string | null): Promise<string | null> {
  const letters = text.match(/\p{L}/gu)?.length ?? 0;
  if (letters >= MIN_LETTERS_TO_DETECT) {
    const detected = await detect(text);
    if (detected?.reliable) return detected.language;
  }
  // A lang attribute below <html> (e.g. on a tweet) describes this text specifically.
  const declared = container.closest('[lang]');
  if (declared && declared !== document.documentElement) {
    const lang = declared.getAttribute('lang');
    if (lang) return lang;
  }
  return pageLanguage;
}
