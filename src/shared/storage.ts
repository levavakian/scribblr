import { type Settings, withDefaults } from './settings';

/** Everything the extension keeps in chrome.storage.local. */
export interface StoredState {
  settings: Partial<Settings>;
  apiKey: string;
  /** Overrides the Gemini endpoint; only the end-to-end tests set this. */
  apiBase: string;
  keyStatus: KeyStatus;
  rateState: RateState;
  models: ModelList;
  usage: Usage;
  /** Model → the thinking setting it accepted (null: none), learned from rejected settings. */
  thinking: Record<string, Record<string, unknown> | null>;
}

export interface KeyStatus {
  state: 'unknown' | 'valid' | 'invalid';
  message?: string;
  checkedAt: number;
}

export interface RateState {
  /** While Date.now() < pausedUntil, no Gemini requests are made. */
  pausedUntil: number;
  pauseReason: 'minute' | 'daily' | null;
  /** Model → time its daily free-tier quota resets (midnight Pacific). */
  exhausted: Record<string, number>;
  lastModel: string | null;
  lastError: { message: string; at: number } | null;
}

export interface ModelList {
  /** Flash models in preference order: newest Flash first, then Flash-Lite. */
  list: string[];
  fetchedAt: number;
  /** Which API key the list was fetched with (a hash, never the key itself). */
  keyId: string;
  /** Listed by the API but answering 404 for this key ("no longer available to new users"). */
  unavailable?: string[];
}

export interface Usage {
  /** Pacific-time day the counts belong to (quotas reset at midnight Pacific). */
  day: string;
  counts: Record<string, number>;
}

export const DEFAULT_RATE_STATE: RateState = {
  pausedUntil: 0,
  pauseReason: null,
  exhausted: {},
  lastModel: null,
  lastError: null,
};

export async function getStored<K extends keyof StoredState>(key: K): Promise<StoredState[K] | undefined> {
  const result = await chrome.storage.local.get(key);
  return result[key] as StoredState[K] | undefined;
}

export async function setStored<K extends keyof StoredState>(key: K, value: StoredState[K]): Promise<void> {
  await chrome.storage.local.set({ [key]: value });
}

export async function loadSettings(): Promise<Settings> {
  return withDefaults(await getStored('settings'));
}

export async function saveSettings(patch: Partial<Settings>): Promise<Settings> {
  const next = { ...(await loadSettings()), ...patch };
  await setStored('settings', next);
  return next;
}

export async function loadRateState(): Promise<RateState> {
  return { ...DEFAULT_RATE_STATE, ...(await getStored('rateState')) };
}
