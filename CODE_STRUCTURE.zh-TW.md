# 程式結構

Notion AI Analyzer 0.6.1 的開發者地圖。產品介面是臺灣繁體中文。本檔為繁中對照。這不是產品使用說明，使用者行為請看 `README.zh-TW.md`。

英文版：[`CODE_STRUCTURE.md`](CODE_STRUCTURE.md)

此擴充功能為 Chrome Manifest V3、vanilla JavaScript，沒有 bundler，也沒有 content scripts。Service worker 負責 Notion I/O、AI 呼叫、佇列處理與 Chrome storage。Popup 與 options 是薄 UI，只傳送 `{ type, ... }` 訊息。

## 執行方式

```text
popup.html  → ui-select.js, popup.js     (action popup)
options.html → ui-select.js, options.js  (options page)
background.js service worker
  importScripts(shared.js, prompt.js, notion.js, gemini.js)
```

`background.js` 是唯一的 Chrome messaging 端點。UI 不會直接連 Notion 或 AI 服務商。佇列續跑是用 `chrome.alarms`（`notion-ai-analyzer-process`）排程，不是在 worker 裡長駐迴圈。

函式庫以 IIFE 掛到 `globalThis`（`AnalyzerShared`、`AnalyzerPrompt`、`AnalyzerNotion`、`AnalyzerGemini`、`AnalyzerSelect`）；若 Node `require` 可用也會設 `module.exports`。Service worker 載入順序必須是：`shared.js` 先於 `prompt.js`／`notion.js`；後兩者先於 `gemini.js`。

## 檔案對照

| 檔案 | 職責 |
| --- | --- |
| `manifest.json` | MV3 manifest：storage、alarms、activeTab；可連 Notion、Google AI Studio、Vertex AI、OpenRouter。 |
| `background.js` | 編排：設定／狀態、金鑰、schema、掃描／佇列、`processItem`、主題整理、單篇確認、設定、訊息分派。 |
| `shared.js` | 文字／ID 輔助：`cleanText`、Notion UUID 擷取與正規化、`visibleLength`、模型名稱清理、`chunkText`、`truncateMessage`。 |
| `prompt.js` | 預設分析提示詞、輸出規格預設與正規化、分析／分段／整理／修復提示詞組裝。 |
| `notion.js` | 欄位名稱、狀態、schema 計畫、頁面／區塊讀取、分析與主題 PATCH 內容。 |
| `gemini.js` | JSON schema、Gemini 形 generateContent 的請求組裝、分析／分段／整理的驗證與修復、模型清單過濾。 |
| `popup.js` | Popup：檢查目前分頁、輪詢狀態、工具列、近期紀錄、單篇主題確認 UI。 |
| `options.js` | 設定表單、服務商／模型探索 UI、提示詞／輸出規格編輯、主題整理卡片、字典匯入／匯出。 |
| `ui-select.js` | 共用 `AnalyzerSelect.enhance` 自訂選單。Popup 與 options 傳入不同的 listener／native-state 選項。 |
| `popup.html`／`popup.css` | Popup 畫面。`#skip-topic` 文案是「這次暫不處理」。 |
| `options.html`／`options.css` | 設定與主題整理頁。 |
| `AGENTS.md` | 重構時的行為穩定規則。 |
| `PRIVACY.md` / `PRIVACY.zh-TW.md` | 英文與繁中隱私及資料流說明。 |
| `README.md` / `README.zh-TW.md` | 英文與繁中產品說明。 |

`background.js` 把載入的模組簡稱為 `S`、`P`、`N`、`G`。

## Notion 資料模型

欄位名稱與狀態字串是公開契約，不要改名。

