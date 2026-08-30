# Notion AI Analyzer 0.6.1

A Chrome extension that uses Google AI Studio, Vertex AI, or OpenRouter to analyse plain text from Notion pages and produce Traditional Chinese titles, topics, keywords, and summaries.

The current user interface is designed for users in Taiwan and uses Traditional Chinese with Taiwan-specific terminology and language conventions. The codebase and developer-facing documentation are maintained primarily in English.

Traditional Chinese (Taiwan): [`README.zh-TW.md`](README.zh-TW.md)

## Highlights in this version

- If the database is missing the 「整理狀態」 property, has the wrong type, or is missing the 「待分析」 option, the options page and popup explain what to finish in Notion. They no longer show engineering jargon, and those notices are not immediately overwritten by a refresh.
- A rescan follows Notion’s current 「待分析」 pages: an idle queue is cleared; a real batch is built only when analysis starts; a paused batch drops stale pages and adds the latest ones.
- When there are no pending articles, the UI tells you to set pages to 「待分析」 in Notion and disables batch-analysis buttons that cannot run.
- The topic-dictionary actions are 「匯出」 and 「匯入」. Import is a split button for 「合併既有字典」 or 「取代既有字典」. Other options-page type sizes were not changed.
- During single-page analysis, the same button switches to 「停止分析」. After stop it returns to analysing the current page and does not affect the batch queue.
- Batch 「停止分析／繼續分析」 is one button, kept the same size as 「重試失敗」 on that row.
- During single-page item-by-item confirmation, a custom topic is added immediately to the existing-topic menu for the next candidate, so you do not have to type it again.
- The old `待確認主題` status is no longer supported. A scan requires an existing `整理狀態` select property and the `待分析` option; if either is missing, the extension stops and says so. Other custom options are left alone.
- The popup switches by the current Notion surface: a database view shows scan, batch analysis, queue control, retry, and batch topic organizing; an analysable article page shows current-page actions only. Progress and stop during a batch stay globally visible so switching tabs does not interrupt the queue.
- 「分析下一篇」 is removed. Database actions are 「掃描資料庫」 and 「分析所有『待分析』頁面」. A scan of the same database finished within two minutes can be reused for batch analysis so consecutive actions do not query again.
- Article analysis and topic organizing are fully separate. Batch analysis writes AI title, summary, keywords, provisional topics, and processing status. It does not change `AI 主題`.
- Batch analysis writes 1–3 classifications into `AI 暫定主題` by default, then continues. You can set 1–5 in settings. New topic names are still at most 5 visible characters.
- Each topic-organizing run collects at most 75 distinct provisional topics from matching pages. Fewer than 75 still runs; it does not automatically continue to another batch.
- 「優先沿用既有主題」 can be turned on per Notion data source. When on, organizing first tries to cover specific situations, behaviours, strategies, and subtypes with existing topics; it may still suggest new topics when that is not reasonable. All results still need human confirmation.
- Topic-organizing queries ask Notion to return only the `整理狀態`, `AI 暫定主題`, and `AI 主題` database properties. Page body, AI title, summary, and keywords are not sent for classification, and occurrence counts, co-occurrence, and article similarity are not used as grouping evidence.
- On a Notion article page you can use 「分析目前頁面」, then confirm provisional topics one by one: keep an existing topic, create a custom name, skip for now, and choose whether to remember the mapping.
- The AI groups this batch’s distinct provisional topics at a medium grain. Besides synonyms and naming variants, it may merge nearby topics that one practical category can cover without a clear loss of main retrieval use. Same domain, hierarchy, or relatedness may support a suggestion but cannot be the only reason to merge.
- New confirmed topics are 2–6 visible characters, preferring 2–4. Existing `AI 主題` names may keep their original form. A new group needs at least two sources; a single source may only map onto an existing topic.
- Stray topics with no suitable group go to 「本輪未分類」. You can create a confirmed topic, map to an existing one, discard permanently, or skip for now.
- Before apply, each page is re-read and values are unioned. Interleaved groups do not overwrite each other. Rollback removes only topics actually added in the last apply.
- The analysis prompt is editable. Output spec values can be set directly, each with its own restore-default action, plus a per-request AI wait limit.
- The topic dictionary can be exported and imported as JSON without API keys, tokens, or article text.
- Usage-saving behaviour is kept: format repair sends only the bad output; safety blocks, empty output, and timeouts do not automatically resend the full article.
- Switching Notion data sources clears the old local queue. Each write also checks the data source so another database is not analysed by mistake.
- If a model rejects strict JSON schema, topic organizing falls back to compatible JSON mode. If the format still cannot be repaired, that batch’s remaining candidates stay unclassified instead of producing a mass of bad cards.
- Organizer warnings are grouped by issue instead of one safety notice per candidate. Updating to this version also clears suggestion cache left by the old grouping spec.

