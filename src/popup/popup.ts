import { LANGUAGES, languageName } from '../shared/languages';
import { type PageStats, type Status, sendToBackground } from '../shared/messages';
import {
  DEFAULT_MODEL_PREFS,
  FALLBACK_MODELS,
  type ModelChoice,
  type ModelPrefs,
  activeModels,
  applyModelPrefs,
  moveModel,
  prettyModel,
  setModelEnabled,
} from '../shared/models';
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
  for (const [id, key] of SLIDERS) $<HTMLInputElement>(id).value = String(settings[key]);
  renderSliderLabels();
  renderModeTitles();
  renderSite();
}

/** Slider element ids and the settings they control. */
const SLIDERS = [
  ['percent', 'percent'],
  ['chunk-size', 'chunkSize'],
  ['practice-percent', 'practicePercent'],
  ['practice-size', 'practiceChunkSize'],
] as const;

function renderSliderLabels(): void {
  const value = (id: string) => Number($<HTMLInputElement>(id).value);
  const size = (id: string) => `Mostly ${chunkSizeLabel(value(id)).toLowerCase()}s`;
  $('percent-out').textContent = `${value('percent')}% of words`;
  $('size-out').textContent = size('chunk-size');
  $('practice-out').textContent = `${value('practice-percent')}% of words`;
  $('practice-size-out').textContent = size('practice-size');
  // Practice chunks come from the words the translated chunks leave over.
  const left = 100 - value('percent');
  const note = $('practice-note');
  note.hidden = value('practice-percent') <= left;
  note.textContent = `Only ${left}% of words are left after the translated ones, so practice is capped at that.`;
}

/** "Shown in Spanish · hover for English" / "Left in English to practice · hover for Spanish". */
function renderModeTitles(): void {
  const source = languageName(settings.sourceLang);
  const target = languageName(settings.targetLang);
  $('shown-lang').textContent = target;
  $('shown-hint').textContent = `hover for ${source}`;
  $('practice-lang').textContent = source;
  $('practice-hint').textContent = `hover for ${target}`;
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
  $<HTMLSelectElement>('source-lang').addEventListener('change', async (e) => {
    await update({ sourceLang: (e.target as HTMLSelectElement).value });
    renderModeTitles();
  });
  $<HTMLSelectElement>('target-lang').addEventListener('change', async (e) => {
    await update({ targetLang: (e.target as HTMLSelectElement).value });
    renderModeTitles();
  });
  $('swap').addEventListener('click', async () => {
    await update({ sourceLang: settings.targetLang, targetLang: settings.sourceLang });
    $<HTMLSelectElement>('source-lang').value = settings.sourceLang;
    $<HTMLSelectElement>('target-lang').value = settings.targetLang;
    renderModeTitles();
  });
  for (const [id, key] of SLIDERS) {
    const input = $<HTMLInputElement>(id);
    input.addEventListener('input', renderSliderLabels);
    input.addEventListener('change', () => void update({ [key]: Number(input.value) }));
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

// ---- Models ----

let modelsRendered = false;

function modelChoices(): ModelChoice[] {
  return applyModelPrefs(status?.models.length ? status.models : FALLBACK_MODELS, settings.models);
}

function iconButton(text: string, label: string, disabled: boolean, onClick: () => void): HTMLButtonElement {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'icon';
  button.textContent = text;
  button.title = label;
  button.setAttribute('aria-label', label);
  button.disabled = disabled;
  button.addEventListener('click', onClick);
  return button;
}

async function updateModels(prefs: ModelPrefs, focus?: { model: string; direction: 'up' | 'down' }): Promise<void> {
  await update({ models: prefs });
  renderModels();
  renderStatus();
  if (!focus) return;
  // Keep keyboard focus on the moved model, so it can be moved again.
  const row = document.querySelector<HTMLLIElement>(`.model-row[data-model="${CSS.escape(focus.model)}"]`);
  const buttons = row?.querySelectorAll<HTMLButtonElement>('button.icon');
  const target = focus.direction === 'up' ? buttons?.[0] : buttons?.[1];
  (target && !target.disabled ? target : row?.querySelector('input'))?.focus();
}

function renderModels(): void {
  modelsRendered = Boolean(status);
  const choices = modelChoices();
  const prefs = settings.models ?? DEFAULT_MODEL_PREFS;
  $('model-list').replaceChildren(
    ...choices.map((choice, i) => {
      const row = document.createElement('li');
      row.className = `model-row${choice.enabled ? '' : ' off'}`;
      row.dataset.model = choice.model;
      const label = document.createElement('label');
      label.className = 'model-toggle';
      const box = document.createElement('input');
      box.type = 'checkbox';
      box.checked = choice.enabled;
      box.addEventListener('change', () => void updateModels(setModelEnabled(prefs, choice.model, box.checked)));
      const name = document.createElement('span');
      name.className = 'model-name';
      name.textContent = prettyModel(choice.model);
      label.append(box, name);
      const meta = document.createElement('span');
      meta.className = 'model-meta';
      const pretty = prettyModel(choice.model);
      row.append(
        label,
        meta,
        iconButton('↑', `Move ${pretty} up`, i === 0, () =>
          void updateModels(moveModel(choices, prefs, choice.model, -1), { model: choice.model, direction: 'up' }),
        ),
        iconButton('↓', `Move ${pretty} down`, i === choices.length - 1, () =>
          void updateModels(moveModel(choices, prefs, choice.model, 1), { model: choice.model, direction: 'down' }),
        ),
      );
      return row;
    }),
  );
  const active = choices.filter((c) => c.enabled);
  $('models-warning').hidden = active.length > 0;
  $('models-summary').textContent = active.length
    ? `${prettyModel(active[0]!.model).replace(/^Gemini /, '')} first, ${active.length} on`
    : 'all switched off';
  renderModelMeta();
}

/** Today's request count and whether the daily quota is used up, per model. */
function renderModelMeta(): void {
  const now = Date.now();
  for (const row of document.querySelectorAll<HTMLLIElement>('.model-row')) {
    const model = row.dataset.model!;
    const until = status?.rate.exhausted[model] ?? 0;
    const used = status?.usage.counts[model];
    const parts = [used ? `${used} today` : '', until > now ? `used up for ${formatDuration(until - now)}` : ''].filter(Boolean);
    row.querySelector('.model-meta')!.textContent = parts.join(' · ');
    row.classList.toggle('exhausted', until > now);
  }
}

function bindModels(): void {
  if (isPage) $<HTMLDetailsElement>('models').open = true;
  $('models-reset').addEventListener('click', () => void updateModels(DEFAULT_MODEL_PREFS));
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
        ? `Paused for ${left}: every free-tier model has used up its daily quota.`
        : `Paused for ${left}: Gemini's per-minute limit was reached.`;
  }

  const active = activeModels(models, settings.models);
  const usable = active.filter((m) => !((rate.exhausted[m] ?? 0) > now));
  const exhausted = active.filter((m) => (rate.exhausted[m] ?? 0) > now);
  const current = usable[0];
  let modelText = current ? `Translating with ${prettyModel(current)}` : active.length ? 'No model available right now' : 'Every model is switched off';
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
  if (!modelsRendered) renderModels();
  else renderModelMeta();
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
    const practice = stats.practiceChunks ? `, ${stats.practiceChunks} to practice` : '';
    const waiting = stats.waiting ? ` · ${stats.waiting} waiting` : '';
    line.textContent = `This page: ${stats.translatedChunks} translated (${share}% of words)${practice}${waiting}`;
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
  bindModels();
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
