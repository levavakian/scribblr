import type { BackgroundMessage, Status } from '../shared/messages';
import { getStored, loadRateState } from '../shared/storage';
import { pacificDay } from '../shared/time';
import { refreshBadge, setTabState } from './badge';
import { pruneCache } from './cache';
import { FALLBACK_MODELS } from './models';
import { translate, validateKey } from './translate';

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
  if (area === 'local' && (changes.apiKey || changes.keyStatus || changes.rateState)) void refreshBadge();
});

async function status(): Promise<Status> {
  const [apiKey, keyStatus, rate, usage, models] = await Promise.all([
    getStored('apiKey'),
    getStored('keyStatus'),
    loadRateState(),
    getStored('usage'),
    getStored('models'),
  ]);
  const day = pacificDay();
  return {
    hasKey: Boolean(apiKey),
    keyStatus: keyStatus ?? null,
    models: models?.list.length ? models.list : FALLBACK_MODELS,
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
