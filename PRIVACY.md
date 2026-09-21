# Privacy and data flow

Last updated: September 20, 2026

Developed and maintained by Penny Hsieh.

This policy applies to **Siftly**, an AI Content Organiser for Notion, in versions distributed through the Chrome Web Store or this project's GitHub repository.

Traditional Chinese (Taiwan): [`PRIVACY.zh-TW.md`](PRIVACY.zh-TW.md)

## Chrome Web Store user-data commitment

The use of information received from Google APIs will adhere to the [Chrome Web Store User Data Policy](https://developer.chrome.com/docs/webstore/program-policies/user-data-faq), including the Limited Use requirements. User data read, stored, or transmitted by the extension is used only to provide the Notion article analysis, topic organisation, result write-back, and user-initiated queue features described below. It is not used for personalised advertising or credit assessment, is not sold, and is not transferred to third parties unrelated to these features.

## Data this extension reads

This extension must be used with the Notion web app in Google Chrome. It uses the Notion Integration Token you provide to access the configured Notion data source and to inspect a Notion page identified from the current tab that belongs to that data source:

- Page ID, Notion URL, and the original page title, for the queue and recent/failed lists.
- Plain-text blocks from the page, for article analysis.
- `整理狀態`, to find pages in `待分析` or `分析失敗`. Topic organising also queries `待主題整理` and `待主題確認`.
- The data-source schema, to check required fields and to list existing confirmed AI topics (`AI 主題`) options.
- When you click `載入可用資料庫` (“Load available databases”) in the options page, the extension uses the Notion Search API to read each authorised data source’s name, ID, parent database ID, and character emoji to build the picker. It does not retain the complete schema, description, cover, user data, or external image URLs from those results.
- During batch topic organising, the extension queries matching pages until it has at most 75 distinct provisional topics (`AI 暫定主題`), or there are no more matching pages. The organiser query asks Notion to return only the `整理狀態`, `AI 暫定主題`, and `AI 主題` database properties; Page ID is used only to write back to the correct page.
- When the popup opens or you use 「分析目前頁面」, the Chrome-side tab access reads only the current tab’s Notion URL to identify the Page ID; it does not read other tabs or browsing history. It may then inspect that page and its data-source schema through the Notion API.

Images, video, audio, files, and PDFs are not used as analysis input and are not sent to the AI provider.

Chrome permissions are `storage`, `alarms`, and `activeTab`. Host permissions are limited to `https://api.notion.com/*`, `https://generativelanguage.googleapis.com/*`, and `https://aiplatform.googleapis.com/*`.

## Where data is sent

1. The extension calls `api.notion.com` directly to read the selected pages. The Notion token is sent in an HTTP header, not in the URL.
   The options-page database list is also fetched directly from the Notion Search API and only when you click load or refresh.
2. For single-page and batch article analysis, the following are sent to the currently selected AI provider (Google AI Studio at `generativelanguage.googleapis.com` or Vertex AI at `aiplatform.googleapis.com`):
   - Notion page plain text
   - the analysis prompt you have configured
   - the output spec
   - the excluded-person terms list

   Providers you did not select do not receive the article. Listing models and testing the connection send the key to the currently selected provider. The Vertex test also sends the fixed string `連線測試` and does not include a Notion page.
3. Returned JSON is checked locally for shape, length, and counts. Article-analysis requests do not include existing confirmed AI topics (`AI 主題`) or the local topic dictionary, and the analysis step does not select confirmed `AI 主題`. Batch analysis does not write `AI 主題`. Single-page reanalysis clears confirmed AI topics and then enters the topic-confirmation flow.
4. Batch topic organising sends only this batch’s distinct provisional topic (`AI 暫定主題`) names and optional existing confirmed AI topic (`AI 主題`) names. Page body, page title, AI title, summary, keywords, occurrence counts, co-occurrence, and impact counts are not sent for classification.
5. Accepted results are written back to `api.notion.com`. During a connection test, if the `整理狀態` Select property or the `待分析` option is missing, the settings page asks for confirmation first. The extension creates that property or completes the required workflow options only after the user chooses `新增並繼續` (“Add and continue”). It does not convert an existing property to another type, delete user-created options, or rename them. After that preparation, testing the connection, scanning, starting a queue, or opening the popup on a Notion page may PATCH other missing AI properties and remaining workflow options.

The extension developer does not operate a separate intermediary server and the extension has no analytics or telemetry. Google AI Studio and Vertex AI handling depends on the project, plan, and Google’s current terms.

### Google AI Studio unpaid service

Under Google’s Gemini API Additional Terms of Service, content and responses submitted to Google AI Studio / Gemini API unpaid service may be used to improve Google products, services, and machine-learning technology, and may be human-reviewed. Do not submit sensitive, confidential, or personal information to the unpaid service. If the account or project meets Google’s paid-service conditions, handling may differ; see the [current official terms](https://ai.google.dev/gemini-api/terms).

## Stored locally

Chrome extension storage holds:

- General settings: Notion target ID, AI provider and model names, keyword-exclusion terms, analysis prompt and output spec, global and per-page topic mappings, and whether to remember keys.
- Run state: latest scanned pending page IDs, the local batch queue, recent results, errors, and pause state. After a successful rescan, the queue is cleared or synced to Notion’s current `待分析` set so stale items are not kept as work.
- Topic dictionary and organiser session: standard topics, definitions, aliases, colours, enabled flags, permanently discarded provisional topic names, the current suggestion batch, unclassified / temporarily skipped items, and the last apply snapshot used for rollback. Dictionary export does not include keys, tokens, or article text.
- Failure diagnostics: only on AI output failure, provider, model name, stop reason, numeric token usage, safety categories, output character count, and validation error count. The diagnostic field does not persist raw AI responses or validation-error text; a separate short user-facing failure message is retained for retry and troubleshooting.
- Keys: the Notion token and the two AI keys each have a separate “remember” option. They are kept in session storage by default; they are stored in local extension storage only if you explicitly choose to remember them.

This local data is not synced to an account or server operated by the developer, and the developer cannot access it.

The database list loaded by the options page exists only in that page’s memory and is not written to Chrome storage. Closing or reopening the options page requires loading it again. If you use an unsaved token to load the list, that token is used only for the current Notion API request and is not stored by the list action.

Successful recent rows store page ID, title, URL, status, and time. Failed rows add the limited diagnostic above. The copied support log omits page ID, title, URL, error text, article text, and raw AI output. 「清除清單」 clears detailed recent responses but keeps page IDs and short errors needed to retry. Pending-page scans are capped at 2,000 pages, failed-page loads at 40 pages, stored page titles at 500 characters, and persisted run state at 4 MiB. The options page can clear Notion and all AI keys. Uninstalling the extension removes its Chrome storage.

## What this extension does not do

- It does not collect browsing history. It only reads the current Notion tab URL to identify the page when the popup opens or when you use single-page analysis.
- It does not run content scripts.
- It does not put keys in URLs, source, ZIP files, analysis logs, or Notion.
- It does not change Notion’s original `名稱` or page body.
- It does not delete database properties or status options you added.
- It does not run a scheduled auto-scan of the database. Opening the popup may query Notion to identify the current page; database scans, article analysis, and topic organising start only after explicit user actions. `alarms` is used only to continue a queue you already started.

## Your responsibilities

Limit which pages the Notion Integration can access. Manage API keys, quotas, and deletion in Google Cloud or AI Studio. On a shared computer, do not remember keys, and clear them when you are done.

## Contact

For privacy or data-handling questions, use the project’s [GitHub Issues](https://github.com/PHCY0614/Notion-AI-Analyzer/issues). Do not post API keys, Notion tokens, article content, or other private information in a public issue.
