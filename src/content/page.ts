import { hash32, hashKey, seededRandom } from '../shared/hash';
import { sameLanguage } from '../shared/languages';
import { collapseWhitespace, escapeText } from '../shared/markup';
import {
  type ContextBlock,
  type ContextPart,
  type PageStats,
  type TranslateRequest,
  type TranslateResult,
  sendToBackground,
} from '../shared/messages';
import { type Settings, chunkSizeLevel } from '../shared/settings';
import type { RateState } from '../shared/storage';
import { localDay } from '../shared/time';
import { flip } from './animate';
import { type AppliedBlock, applyTranslations, revertTranslations } from './apply';
import { type ChunkSpec, buildChunk } from './chunks';
import { detectPageLanguage, languageOf } from './lang';
import { ELEMENT_NODE, isOwnNode, originalText } from './own';
import { planChunks } from './plan';
import { type Run, type TextPiece, atomicRanges, blockContainerOf, hardBreaks, isExcluded, scanAddedSubtree, scanRuns } from './scan';
import { segmentText } from './segment';
import { Tooltip } from './tooltip';

/** Text must stop changing for this long before it's translated (streaming replies, live chat). */
const SETTLE_MS = 1200;
/** …and so must its neighbours, unless they keep changing for longer than this. */
const MAX_HOLD_MS = 8000;
const IDLE_TICK_MS = 400;
const MAX_CHUNKS_PER_REQUEST = 200;
const MAX_CHUNK_CHARS_PER_REQUEST = 12_000;
const MAX_CONTEXT_CHARS = 40_000;
/** New content is collected into one request: wait for a lull, but not forever. */
const FOLLOW_UP_DEBOUNCE_MS = 1500;
const FOLLOW_UP_MAX_WAIT_MS = 5000;
/** Minimum time between follow-up requests; it grows while content keeps streaming in. */
const MIN_GAP_MS = 3000;
const MAX_GAP_MS = 30_000;
/** Pauses longer than this (daily limits) give up on the waiting chunks instead of retrying. */
const LONG_PAUSE_MS = 5 * 60_000;
const MAX_ATTEMPTS = 4;

type BlockState = 'new' | 'detecting' | 'skipped' | 'planned' | 'requested' | 'ready' | 'applied' | 'done' | 'removed';

interface Chunk {
  spec: ChunkSpec;
  key: string;
  words: number;
  translation?: string;
  failed?: boolean;
}

interface Block {
  id: number;
  run: Run;
  firstNode: Text;
  /** When the block's text was first seen in its current form. */
  seenAt: number;
  state: BlockState;
  /** Left over from the first pass on a long page: requested once it nears the viewport. */
  lazy: boolean;
  waitUntil: number;
  attempts: number;
  words: number;
  chunks: Chunk[];
  applied: AppliedBlock | null;
}

interface ChunkRef {
  block: Block;
  index: number;
}

function firstTextNode(run: Run): Text {
  return (run.pieces.find((p) => p.kind === 'text') as TextPiece).node;
}

function byDocumentOrder(a: Block, b: Block): number {
  if (a === b) return 0;
  return a.firstNode.compareDocumentPosition(b.firstNode) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1;
}

function viewportDistance(el: Element): number {
  const r = el.getBoundingClientRect();
  if (r.bottom < 0) return -r.bottom;
  if (r.top > window.innerHeight) return r.top - window.innerHeight;
  return 0;
}

function inViewport(el: Element): boolean {
  const r = el.getBoundingClientRect();
  return (r.width > 0 || r.height > 0) && r.bottom > 0 && r.right > 0 && r.top < window.innerHeight && r.left < window.innerWidth;
}

function whenVisible(): Promise<void> {
  if (document.visibilityState === 'visible') return Promise.resolve();
  return new Promise((resolve) => {
    const onChange = () => {
      if (document.visibilityState !== 'visible') return;
      document.removeEventListener('visibilitychange', onChange);
      resolve();
    };
    document.addEventListener('visibilitychange', onChange);
  });
}

function plainPart(text: string): string {
  return escapeText(collapseWhitespace(text));
}

function tagOf(el: Element): string {
  const role = el.getAttribute('role');
  return (role && /^[a-z]+$/.test(role) ? role : el.localName).slice(0, 24);
}

