import { hashKey } from '../shared/hash';
import type { TranslateRequest, TranslateResult } from '../shared/messages';
import { type CallLogEntry, type RateState, getStored, loadRateState, loadSettings, setStored } from '../shared/storage';
import { nextPacificMidnight, pacificDay } from '../shared/time';
import { getCached, putCached } from './cache';
import { DEFAULT_API_BASE, type Failure, extractTranslations, generateContent, listModels } from './gemini';
import { FALLBACK_MODELS, activeModels, orderFlashModels } from '../shared/models';
import { requestBody, thinkingConfig } from './prompt';

const MAX_CONCURRENT = 2;
/** Local pacing per model, so bursts rarely hit the per-minute limit. */
const MAX_PER_MINUTE = 8;
const MAX_LOCAL_WAIT_MS = 20_000;
const ERROR_RETRY_MS = 20_000;
const MODEL_LIST_MAX_AGE_MS = 12 * 3600_000;
const NO_MODELS_MESSAGE = "Every model is switched off in Scribblr's settings, so nothing can be translated.";

// ---- State helpers --------------------------------------------------------------------------

let rateWrite: Promise<unknown> = Promise.resolve();

/** Serialized read-modify-write of the rate state (requests can finish concurrently). */
export function updateRate(change: (rate: RateState) => RateState): Promise<RateState> {
  const next = rateWrite.then(async () => {
    const updated = change(await loadRateState());
    await setStored('rateState', updated);
    return updated;
  });
  rateWrite = next.catch(() => {});
  return next;
}

async function countRequest(model: string): Promise<void> {
  const day = pacificDay();
  const usage = await getStored('usage');
  const counts = usage?.day === day ? { ...usage.counts } : {};
  counts[model] = (counts[model] ?? 0) + 1;
  await setStored('usage', { day, counts });
}

async function apiBase(): Promise<string> {
  return (await getStored('apiBase')) || DEFAULT_API_BASE;
}

/** The model chain for this key, refreshed from the API twice a day. */
export async function modelChain(apiKey: string, base: string, force = false): Promise<string[]> {
  const stored = await getStored('models');
  const keyId = hashKey(apiKey);
  const sameKey = stored?.keyId === keyId;
  if (!force && sameKey && Date.now() - stored.fetchedAt < MODEL_LIST_MAX_AGE_MS && stored.list.length) return stored.list;
  const unavailable = sameKey ? (stored.unavailable ?? []) : [];
  const result = await listModels(apiKey, base);
  if (result.ok) {
    const list = orderFlashModels(result.value).filter((m) => !unavailable.includes(m));
    if (list.length) {
      await setStored('models', { list, fetchedAt: Date.now(), keyId, unavailable });
      return list;
    }
  }
  return sameKey && stored.list.length ? stored.list : FALLBACK_MODELS.filter((m) => !unavailable.includes(m));
}

/** Takes a model that answered 404 out of the chain, and keeps it out on later refreshes. */
async function dropModel(apiKey: string, model: string): Promise<void> {
  const stored = await getStored('models');
  const keyId = hashKey(apiKey);
  const base = stored?.keyId === keyId ? stored : { list: FALLBACK_MODELS, fetchedAt: 0, keyId, unavailable: [] };
  await setStored('models', {
    ...base,
    list: base.list.filter((m) => m !== model),
    unavailable: [...new Set([...(base.unavailable ?? []), model])],
  });
}

/** What to tell the user when the key's project can't pay for requests. */
function billingMessage(failure: Failure): string {
  const freeTier = 'or use a key from a project without billing (that gets the free tier): aistudio.google.com/apikey.';
  if (/spend(ing)? cap/i.test(failure.message)) {
    return `This key's Google project hit its monthly spend cap. Raise the cap at aistudio.google.com/spend, ${freeTier}`;
  }
  return `This key's Google project has prepaid billing and its credits are used up. Add credits in AI Studio, ${freeTier}`;
}

// ---- Concurrency and pacing -----------------------------------------------------------------

let active = 0;
const waiting: Array<() => void> = [];

async function acquire(): Promise<void> {
  if (active >= MAX_CONCURRENT) await new Promise<void>((resolve) => waiting.push(resolve));
  active++;
}

function release(): void {
  active--;
  waiting.shift()?.();
}

const recentCalls = new Map<string, number[]>();

/** When the next call to `model` fits within the local per-minute budget. */
function nextSlot(model: string, now: number): number {
  const calls = (recentCalls.get(model) ?? []).filter((t) => now - t < 60_000);
  recentCalls.set(model, calls);
  return calls.length < MAX_PER_MINUTE ? now : calls[0]! + 60_000;
}

