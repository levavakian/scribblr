import type { PageState, TabMessage } from '../shared/messages';
import { type Settings, isSiteDisabled, withDefaults } from '../shared/settings';
import { type KeyStatus, type RateState, getStored, loadSettings } from '../shared/storage';
import { PageController } from './page';

async function main(): Promise<void> {
  let settings: Settings = await loadSettings();
  let hasKey = Boolean(await getStored('apiKey'));
  const controller = new PageController(settings);
  const host = location.hostname;
  let reported: PageState | null = null;

  const desiredState = (): PageState => {
    if (!settings.enabled || isSiteDisabled(settings, host)) return 'disabled';
    return hasKey ? 'active' : 'no-key';
  };

  const sync = () => {
    const state = desiredState();
    controller.updateSettings(settings);
    if (state === 'active') void controller.start();
    else controller.stop();
    if (state !== reported) {
      reported = state;
      chrome.runtime.sendMessage({ type: 'page-state', state }).catch(() => {});
    }
  };

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (changes.settings) settings = withDefaults(changes.settings.newValue as Partial<Settings> | undefined);
    if (changes.apiKey) {
      hasKey = Boolean(changes.apiKey.newValue);
      controller.unblock();
    }
    if (changes.keyStatus && (changes.keyStatus.newValue as KeyStatus | undefined)?.state !== 'invalid') controller.unblock();
    if (changes.rateState) controller.onRateState(changes.rateState.newValue as RateState | undefined);
    if (changes.settings || changes.apiKey) sync();
  });

  chrome.runtime.onMessage.addListener((message: TabMessage, _sender, sendResponse) => {
    if (message.type === 'redo') {
      controller.stop();
      sync();
      sendResponse({ ok: true });
    } else if (message.type === 'page-stats') {
      sendResponse({ ...controller.stats(), state: desiredState() });
    }
  });

  sync();
}

if (window === window.top) void main();