| 欄位 | 類型 | 寫入者 |
| --- | --- | --- |
| `整理狀態` | select | 分析、確認、整理套用／回復、失敗／中止還原 |
| `AI 標題` | rich_text | 僅文章分析 |
| `AI 摘要` | rich_text | 僅文章分析 |
| `AI 關鍵字` | rich_text | 僅文章分析 |
| `AI 暫定主題` | rich_text | 分析寫入以 `｜` 分隔的暫定名稱。整理套用、未分類處置、單篇確認會移除已處理名稱。 |
| `AI 主題` | multi_select | 已確認的分類。**批次分析不寫這個欄位。** 單篇再分析會寫入空的 multi_select。整理套用與單篇確認會加入已確認名稱。 |

狀態：`待分析` → `分析中` → `待主題整理`（批次）或 `待主題確認`（單篇）→ `已分析`，或 `分析失敗`。停止後的中止路徑會嘗試把狀態還原為 `待分析`。

**不要把 `AI 暫定主題` 與 `AI 主題` 混為一談。**

- `AI 暫定主題` 是文章分析產出的獨立分類。分析提示詞不會收到既有 `AI 主題` 或本機字典。
- `AI 主題` 是已確認的分類，只在單篇確認裡經人工（或已記住的對照）決定後寫入，或在整理套用／未分類處置（採用／改用／自訂）時寫入。
- 對已分析頁面再分析會以 `single_review` 模式執行，**在寫入草稿時清空已確認的 `AI 主題`**，然後開啟主題確認。批次分析不改動已確認的 `AI 主題`，以便之後由主題整理套用。

`ensureSchema`／`readyNotion` 只有在 `整理狀態` 已存在、型別為 select，且包含 `待分析` 時，才可能 PATCH 缺少的 data-source schema（AI 欄位與其餘狀態選項）。它們不會刪除或改名使用者自建的選項。因此掃描、測試、佇列與 Popup inspection 路徑對 data source 不一定是唯讀。

## Chrome storage

不要改這些 key 名稱。

| Key | 儲存位置 | 內容 |
| --- | --- | --- |
| `notionAiAnalyzerConfig` | `local` | 非機密設定、字典、永久捨棄名稱、依資料庫的 `preferExistingTopics`、已記住的對照。 |
| `notionAiAnalyzerState` | `local` | 佇列、近期／失敗、`topicReview`、`topicOrganizer`、回復快照、暫停／階段。 |
| `notionAiAnalyzerNotionToken` | session，若勾選記住則為 local | Notion token |
| `notionAiAnalyzerGeminiKey` | session，若勾選記住則為 local | Google AI Studio 金鑰 |
| `notionAiAnalyzerVertexKey` | 同上 | Vertex 金鑰 |
| `notionAiAnalyzerOpenRouterKey` | 同上 | OpenRouter 金鑰 |

金鑰不會寫入設定 JSON、匯出檔、近期紀錄或 Notion。

## 執行模式

`stateCache.mode` 是粗略的 UI／佇列旗標，不是完整狀態機：

| 模式 | 意義 |
| --- | --- |
| `idle` | 沒有進行中工作；popup 依畫面顯示對應操作。 |
| `batch` | 批次佇列處理中。 |
| `paused` | 批次已暫停（停止），或單篇分析寫入 `待主題確認` 後暫停。 |
| `single_review` | 目前頁面分析／再分析。`processItem` 走單篇草稿路徑。 |
| `topic_apply` | 整理套用或未分類處置正在寫入頁面。 |

`stopRequested` 在 `processItem` 的階段邊界檢查（寫入 `分析中` 之後、讀取頁面之後、AI 之後）。它不是對進行中 Notion／AI 請求的無競態取消。中止路徑會把該篇放回佇列，並嘗試還原為 `待分析`。

`queueAll` 對同一 data source 可重用最多兩分鐘內的 `pendingScan` 快取，而不再呼叫 `scanPending`。

## 訊息協定

不要改 `message.type` 字串。UI 的 `send()` 在 `{ ok: false }` 時丟出錯誤。Service worker 一律回 `{ ok: true, data }` 或 `{ ok: false, error: { code, message } }`。

**狀態／設定**

