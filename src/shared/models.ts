// The model chain. By default it starts with the newest free-tier Flash model, then older Flash
// models, then Flash-Lite. Preview models come last and stay off unless switched on. Each model has
// its own daily free-tier quota, so when one runs out the next one takes over. Users can reorder
// the chain and switch models on and off (ModelPrefs in the settings).

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

// Versioned Flash and Flash-Lite models, stable or preview. No "-latest" aliases, which share
// another model's quota, and no image, audio or TTS variants.
const FLASH = /^(?:models\/)?gemini-(\d+)(?:\.(\d+))?-flash(-lite)?(-preview(?:-\d{2}-\d{4})?)?$/;

export function orderFlashModels(names: string[]): string[] {
  const models = new Map<string, { version: number; lite: boolean; preview: boolean }>();
  for (const raw of names) {
    const m = FLASH.exec(raw.trim());
    if (!m) continue;
    models.set(raw.trim().replace(/^models\//, ''), {
      version: Number(m[1]) * 1000 + Number(m[2] ?? 0),
      lite: Boolean(m[3]),
      preview: Boolean(m[4]),
    });
  }
  return [...models]
    .sort(([, a], [, b]) => Number(a.preview) - Number(b.preview) || Number(a.lite) - Number(b.lite) || b.version - a.version)
    .map(([name]) => name);
}

export function isPreview(model: string): boolean {
  return /-preview/.test(model);
}

/** Stable models are on unless switched off; previews are off unless switched on. */
export function enabledByDefault(model: string): boolean {
  return !isPreview(model);
}

/** The user's choices, kept relative to the defaults so that new releases still slot in. */
export interface ModelPrefs {
  /** A custom order. Models missing from it, such as new releases, follow it in the default order. */
  order: string[];
  /** Models switched off that are on by default. */
  off: string[];
  /** Models switched on that are off by default (previews). */
  on: string[];
}

export const DEFAULT_MODEL_PREFS: ModelPrefs = { order: [], off: [], on: [] };

export interface ModelChoice {
  model: string;
  enabled: boolean;
}

/** The available models (given in default order) in the user's order, each marked on or off. */
export function applyModelPrefs(available: string[], prefs: ModelPrefs | undefined): ModelChoice[] {
  const p = { ...DEFAULT_MODEL_PREFS, ...prefs };
  const present = new Set(available);
  const ordered = [...new Set([...p.order.filter((m) => present.has(m)), ...available])];
  return ordered.map((model) => ({
    model,
    enabled: p.on.includes(model) || (!p.off.includes(model) && enabledByDefault(model)),
  }));
}

/** The models to try, in order. */
export function activeModels(available: string[], prefs: ModelPrefs | undefined): string[] {
  return applyModelPrefs(available, prefs)
    .filter((c) => c.enabled)
    .map((c) => c.model);
}

export function setModelEnabled(prefs: ModelPrefs, model: string, enabled: boolean): ModelPrefs {
  const on = prefs.on.filter((m) => m !== model);
  const off = prefs.off.filter((m) => m !== model);
  if (enabled !== enabledByDefault(model)) (enabled ? on : off).push(model);
  return { ...prefs, on, off };
}

/** Moves a model one place up (-1) or down (+1) in the list the user sees. */
export function moveModel(choices: ModelChoice[], prefs: ModelPrefs, model: string, delta: -1 | 1): ModelPrefs {
  const order = choices.map((c) => c.model);
  const i = order.indexOf(model);
  const j = i + delta;
  if (i < 0 || j < 0 || j >= order.length) return prefs;
  [order[i], order[j]] = [order[j]!, order[i]!];
  return { ...prefs, order };
}

/** "gemini-3.8-flash" → "Gemini 3.8 Flash", "gemini-3-flash-preview" → "Gemini 3 Flash (preview)". */
export function prettyModel(model: string): string {
  const preview = isPreview(model);
  const name = model
    .replace(/-preview(?:-\d{2}-\d{4})?$/, '')
    .replace(/^gemini-/, 'Gemini ')
    .replace(/-flash-lite$/, ' Flash-Lite')
    .replace(/-flash$/, ' Flash');
  return preview ? `${name} (preview)` : name;
}
