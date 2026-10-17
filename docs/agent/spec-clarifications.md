# Spec clarifications

The user's answers (2026-10-17) to questions about `docs/human/spec.md`, plus the defaults I chose myself. The spec must never be edited (see AGENTS.md), so decisions are recorded here.

## Decided by the user

| Topic | Decision |
|---|---|
| Model | Start each day on `gemini-3.8-flash`, the newest free-tier Flash. When its **daily** quota runs out, step down through older Flash models and then Flash-Lite models; each model has its own quota. Pause only when all of them are exhausted. |
| Batching | On page load, request 1 covers the elements on screen (fast first result). Request 2 covers the rest of the page, which animates in as it scrolls into view. Content added later (infinite scroll, SPA navigation) is batched into follow-up requests. About 2 requests per page. |
| Chunk-size slider | A single slider from word to paragraph sets the *typical* chunk size. Actual sizes are sampled from a distribution centred on it: "phrase" gives mostly phrases, some single words, and the occasional sentence. |
| Sites | Runs everywhere by default. The popup has a global on/off and a "disable on this site" toggle. |
| Source language | Only translate text detected as the source language, using on-device `chrome.i18n.detectLanguage`. Everything else is skipped, which also saves requests. |
| Animation | "Scrambling letters": each character cycles through random glyphs and settles on the translation, left to right, inline in the page's own font. |
| Revisits | Reshuffle daily. Chunk selection is seeded from (text, settings, local date), so within a day the same text gets the same chunks and cached translations. The next day brings a new selection. |
| Platform | Chrome runs on **Windows**. The user builds inside **WSL** with nix and loads the unpacked build into Windows Chrome. This server is headless and has no Chrome. |
| Streaming text (spec line added after the Q&A) | Text that streams in after the page loaded (an AI chat reply, a live chat) must be translated too. |
| Practice chunks (spec section added later) | A second set of chunks is left in the source language with a blue dashed underline; hovering shows the translation, labelled "Translation". It has its own amount and chunk-size sliders: `practicePercent` (default 10) and `practiceChunkSize`.<br>• `planBoth` in `plan.ts` picks translated chunks first, then practice chunks from the leftover words, with the practice fraction scaled by 1/(1−translated) and capped at everything left. Each set has its own seed, so practice settings never reshuffle translated chunks.<br>• Both kinds go to the model in the same request, indistinguishable.<br>• In `apply.ts`, practice slots keep their text (from = to, so no flip), and the hover is the translation as plain text with kept elements' text filled in. |
| Model choice (spec line added later) | "Let you choose the order and which models are active." Implemented in `shared/models.ts` and the popup's Models section:<br>• Every listed Flash and Flash-Lite model, stable and preview, gets an on/off switch and up/down buttons.<br>• `settings.models` stores `{order, off, on}` relative to the defaults: stable models on, previews off, newest first. A custom order keeps new releases at its end; with no custom order they join in default position.<br>• Changing the models lifts a daily pause, since a model just switched on may have quota.<br>• With every model off, requests stop with a message. |
| Strict chunks (spec line added later) | The prompt must say the translation covers only the chunk: "What are you talking <chunk>about</chunk>" → "sobre" / "de qué", never "de qué estás hablando". This is now the first rule in `systemInstruction`, with that example. `npm run test:live` checks it with five tempting fragments, which pass on Flash-Lite. |

## How streaming text is handled

- A block is only translated once its text has stopped changing for 1.2s.
- It also waits while its parent keeps changing, up to 8s. A streaming reply is therefore sent as one request once it finishes, not one request per paragraph.
- New content is collected for a 1.5s lull (5s at most) before a follow-up request.
- Follow-up requests are spaced at least 3s apart. The gap grows ×1.5 per consecutive follow-up, up to 30s, and resets after a quiet minute. A live chat can't drain the quota.
- If the page rewrites a text node we shortened (React updating a streamed message), we remove our nodes, keep the page's text, and translate the block again once it settles.

## Defaults I chose (user can override)

- "Percent of page" means the fraction of words, segmented with `Intl.Segmenter` so CJK works. Numbers alone don't count as words.
- Chunk selection fills up to the word target in random order, then dithers on the smallest leftover segment. The expected share is exactly the slider value: a one-word button at 40% is translated in 40% of page views. A paragraph lands within one small segment of the target.
- Chunks contain whole words only, prefer clause and sentence boundaries, and never cross block elements or `<br>`. A chunk never ends on an article, possessive or demonstrative that leans on the next word. `LEADING_WORDS` in `segment.ts` covers en/es/fr/de/it/pt/nl; in those cases the chunk takes the next word along.
- Inline elements:
  - Links, `abbr`, `time` and inline buttons are atomic: whole or not at all.
  - Code, images and icons are kept as-is (`<xN/>` tags).
  - Styling wrappers (`b`, `em`, `span`, …) are transparent. When a chunk contains one fully, it becomes a `<tN>` tag so the formatting survives. When a chunk covers one only partially, its text pieces are merged into one.
