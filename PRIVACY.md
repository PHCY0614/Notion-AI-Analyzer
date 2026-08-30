# Privacy and data flow

Version: 0.6.1

Traditional Chinese (Taiwan): [`PRIVACY.zh-TW.md`](PRIVACY.zh-TW.md)

## Data this extension reads

This extension uses the Notion Integration Token you provide to access the configured Notion data source and to inspect a Notion page identified from the current tab:

- Page ID, Notion URL, and the original page title, for the queue and recent/failed lists.
- Plain-text blocks from the page, for article analysis.
- `整理狀態`, to find pages in `待分析` or `分析失敗`. Topic organizing also queries `待主題整理` and `待主題確認`.
- The data-source schema, to check required fields and to list existing confirmed AI topics (`AI 主題`) options.
- During batch topic organizing, the extension queries matching pages until it has at most 75 distinct provisional topics (`AI 暫定主題`), or there are no more matching pages. The organizer query asks Notion to return only the `整理狀態`, `AI 暫定主題`, and `AI 主題` database properties; Page ID is used only to write back to the correct page.
- When the popup opens or you use 「分析目前頁面」, the Chrome-side tab access reads only the current tab’s Notion URL to identify the Page ID; it does not read other tabs or browsing history. It may then inspect that page and its data-source schema through the Notion API.

Images, video, audio, files, and PDFs are not used as analysis input and are not sent to the AI provider.

Chrome permissions are `storage`, `alarms`, and `activeTab`. Host permissions are limited to `https://api.notion.com/*`, `https://generativelanguage.googleapis.com/*`, `https://aiplatform.googleapis.com/*`, and `https://openrouter.ai/*`.

## Where data is sent

1. The extension calls `api.notion.com` directly to read the selected pages. The Notion token is sent in an HTTP header, not in the URL.
2. For single-page and batch article analysis, the following are sent to the currently selected AI provider (Google AI Studio at `generativelanguage.googleapis.com`, Vertex AI at `aiplatform.googleapis.com`, or OpenRouter at `openrouter.ai`):
   - Notion page plain text
   - the analysis prompt you have configured
   - the output spec
   - the excluded-person terms list

   Providers you did not select do not receive the article. Listing models and testing the connection send the key to the currently selected provider. The Vertex test also sends the fixed string `連線測試` and does not include a Notion page.
3. Returned JSON is checked locally for shape, length, and counts. Article-analysis requests do not include existing confirmed AI topics (`AI 主題`) or the local topic dictionary, and the analysis step does not select confirmed `AI 主題`. Batch analysis does not write `AI 主題`. Single-page reanalysis clears confirmed AI topics and then enters the topic-confirmation flow.
4. Batch topic organizing sends only this batch’s distinct provisional topic (`AI 暫定主題`) names and optional existing confirmed AI topic (`AI 主題`) names. Page body, page title, AI title, summary, keywords, occurrence counts, co-occurrence, and impact counts are not sent for classification.
5. Accepted results are written back to `api.notion.com`. Testing the connection, scanning, starting a queue, or opening the popup on a Notion page may PATCH missing AI properties and remaining status options only when `整理狀態` already exists, its type is select, and it includes the `待分析` option. User-created options are not deleted or renamed.

The extension developer does not operate a separate intermediary server and the extension has no analytics or telemetry. With OpenRouter, OpenRouter forwards the request to the underlying model provider for the selected model, so both OpenRouter and that provider may process the article; their retention and data-use practices depend on the selected model and account settings. Google AI Studio and Vertex AI handling depends on the project, plan, and Google’s current terms.

### Google AI Studio unpaid service

Under Google’s Gemini API Additional Terms of Service, content and responses submitted to Google AI Studio / Gemini API unpaid service may be used to improve Google products, services, and machine-learning technology, and may be human-reviewed. Do not submit sensitive, confidential, or personal information to the unpaid service. If the account or project meets Google’s paid-service conditions, handling may differ; see the [current official terms](https://ai.google.dev/gemini-api/terms).

## Stored locally

Chrome extension storage holds:

- General settings: Notion target ID, AI provider and model names, excluded-person terms, analysis prompt and output spec, global and per-page topic mappings, and whether to remember keys.
- Run state: latest scanned pending page IDs, the local batch queue, recent results, errors, and pause state. After a successful rescan, the queue is cleared or synced to Notion’s current `待分析` set so stale items are not kept as work.
- Topic dictionary and organizer session: standard topics, definitions, aliases, colors, enabled flags, permanently discarded provisional topic names, the current suggestion batch, unclassified / temporarily skipped items, and the last apply snapshot used for rollback. Dictionary export does not include keys, tokens, or article text.
- Failure diagnostics: only on AI output failure, provider, model name, stop reason, token usage, safety categories, and at most 12,000 characters of the raw AI response. Logs do not include API keys, the Notion token, the full source article, request headers, or the full request body.
- Keys: the Notion token and the three AI keys each have a separate “remember” option. They are kept in session storage by default; they are stored in local extension storage only if you explicitly choose to remember them.

Successful recent rows store page ID, title, URL, status, and time. Failed rows add the limited diagnostic above so you can copy a log. 「清除清單」 clears those detailed responses but keeps page IDs and short errors needed to retry. The options page can clear Notion and all AI keys. Uninstalling the extension removes its Chrome storage.

## What this extension does not do

- It does not collect browsing history. It only reads the current Notion tab URL to identify the page when the popup opens or when you use single-page analysis.
- It does not run content scripts.
- It does not put keys in URLs, source, ZIP files, analysis logs, or Notion.
- It does not change Notion’s original `名稱` or page body.
- It does not delete database properties or status options you added.
- It does not run a scheduled auto-scan of the database. Opening the popup may query Notion to identify the current page; database scans, article analysis, and topic organizing start only after explicit user actions. `alarms` is used only to continue a queue you already started.

## Your responsibilities

Limit which pages the Notion Integration can access. Manage API keys, quotas, and deletion in Google Cloud, AI Studio, or OpenRouter. On a shared computer, do not remember keys, and clear them when you are done.
