# Code structure

Developer map for Notion AI Analyzer 0.6.1. Product copy is Traditional Chinese (Taiwan). This file is English. Do not treat it as a product guide; see `README.md` or `README.zh-TW.md` for user-facing behaviour.

Traditional Chinese (Taiwan): [`CODE_STRUCTURE.zh-TW.md`](CODE_STRUCTURE.zh-TW.md)

The extension is Chrome Manifest V3, vanilla JavaScript, no bundler, no content scripts. The service worker owns Notion I/O, AI calls, queue processing, and Chrome storage. Popup and options are thin UIs that send `{ type, ... }` messages.

## Runtime

```text
popup.html  → ui-select.js, popup.js     (action popup)
options.html → ui-select.js, options.js  (options page)
background.js service worker
  importScripts(shared.js, prompt.js, notion.js, gemini.js)
```

`background.js` is the only Chrome messaging endpoint. UI never talks to Notion or AI providers directly. Queue continuation is scheduled with `chrome.alarms` (`notion-ai-analyzer-process`), not a long-lived loop in the worker.

Libraries attach an IIFE to `globalThis` (`AnalyzerShared`, `AnalyzerPrompt`, `AnalyzerNotion`, `AnalyzerGemini`, `AnalyzerSelect`) and also `module.exports` when Node `require` is available. Service-worker load order is required: `shared.js` before `prompt.js` / `notion.js`; those before `gemini.js`.

## File map

| File | Role |
| --- | --- |
| `manifest.json` | MV3 manifest: storage, alarms, activeTab; host access to Notion, Google AI Studio, Vertex AI, OpenRouter. |
| `background.js` | Orchestration: config/state, secrets, schema, scan/queue, `processItem`, topic organizer, single-page review, settings, message switch. |
| `shared.js` | Text/ID helpers: `cleanText`, Notion UUID extract/normalize, `visibleLength`, model-name sanitize, `chunkText`, `truncateMessage`. |
| `prompt.js` | Default analysis prompt, output-spec defaults/normalization, analysis / chunk / organizer / repair prompt builders. |
| `notion.js` | Property names, statuses, schema plan, page/block readers, analysis and topic PATCH payloads. |
| `gemini.js` | JSON schemas, request builders for Gemini-shaped generateContent, analysis/chunk/organizer validators and repair, model listing filters. |
| `popup.js` | Popup: inspect current tab, poll status, toolbar, recent list, single-page topic review UI. |
| `options.js` | Settings form, provider/model discovery UI, prompt/output-spec editors, topic organizer cards, dictionary import/export. |
| `ui-select.js` | Shared `AnalyzerSelect.enhance` custom select. Popup and options pass different listener/native-state options. |
| `popup.html` / `popup.css` | Popup chrome. `#discard-topic` label is 「這次暫不處理」. |
| `options.html` / `options.css` | Settings and organizer page. |
| `AGENTS.md` | Behavioural stability rules for refactors. |
| `PRIVACY.md` / `PRIVACY.zh-TW.md` | English and Traditional Chinese privacy and data-flow documentation. |
| `README.md` / `README.zh-TW.md` | English and Traditional Chinese product guide. |

`background.js` aliases loaded modules as `S`, `P`, `N`, `G`.

## Notion data model

Property names and status strings are part of the public contract. Do not rename them.

| Property | Type | Writer |
| --- | --- | --- |
| `整理狀態` | select | Analysis, review, organizer apply/rollback, failure/abort restore |
| `AI 標題` | rich_text | Article analysis only |
| `AI 摘要` | rich_text | Article analysis only |
| `AI 關鍵字` | rich_text | Article analysis only |
| `AI 暫定主題` | rich_text | Analysis writes `｜`-joined provisionals. Organizer apply, unclassified resolve, and single-page review remove resolved names. |
| `AI 主題` | multi_select | Confirmed taxonomy. **Batch analysis does not write this field.** Single-page reanalysis writes an empty multi_select. Organizer apply and single-page review add confirmed names. |

Statuses: `待分析` → `分析中` → `待主題整理` (batch) or `待主題確認` (single-page) → `已分析`, or `分析失敗`. Abort after a stop attempts to restore `待分析`.

**Do not conflate `AI 暫定主題` with `AI 主題`.**

- `AI 暫定主題` is independent classification from article analysis. The analysis prompt never receives existing `AI 主題` or the local dictionary.
- `AI 主題` is confirmed taxonomy, written only after a human (or remembered mapping) decision in single-page review, or after organizer apply / unclassified resolve (approve / replace / custom).
- Reanalysis of an already-analyzed page runs in `single_review` mode and **clears confirmed `AI 主題`** when the draft is written, then opens topic review. Batch analysis leaves confirmed `AI 主題` unchanged so the organizer can apply later.