/**
 * Runs the extension on one page: finds text, decides what to translate, asks the background for
 * translations, and swaps them in as they scroll into view.
 */
export class PageController {
  private active = false;
  private generation = 0;
  private settings: Settings;

  private blocks = new Set<Block>();
  private fresh = new Set<Block>();
  private byContainer = new Map<Element, Block[]>();
  private byNode = new WeakMap<Node, Block>();
  private chunkOriginals = new Map<string, string>();
  private shownTexts = new Set<string>();
  private nextId = 1;

  private activity = new WeakMap<Element, number>();
  private dirtyOwn = new Set<Element>();
  private dirtyAdded = new Set<Element>();
  private queuedRecords: MutationRecord[] = [];
  private needsGc = false;

  private visible = new Set<Element>();
  private near = new Set<Element>();

  private pageLanguage: string | null = null;
  private inflight = 0;
  private pausedUntil = 0;
  private blocked: 'no-key' | 'invalid-key' | null = null;
  private firstWantedAt = 0;
  private lastWantedAt = 0;
  private lastSentAt = 0;
  private followUpGap = MIN_GAP_MS;

  private timer: ReturnType<typeof setTimeout> | undefined;
  private timerDue = 0;
  private ticking = false;

  private readonly mutations = new MutationObserver((records) => this.onMutations(records));
  private readonly visibility = new IntersectionObserver((entries) => this.onVisibility(entries));
  private readonly nearness = new IntersectionObserver((entries) => this.onNearness(entries), { rootMargin: '100% 0px 100% 0px' });
  private readonly tooltip = new Tooltip((id) => this.chunkOriginals.get(id));
  private readonly reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

  constructor(settings: Settings) {
    this.settings = settings;
  }

  /** New settings apply to text processed from now on; "Redo this page" re-applies them everywhere. */
  updateSettings(settings: Settings): void {
    this.settings = settings;
  }

  /** The API key changed: retry anything that was waiting for one. */
  unblock(): void {
    this.blocked = null;
    for (const b of this.blocks) if (b.state === 'planned') b.waitUntil = 0;
    this.schedule(0);
  }

  onRateState(rate: RateState | undefined): void {
    const until = rate?.pausedUntil ?? 0;
    if (until < this.pausedUntil) {
      // The pause was lifted or shortened.
      this.pausedUntil = until;
      for (const b of this.blocks) if (b.state === 'planned') b.waitUntil = Math.min(b.waitUntil, until);
      this.schedule(0);
    }
  }

  async start(): Promise<void> {
    if (this.active || !document.body) return;
    this.active = true;
    const generation = ++this.generation;
    this.mutations.observe(document.body, { childList: true, characterData: true, subtree: true, attributes: true, attributeFilter: ['hidden', 'open'] });
    this.tooltip.attach();

    // Text already on the page counts as settled.
    const now = Date.now();
    for (const run of scanRuns(document.body, true)) this.addBlock(run, now - SETTLE_MS);
    this.pageLanguage = await detectPageLanguage(this.sampleText());
    if (generation !== this.generation) return;
    await this.detectAndPlan([...this.fresh]);
    // Don't spend quota on tabs opened in the background until they're looked at.
    await whenVisible();
    if (generation !== this.generation) return;
    this.sendInitialRequests();
    this.schedule();
  }

  stop(): void {
    if (!this.active) return;
    this.active = false;
    this.generation++;
    this.mutations.disconnect();
    this.visibility.disconnect();
    this.nearness.disconnect();
    this.tooltip.detach();
    clearTimeout(this.timer);
    this.timer = undefined;
    for (const b of this.blocks) if (b.applied) revertTranslations(b.applied);
    this.blocks.clear();
    this.fresh.clear();
    this.byContainer.clear();
    this.byNode = new WeakMap();
    this.chunkOriginals.clear();
    this.dirtyOwn.clear();
    this.dirtyAdded.clear();
    this.queuedRecords = [];
    this.visible.clear();
    this.near.clear();
    this.inflight = 0;
    this.firstWantedAt = this.lastWantedAt = this.lastSentAt = 0;
    this.followUpGap = MIN_GAP_MS;
  }

