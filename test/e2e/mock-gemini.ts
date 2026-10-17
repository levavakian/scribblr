// A stand-in for the Gemini API (and a static server for the test pages). The extension's API base is
// pointed here, so tests can check exactly what gets requested and script rate limits and errors.
import { readFile } from 'node:fs/promises';
import { type IncomingMessage, type ServerResponse, createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { parseMarkup } from '../../src/shared/markup';

export type Behavior = 'ok' | 'minute' | 'daily' | 'daily-no-hint' | 'billing' | 'not-found' | 'overloaded';

/** When the real API's free-tier daily quotas said they'd reset: midnight UTC. */
export function nextUtcMidnight(now = Date.now()): number {
  const d = new Date(now);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1);
}

/** Google's "10h46m4.25s" style. */
function googleDuration(ms: number): string {
  const s = ms / 1000;
  return `${Math.floor(s / 3600)}h${Math.floor((s % 3600) / 60)}m${(s % 60).toFixed(2)}s`;
}

export interface LoggedRequest {
  model: string;
  prompt: string;
  /** Chunk id → the chunk's markup, as sent. */
  chunks: Record<number, string>;
  /** generationConfig.thinkingConfig, if any. */
  thinking?: Record<string, unknown>;
  behavior: Behavior | 'thinking-rejected';
  at: number;
}

export const MODELS = [
  'gemini-3.8-flash',
  'gemini-3.7-flash',
  'gemini-3.6-flash',
  'gemini-3.5-flash',
  'gemini-2.5-flash',
  'gemini-3.5-flash-lite',
  'gemini-3.1-flash-lite',
];

/** The fake "translation": upper-case every word, keeping the inline tags where they are. */
export function fakeTranslate(markup: string): string {
  return parseMarkup(markup)
    .map((t) => (t.kind === 'text' ? t.text.toUpperCase() : t.kind === 'open' ? `<t${t.n}>` : t.kind === 'close' ? `</t${t.n}>` : `<x${t.n}/>`))
    .join('');
}