- `GET_STATUS`／`GET_CONFIG`／`GET_PROMPT_PREVIEW`
- `SAVE_SETTINGS`／`CLEAR_CREDENTIALS`／`OPEN_OPTIONS`

**服務商／schema（由 background 負責，不是 options 頁）**

- `TEST_CONNECTIONS` — 設定頁會先儲存；此呼叫執行 Notion 就緒、schema 與服務商探測。
- `LIST_MODELS` — Gemini 清單、Vertex 建議集合或 OpenRouter 目錄。Options 的 `renderModels` 只負責填入 `<select>`。

**批次佇列**

- `SCAN_PENDING`／`ANALYZE_ALL`／`STOP_ANALYSIS`／`RESUME_ANALYSIS`／`RETRY_FAILED`

**單篇**

- `INSPECT_PAGE`／`REANALYZE_PAGE`／`REVIEW_CURRENT_PAGE_TOPICS`／`RESOLVE_TOPIC_REVIEW`／`CLEAR_RECENT`

目前頁面再分析與近期成功列使用 `REANALYZE_PAGE` 且 `force: true`。失敗列重試不帶 `force`，也不跳出確認。Popup 文案說明再分析會清除既有 `AI 主題`。

**主題整理**

- `PREPARE_TOPIC_ORGANIZER`／`GET_TOPIC_ORGANIZER`
- `APPLY_TOPIC_GROUPS`／`SKIP_TOPIC_GROUP`／`RESOLVE_ORGANIZER_UNCLASSIFIED`
- `CLEAR_TOPIC_ORGANIZER`／`ROLLBACK_TOPIC_APPLY`
- `EXPORT_TOPIC_DICTIONARY`／`PREVIEW_TOPIC_DICTIONARY_IMPORT`／`IMPORT_TOPIC_DICTIONARY`

整理群組草稿（`selected`、`selectedAliases`、`standardTopic`）存在 options 頁的記憶體物件上。**暫不處理與套用都會**把 `groups` 送到 background（`saveTopicOrganizerDrafts` 後再 persist）。草稿不會一直只留在本機直到套用。

## 分析管線

`processItem`（批次或 `single_review`）：

1. 確認目前設定的 data source schema；拒絕來自其他來源的佇列頁面。
2. PATCH `整理狀態` → `分析中`。
3. 讀取區塊（90 秒上限），組成文章純文字。圖片、影片、音訊、檔案與 PDF 不是分析輸入。
4. `background.js` 的 `analyzeArticle` 呼叫所選服務商。`gemini.js`／`prompt.js` 組裝 payload 並驗證／修復 JSON。長文可能先分段筆記再整合。格式修復只送不合格輸出，不含原文。安全封鎖、空輸出與逾時不會重送全文。
5. 以 `N.analysisDraftPayload(result, status, clearFinalTopics)` PATCH：
   - 批次：狀態 `待主題整理`，`clearFinalTopics` 為 false（省略 `AI 主題`）。
   - `single_review`：狀態 `待主題確認`，`clearFinalTopics` 為 true（空的 `AI 主題`），然後開啟 `topicReview` 並暫停。

Gemini 與 Vertex 的 HTTP 走 `googleGenerativeRequest` 與薄包裝。OpenRouter 是另一條路徑。Notion 走 `notionRequest`，JSON 錯誤的 fallback 形狀不同。

文章分析不會挑選已確認的分類名稱。批次省略 `AI 主題`；單篇再分析只把它寫成空的 multi_select。

## 單篇主題確認

`background.js` 的 `normalizeTopicReview`／`resolveTopicReview` 逐一處理剩餘的 `AI 暫定主題` 名稱。採用／改用／自訂會把名稱加入 `AI 主題`，並從暫定主題移除。只有暫定主題全部清空時，狀態才變成 `已分析`。

**暫不處理與永久捨棄不是同一條路徑：**

