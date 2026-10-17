import type { PageState } from '../shared/messages';
import { getStored, loadRateState } from '../shared/storage';

const AMBER = '#d97706';
const GRAY = '#6b7280';

/** Global badge: "!" when the API key is missing or invalid, "||" while paused by a rate limit. */
export async function refreshBadge(): Promise<void> {
  const [apiKey, keyStatus, rate] = await Promise.all([getStored('apiKey'), getStored('keyStatus'), loadRateState()]);
  const now = Date.now();
  let text = '';
  let color = GRAY;
  let title = 'Scribblr';
  if (!apiKey || keyStatus?.state === 'invalid') {
    text = '!';
    color = AMBER;
    title = apiKey ? 'Scribblr: the Gemini API key was rejected' : 'Scribblr: add a Gemini API key to start';
  } else if (rate.pausedUntil > now) {
    text = '||';
    const limit = rate.pauseReason === 'daily' ? 'daily limits reached' : 'per-minute limit reached';
    title = `Scribblr: paused until ${new Date(rate.pausedUntil).toLocaleTimeString()} (${limit})`;
    await chrome.alarms.create('pause-ends', { when: rate.pausedUntil + 500 });
  }
  await chrome.action.setBadgeText({ text });
  await chrome.action.setBadgeBackgroundColor({ color });
  await chrome.action.setTitle({ title });
}

/** Per-tab badge: "off" where the extension is turned off. */
export async function setTabState(tabId: number, state: PageState): Promise<void> {
  if (state === 'disabled') {
    await chrome.action.setBadgeText({ tabId, text: 'off' });
    await chrome.action.setBadgeBackgroundColor({ tabId, color: GRAY });
  } else {
    // null falls back to the global badge.
    await chrome.action.setBadgeText({ tabId, text: null as unknown as string });
  }
}
