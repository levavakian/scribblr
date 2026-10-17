import { describe, expect, it } from 'vitest';
import { classifyFailure, extractTranslations } from '../../src/background/gemini';
import { orderFlashModels } from '../../src/background/models';

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

describe('classifyFailure', () => {
  it('recognises a daily quota even when Google suggests retrying in seconds', () => {
    expect(classifyFailure(429, quotaError('GenerateRequestsPerDayPerProjectPerModel-FreeTier', '41s'))).toMatchObject({ kind: 'rate-daily' });
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

  it('treats a quota of zero (model not on the free tier) like a used-up daily quota', () => {
    expect(classifyFailure(429, quotaError('GenerateRequestsPerMinutePerProjectPerModel-FreeTier', '5s', '0'))).toMatchObject({ kind: 'rate-daily' });
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

describe('orderFlashModels', () => {
  it('puts the newest Flash first, then older Flash, then Flash-Lite; skipping previews and variants', () => {
    const names = [
      'models/gemini-2.5-flash',
      'models/gemini-2.5-flash-preview-tts',
      'models/gemini-flash-latest',
      'models/gemini-flash-lite-latest',
      'models/gemini-2.5-flash-lite',
      'models/gemini-2.5-flash-image',
      'models/gemini-3-flash-preview',
      'models/gemini-3.1-flash-lite-preview',
      'models/gemini-3.1-flash-lite',
      'models/gemini-3.5-flash',
      'models/gemini-3.5-flash-lite',
      'models/gemini-3.6-flash',
      'models/gemini-3.7-flash',
      'models/gemini-3.8-flash',
      'models/gemini-3.8-flash-tts',
      'models/gemini-3.10-flash',
    ];
    expect(orderFlashModels(names)).toEqual([
      'gemini-3.10-flash',
      'gemini-3.8-flash',
      'gemini-3.7-flash',
      'gemini-3.6-flash',
      'gemini-3.5-flash',
      'gemini-2.5-flash',
      'gemini-3.5-flash-lite',
      'gemini-3.1-flash-lite',
      'gemini-2.5-flash-lite',
    ]);
  });
});