## Notion properties

Before using this extension, the database must already have a `整理狀態` select property and the `待分析` option. Testing the connection, scanning, starting a queue, or opening the popup on a Notion page checks these first (`整理狀態` must be select and include `待分析`); if they are missing, the extension stops and explains how to fix them in Notion. Only after that gate passes may it PATCH missing AI properties and remaining status options. It does not delete, move, rename, or change other options you created.

| Property | Type | Use |
| --- | --- | --- |
| AI 標題 | rich_text | Default at most 12 visible characters |
| AI 主題 | multi_select | Confirmed standard topics |
| AI 暫定主題 | rich_text | Classifications still to organize or confirm, separated by `｜` |
| AI 關鍵字 | rich_text | Default 5 keywords, separated by `｜` |
| AI 摘要 | rich_text | Default 100–250 characters |
| 整理狀態 | select | 待分析, 分析中, 待主題整理, 待主題確認, 已分析, 分析失敗 |

## Install

1. Unzip the ZIP.
2. Open Chrome `chrome://extensions`.
3. Turn on Developer mode.
4. Load unpacked and choose the folder that contains `manifest.json`.
5. Open the options page and enter the Notion Integration Token, the database URL or Data Source ID, and the AI key.
6. Click 「測試連線並準備欄位」.

The Notion Integration must already be invited to the target database.

## AI providers

### Google AI Studio

Uses a Gemini API key. Usage here does not draw down the Google Cloud US$300 trial credit. The options page links to AI Studio usage and rate-limit documentation.

