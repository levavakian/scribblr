import type { BackgroundMessage, Status } from '../shared/messages';
import { FALLBACK_MODELS } from '../shared/models';
import type { Settings } from '../shared/settings';
import { getStored, loadRateState } from '../shared/storage';
import { pacificDay } from '../shared/time';
import { refreshBadge, setTabState } from './badge';
import { pruneCache } from './cache';
import { DEFAULT_API_BASE } from './gemini';
import { modelChain, translate, updateRate, validateKey } from './translate';

chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason === 'install') void chrome.tabs.create({ url: chrome.runtime.getURL('options.html') });
  void refreshBadge();
  void pruneCache();
});

chrome.runtime.onStartup.addListener(() => {
  void refreshBadge();
  void pruneCache();
});

chrome.alarms.onAlarm.addListener(() => void refreshBadge());

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (changes.apiKey || changes.keyStatus || changes.rateState) void refreshBadge();
  // Switching a model on (or reordering) can make a model with quota left available again.
  const modelPrefs = (value: unknown) => JSON.stringify((value as Partial<Settings> | undefined)?.models);
  if (changes.settings && modelPrefs(changes.settings.oldValue) !== modelPrefs(changes.settings.newValue)) {
    void updateRate((r) => (r.pauseReason === 'daily' ? { ...r, pausedUntil: 0, pauseReason: null } : r));
  }
});

async function status(): Promise<Status> {
  const [apiKey, keyStatus, rate, usage, apiBase] = await Promise.all([
    getStored('apiKey'),
    getStored('keyStatus'),
    loadRateState(),
    getStored('usage'),
    getStored('apiBase'),
  ]);
  const day = pacificDay();
  return {
    hasKey: Boolean(apiKey),
    keyStatus: keyStatus ?? null,
    // The models this key can use (listing them is free, and cached for 12 hours).
    models: apiKey && keyStatus?.state !== 'invalid' ? await modelChain(apiKey, apiBase || DEFAULT_API_BASE) : FALLBACK_MODELS,
    rate,
    usage: usage?.day === day ? usage : { day, counts: {} },
    now: Date.now(),
  };
}

async function handle(message: BackgroundMessage, sender: chrome.runtime.MessageSender): Promise<unknown> {
  switch (message.type) {
    case 'translate':
      return translate(message.request);
    case 'page-state':
      if (sender.tab?.id !== undefined) await setTabState(sender.tab.id, message.state);
      return { ok: true };
    case 'status':
      return status();
    case 'validate-key':
      return validateKey(message.key.trim());
  }
}

chrome.runtime.onMessage.addListener((message: BackgroundMessage, sender, sendResponse) => {
  handle(message, sender).then(sendResponse, (error: unknown) => {
    console.error('scribblr:', error);
    sendResponse(undefined);
  });
  return true;
});
