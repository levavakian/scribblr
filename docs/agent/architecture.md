# Architecture notes (for future sessions)

See README "How it works" for the module map. This file covers the reasoning and the traps.

## The DOM rule: never move or remove page nodes

Frameworks like React keep references to their text nodes. Wrapping or replacing those nodes breaks the page, either with "removeChild: not a child" crashes or with updates that silently stop showing. So `content/apply.ts` only does three things:

1. Shortens page text nodes in place. The node keeps the text before its first chunk.
2. Inserts our own nodes after them: `<scribblr-t>` elements and plain text nodes.
3. Puts translated text *inside* page elements that a chunk fully contains (`<tN>` tags), e.g. a link keeps its element, href and listeners.

Bookkeeping lives in `content/own.ts`:

- `originalText` (WeakMap): shortened page nodes → their original text. The scanner reads through it, so rescans see the original page.
- `ownTextNodes` (WeakSet): text nodes we inserted. The scanner skips them.
- `PageController.ourChange()`: wraps our DOM writes with `takeRecords()` before and after, so the MutationObserver never treats our edits as page changes. Animation writes happen inside our elements and are filtered by `isOwnNode`.

When the page changes a node we shortened, `revertTranslations(applied, changedByPage)` removes our nodes, restores the other nodes, and keeps the page's new text. The block is then rescanned and translated again once it settles.

## Page controller flow (`content/page.ts`)

1. Scan `body` into runs (`scan.ts`). Initial runs count as settled.
2. Detect each run's language and plan its chunks (seeded by text, settings and day).
3. Initial requests: the on-screen batch, then (after it completes) the rest. Batches over the cap are left "lazy" until they come near the viewport (an IntersectionObserver with a 100% margin).
4. Results are applied when the block is visible (a second IntersectionObserver), with the flip animation.
5. The MutationObserver marks containers and added subtrees dirty. A tick (every ~400ms while there's work) rescans and reconciles. New blocks settle (1.2s quiet, parent quiet or 8s), then go out in debounced follow-up batches.

## Background (`background/translate.ts`)

- Serves cache hits first. Paused or keyless requests still get them.
- The model chain comes from `models.list` (refreshed every 12h per key, with 404'd models remembered).
- `rateState` in storage holds `pausedUntil`/`pauseReason`/`exhausted`. All writes go through `updateRate()`, which serializes them.
- At most 2 concurrent calls, and 8 per minute per model, paced locally.
- `keepAlive()` pings an extension API every 20s during long calls, so the MV3 worker isn't killed.

## Testing

- `npm test`: tsc and Vitest. DOM tests run in jsdom, which has no layout, so they pass a tag-based `styleOf` into `scanRuns`.
- `npm run test:e2e`: Playwright runs the built `dist/` in the Nix Chromium (`SCRIBBLR_CHROMIUM`), headless, against `test/e2e/mock-gemini.ts`.
  - The mock serves the test pages and scripted API behaviours (`script()` / `always()`: minute, daily, billing, not-found, overloaded).
  - Its "translation" upper-cases words, which makes assertions easy.
  - Screenshots go to `test-results/screenshots/`.
- `npm run test:live` and `LIVE_E2E=1 npx playwright test live` hit the real API. Load the key first: `set -a; . ~/.envrc; set +a`.

## Known gaps

- Only the top frame is handled (`window === window.top`). Iframes are skipped, which includes YouTube's live chat.
- Open shadow roots aren't traversed: neither the scanner nor the MutationObserver enters them.
- Visibility changes from class or style toggles aren't observed; only the `hidden` and `open` attributes are, to keep the observer quiet. Text that was hidden at scan time and is revealed by a class change isn't translated until something else rescans its container.

## Traps

- Nix flakes in a git repo only see **tracked** files: `git add` new flake inputs before `nix develop`. A fresh clone is fine.
- Playwright wipes `test-results/` at the start of each run, screenshots included.
- Vitest hides `console.log` from passing tests unless run with `--reporter=verbose`.
- npm 11 gates install scripts. `package.json` → `allowScripts` approves esbuild's.
- Branded Google Chrome 137+ ignores `--load-extension`, but Nix's Chromium honours it. That's why the tests use Chromium.
- The real Gemini 429 for free-tier quotas says "check your plan and billing details". Billing detection must match "spend cap" / "prepayment credits" or a 402, never just "billing".
- The mock's request order is the background's call order. Initial requests are sequential on purpose; the tests rely on "screen first".
- Thinking settings are per model. Never fall back to *no* `thinkingConfig` when a level is rejected: the default thinking is about 4× slower (16s against 3.6s on 3.8 Flash). Step up a level instead (the `thinking` storage key).