`ensureSchema` / `readyNotion` may PATCH a missing data-source schema (AI fields and remaining status options) only when `整理狀態` already exists, its type is select, and it includes the `待分析` option. They do not delete or rename user-created options. Scan, test, queue, and popup inspection paths are therefore not necessarily read-only on the data source.

## Chrome storage

Do not rename these keys.

| Key | Store | Contents |
| --- | --- | --- |
| `notionAiAnalyzerConfig` | `local` | Non-secret settings, dictionary, discarded names, per-data-source `preferExistingTopics`, remembered mappings. |
| `notionAiAnalyzerState` | `local` | Queue, recent/failed, `topicReview`, `topicOrganizer`, rollback snapshot, pause/stage. |
| `notionAiAnalyzerNotionToken` | session, or local if remembered | Notion token |
| `notionAiAnalyzerGeminiKey` | session, or local if remembered | Google AI Studio key |
| `notionAiAnalyzerVertexKey` | same | Vertex key |
| `notionAiAnalyzerOpenRouterKey` | same | OpenRouter key |

Secrets are never written into config JSON, export files, recent logs, or Notion.

## Runtime modes

`stateCache.mode` is a coarse UI/queue flag, not a full state machine:

| Mode | Meaning |
| --- | --- |
| `idle` | Nothing in flight; popup shows surface-specific actions. |
| `batch` | Batch queue processing. |
| `paused` | Batch paused (stop), or a single-page run that paused after writing `待主題確認`. |
| `single_review` | Current-page analyze/reanalyze. `processItem` uses the single-page draft path. |
| `topic_apply` | Organizer apply or unclassified resolve is writing pages. |

`stopRequested` is checked at phase boundaries inside `processItem` (after the `分析中` write, after the page read, and after AI). It is not a race-free cancellation of an in-flight Notion/AI request. The abort path requeues the item and attempts to restore `待分析`.

`queueAll` may reuse a `pendingScan` cache at most two minutes old for the same data source instead of calling `scanPending` again.

## Message protocol

Do not rename `message.type` strings. UI `send()` throws when `{ ok: false }`. The service worker always replies `{ ok: true, data }` or `{ ok: false, error: { code, message } }`.

**Status / config**

- `GET_STATUS` / `GET_CONFIG` / `GET_PROMPT_PREVIEW`
- `SAVE_SETTINGS` / `CLEAR_CREDENTIALS` / `OPEN_OPTIONS`

**Provider / schema (owned by background, not the options page)**

- `TEST_CONNECTIONS` — save is done by the options page first; this call runs Notion readiness, schema, and a provider probe.
- `LIST_MODELS` — Gemini list, Vertex recommended set, or OpenRouter catalog. Options `renderModels` only fills the `<select>`.

**Batch queue**

- `SCAN_PENDING` / `ANALYZE_ALL` / `STOP_ANALYSIS` / `RESUME_ANALYSIS` / `RETRY_FAILED`

**Single page**

- `INSPECT_PAGE` / `REANALYZE_PAGE` / `REVIEW_CURRENT_PAGE_TOPICS` / `RESOLVE_TOPIC_REVIEW` / `CLEAR_RECENT`

`REANALYZE_PAGE` with `force: true` is used for current-page reanalyze and for non-failed recent-list rows. Failed recent rows retry without `force` and without a confirm dialog. Popup copy states that reanalysis clears existing `AI 主題`.

**Topic organizer**

- `PREPARE_TOPIC_ORGANIZER` / `GET_TOPIC_ORGANIZER`
- `APPLY_TOPIC_GROUPS` / `SKIP_TOPIC_GROUP` / `RESOLVE_ORGANIZER_UNCLASSIFIED`
- `CLEAR_TOPIC_ORGANIZER` / `ROLLBACK_TOPIC_APPLY`
- `EXPORT_TOPIC_DICTIONARY` / `PREVIEW_TOPIC_DICTIONARY_IMPORT` / `IMPORT_TOPIC_DICTIONARY`

Organizer group drafts (`selected`, `selectedAliases`, `standardTopic`) live on in-memory group objects in the options page. **Skip as well as apply** sends `groups` to the background (`saveTopicOrganizerDrafts` then persist). They do not remain local until apply.

## Analysis pipeline

`processItem` (batch or `single_review`):