| 畫面 | 控制項 | 訊息 action | 效果 |
| --- | --- | --- | --- |
| Popup `#skip-topic`「這次暫不處理」 | `RESOLVE_TOPIC_REVIEW` `skip` | 名稱留在 `AI 暫定主題`；不加入 `AI 主題`。 |
| Options 未分類「永久捨棄」 | `RESOLVE_ORGANIZER_UNCLASSIFIED` `discard` | 從受影響頁面移除該暫定主題；記入 `discardedTopicNames`；不加入 `AI 主題`。 |
| Options 未分類暫時跳過 | `skip` | 只改本機整理工作階段；Notion 不變。 |

Popup 的 `#skip-topic` 除非 `canDiscard === false` 否則維持可按。這個公開狀態旗標名稱不變。

## 主題整理

`prepareTopicOrganizer` 查詢 `待主題整理`／`待主題確認` 頁面，直到收集到最多 **75** 個去重後的暫定名稱（`G.TOPIC_ORGANIZER_BATCH_LIMIT`），或已沒有更多符合條件的頁面。它的 Notion 查詢只要求回傳 `整理狀態`、`AI 暫定主題` 與 `AI 主題` 三個資料庫欄位；回應仍可能包含標準的頁面頂層 metadata。頁面正文、AI 標題／摘要／關鍵字與共現關係都不會送給模型。

已被 Notion 選項、已記住的頁面對照或字典對上的名稱，會直接成為確認群組、不呼叫 AI。其餘名稱走 `requestOrganizerGroups`：schema → 相容模式（`canRetryTopicOrganizerWithoutSchema`）→ 修復，最多三次 AI 呼叫。若 JSON 仍失敗，整批剩餘項目改列未分類，而不是產出錯誤卡片。

套用前會重讀每一頁，把標準主題與目前 `AI 主題` 聯集寫回；不會盲目覆寫其他群組。回復還原上一次套用／人工處置的快照；不會刪除新建的 Notion multi_select 選項，也不保證保留那些頁面之後的每一次使用者編輯。

依資料庫的 `preferExistingTopics` 只影響整理提示詞，不影響文章分析。

## UI

**Popup**（`popup.js`）在 `actionBusy` 為 false 時每 1.5 秒輪詢 `GET_CONFIG` + `GET_STATUS`。`inspectCurrentPage` 把分頁分成 `other`、Notion 資料庫或單篇文章（`INSPECT_PAGE`）。主題確認進行中會擋住批次／掃描／重試／整理。進行中的 `single_review` 會把目前頁面按鈕改為 `STOP_ANALYSIS`。批次進行時，即使切到其他分頁，佇列控制鈕仍保持可見。

**Options**（`options.js`）負責表單狀態、自訂選單、整理畫面（`renderOrganizer` 與輔助函式）與字典檔。服務商測試、schema PATCH 與 AI 呼叫仍在 `background.js`。

**自訂選單**（`ui-select.js`）：`sync()` 重建顯示值、trigger 停用狀態、選項、選取核取與可選的 native hidden／disabled 對應。`close()` 隱藏選單並重設 `aria-expanded`。選項點擊順序：設定 native 值 → 冒泡 `change` → `sync` → `close` → 把焦點還給 trigger。Popup 設 `attachDocumentListeners`，`matchNativeState` 為 false。Options 設 `matchNativeState` 並用頁面層的 document 處理，因此 `attachDocumentListeners` 為 false。

## 穩定規則

改程式時遵循 `AGENTS.md`：

- 不要改 Notion 欄位名稱、Chrome storage key、訊息 `type` 或狀態字串／轉換。
- 結構重構時不要改提示詞。
- 維持 `AI 暫定主題` 與 `AI 主題` 分離；再分析必須作廢先前的分析結果**以及**已確認的 `AI 主題`。
- 維持回復與 skip／discard 行為。
- 偏好小而可獨立審查的變更。沒有真正減少重複時，不要加抽象層。

`background.js` 的區塊註解，以及 payload／驗證／UI 輔助函式上的 JSDoc，是本檔在函式層級的對照。