function quotaError(quotaId: string, retryMs?: number) {
  const retry = retryMs === undefined ? '' : `\nPlease retry in ${googleDuration(retryMs)}.`;
  return {
    error: {
      code: 429,
      message: `You exceeded your current quota, please check your plan and billing details.\n* Quota exceeded for metric: generativelanguage.googleapis.com/generate_content_free_tier_requests, limit: 20${retry}`,
      status: 'RESOURCE_EXHAUSTED',
      details: [
        { '@type': 'type.googleapis.com/google.rpc.QuotaFailure', violations: [{ quotaId, quotaValue: '20' }] },
        ...(retryMs === undefined ? [] : [{ '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: `${Math.round(retryMs / 1000)}s` }]),
      ],
    },
  };
}

export class MockGemini {
  requests: LoggedRequest[] = [];
  latencyMs = 150;
  /** Per model, the behaviours of its next requests (then 'ok'). Use '*' for any model. */
  private scripts = new Map<string, Behavior[]>();
  private persistent = new Map<string, Behavior>();
  /** Models that answer 400 to thinkingLevel "minimal", like gemini-3.8-flash. */
  rejectMinimalThinking = new Set<string>();
  private server = createServer((req, res) => void this.handle(req, res));
  url = '';

  constructor(private readonly pagesDir: string) {}

  async start(): Promise<void> {
    await new Promise<void>((resolve) => this.server.listen(0, '127.0.0.1', resolve));
    this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }

  async stop(): Promise<void> {
    this.server.closeAllConnections();
    await new Promise((resolve) => this.server.close(resolve));
  }

  /** The next requests to `model` behave like this, in order. */
  script(model: string, ...behaviors: Behavior[]): void {
    this.scripts.set(model, [...(this.scripts.get(model) ?? []), ...behaviors]);
  }

  /** Every request to `model` behaves like this until reset. */
  always(model: string, behavior: Behavior): void {
    this.persistent.set(model, behavior);
  }

  reset(): void {
    this.requests = [];
    this.scripts.clear();
    this.persistent.clear();
    this.rejectMinimalThinking.clear();
    this.latencyMs = 150;
  }

  private nextBehavior(model: string): Behavior {
    for (const key of [model, '*']) {
      const queue = this.scripts.get(key);
      if (queue?.length) return queue.shift()!;
      const fixed = this.persistent.get(key);
      if (fixed) return fixed;
    }
    return 'ok';
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    res.setHeader('access-control-allow-origin', '*');
    res.setHeader('access-control-allow-headers', 'content-type, x-goog-api-key');
    res.setHeader('access-control-allow-methods', 'GET, POST, OPTIONS');
    if (req.method === 'OPTIONS') return void res.writeHead(204).end();

    const url = new URL(req.url ?? '/', this.url);
    if (url.pathname.startsWith('/pages/')) {
      try {
        const html = await readFile(join(this.pagesDir, url.pathname.slice('/pages/'.length)));
        return void res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(html);
      } catch {
        return void res.writeHead(404).end('not found');
      }
    }

    const json = (status: number, body: unknown) => res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));

    if (url.pathname === '/v1beta/models') {
      return void json(200, {
        models: [...MODELS, 'gemini-flash-latest', 'gemini-3-flash-preview'].map((m) => ({
          name: `models/${m}`,
          supportedGenerationMethods: ['generateContent', 'countTokens'],
        })),
      });
    }

    const match = /^\/v1beta\/models\/([^/:]+):generateContent$/.exec(url.pathname);
    if (!match || req.method !== 'POST') return void json(404, { error: { code: 404, message: 'Not found' } });

    const model = decodeURIComponent(match[1]!);
    let body = '';
    for await (const piece of req) body += piece;
    const request = JSON.parse(body) as {
      contents: Array<{ parts: Array<{ text: string }> }>;
      generationConfig?: { thinkingConfig?: Record<string, unknown> };
    };
    const prompt = request.contents[0]?.parts[0]?.text ?? '';
    const chunks: Record<number, string> = {};
    for (const m of prompt.matchAll(/<chunk id="(\d+)">([\s\S]*?)<\/chunk>/g)) chunks[Number(m[1])] = m[2]!;
    const thinking = request.generationConfig?.thinkingConfig;

    if (this.rejectMinimalThinking.has(model) && thinking?.thinkingLevel === 'minimal') {
      this.requests.push({ model, prompt, chunks, thinking, behavior: 'thinking-rejected', at: Date.now() });
      return void json(400, {
        error: { code: 400, message: 'Thinking level MINIMAL is not supported for this model. Please retry with other thinking level.', status: 'INVALID_ARGUMENT' },
      });
    }

    const behavior = this.nextBehavior(model);
    this.requests.push({ model, prompt, chunks, thinking, behavior, at: Date.now() });
    await new Promise((resolve) => setTimeout(resolve, this.latencyMs));

    switch (behavior) {
      case 'minute':
        return void json(429, quotaError('GenerateRequestsPerMinutePerProjectPerModel-FreeTier', 2000));
      case 'daily':
        return void json(429, quotaError('GenerateRequestsPerDayPerProjectPerModel-FreeTier', nextUtcMidnight() - Date.now()));
      case 'daily-no-hint':
        return void json(429, quotaError('GenerateRequestsPerDayPerProjectPerModel-FreeTier'));
      case 'billing':
        return void json(402, { error: { code: 402, message: 'Your prepayment credits are depleted.', status: 'RESOURCE_EXHAUSTED' } });
      case 'not-found':
        return void json(404, { error: { code: 404, message: `This model models/${model} is no longer available to new users.`, status: 'NOT_FOUND' } });
      case 'overloaded':
        return void json(503, { error: { code: 503, message: 'The model is overloaded.', status: 'UNAVAILABLE' } });
      case 'ok': {
        const translations = Object.entries(chunks).map(([id, markup]) => ({ id: Number(id), text: fakeTranslate(markup) }));
        return void json(200, {
          candidates: [{ content: { parts: [{ text: JSON.stringify({ translations }) }] }, finishReason: 'STOP' }],
        });
      }
    }
  }
}