  stats(): PageStats {
    const stats: PageStats = { state: 'active', blocks: 0, translatedChunks: 0, words: 0, translatedWords: 0, waiting: 0 };
    for (const b of this.blocks) {
      if (b.state === 'new' || b.state === 'detecting' || b.state === 'skipped') continue;
      stats.blocks++;
      stats.words += b.words;
      if (b.state === 'planned' || b.state === 'requested' || b.state === 'ready') stats.waiting++;
      if (b.state !== 'applied') continue;
      for (const c of b.chunks) {
        if (c.translation === undefined || c.failed) continue;
        stats.translatedChunks++;
        stats.translatedWords += c.words;
      }
    }
    return stats;
  }

  // ---- Blocks -------------------------------------------------------------------------------

  private addBlock(run: Run, seenAt: number): void {
    const block: Block = {
      id: this.nextId++,
      run,
      firstNode: firstTextNode(run),
      seenAt,
      state: 'new',
      lazy: false,
      waitUntil: 0,
      attempts: 0,
      words: 0,
      chunks: [],
      applied: null,
    };
    this.blocks.add(block);
    this.fresh.add(block);
    const list = this.byContainer.get(run.container);
    if (list) {
      list.push(block);
    } else {
      this.byContainer.set(run.container, [block]);
      this.visibility.observe(run.container);
      this.nearness.observe(run.container);
    }
    for (const p of run.pieces) if (p.kind === 'text') this.byNode.set(p.node, block);
  }

  /** Forgets a block, undoing its translations. Nodes in `changedByPage` keep the page's new text. */
  private removeBlock(block: Block, changedByPage?: ReadonlySet<Node>): void {
    if (block.state === 'removed') return;
    if (block.applied) {
      const applied = block.applied;
      this.ourChange(() => revertTranslations(applied, changedByPage));
      for (const c of applied.chunks) this.chunkOriginals.delete(c.id);
      block.applied = null;
    }
    block.state = 'removed';
    this.blocks.delete(block);
    this.fresh.delete(block);
    const container = block.run.container;
    const list = this.byContainer.get(container)?.filter((b) => b !== block) ?? [];
    if (list.length) {
      this.byContainer.set(container, list);
    } else {
      this.byContainer.delete(container);
      this.visibility.unobserve(container);
      this.nearness.unobserve(container);
      this.visible.delete(container);
      this.near.delete(container);
    }
    for (const p of block.run.pieces) {
      if (p.kind === 'text' && this.byNode.get(p.node) === block) this.byNode.delete(p.node);
    }
  }

  /** Brings the blocks of `container` in line with a fresh scan of it. */
  private reconcile(container: Element, runs: Run[], now: number): void {
    const existing = this.byContainer.get(container) ?? [];
    const kept = new Set<Block>();
    const added: Run[] = [];
    for (const run of runs) {
      const first = firstTextNode(run);
      const match = existing.find((b) => !kept.has(b) && b.firstNode === first && b.run.text === run.text);
      if (match) kept.add(match);
      else added.push(run);
    }
    for (const b of existing) if (!kept.has(b)) this.removeBlock(b);
    for (const run of added) {
      // These text nodes may belong to a block scanned under another container; the new scan wins.
      for (const p of run.pieces) {
        const owner = p.kind === 'text' ? this.byNode.get(p.node) : undefined;
        if (owner) this.removeBlock(owner);
      }
      this.addBlock(run, now);
    }
  }

  /** Whether the block's page nodes still hold the text we planned against. */
  private intact(b: Block): boolean {
    return b.run.pieces.every((p) => p.kind !== 'text' || (p.node.isConnected && (originalText.get(p.node) ?? p.node.data) === p.text));
  }

  private gc(): void {
    this.needsGc = false;
    for (const b of [...this.blocks]) {
      if (!b.run.container.isConnected || !this.intact(b)) {
        this.removeBlock(b);
        if (b.run.container.isConnected) this.dirtyOwn.add(b.run.container);
      }
    }
  }

  private sampleText(): string {
    let sample = '';
    for (const b of this.blocks) {
      sample += `${b.run.text} `;
      if (sample.length > 4000) break;
    }
    return collapseWhitespace(sample);
  }