Content and responses submitted through Google AI Studio or the Gemini API as an unpaid service may be used by Google to improve and develop its products, services, and machine-learning technologies, and may be human-reviewed. Do not submit sensitive, confidential, or personal information. If the project has Cloud Billing enabled, paid-service data terms may apply; the [Gemini API Additional Terms of Service](https://ai.google.dev/gemini-api/terms) govern.

### Vertex AI

Uses a Google Cloud API key with Vertex AI enabled. Eligible usage may count against the Google Cloud trial credit; actual coverage and remaining credit follow Cloud Billing. The model list is Google text-generation models, including Preview models. After you select one, a lightweight token-count request verifies it; the extension does not switch models automatically.

### OpenRouter

Model listing includes only concrete models with text output, explicit Structured Outputs support, and enough context for article analysis. It excludes `openrouter/free` random routing and image, audio/video, embedding, rerank, and code-specialist models. Preview / experimental models are kept. Free and paid models are labelled; paid models require a cost-confirmation checkbox.

## Batch analysis flow

1. Read `待分析` pages from oldest to newest by Notion `created_time`.
2. Read plain-text blocks.
3. For a typical article, one main AI call produces the title, summary, keywords, and provisional topics. Long articles may first use chunk-note calls and then a synthesis call.
4. Update only `AI 標題`, `AI 摘要`, `AI 關鍵字`, `AI 暫定主題`, and `整理狀態`. Existing `AI 主題` is left as-is.
5. Status becomes `待主題整理`.
6. Batch analysis continues to the next page.

Whether or not a topic dictionary exists, the dictionary and existing Notion options are not sent in the article-analysis prompt and do not affect independent classification of the article.

### Analyse the current page

Open the extension on an article page in the configured database and click 「分析目前頁面」. The Page ID is taken from the current tab URL. Source URLs, post numbers, capture keys, and local queue order are not required. If the page already has AI content, the confirmation explains that reanalysis will regenerate the AI analysis, clear all existing confirmed `AI 主題`, and restart topic confirmation. After analysis you can accept a candidate, map it to an existing topic, create a custom topic of at most 5 characters, or skip it for now. Topics confirmed in this new review are unioned into `AI 主題`. Candidates skipped for now remain in `AI 暫定主題` until they are resolved. The field is cleared only after everything is resolved and status becomes `已分析`.

## Topic organizing

Each time you click 「掃描並產生整理建議」, pages in `待主題整理` or `待主題確認` are queried until there are at most 75 distinct `AI 暫定主題` names, or no more matching pages. Fewer than 75 still runs. Each button press is its own batch and does not automatically continue to the next batch.

The organizer query asks Notion to return only the `整理狀態`, `AI 暫定主題`, and `AI 主題` database properties; Page ID is used only to write back to the correct page. Classification sent to the AI is only this batch’s distinct provisional topic names and optional existing confirmed `AI 主題` names. Page body, page title, AI title, summary, keywords, occurrence counts, co-occurrence, and impact counts are not used for classification.

The AI reads the batch of provisional names and proposes medium-grain, durable confirmed topics. This is deduplication and normalisation of topic labels, not a fixed top-level taxonomy and not clustering by article co-occurrence. Merge is proposed when one practical medium-grain category can cover several provisional topics without a clear loss of their main retrieval use. That includes synonyms, naming / wording variants, and nearby ranges people would usually browse or search together. Same domain, hierarchy, relatedness, frequent co-occurrence, or the ability to sit on the same article may support a suggestion but cannot be the only reason to merge. Topics that belong to different analysis dimensions, or that would need an oversized umbrella whose content you cannot predict, stay separate. Existing `AI 主題` is optional cross-batch reference, not a required reuse. New confirmed topics must be 2–6 visible characters, preferring natural, precise 2–4 character names. 5–6 characters are only when necessary, and empty tails such as 「解析、解讀、觀察、系統、規劃、分析」 should not be added to pad length. A new group needs at least two sources; a single source may only map onto an existing AI topic.

Sources with no suitable group are listed under 「本輪未分類」 and handled with the same item-by-item confirmation pattern:

- Create a new confirmed topic.
- Map to an existing Notion `AI 主題`.
- Permanently discard an unsuitable provisional topic.
- Skip for now and keep it for a later rescan.

Create, map-to-existing, and permanent discard all count as resolving that provisional topic and immediately remove it from `AI 暫定主題` on every affected page. Skip-for-now does not change Notion, so you can decide again later. Permanently discarded names are remembered locally and are not forced into AI grouping later, but if they appear again on other pages they still surface for a human to remove them explicitly.

Before apply you can:

- Tick suggestions and, inside a group, decide which provisional topics to apply; unticked candidates stay pending confirmation.
- Read 「建議說明」 and related topics the model suggested keeping separate, or click 「暫不處理」 for the next suggestion run.
- Edit the standard topic name.
- 「若套用，將更新 N 篇」 is computed locally after the AI judgement. It is a scope count, not a confidence score.
- Expand 「本輪未分類」 to create, map, discard, or skip provisional topics that were not forced into a group.
- Optionally tick all high-confidence suggestions. That only pre-selects; it does not apply.
- Use 「清除目前建議」 to drop a stale list. That does not delete Notion topics, change articles, or clear the topic dictionary.

After confirmation, Notion API batch updates run with no further AI call. Each page is re-read before write, and the standard topic is unioned with current `AI 主題`. Each successfully applied or manually resolved provisional topic is removed from that page’s `AI 暫定主題` at once; unticked or still-open candidates in the same group stay. While unresolved items remain, status stays `待主題確認`. When provisional topics are fully empty, the field is cleared and status becomes `已分析`. The local dictionary is reused only while the corresponding standard still exists in Notion, so deleted old topics are not suggested again. The last apply or manual-resolve snapshot is kept; rollback removes only topics actually added that time and restores matching status and provisional topics. Newly created Notion options are not deleted automatically.

## Advanced analysis settings

Default output is title cap 12, topics 1–3, keywords 5, summary 100–250. The options page shows six numeric fields and a live spec summary. There is no compact / balanced / detailed preset. Allowed ranges:

- Title cap: 6–30
- Topic min / max: 1–5
- Keyword count: 3–10
- Summary min: 50–500
- Summary max: 100–800

「恢復預設規格」 resets only the six numeric fields. 「恢復預設提示詞」 resets only the analysis prompt, so one customisation is not cleared by accident. Settings apply to the prompt, JSON Schema, local validation, and format repair, not just on-screen copy. You can edit, copy, restore, and preview the prompt, including the fixed safety and output contract that is actually sent.

The per-request AI wait limit can be 3, 5, or 10 minutes, or unlimited. Default is 5 minutes. A timeout stops that request, does not automatically resend the full article, returns the page to pending analysis, and pauses the queue.

## Long articles and failures

- A typical article is one main AI call. Only when the text exceeds the model’s safe length are notes extracted in chunks and then combined.
- On bad AI JSON, the repair request contains only the bad output and the check message, not the source article.
- Chunk format repair contains only the bad chunk output; it does not resend the chunk or the full article.
- Safety blocks, prohibited content, and empty output are not retried in a way that cannot succeed.
- Notion write retries do not call AI again.
- Explicit timeout messages: 90 seconds for a single-page read, 90 seconds for a scan, 60 seconds for a Notion write.

## Privacy

The extension developer does not operate a separate intermediary server, and the extension has no analytics or telemetry. Articles go from Notion to the AI provider you selected; providers you did not select do not receive the article. Images, video, audio, files, and PDFs are not used as analysis input. Opening the popup on a Notion page may query Notion to identify the current page. For the full data-flow description, see [`PRIVACY.md`](PRIVACY.md) ([Traditional Chinese](PRIVACY.zh-TW.md)).