- Never touch inputs, textareas, contenteditable, `<pre>`/`<code>`, scripts/styles, `aria-hidden`, `translate="no"`/`.notranslate`, icon-font text, hidden text, or the extension's own UI.
- Each request sends the page title and the page text with chunks annotated. Context is capped at 40k characters (the batch plus its nearest neighbours). A request holds at most 200 chunks or 12k characters of chunk text.
- Tabs opened in the background send no requests until they are first viewed.
- The model chain is discovered at runtime from `models.list`:
  - Order: Flash newest→oldest, then Flash-Lite newest→oldest, with a hardcoded fallback list.
  - Models that answer 404 are remembered per key and skipped from then on.
  - 5xx errors fall through to the next model for that request only.
- Rate limits:
  - A per-minute 429 pauses for the `RetryInfo` delay (60s if absent) and does not switch model.
  - A per-day 429 marks that model used up until the reset time Google gives in the error ("Please retry in 10h46m4.25s", also in RetryInfo; at least 1 minute). Without a hint, it's used up until midnight Pacific. The chain moves to the next model, and once every model is used up, everything pauses until the earliest reset.
  - The popup and the toolbar badge (`||`) show the paused state and when it resumes.
  - Requests are paced locally at 8 per minute per model.
  - Cached translations are still served while paused.
- Billing errors are blocking, not rate limits:
  - A depleted prepay balance (402) and an exceeded monthly spend cap (a 429 whose message mentions the spend cap) block requests and show what to do in AI Studio.
  - Don't match on "billing": ordinary quota 429s say "check your plan and billing details".
- Saving a key lists models, then makes one tiny call to a Flash-Lite model. Listing works even for keys that can't generate anything.
- Settings changes apply to text processed from then on. The popup's "Redo this page" re-applies them.
- Hover shows the original in a tooltip and highlights every piece of the chunk. Under `prefers-reduced-motion`, the scramble is skipped. Text the page re-renders isn't flipped a second time.
- The API key lives in `chrome.storage.local`.

## Facts discovered

- Free-tier limits aren't published; AI Studio shows each project's limits. Community reports from Sep–Oct 2026:
  - `gemini-3.8-flash` and the 3.7, 3.6 and 3.5 Flash models: about **20 RPD** each.
  - 3.5 and 3.1 Flash-Lite: about **500 RPD** each.
  - RPD resets at midnight Pacific, per the docs. The live API disagreed: on 2026-10-17 at 13:13 UTC, 3.8 Flash's daily 429 said "limit: 20 … Please retry in 10h46m", which is midnight UTC. Thirty seconds later a request to the same model succeeded anyway, so enforcement is loose. Trust the per-error hint over the documented reset.
- Flash models visible to the user's key on 2026-10-17:
  - Flash: `gemini-3.8-flash`, `-3.7-flash`, `-3.6-flash`, `-3.5-flash`, `-3-flash-preview`, `-2.5-flash`.
  - Flash-Lite: `-3.5-flash-lite`, `-3.1-flash-lite`, `-3.1-flash-lite-preview`, `-2.5-flash-lite`.
  - Aliases: `gemini-flash-latest`, `gemini-flash-lite-latest`.
  - `gemini-2.5-flash-lite` is listed but answers 404 "no longer available to new users".
- Billing (Google's docs, 2026):
  - New users default to the **Prepay** plan. Projects linked to a billing account don't get the free tier; only projects with no billing account do.
  - A $0 prepay balance makes every key on that billing account return **402**.
  - A project can also have a **monthly spend cap** (aistudio.google.com/spend). Once it's exceeded, requests fail with a bare 429.
- The user's key (`~/.envrc`) was on a billed project at first (402, then the spend-cap 429). On 2026-10-17 the user disabled billing on the project, and the same key then worked on the free tier straight away.
- Thinking levels: `gemini-3.8-flash` rejects `thinkingLevel: "minimal"` with a 400. It accepts `"low"`, which took about 3.6s for a 10-chunk request; with no thinking setting, the default thinking took about 16s. `gemini-3.5-flash-lite` accepts `"minimal"` (about 1.5s). `background/translate.ts` steps minimal → low → none and stores what each model accepted under the `thinking` storage key.
- Free-tier quota counting is per model (`quotaDimensions.model`), but loose and odd. On 2026-10-17, 3.7 Flash returned "limit: 20 … retry in 9h53m" after only a handful of our calls, and a call between two 429s went through. Don't assume exactly 20 usable calls per model. The chain copes by skipping models with a daily 429 until Google's reset time. The `log` storage key (last 50 API calls: model, outcome, ms, detail) shows what happened.
- Live run on the article test page (3.8 Flash, free tier): the first translations appeared after about 4s. Quality was good and in context. Before chunks were kept from ending on articles, phrase chunks ending on an article left the noun dangling ("de todo el world").
- Live tests use `GEMINI_API_KEY` from `~/.envrc` and spend the user's real quota (or money, on a billed project). Keep them opt-in and minimal, and run them against Flash-Lite.
- This server runs Nix 2.35 without `nix-command`/`flakes` enabled. `shell.sh` passes `--extra-experimental-features 'nix-command flakes'` itself, which also covers a fresh WSL install.
- Windows: `npm run install:windows` copies the build to `%USERPROFILE%\scribblr-extension`, because it's unverified whether Windows Chrome can "Load unpacked" from `\\wsl.localhost\…`. The WSL detection path is untested, since this server isn't WSL; the `SCRIBBLR_WINDOWS_DIR` override was tested.