/** Calling an extension API every 20s keeps the service worker alive during long requests. */
function keepAlive(): () => void {
  const timer = setInterval(() => void chrome.runtime.getPlatformInfo().catch(() => {}), 20_000);
  return () => clearInterval(timer);
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// ---- Translating ----------------------------------------------------------------------------

/** The least thinking a model accepts. Models reject levels they don't support (3.8 Flash refuses
 *  "minimal"), so step up once and remember: no thinking setting at all means slow default thinking. */
async function thinkingFor(model: string): Promise<Record<string, unknown> | undefined> {
  const learned = (await getStored('thinking'))?.[model];
  return learned === undefined ? thinkingConfig(model) : (learned ?? undefined);
}

function nextThinking(current: Record<string, unknown>): Record<string, unknown> | undefined {
  return current.thinkingLevel === 'minimal' ? { thinkingLevel: 'low' } : undefined;
}

async function callModel(apiKey: string, base: string, model: string, request: TranslateRequest, ids: Set<number>) {
  let thinking = await thinkingFor(model);
  let response = await generateContent(apiKey, base, model, requestBody(request, ids, thinking));
  while (!response.ok && response.failure.kind === 'bad-request' && thinking && /think/i.test(response.failure.message)) {
    thinking = nextThinking(thinking);
    await setStored('thinking', { ...(await getStored('thinking')), [model]: thinking ?? null });
    response = await generateContent(apiKey, base, model, requestBody(request, ids, thinking));
  }
  if (!response.ok) return response;
  return extractTranslations(response.value, ids);
}

const LOG_SIZE = 50;

async function logCall(entry: CallLogEntry): Promise<void> {
  const log = (await getStored('log')) ?? [];
  await setStored('log', [...log, entry].slice(-LOG_SIZE));
}

async function noteError(failure: Failure): Promise<void> {
  await updateRate((r) => ({ ...r, lastError: { message: failure.message, at: Date.now() } }));
}

/**
 * Translates the chunks of a request. Cached chunks are served straight away, even while paused;
 * the rest go to the first model in the chain whose daily quota isn't used up.
 */
export async function translate(request: TranslateRequest): Promise<TranslateResult> {
  const cached = await getCached(request.chunks.map((c) => c.key));
  const translations: Record<number, string> = {};
  for (const c of request.chunks) {
    const hit = cached.get(c.key);
    if (hit !== undefined) translations[c.id] = hit;
  }
  const missing = request.chunks.filter((c) => !(c.id in translations));
  if (!missing.length) return { translations };

  const apiKey = await getStored('apiKey');
  if (!apiKey) return { translations, pending: { reason: 'no-key' } };
  const keyStatus = await getStored('keyStatus');
  if (keyStatus?.state === 'invalid') return { translations, pending: { reason: 'invalid-key', message: keyStatus.message } };

  await acquire();
  const stopKeepAlive = keepAlive();
  try {
    return await translateMissing(request, missing, translations, apiKey, await apiBase());
  } finally {
    stopKeepAlive();
    release();
  }
}

async function translateMissing(
  request: TranslateRequest,
  missing: TranslateRequest['chunks'],
  translations: Record<number, string>,
  apiKey: string,
  base: string,
): Promise<TranslateResult> {
  const ids = new Set(missing.map((c) => c.id));
  const skipped = new Set<string>(); // models that failed transiently for this request
  let lastFailure: Failure | null = null;

  for (let attempt = 0; attempt < 16; attempt++) {
    const now = Date.now();
    const rate = await loadRateState();
    if (now < rate.pausedUntil) return { translations, pending: { reason: 'paused', until: rate.pausedUntil } };

    // The user's order and on/off switches, applied to the models this key can use.
    const chain = activeModels(await modelChain(apiKey, base), (await loadSettings()).models);
    if (!chain.length) {
      return { translations, pending: { reason: 'error', until: now + 60_000, message: NO_MODELS_MESSAGE } };
    }
    const usable = chain.filter((m) => !((rate.exhausted[m] ?? 0) > now));
    if (!usable.length) {
      // Every model's daily quota is used up: pause until the first one resets.
      const resets = chain.map((m) => rate.exhausted[m] ?? 0).filter((t) => t > now);
      const until = resets.length ? Math.min(...resets) : nextPacificMidnight(now);
      await updateRate((r) => ({ ...r, pausedUntil: until, pauseReason: 'daily' }));
      return { translations, pending: { reason: 'paused', until } };
    }
    const model = usable.find((m) => !skipped.has(m));
    if (!model) {
      if (lastFailure) await noteError(lastFailure);
      return { translations, pending: { reason: 'error', until: now + ERROR_RETRY_MS, message: lastFailure?.message } };
    }

    const slot = nextSlot(model, now);
    if (slot - now > MAX_LOCAL_WAIT_MS) return { translations, pending: { reason: 'paused', until: slot } };
    if (slot > now) await sleep(slot - now);
    recentCalls.get(model)!.push(Date.now());

    const started = Date.now();
    const outcome = await callModel(apiKey, base, model, request, ids);
    await countRequest(model);
    await logCall({
      at: started,
      model,
      outcome: outcome.ok ? 'ok' : outcome.failure.kind,
      ms: Date.now() - started,
      chunks: ids.size,
      ...(outcome.ok ? {} : { detail: outcome.failure.message.slice(0, 300) }),
    });

    if (outcome.ok) {
      const entries: Array<[string, string]> = [];
      for (const c of missing) {
        const text = outcome.value[c.id];
        if (text === undefined) continue;
        translations[c.id] = text;
        entries.push([c.key, text]);
      }
      await putCached(entries);
      await updateRate((r) => ({ ...r, lastModel: model, lastError: null }));
      const failed = missing.filter((c) => !(c.id in translations)).map((c) => c.id);
      return { translations, model, ...(failed.length ? { failed } : {}) };
    }

    const failure = outcome.failure;
    lastFailure = failure;
    switch (failure.kind) {
      case 'rate-daily': {
        // Trust the reset time Google sends with the error. The docs say midnight Pacific, but the
        // API has pointed at midnight UTC. Without a hint, fall back to the docs.
        const until = failure.retryAfterMs !== undefined ? Date.now() + Math.max(60_000, failure.retryAfterMs) : nextPacificMidnight();
        await updateRate((r) => ({ ...r, exhausted: { ...r.exhausted, [model]: until } }));
        continue;
      }
      case 'rate-minute': {
        const until = Date.now() + (failure.retryAfterMs ?? 60_000) + 1000;
        await updateRate((r) => ({ ...r, pausedUntil: until, pauseReason: 'minute' }));
        return { translations, pending: { reason: 'paused', until } };
      }
      case 'invalid-key':
      case 'billing': {
        const message = failure.kind === 'billing' ? billingMessage(failure) : failure.message;
        await setStored('keyStatus', { state: 'invalid', message, checkedAt: Date.now() });
        return { translations, pending: { reason: 'invalid-key', message } };
      }
      case 'not-found':
        await dropModel(apiKey, model);
        skipped.add(model);
        continue;
      case 'transient':
      case 'bad-response':
        skipped.add(model);
        continue;
      case 'blocked':
        return { translations, model, failed: [...ids] };
      case 'bad-request':
      case 'permission':
        await noteError(failure);
        return { translations, pending: { reason: 'error', until: Date.now() + 5 * 60_000, message: failure.message } };
    }
  }
  return { translations, pending: { reason: 'error', until: Date.now() + ERROR_RETRY_MS, message: lastFailure?.message } };
}

/**
 * One tiny generation call on a Flash-Lite model (the biggest daily quota). Listing models works even
 * for keys that can't generate anything, such as billed projects that ran out of credits.
 */
async function probeGeneration(key: string, base: string, chain: string[]): Promise<{ failure?: Failure; unavailable: string[] }> {
  const unavailable: string[] = [];
  const candidates = [...chain.filter((m) => m.endsWith('-lite')), ...chain.filter((m) => !m.endsWith('-lite')).reverse()];
  for (const model of candidates.slice(0, 4)) {
    const result = await generateContent(key, base, model, {
      contents: [{ role: 'user', parts: [{ text: 'Reply with: ok' }] }],
      generationConfig: { maxOutputTokens: 8 },
    });
    if (result.ok) return { unavailable };
    if (result.failure.kind === 'not-found') {
      unavailable.push(model);
      continue;
    }
    // A rate limit still means the key itself works.
    if (result.failure.kind === 'rate-minute' || result.failure.kind === 'rate-daily') return { unavailable };
    return { failure: result.failure, unavailable };
  }
  return { unavailable };
}

/** Checks a key and saves it if it can translate. */
export async function validateKey(key: string): Promise<{ ok: boolean; message: string; models?: string[] }> {
  const base = await apiBase();
  const listed = await listModels(key, base);
  if (!listed.ok) {
    const { kind, message } = listed.failure;
    if (kind === 'transient') {
      await setStored('apiKey', key);
      await setStored('keyStatus', { state: 'unknown', message, checkedAt: Date.now() });
      return { ok: true, message: `Saved, but couldn't check the key: ${message}` };
    }
    return { ok: false, message: kind === 'invalid-key' || kind === 'bad-request' ? 'Google says this API key is not valid.' : message };
  }
  const ordered = orderFlashModels(listed.value);
  const probe = await probeGeneration(key, base, ordered.length ? ordered : FALLBACK_MODELS);
  if (probe.failure && probe.failure.kind !== 'transient') {
    return { ok: false, message: probe.failure.kind === 'billing' ? billingMessage(probe.failure) : probe.failure.message };
  }
  const list = ordered.filter((m) => !probe.unavailable.includes(m));
  await setStored('apiKey', key);
  await setStored('keyStatus', { state: probe.failure ? 'unknown' : 'valid', checkedAt: Date.now() });
  await setStored('models', { list: list.length ? list : FALLBACK_MODELS, fetchedAt: Date.now(), keyId: hashKey(key), unavailable: probe.unavailable });
  // A new key may come with fresh quota.
  await updateRate((r) => ({ ...r, exhausted: {}, pausedUntil: 0, pauseReason: null, lastError: null }));
  return { ok: true, message: probe.failure ? `Saved, but couldn't test it: ${probe.failure.message}` : 'Key works.', models: list };
}