  // ---- Watching the page ----------------------------------------------------------------------

  /** Runs our own DOM changes without mistaking them for the page's. */
  private ourChange(change: () => void): void {
    const before = this.mutations.takeRecords();
    try {
      change();
    } finally {
      this.mutations.takeRecords();
      if (before.length) {
        this.queuedRecords.push(...before);
        this.schedule(0);
      }
    }
  }

  private onMutations(records: MutationRecord[]): void {
    if (!this.active) return;
    const now = Date.now();
    let relevant = false;
    for (const r of records) {
      const target = r.target;
      if (isOwnNode(target)) continue;
      if (r.type === 'childList') {
        let changed = false;
        r.removedNodes.forEach((n) => {
          if (isOwnNode(n)) return;
          changed = true;
          const block = this.byNode.get(n);
          if (block) this.removeBlock(block);
          else if (n.nodeType === ELEMENT_NODE) this.needsGc = true;
        });
        r.addedNodes.forEach((n) => {
          if (isOwnNode(n)) return;
          changed = true;
          if (n.nodeType === ELEMENT_NODE) this.dirtyAdded.add(n as Element);
        });
        if (!changed) continue;
      } else if (r.type === 'characterData') {
        // The page rewrote one of its text nodes, e.g. a streaming reply growing.
        const block = this.byNode.get(target);
        if (block) this.removeBlock(block, new Set([target]));
      } else if (r.type === 'attributes') {
        this.dirtyAdded.add(target as Element);
      }
      const el = target.nodeType === ELEMENT_NODE ? (target as Element) : target.parentElement;
      if (!el) continue;
      this.dirtyOwn.add(el);
      for (let a: Element | null = el; a; a = a.parentElement) this.activity.set(a, now);
      relevant = true;
    }
    if (relevant) this.schedule(100);
  }

  private rescan(now: number): void {
    const containers = new Set<Element>();
    for (const el of this.dirtyOwn) {
      if (!el.isConnected) continue;
      const container = blockContainerOf(el);
      if (container && !isExcluded(container)) containers.add(container);
    }
    this.dirtyOwn.clear();
    for (const container of containers) this.reconcile(container, scanRuns(container, false), now);

    const added = [...this.dirtyAdded];
    this.dirtyAdded.clear();
    for (const el of added) {
      if (!el.isConnected || isExcluded(el)) continue;
      const groups = new Map<Element, Run[]>();
      for (const run of scanAddedSubtree(el)) {
        const list = groups.get(run.container);
        if (list) list.push(run);
        else groups.set(run.container, [run]);
      }
      for (const [container, runs] of groups) this.reconcile(container, runs, now);
    }
  }

  private isSettled(b: Block, now: number): boolean {
    const quiet = (el: Element | null) => !el || now - (this.activity.get(el) ?? 0) >= SETTLE_MS;
    const container = b.run.container;
    return now - b.seenAt >= SETTLE_MS && quiet(container) && (quiet(container.parentElement) || now - b.seenAt >= MAX_HOLD_MS);
  }

  private onVisibility(entries: IntersectionObserverEntry[]): void {
    for (const e of entries) {
      if (!e.isIntersecting) {
        this.visible.delete(e.target);
        continue;
      }
      this.visible.add(e.target);
      for (const b of this.byContainer.get(e.target) ?? []) if (b.state === 'ready') this.applyBlock(b);
    }
  }

  private onNearness(entries: IntersectionObserverEntry[]): void {
    let wanted = false;
    for (const e of entries) {
      if (!e.isIntersecting) {
        this.near.delete(e.target);
        continue;
      }
      this.near.add(e.target);
      if (this.byContainer.get(e.target)?.some((b) => b.lazy && b.state === 'planned')) wanted = true;
    }
    if (wanted) {
      this.lastWantedAt = Date.now();
      this.schedule(0);
    }
  }

  // ---- Processing loop ------------------------------------------------------------------------

