import { describe, expect, it } from 'vitest';
import { classifyFailure, extractTranslations, parseDuration } from '../../src/background/gemini';

function quotaError(quotaId: string, retryDelay?: string, quotaValue = '20') {
  return {
    error: {
      code: 429,
      // Google's real wording, which mentions billing even for plain free-tier limits.
      message: 'You exceeded your current quota, please check your plan and billing details.',
      status: 'RESOURCE_EXHAUSTED',
      details: [
        {
          '@type': 'type.googleapis.com/google.rpc.QuotaFailure',
          violations: [
            {
              quotaMetric: 'generativelanguage.googleapis.com/generate_content_free_tier_requests',
              quotaId,
              quotaDimensions: { location: 'global', model: 'gemini-3.8-flash' },
              quotaValue,
            },
          ],
        },
        { '@type': 'type.googleapis.com/google.rpc.Help', links: [] },
        ...(retryDelay ? [{ '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay }] : []),
      ],
    },
  };
}

describe('parseDuration', () => {
  it("reads protobuf durations and Google's h/m/s style", () => {
    expect(parseDuration('34s')).toBe(34_000);
    expect(parseDuration('1.5s')).toBe(1500);
    expect(parseDuration('500ms')).toBe(500);
    expect(parseDuration('10h46m4.25s')).toBe(38_764_250);
    expect(parseDuration('3m')).toBe(180_000);
    expect(parseDuration('')).toBeUndefined();
    expect(parseDuration('soon')).toBeUndefined();
  });
});

describe('classifyFailure', () => {
  it('recognises a daily quota and keeps the reset time Google gives', () => {
    // As returned by the real API on 2026-10-17 at 13:13 UTC.
    const real = quotaError('GenerateRequestsPerDayPerProjectPerModel-FreeTier');
    real.error.message +=
      '\n* Quota exceeded for metric: generativelanguage.googleapis.com/generate_content_free_tier_requests, limit: 20, model: gemini-3.8-flash\nPlease retry in 10h46m4.25202083s.';
    expect(classifyFailure(429, real)).toEqual({ kind: 'rate-daily', message: real.error.message, retryAfterMs: 38_764_252 });
    expect(classifyFailure(429, quotaError('GenerateRequestsPerDayPerProjectPerModel-FreeTier', '41s'))).toMatchObject({
      kind: 'rate-daily',
      retryAfterMs: 41_000,
    });
  });

  it('recognises per-minute quotas and their retry delay', () => {
    expect(classifyFailure(429, quotaError('GenerateRequestsPerMinutePerProjectPerModel-FreeTier', '17s'))).toMatchObject({
      kind: 'rate-minute',
      retryAfterMs: 17_000,
    });
    expect(classifyFailure(429, quotaError('GenerateContentInputTokensPerModelPerMinute-FreeTier', '2.5s'))).toMatchObject({
      kind: 'rate-minute',
      retryAfterMs: 2500,
    });
  });

  it('treats a quota of zero (model not on the free tier) as unusable for the day, ignoring the short retry hint', () => {
    expect(classifyFailure(429, quotaError('GenerateRequestsPerMinutePerProjectPerModel-FreeTier', '5s', '0'))).toEqual({
      kind: 'rate-daily',
      message: expect.any(String),
    });
  });

  it('falls back to the message and retry hints', () => {
    const bare = { error: { code: 429, status: 'RESOURCE_EXHAUSTED', message: 'Quota exceeded. Please retry in 12.5s.' } };
    expect(classifyFailure(429, bare)).toMatchObject({ kind: 'rate-minute', retryAfterMs: 12_500 });
    expect(classifyFailure(429, null)).toMatchObject({ kind: 'rate-minute', retryAfterMs: 60_000 });
    expect(classifyFailure(429, null, '30')).toMatchObject({ kind: 'rate-minute', retryAfterMs: 30_000 });
    expect(classifyFailure(429, { error: { message: 'Quota exceeded for requests per day' } })).toMatchObject({ kind: 'rate-daily' });
  });

  it('tells depleted prepaid credits (402) apart from rate limits', () => {
    const depleted = {
      error: {
        code: 402,
        message: 'Your prepayment credits are depleted. Please go to AI Studio at https://ai.studio/projects to manage your project and billing. ',
        status: 'RESOURCE_EXHAUSTED',
      },
    };
    expect(classifyFailure(402, depleted).kind).toBe('billing');
    const capped = {
      error: {
        code: 429,
        message: 'Your project has exceeded its monthly spending cap. Please go to AI Studio at https://ai.studio/spend to manage your project spend cap.',
        status: 'RESOURCE_EXHAUSTED',
      },
    };
    expect(classifyFailure(429, capped).kind).toBe('billing');
  });

  it('recognises bad keys, missing models and server trouble', () => {
    const badKey = {
      error: {
        code: 400,
        message: 'API key not valid. Please pass a valid API key.',
        status: 'INVALID_ARGUMENT',
        details: [{ '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason: 'API_KEY_INVALID' }],
      },
    };
    expect(classifyFailure(400, badKey).kind).toBe('invalid-key');
    expect(classifyFailure(404, { error: { message: 'models/gemini-9-flash is not found' } }).kind).toBe('not-found');
    expect(classifyFailure(503, { error: { message: 'The model is overloaded.' } }).kind).toBe('transient');
    expect(classifyFailure(403, { error: { message: 'Permission denied' } }).kind).toBe('permission');
    expect(classifyFailure(400, { error: { message: 'Invalid JSON payload' } }).kind).toBe('bad-request');
  });
});

describe('extractTranslations', () => {
  const response = (text: string, finishReason = 'STOP') => ({ candidates: [{ content: { parts: [{ text }] }, finishReason }] });

  it('reads the structured output, ignoring ids that were not asked for', () => {
    const r = extractTranslations(response('{"translations":[{"id":0,"text":"Hola"},{"id":1,"text":"mundo"},{"id":9,"text":"x"}]}'), new Set([0, 1]));
    expect(r).toEqual({ ok: true, value: { 0: 'Hola', 1: 'mundo' } });
  });

  it('skips thought parts', () => {
    const data = { candidates: [{ content: { parts: [{ text: 'thinking…', thought: true }, { text: '{"translations":[{"id":0,"text":"Sí"}]}' }] } }] };
    expect(extractTranslations(data, new Set([0]))).toEqual({ ok: true, value: { 0: 'Sí' } });
  });

  it('salvages complete entries from cut-off output', () => {
    const cut = '{"translations":[{"id":0,"text":"Uno"},{"id":1,"text":"Dos \\"citado\\""},{"id":2,"text":"Tr';
    expect(extractTranslations(response(cut, 'MAX_TOKENS'), new Set([0, 1, 2]))).toEqual({ ok: true, value: { 0: 'Uno', 1: 'Dos "citado"' } });
  });

  it('reports blocked prompts', () => {
    expect(extractTranslations({ promptFeedback: { blockReason: 'SAFETY' } }, new Set([0]))).toMatchObject({ ok: false, failure: { kind: 'blocked' } });
  });
});
