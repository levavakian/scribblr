export const DEFAULT_API_BASE = 'https://generativelanguage.googleapis.com';

const REQUEST_TIMEOUT_MS = 90_000;

export type FailureKind =
  | 'rate-minute' // a per-minute quota: wait retryAfterMs
  | 'rate-daily' // this model's daily quota is used up (retryAfterMs: when Google says it resets)
  | 'invalid-key'
  | 'billing' // HTTP 402: the key's project is on prepaid billing and out of credits
  | 'bad-request'
  | 'not-found' // the model doesn't exist (any more)
  | 'permission'
  | 'transient' // network trouble, timeouts, overloaded servers
  | 'blocked' // the model refused the content
  | 'bad-response';

export interface Failure {
  kind: FailureKind;
  message: string;
  retryAfterMs?: number;
}

export type Outcome<T> = { ok: true; value: T } | { ok: false; failure: Failure };

/** Parses "34s", "1.5s", "500ms" and Google's "10h46m4.25s"; undefined if it isn't a duration. */
export function parseDuration(value: unknown): number | undefined {
  const text = String(value ?? '').trim();
  const ms = /^([\d.]+)ms$/.exec(text);
  if (ms) return Math.round(Number(ms[1]));
  const m = /^(?:(\d+)h)?(?:(\d+)m)?(?:([\d.]+)s)?$/.exec(text);
  if (!text || !m || (m[1] ?? m[2] ?? m[3]) === undefined) return undefined;
  return Math.round(((Number(m[1] ?? 0) * 60 + Number(m[2] ?? 0)) * 60 + Number(m[3] ?? 0)) * 1000);
}

/** Works out what a failed Gemini response means; 429s are told apart by their quota ids. */
export function classifyFailure(status: number, payload: unknown, retryAfterHeader?: string | null): Failure {
  const error = ((payload as { error?: Record<string, unknown> } | null)?.error ?? {}) as {
    message?: string;
    status?: string;
    details?: Array<Record<string, unknown>>;
  };
  const message = (error.message || `HTTP ${status}`).trim();
  const details = Array.isArray(error.details) ? error.details : [];
  const typeOf = (d: Record<string, unknown>) => String(d['@type'] ?? '');

  // Projects linked to a billing account don't get the free tier. When their prepaid credits run out
  // (402) or they pass their monthly spend cap (a bare 429), every request fails until the owner
  // fixes it in AI Studio: retrying every minute would never help.
  // (Ordinary quota errors say "check your plan and billing details", so don't match on "billing".)
  if (status === 402 || /spend(ing)? cap|prepayment credits/i.test(message)) return { kind: 'billing', message };

  if (status === 429 || error.status === 'RESOURCE_EXHAUSTED') {
    let daily = false;
    let perMinute = false;
    let noFreeTier = false;
    let retryAfterMs: number | undefined;
    for (const d of details) {
      if (typeOf(d).endsWith('QuotaFailure')) {
        for (const v of (d.violations as Array<Record<string, unknown>> | undefined) ?? []) {
          const id = `${v.quotaId ?? ''} ${v.quotaMetric ?? ''}`;
          if (/per_?day|daily/i.test(id)) daily = true;
          else if (/per_?minute/i.test(id)) perMinute = true;
          if (String(v.quotaValue) === '0') noFreeTier = true;
        }
      } else if (typeOf(d).endsWith('RetryInfo')) {
        retryAfterMs = parseDuration(d.retryDelay);
      }
    }
    if (!daily && !perMinute) {
      if (/per day|daily/i.test(message)) daily = true;
      else if (/per minute/i.test(message)) perMinute = true;
    }
    retryAfterMs ??= (() => {
      const m = /retry in ((?:\d+h)?(?:\d+m(?!s))?(?:[\d.]+(?:ms|s))?)/i.exec(message);
      const fromMessage = m ? parseDuration(m[1]) : undefined;
      if (fromMessage !== undefined) return fromMessage;
      const header = Number(retryAfterHeader);
      return Number.isFinite(header) && header > 0 ? header * 1000 : undefined;
    })();
    // A limit of 0 means the model isn't on the free tier at all: skip it for the day.
    if (noFreeTier) return { kind: 'rate-daily', message };
    // For daily quotas Google says when the quota resets ("retry in 10h46m4.25s"); keep that.
    if (daily) return { kind: 'rate-daily', message, ...(retryAfterMs !== undefined ? { retryAfterMs } : {}) };
    if (perMinute || retryAfterMs === undefined || retryAfterMs <= 15 * 60_000) {
      return { kind: 'rate-minute', message, retryAfterMs: retryAfterMs ?? 60_000 };
    }
    return { kind: 'rate-daily', message };
  }

  const reasons = details.filter((d) => typeOf(d).endsWith('ErrorInfo')).map((d) => String(d.reason));
  if (reasons.includes('API_KEY_INVALID') || /api key not valid|api_key_invalid|api key expired/i.test(message)) {
    return { kind: 'invalid-key', message };
  }
  if (status === 401 || status === 403) return { kind: 'permission', message };
  if (status === 404) return { kind: 'not-found', message };
  if (status === 408 || status >= 500) return { kind: 'transient', message };
  return { kind: 'bad-request', message };
}