  private schedule(delay = IDLE_TICK_MS): void {
    if (!this.active) return;
    const due = Date.now() + delay;
    if (this.timer !== undefined) {
      if (due >= this.timerDue) return;
      clearTimeout(this.timer);
    }
    this.timerDue = due;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.tick();
    }, delay);
  }

  private hasWork(): boolean {
    if (this.fresh.size || this.dirtyOwn.size || this.dirtyAdded.size || this.queuedRecords.length || this.needsGc) return true;
    for (const b of this.blocks) {
      if (b.state === 'planned' && (!b.lazy || this.near.has(b.run.container))) return true;
    }
    return false;
  }

  private async tick(): Promise<void> {
    if (!this.active) return;
    if (this.ticking) {
      this.schedule();
      return;
    }
    this.ticking = true;
    try {
      if (this.queuedRecords.length) {
        const records = this.queuedRecords;
        this.queuedRecords = [];
        this.onMutations(records);
      }
      if (this.needsGc) this.gc();
      const now = Date.now();
      this.rescan(now);
      const settled = [...this.fresh].filter((b) => this.isSettled(b, now));
      if (settled.length) await this.detectAndPlan(settled);
      this.maybeFollowUp(Date.now());
    } finally {
      this.ticking = false;
    }
    if (this.hasWork()) this.schedule();
  }

  private async detectAndPlan(blocks: Block[]): Promise<void> {
    for (const b of blocks) {
      b.state = 'detecting';
      this.fresh.delete(b);
    }
    const languages = await Promise.all(blocks.map((b) => languageOf(b.run.text, b.run.container, this.pageLanguage)));
    const now = Date.now();
    blocks.forEach((b, i) => {
      if (b.state !== 'detecting') return; // removed while detecting
      const language = languages[i];
      if (language && !sameLanguage(language, this.settings.sourceLang)) {
        b.state = 'skipped';
        return;
      }
      if (this.plan(b)) this.lastWantedAt = now;
    });
  }

  /** Picks the block's chunks. Returns whether there is anything to translate. */
  private plan(b: Block): boolean {
    const s = this.settings;
    const seg = segmentText(b.run.text, s.sourceLang, atomicRanges(b.run), hardBreaks(b.run));
    b.words = seg.units.filter((u) => u.translatable).length;
    // Seeded by the text, the settings and the day: the same text gets the same chunks (and cache
    // hits) all day, and a fresh selection tomorrow.
    const seed = hash32([b.run.text, s.sourceLang, s.targetLang, s.percent, s.chunkSize, localDay()].join('\u0000'));
    const planned = planChunks(seg, { fraction: s.percent / 100, sizeLevel: chunkSizeLevel(s.chunkSize), random: seededRandom(seed) });
    b.chunks = planned.map(({ startUnit, endUnit }) => {
      const spec = buildChunk(b.run, seg.units[startUnit]!.start, seg.units[endUnit - 1]!.end);
      return {
        spec,
        key: hashKey([s.sourceLang, s.targetLang, b.run.text, spec.start, spec.end, spec.markup].join('\u0000')),
        words: seg.units.slice(startUnit, endUnit).filter((u) => u.translatable).length,
      };
    });
    b.state = b.chunks.length ? 'planned' : 'done';
    return b.chunks.length > 0;
  }

  // ---- Requests -----------------------------------------------------------------------------

  /** First pass: one request for what's on screen, one for the rest of the page. */
  private sendInitialRequests(): void {
    const planned = [...this.blocks].filter((b) => b.state === 'planned').sort(byDocumentOrder);
    const onScreen = planned.filter((b) => inViewport(b.run.container));
    const shown = new Set(onScreen);
    const distances = new Map(planned.map((b) => [b, viewportDistance(b.run.container)]));
    const rest = planned.filter((b) => !shown.has(b)).sort((a, b) => distances.get(a)! - distances.get(b)!);
    const first = this.takeBatch(onScreen);
    const second = this.takeBatch(rest);
    const taken = new Set(second);
    for (const b of rest) if (!taken.has(b)) b.lazy = true;
    // The rest of the page waits for the screen's translations, so those arrive first.
    for (const b of second) b.state = 'requested';
    this.lastSentAt = Date.now();
    const generation = this.generation;
    void (async () => {
      if (first.length) await this.send(first);
      const stillWanted = second.filter((b) => b.state === 'requested');
      if (stillWanted.length && generation === this.generation) await this.send(stillWanted);
    })();
  }

  private maybeFollowUp(now: number): void {
    // Requests still go out while the extension is paused: cached translations are served without
    // calling Gemini, and blocks that need the API wait for the pause to end (waitUntil).
    if (this.inflight > 0 || this.blocked || document.visibilityState !== 'visible') return;
    const wanted = [...this.blocks].filter((b) => b.state === 'planned' && b.waitUntil <= now && (!b.lazy || this.near.has(b.run.container)));
    if (!wanted.length) {
      this.firstWantedAt = 0;
      return;
    }
    this.firstWantedAt ||= now;
    const lull = now - this.lastWantedAt >= FOLLOW_UP_DEBOUNCE_MS || now - this.firstWantedAt >= FOLLOW_UP_MAX_WAIT_MS;
    if (!lull || now - this.lastSentAt < this.followUpGap) return;

    const rank = (b: Block) => (this.visible.has(b.run.container) ? 0 : this.near.has(b.run.container) ? 1 : 2);
    wanted.sort((a, b) => rank(a) - rank(b) || byDocumentOrder(a, b));
    const batch = this.takeBatch(wanted);
    // Back off while content keeps streaming in (live chat), so one page can't drain the quota.
    this.followUpGap = now - this.lastSentAt < 60_000 ? Math.min(MAX_GAP_MS, this.followUpGap * 1.5) : MIN_GAP_MS;
    this.lastSentAt = now;
    this.firstWantedAt = 0;
    void this.send(batch);
  }

  private takeBatch(candidates: Block[]): Block[] {
    const batch: Block[] = [];
    let chunks = 0;
    let chars = 0;
    for (const b of candidates) {
      const n = b.chunks.length;
      const c = b.chunks.reduce((sum, ch) => sum + ch.spec.markup.length, 0);
      if (batch.length && (chunks + n > MAX_CHUNKS_PER_REQUEST || chars + c > MAX_CHUNK_CHARS_PER_REQUEST)) break;
      batch.push(b);
      chunks += n;
      chars += c;
    }
    return batch;
  }

  private async send(batch: Block[]): Promise<void> {
    const generation = this.generation;
    for (const b of batch) {
      b.state = 'requested';
      b.attempts++;
    }
    const { request, refs } = this.buildRequest(batch);
    this.inflight++;
    let result: TranslateResult;
    try {
      result = await sendToBackground<TranslateResult>({ type: 'translate', request });
    } catch (error) {
      if (!chrome.runtime?.id) {
        // The extension was reloaded or removed; this content script is orphaned.
        this.stop();
        return;
      }
      result = { translations: {}, pending: { reason: 'error', until: Date.now() + 20_000, message: String(error) } };
    } finally {
      this.inflight--;
    }
    if (generation !== this.generation) return;
    this.handleResult(batch, refs, result ?? { translations: {} });
    this.schedule(0);
  }

  private buildRequest(batch: Block[]): { request: TranslateRequest; refs: Map<number, ChunkRef> } {
    const refs = new Map<number, ChunkRef>();
    const inBatch = new Set(batch);
    const all = [...this.blocks].sort(byDocumentOrder);

    // Context: the whole page if it fits, otherwise the batch plus its nearest neighbours.
    let include: Set<Block>;
    const total = all.reduce((sum, b) => sum + b.run.text.length, 0);
    if (total <= MAX_CONTEXT_CHARS) {
      include = new Set(all);
    } else {
      include = new Set(batch);
      let budget = MAX_CONTEXT_CHARS - batch.reduce((sum, b) => sum + b.run.text.length, 0);
      const positions = all.flatMap((b, i) => (inBatch.has(b) ? [i] : []));
      const distance = (i: number) => Math.min(...positions.map((p) => Math.abs(p - i)));
      const others = all.map((b, i) => [b, distance(i)] as const).filter(([b]) => !inBatch.has(b));
      others.sort((a, b) => a[1] - b[1]);
      for (const [b] of others) {
        if (budget <= 0) break;
        if (b.run.text.length > budget) continue;
        include.add(b);
        budget -= b.run.text.length;
      }
    }

    const blocks: ContextBlock[] = [];
    let inGap = false;
    for (const b of all) {
      if (!include.has(b)) {
        if (!inGap) blocks.push({ tag: '', parts: [] });
        inGap = true;
        continue;
      }
      inGap = false;
      if (!inBatch.has(b)) {
        const text = plainPart(b.run.text).trim();
        if (text) blocks.push({ tag: tagOf(b.run.container), parts: [text] });
        continue;
      }
      const parts: ContextPart[] = [];
      let pos = 0;
      b.chunks.forEach((c, index) => {
        if (c.spec.start > pos) parts.push(plainPart(b.run.text.slice(pos, c.spec.start)));
        if (c.failed) {
          parts.push(plainPart(b.run.text.slice(c.spec.start, c.spec.end)));
        } else {
          const id = refs.size;
          refs.set(id, { block: b, index });
          parts.push({ chunk: id, markup: c.spec.markup });
        }
        pos = c.spec.end;
      });
      if (pos < b.run.text.length) parts.push(plainPart(b.run.text.slice(pos)));
      blocks.push({ tag: tagOf(b.run.container), parts });
    }

    const request: TranslateRequest = {
      sourceLang: this.settings.sourceLang,
      targetLang: this.settings.targetLang,
      page: { title: document.title, url: location.origin + location.pathname },
      blocks,
      chunks: [...refs].map(([id, ref]) => ({ id, key: ref.block.chunks[ref.index]!.key })),
    };
    return { request, refs };
  }

  private handleResult(batch: Block[], refs: Map<number, ChunkRef>, result: TranslateResult): void {
    const now = Date.now();
    for (const [id, text] of Object.entries(result.translations ?? {})) {
      const ref = refs.get(Number(id));
      if (ref) ref.block.chunks[ref.index]!.translation = text;
    }
    for (const id of result.failed ?? []) {
      const ref = refs.get(id);
      if (ref) ref.block.chunks[ref.index]!.failed = true;
    }

    const pending = result.pending;
    let retryAt = now + 20_000;
    if (pending?.reason === 'no-key' || pending?.reason === 'invalid-key') this.blocked = pending.reason;
    if (pending?.until) retryAt = pending.until;
    if (pending?.reason === 'paused') this.pausedUntil = Math.max(this.pausedUntil, retryAt);
    const giveUp = pending?.reason === 'paused' && retryAt - now > LONG_PAUSE_MS;

    for (const b of batch) {
      if (b.state !== 'requested') continue;
      const open = b.chunks.filter((c) => c.translation === undefined && !c.failed);
      if (open.length) {
        if (giveUp || b.attempts >= MAX_ATTEMPTS) {
          for (const c of open) c.failed = true;
        } else {
          b.state = 'planned';
          b.waitUntil = retryAt;
          continue;
        }
      }
      b.state = 'ready';
      if (this.visible.has(b.run.container)) this.applyBlock(b);
    }
  }

  // ---- Showing translations -------------------------------------------------------------------

  private applyBlock(b: Block): void {
    // Catch up on page changes first: they may have touched this block.
    const pending = this.mutations.takeRecords();
    if (pending.length) this.onMutations(pending);
    if (b.state !== 'ready') return;
    if (!this.intact(b)) {
      const container = b.run.container;
      this.removeBlock(b);
      this.dirtyOwn.add(container);
      this.schedule(0);
      return;
    }
    const items = b.chunks.flatMap((c, i) =>
      c.translation !== undefined && !c.failed ? [{ id: `${b.id}.${i}`, spec: c.spec, translation: c.translation }] : [],
    );
    if (!items.length) {
      b.state = 'done';
      return;
    }
    let result: ReturnType<typeof applyTranslations> | undefined;
    this.ourChange(() => {
      result = applyTranslations(document, items);
    });
    if (!result) return;
    b.applied = result.applied;
    b.state = 'applied';
    for (const id of result.skipped) {
      const chunk = b.chunks[Number(id.split('.')[1])];
      if (chunk) chunk.failed = true;
    }
    // Text that was already flipped once this visit (e.g. re-rendered by the page) just appears.
    const textKey = hashKey(b.run.text);
    const instant = this.reducedMotion.matches || this.shownTexts.has(textKey);
    this.shownTexts.add(textKey);
    for (const c of result.applied.chunks) {
      this.chunkOriginals.set(c.id, c.original);
      flip(c.slots, { instant });
    }
  }
}
