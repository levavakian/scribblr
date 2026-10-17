import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { type BrowserContext, type Page, type Worker, test as base, chromium, expect } from '@playwright/test';
import type { Settings } from '../../src/shared/settings';
import { MockGemini } from './mock-gemini';

const root = resolve(import.meta.dirname, '../..');
const dist = join(root, 'dist');

export interface ExtensionFixtures {
  gemini: MockGemini;
  context: BrowserContext;
  worker: Worker;
  extensionId: string;
  /** Points the extension at the mock API and stores a key and settings. */
  configure: (settings?: Partial<Settings>, extra?: Record<string, unknown>) => Promise<void>;
  /** Opens a test page from test/e2e/pages. */
  openPage: (name: string) => Promise<Page>;
}

export const test = base.extend<ExtensionFixtures>({
  gemini: async ({}, use) => {
    const gemini = new MockGemini(join(import.meta.dirname, 'pages'));
    await gemini.start();
    await use(gemini);
    await gemini.stop();
  },

  context: async ({}, use) => {
    const executablePath = process.env.SCRIBBLR_CHROMIUM;
    if (!executablePath) throw new Error('SCRIBBLR_CHROMIUM is not set: run the end-to-end tests inside ./shell.sh');
    const userDataDir = await mkdtemp(join(tmpdir(), 'scribblr-e2e-'));
    const context = await chromium.launchPersistentContext(userDataDir, {
      executablePath,
      headless: !process.env.HEADED,
      viewport: { width: 1100, height: 800 },
      args: [`--disable-extensions-except=${dist}`, `--load-extension=${dist}`, '--lang=en-US'],
    });
    await use(context);
    await context.close();
    await rm(userDataDir, { recursive: true, force: true });
  },

  worker: async ({ context }, use) => {
    const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
    await use(worker);
  },

  extensionId: async ({ worker }, use) => {
    await use(new URL(worker.url()).host);
  },

  configure: async ({ worker, gemini }, use) => {
    await use(async (settings = {}, extra = {}) => {
      await worker.evaluate(
        async ({ settings, extra, apiBase }) => {
          await chrome.storage.local.set({
            apiKey: 'test-key',
            apiBase,
            keyStatus: { state: 'valid', checkedAt: Date.now() },
            settings: { enabled: true, disabledSites: [], sourceLang: 'en', targetLang: 'es', percent: 40, chunkSize: 30, ...settings },
            ...extra,
          });
        },
        { settings, extra, apiBase: gemini.url },
      );
    });
  },

  openPage: async ({ context, gemini }, use) => {
    await use(async (name: string) => {
      const page = await context.newPage();
      await page.goto(`${gemini.url}/pages/${name}`);
      return page;
    });
  },
});

export { expect };

/** Translated chunks currently on the page, with their final (post-animation) text. */
export async function translatedTexts(page: Page, within = 'body'): Promise<string[]> {
  return page.$$eval(`${within} scribblr-t:not([data-flipping])`, (els) => els.map((e) => e.textContent ?? '').filter((t) => t.trim()));
}

/** Asks the content script of `page` how much of it is translated. */
export async function pageStats(worker: Worker, page: Page) {
  await page.bringToFront();
  return worker.evaluate(async () => {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    return chrome.tabs.sendMessage(tab!.id!, { type: 'page-stats' });
  }) as Promise<{ state: string; words: number; translatedWords: number; translatedChunks: number; waiting: number }>;
}

/** The extension's stored state. */
export async function stored<T = unknown>(worker: Worker, key: string): Promise<T> {
  return worker.evaluate(async (k) => (await chrome.storage.local.get(k))[k], key) as Promise<T>;
}

/** Scrolls through the whole page so every block gets a chance to flip in. */
export async function scrollThrough(page: Page): Promise<void> {
  const height = await page.evaluate(() => document.documentElement.scrollHeight);
  for (let y = 0; y <= height; y += 400) {
    await page.evaluate((top) => window.scrollTo(0, top), y);
    await page.waitForTimeout(120);
  }
}
