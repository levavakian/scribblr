// The model chain: the newest free-tier Flash model first, then older Flash models, then Flash-Lite.
// Each model has its own daily free-tier quota, so when one runs out the next one takes over.

/** Used when the model list can't be fetched. */
export const FALLBACK_MODELS = [
  'gemini-3.8-flash',
  'gemini-3.7-flash',
  'gemini-3.6-flash',
  'gemini-3.5-flash',
  'gemini-2.5-flash',
  'gemini-3.5-flash-lite',
  'gemini-3.1-flash-lite',
  'gemini-2.5-flash-lite',
];

// Stable, versioned Flash and Flash-Lite models only: no previews, "-latest" aliases (which share
// another model's quota), or image/audio/TTS variants.
const FLASH = /^(?:models\/)?gemini-(\d+)(?:\.(\d+))?-flash(-lite)?$/;

export function orderFlashModels(names: string[]): string[] {
  const models = new Map<string, { version: number; lite: boolean }>();
  for (const raw of names) {
    const m = FLASH.exec(raw.trim());
    if (!m) continue;
    const name = raw.trim().replace(/^models\//, '');
    models.set(name, { version: Number(m[1]) * 1000 + Number(m[2] ?? 0), lite: Boolean(m[3]) });
  }
  return [...models]
    .sort(([, a], [, b]) => Number(a.lite) - Number(b.lite) || b.version - a.version)
    .map(([name]) => name);
}