1. Ensure schema for the configured data source; refuse a queued page from another source.
2. PATCH `整理狀態` → `分析中`.
3. Read blocks (90s bound), build article text. Images, video, audio, files, and PDFs are not analysis input.
4. `analyzeArticle` in `background.js` calls the selected provider. `gemini.js` / `prompt.js` build the payload and validate/repair JSON. Long articles may chunk-note then synthesize. Format repair sends the invalid output, not the source article. Safety blocks, empty output, and timeouts do not retry the full article.
5. PATCH via `N.analysisDraftPayload(result, status, clearFinalTopics)`:
   - Batch: status `待主題整理`, `clearFinalTopics` false (omit `AI 主題`).
   - `single_review`: status `待主題確認`, `clearFinalTopics` true (empty `AI 主題`), then open `topicReview` and pause.

Provider HTTP for Gemini and Vertex is `googleGenerativeRequest` with thin wrappers. OpenRouter is a separate path. Notion uses `notionRequest` with a different JSON-error fallback shape.

Article analysis never selects confirmed taxonomy names. Batch omits `AI 主題`; single-page reanalysis only writes it as an empty multi_select.

## Single-page topic review

`normalizeTopicReview` / `resolveTopicReview` in `background.js` walk remaining `AI 暫定主題` names. Approve / replace / custom add a name to `AI 主題` and remove it from provisionals. Status becomes `已分析` only when no provisionals remain.

**Skip versus discard is not shared:**

| Surface | Control | Message action | Effect |
| --- | --- | --- | --- |
| Popup `#discard-topic` 「這次暫不處理」 | `RESOLVE_TOPIC_REVIEW` `skip` | Keep the name in `AI 暫定主題`; do not add `AI 主題`. |
| Options unclassified 「永久捨棄」 | `RESOLVE_ORGANIZER_UNCLASSIFIED` `discard` | Remove the provisional from affected pages; record `discardedTopicNames`; do not add `AI 主題`. |
| Options unclassified skip | `skip` | Local organizer session only; Notion unchanged. |

Popup `#discard-topic` stays enabled unless `canDiscard === false`; that flag still gates the skip button despite the id.

## Topic organizer

`prepareTopicOrganizer` queries pages in `待主題整理` / `待主題確認` until it has at most **75** distinct provisional names (`G.TOPIC_ORGANIZER_BATCH_LIMIT`), or no more matching pages. Its Notion query requests only the `整理狀態`, `AI 暫定主題`, and `AI 主題` database properties; standard top-level page metadata may still be present in the response. Page body, AI title/summary/keywords, and co-occurrence are not sent to the model.

Names already mapped by Notion options, remembered page resolutions, or the dictionary become confirmed groups without an AI call. Remaining names go through `requestOrganizerGroups`: schema → compatibility (`canRetryTopicOrganizerWithoutSchema`) → repair, at most three AI calls. If JSON still fails, the whole remainder stays unclassified rather than emitting bad group cards.

Apply re-reads each page and unions the standard into current `AI 主題`; it does not blindly overwrite sibling groups. Rollback restores the last apply/manual-resolve snapshot; it does not delete newly created Notion multi_select options, and it does not preserve every later user edit on those pages.

Per-data-source `preferExistingTopics` only affects organizer prompts, not article analysis.

## UI

**Popup** (`popup.js`) polls `GET_CONFIG` + `GET_STATUS` every 1.5s while `actionBusy` is false. `inspectCurrentPage` classifies the tab as `other`, Notion database, or a single page (`INSPECT_PAGE`). Topic review blocks batch/scan/retry/organize. A live `single_review` run switches the current-page button to `STOP_ANALYSIS`. Queue control stays visible during an active batch even on another tab.

**Options** (`options.js`) owns form state, custom selects, organizer rendering (`renderOrganizer` and helpers), and dictionary files. Provider tests, schema PATCHes, and AI calls stay in `background.js`.

**Custom select** (`ui-select.js`): `sync()` rebuilds displayed value, trigger disabled state, options, selected checks, and optional native hidden/disabled mirroring. `close()` hides the menu and resets `aria-expanded`. Option click order: set native value → bubbling `change` → `sync` → `close` → restore trigger focus. Popup sets `attachDocumentListeners` and leaves `matchNativeState` false. Options sets `matchNativeState` and page-level document handlers, so `attachDocumentListeners` is false.

## Stability rules

Follow `AGENTS.md` when changing code:

- Do not rename Notion properties, Chrome storage keys, message `type` values, or status strings/transitions.
- Do not modify prompts during a structural refactor.
- Keep `AI 暫定主題` and `AI 主題` distinct; reanalysis must invalidate previous analysis **and** confirmed `AI 主題`.
- Preserve rollback and skip/discard behaviour.
- Prefer small, independently reviewable changes. Do not add abstractions unless they remove real duplication.

Section comments in `background.js` and JSDoc on payload/validation/UI helpers are the function-level companion to this file.
