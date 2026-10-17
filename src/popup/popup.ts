import { LANGUAGES, languageName } from '../shared/languages';
import { type PageStats, type Status, sendToBackground } from '../shared/messages';
import { type Settings, chunkSizeLabel, isSiteDisabled } from '../shared/settings';
import { type KeyStatus, getStored, loadSettings, saveSettings } from '../shared/storage';
import { formatDuration } from '../shared/time';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

const isPage = new URLSearchParams(location.search).has('page') || location.pathname.endsWith('options.html');
if (isPage) document.body.classList.add('page');

let settings: Settings;
let tab: chrome.tabs.Tab | undefined;
let host: string | null = null;
let status: Status | null = null;
let editingKey = false;

function prettyModel(model: string): string {
  return model
    .replace(/^gemini-/, 'Gemini ')
    .replace(/-flash-lite$/, ' Flash-Lite')
    .replace(/-flash$/, ' Flash');
}

// ---- Brand: SCRIBBLR on split-flap tiles that flip in when the popup opens ----

function renderBrand(): void {
  const brand = $('brand');
  const word = 'SCRIBBLR';
  const tiles = [...word].map(() => {
    const tile = document.createElement('span');
    tile.className = 'flap';
    tile.setAttribute('aria-hidden', 'true');
    brand.appendChild(tile);
    return tile;
  });
  const glyphs = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const start = performance.now();
  const step = (now: number) => {
    let done = true;
    tiles.forEach((tile, i) => {
      const settleAt = 180 + i * 70;
      if (reduced || now - start >= settleAt) {
        tile.textContent = word[i]!;
      } else {
        done = false;
        tile.textContent = glyphs[Math.floor(Math.random() * glyphs.length)]!;
      }
    });
    if (!done) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

// ---- Settings ----

function fillLanguages(select: HTMLSelectElement, value: string): void {
  select.replaceChildren(
    ...LANGUAGES.map((l) => {
      const option = document.createElement('option');
      option.value = l.code;
      option.textContent = l.name;
      if (l.native !== l.name) option.title = l.native;
      return option;
    }),
  );
  select.value = value;
}

function renderSettings(): void {
  $<HTMLInputElement>('enabled').checked = settings.enabled;
  fillLanguages($('source-lang'), settings.sourceLang);
  fillLanguages($('target-lang'), settings.targetLang);
  $<HTMLInputElement>('percent').value = String(settings.percent);
  $<HTMLInputElement>('chunk-size').value = String(settings.chunkSize);
  renderSliderLabels();
  renderSite();
}

function renderSliderLabels(): void {
  $('percent-out').textContent = `${$<HTMLInputElement>('percent').value}% of words`;
  $('size-out').textContent = `Mostly ${chunkSizeLabel(Number($<HTMLInputElement>('chunk-size').value)).toLowerCase()}s`;
}

function renderSite(): void {
  const card = $('site-card');
  card.hidden = !host;
  if (!host) return;
  $('site-name').textContent = host;
  const toggle = $<HTMLInputElement>('site-enabled');
  toggle.checked = !isSiteDisabled(settings, host);
  toggle.disabled = !settings.enabled;
}

async function update(patch: Partial<Settings>): Promise<void> {
  settings = await saveSettings(patch);
}

function bindSettings(): void {
  $<HTMLInputElement>('enabled').addEventListener('change', async (e) => {
    await update({ enabled: (e.target as HTMLInputElement).checked });
    renderSite();
    void refreshPage();
  });
  $<HTMLInputElement>('site-enabled').addEventListener('change', async (e) => {
    if (!host) return;
    const on = (e.target as HTMLInputElement).checked;
    const others = settings.disabledSites.filter((h) => h !== host);
    await update({ disabledSites: on ? others : [...others, host] });
    void refreshPage();
  });
  $<HTMLSelectElement>('source-lang').addEventListener('change', (e) => void update({ sourceLang: (e.target as HTMLSelectElement).value }));
  $<HTMLSelectElement>('target-lang').addEventListener('change', (e) => void update({ targetLang: (e.target as HTMLSelectElement).value }));
  $('swap').addEventListener('click', async () => {
    await update({ sourceLang: settings.targetLang, targetLang: settings.sourceLang });
    $<HTMLSelectElement>('source-lang').value = settings.sourceLang;
    $<HTMLSelectElement>('target-lang').value = settings.targetLang;
  });
  for (const id of ['percent', 'chunk-size']) {
    const input = $<HTMLInputElement>(id);
    input.addEventListener('input', renderSliderLabels);
    input.addEventListener('change', () => void update(id === 'percent' ? { percent: Number(input.value) } : { chunkSize: Number(input.value) }));
  }
}

// ---- API key ----

function renderKey(apiKey: string | undefined, keyStatus: KeyStatus | undefined | null): void {
  const hasKey = Boolean(apiKey);
  const invalid = keyStatus?.state === 'invalid';
  const showForm = !hasKey || invalid || editingKey;
  $('key-form').hidden = !showForm;
  $('key-summary').hidden = !hasKey || showForm;
  if (!hasKey) return;
  $('key-mask').textContent = `••••${apiKey!.slice(-4)}`;
  const badge = $('key-badge');
  badge.className = `pill ${keyStatus?.state === 'valid' ? '' : keyStatus?.state === 'invalid' ? 'bad' : 'unknown'}`;
  badge.textContent = keyStatus?.state === 'valid' ? 'working' : keyStatus?.state === 'invalid' ? 'rejected' : 'unchecked';
  if (invalid && !editingKey) {
    const message = $('key-message');
    message.className = 'note bad';
    message.textContent = keyStatus?.message
      ? `${keyStatus.message} Then save the key again here.`
      : 'Google rejected the saved key. Paste a new one.';
  }
}

function bindKey(): void {
  $('change-key').addEventListener('click', () => {
    editingKey = true;
    $('key-form').hidden = false;
    $('key-summary').hidden = true;
    $<HTMLInputElement>('api-key').focus();
  });
  $('key-entry').addEventListener('submit', async (e) => {
    e.preventDefault();
    const input = $<HTMLInputElement>('api-key');
    const key = input.value.trim();
    const message = $('key-message');
    if (!key) return;
    const button = $<HTMLButtonElement>('save-key');
    button.disabled = true;
    message.className = 'note';
    message.textContent = 'Checking the key…';
    const result = await sendToBackground<{ ok: boolean; message: string }>({ type: 'validate-key', key });
    button.disabled = false;
    message.className = `note ${result?.ok ? 'good' : 'bad'}`;
    message.textContent = result?.message ?? 'Something went wrong.';
    if (result?.ok) {
      input.value = '';
      editingKey = false;
      await refreshStatus();
    }
  });
}

// ---- Status ----

function renderStatus(): void {
  if (!status) return;
  const now = Date.now();
  const { rate, models, usage } = status;

  const pauseLine = $('pause-line');
  pauseLine.hidden = !(rate.pausedUntil > now);
  if (!pauseLine.hidden) {
    const left = formatDuration(rate.pausedUntil - now);
    pauseLine.textContent =
      rate.pauseReason === 'daily'
        ? `Paused for ${left}: every free-tier model has used up today's quota. Quotas reset at midnight Pacific time.`
        : `Paused for ${left}: Gemini's per-minute limit was reached.`;
  }

  const usable = models.filter((m) => !((rate.exhausted[m] ?? 0) > now));
  const exhausted = models.filter((m) => (rate.exhausted[m] ?? 0) > now);
  const current = usable[0];
  let modelText = current ? `Translating with ${prettyModel(current)}` : 'No model available right now';
  if (exhausted.length && current) modelText += ` (${exhausted.map(prettyModel).join(', ')} used up for today)`;
  $('model-line').textContent = status.hasKey ? `${modelText}.` : 'Add an API key to start translating.';

  const total = Object.values(usage.counts).reduce((a, b) => a + b, 0);
  $('usage-line').textContent = total
    ? `Requests today: ${Object.entries(usage.counts)
        .map(([m, n]) => `${prettyModel(m)} ${n}`)
        .join(' · ')}`
    : 'No requests to Gemini yet today.';

  const errorLine = $('error-line');
  const error = rate.lastError;
  errorLine.hidden = !error || now - error.at > 10 * 60_000;
  if (!errorLine.hidden) errorLine.textContent = `Last error: ${error!.message}`;
}

async function refreshStatus(): Promise<void> {
  status = (await sendToBackground<Status>({ type: 'status' })) ?? null;
  const [apiKey, keyStatus] = await Promise.all([getStored('apiKey'), getStored('keyStatus')]);
  renderKey(apiKey, keyStatus);
  renderStatus();
}

async function refreshPage(): Promise<void> {
  const line = $('page-line');
  const redo = $<HTMLButtonElement>('redo');
  $('page-row').hidden = isPage;
  if (isPage || tab?.id === undefined) return;
  let stats: PageStats | undefined;
  try {
    stats = await chrome.tabs.sendMessage<{ type: 'page-stats' }, PageStats>(tab.id, { type: 'page-stats' });
  } catch {
    stats = undefined;
  }
  redo.disabled = !stats || stats.state !== 'active';
  if (!stats) {
    line.textContent = host ? 'Reload the page to start translating it.' : 'Scribblr can’t run on this page.';
  } else if (stats.state === 'disabled') {
    line.textContent = 'Off on this page.';
  } else if (stats.state === 'no-key') {
    line.textContent = 'Waiting for an API key.';
  } else if (!stats.words) {
    line.textContent = `No ${languageName(settings.sourceLang)} text found yet.`;
  } else {
    const share = Math.round((100 * stats.translatedWords) / stats.words);
    const waiting = stats.waiting ? ` · ${stats.waiting} waiting` : '';
    line.textContent = `This page: ${stats.translatedChunks} chunks, ${share}% of words${waiting}`;
  }
}

async function main(): Promise<void> {
  renderBrand();
  settings = await loadSettings();
  if (!isPage) {
    [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    try {
      const url = new URL(tab?.url ?? '');
      host = /^https?:$/.test(url.protocol) ? url.hostname : null;
    } catch {
      host = null;
    }
  }
  renderSettings();
  bindSettings();
  bindKey();
  $('redo').addEventListener('click', async () => {
    if (tab?.id === undefined) return;
    await chrome.tabs.sendMessage(tab.id, { type: 'redo' }).catch(() => {});
    setTimeout(() => void refreshPage(), 300);
  });
  await Promise.all([refreshStatus(), refreshPage()]);
  setInterval(renderStatus, 1000);
  setInterval(() => void refreshStatus(), 4000);
  setInterval(() => void refreshPage(), 2000);
}

void main();