async function call(url: string, apiKey: string, init: RequestInit = {}): Promise<Outcome<unknown>> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      ...init,
      signal: controller.signal,
      headers: { 'x-goog-api-key': apiKey, ...(init.body ? { 'content-type': 'application/json' } : {}) },
    });
    const text = await response.text();
    let payload: unknown = null;
    try {
      payload = text ? JSON.parse(text) : null;
    } catch {
      // Not JSON (e.g. a proxy error page).
    }
    if (!response.ok) return { ok: false, failure: classifyFailure(response.status, payload, response.headers.get('retry-after')) };
    if (payload === null) return { ok: false, failure: { kind: 'bad-response', message: 'Empty or non-JSON response' } };
    return { ok: true, value: payload };
  } catch (error) {
    const aborted = (error as Error)?.name === 'AbortError';
    return { ok: false, failure: { kind: 'transient', message: aborted ? 'Request timed out' : `Network error: ${String(error)}` } };
  } finally {
    clearTimeout(timeout);
  }
}

/** Names of all models the key can call generateContent on, e.g. "gemini-3.8-flash". */
export async function listModels(apiKey: string, base = DEFAULT_API_BASE): Promise<Outcome<string[]>> {
  const result = await call(`${base}/v1beta/models?pageSize=1000`, apiKey);
  if (!result.ok) return result;
  const models = ((result.value as { models?: Array<{ name?: string; supportedGenerationMethods?: string[] }> }).models ?? [])
    .filter((m) => m.supportedGenerationMethods?.includes('generateContent'))
    .map((m) => String(m.name ?? '').replace(/^models\//, ''))
    .filter(Boolean);
  return { ok: true, value: models };
}

export interface GenerateResponse {
  candidates?: Array<{
    content?: { parts?: Array<{ text?: string; thought?: boolean }> };
    finishReason?: string;
  }>;
  promptFeedback?: { blockReason?: string };
}

export async function generateContent(apiKey: string, base: string, model: string, body: unknown): Promise<Outcome<GenerateResponse>> {
  const result = await call(`${base}/v1beta/models/${encodeURIComponent(model)}:generateContent`, apiKey, {
    method: 'POST',
    body: JSON.stringify(body),
  });
  return result as Outcome<GenerateResponse>;
}

/**
 * Reads `{"translations": [{"id": 0, "text": "…"}]}` out of a response, keeping only the requested
 * ids. If the output was cut off, the complete entries are still recovered.
 */
export function extractTranslations(data: GenerateResponse, ids: ReadonlySet<number>): Outcome<Record<number, string>> {
  const candidate = data.candidates?.[0];
  if (!candidate) {
    return { ok: false, failure: { kind: 'blocked', message: `Blocked: ${data.promptFeedback?.blockReason ?? 'no response'}` } };
  }
  const text = (candidate.content?.parts ?? [])
    .filter((p) => !p.thought && typeof p.text === 'string')
    .map((p) => p.text)
    .join('');
  const translations: Record<number, string> = {};
  const add = (id: unknown, value: unknown) => {
    const n = Number(id);
    if (ids.has(n) && typeof value === 'string' && !(n in translations)) translations[n] = value;
  };
  try {
    const json = JSON.parse(text) as { translations?: Array<{ id?: unknown; text?: unknown }> };
    for (const t of json.translations ?? []) add(t?.id, t?.text);
  } catch {
    for (const m of text.matchAll(/\{\s*"id"\s*:\s*(\d+)\s*,\s*"text"\s*:\s*("(?:[^"\\]|\\.)*")\s*\}/g)) {
      try {
        add(m[1], JSON.parse(m[2]!));
      } catch {
        // Skip a malformed entry.
      }
    }
  }
  if (!Object.keys(translations).length) {
    const reason = candidate.finishReason && candidate.finishReason !== 'STOP' ? candidate.finishReason : 'unreadable output';
    return { ok: false, failure: { kind: reason === 'SAFETY' || reason === 'PROHIBITED_CONTENT' ? 'blocked' : 'bad-response', message: `No translations (${reason})` } };
  }
  return { ok: true, value: translations };
}
