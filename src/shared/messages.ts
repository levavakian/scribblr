import type { KeyStatus, RateState, Usage } from './storage';

/** A chunk to translate, as it appears inside its block: text plus inline tags (<t1>…</t1>, <x2/>). */
export interface ChunkRef {
  chunk: number;
  markup: string;
}

/** Plain (escaped) text, or a chunk to translate. */
export type ContextPart = string | ChunkRef;

export interface ContextBlock {
  /** The block's tag name (p, li, button, h2, …), a hint for register and tone. */
  tag: string;
  parts: ContextPart[];
}

export interface TranslateRequest {
  sourceLang: string;
  targetLang: string;
  page: { title: string; url: string };
  /** The page's text in reading order, as context. A block with no parts marks omitted text. */
  blocks: ContextBlock[];
  /** Every chunk referenced by `blocks`, with its translation-cache key. */
  chunks: Array<{ id: number; key: string }>;
}

export type PendingReason = 'paused' | 'no-key' | 'invalid-key' | 'error';

export interface TranslateResult {
  /** Chunk id → translation (markup with the same inline tags). */
  translations: Record<number, string>;
  model?: string;
  /** Set when some chunks could not be translated yet; they are absent from `translations`. */
  pending?: { reason: PendingReason; until?: number; message?: string };
  /** Chunks the model refused or skipped. Retrying them would waste quota. */
  failed?: number[];
}

export type PageState = 'active' | 'disabled' | 'no-key';

export interface PageStats {
  state: PageState;
  blocks: number;
  translatedChunks: number;
  words: number;
  translatedWords: number;
  waiting: number;
}

export interface Status {
  hasKey: boolean;
  keyStatus: KeyStatus | null;
  models: string[];
  rate: RateState;
  usage: Usage;
  now: number;
}

/** Messages handled by the background service worker. */
export type BackgroundMessage =
  | { type: 'translate'; request: TranslateRequest }
  | { type: 'page-state'; state: PageState }
  | { type: 'status' }
  | { type: 'validate-key'; key: string };

/** Messages handled by content scripts. */
export type TabMessage = { type: 'redo' } | { type: 'page-stats' };

export async function sendToBackground<T>(message: BackgroundMessage): Promise<T> {
  return (await chrome.runtime.sendMessage(message)) as T;
}
