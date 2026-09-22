"use strict";

// Service worker: schema, connection tests, and settings persistence.

// ==== AI model discovery and connection diagnostics ====
function recommendedVertexModels() {
  return [
    { name: "gemini-3.5-flash-lite", displayName: "Gemini 3.5 Flash-Lite", inputTokenLimit: null, outputTokenLimit: null },
    { name: "gemini-3.1-flash-lite", displayName: "Gemini 3.1 Flash-Lite", inputTokenLimit: null, outputTokenLimit: null },
    { name: "gemini-2.5-flash-lite", displayName: "Gemini 2.5 Flash-Lite", inputTokenLimit: null, outputTokenLimit: null },
    { name: "gemini-3.8-flash", displayName: "Gemini 3.8 Flash", inputTokenLimit: null, outputTokenLimit: null },
    { name: "gemini-3.7-flash", displayName: "Gemini 3.7 Flash", inputTokenLimit: null, outputTokenLimit: null },
    { name: "gemini-3.6-flash", displayName: "Gemini 3.6 Flash", inputTokenLimit: null, outputTokenLimit: null },
    { name: "gemini-3.5-flash", displayName: "Gemini 3.5 Flash", inputTokenLimit: null, outputTokenLimit: null },
    { name: "gemini-2.5-flash", displayName: "Gemini 2.5 Flash", inputTokenLimit: null, outputTokenLimit: null },
    { name: "gemini-2.5-pro", displayName: "Gemini 2.5 Pro", inputTokenLimit: null, outputTokenLimit: null },
    { name: "gemini-3.1-pro-preview", displayName: "Gemini 3.1 Pro Preview", inputTokenLimit: null, outputTokenLimit: null },
    { name: "gemini-3-flash-preview", displayName: "Gemini 3 Flash Preview", inputTokenLimit: null, outputTokenLimit: null }
  ];
}

async function testVertexModel(config) {
  const { apiKey, model } = await activeAiContext({ ...config, aiProvider: "vertex" });
  const response = await fetch(
    `https://aiplatform.googleapis.com/v1/publishers/google/models/${encodeURIComponent(model)}:countTokens`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": apiKey
      },
      body: JSON.stringify({ contents: [{ role: "user", parts: [{ text: "連線測試" }] }] })
    }
  );
  const data = await readJsonResponse(response);
  if (!response.ok) {
    throw new AppError(errorMessage(data, `Vertex AI 連線測試錯誤 ${response.status}`), {
      code: [400, 401, 403].includes(response.status) ? "VERTEX_AUTH" : "VERTEX_API",
      status: response.status
    });
  }
  return true;
}

async function listGeminiModels(apiKey = "") {
  const key = apiKey || await requireGeminiKey();
  const models = [];
  let pageToken = "";
  do {
    const query = new URLSearchParams({ pageSize: "100" });
    if (pageToken) query.set("pageToken", pageToken);
    let response;
    try {
      response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?${query}`, {
        headers: { "x-goog-api-key": key }
      });
    } catch {
      throw new AppError("無法連線到 Gemini API，請檢查網路後再試", { code: "GEMINI_NETWORK" });
    }
    const data = await readJsonResponse(response);
    if (!response.ok) {
      const code = [400, 401, 403].includes(response.status) ? "GEMINI_AUTH" : "GEMINI_API";
      throw new AppError(errorMessage(data, `Gemini API 錯誤 ${response.status}`), {
        code,
        status: response.status
      });
    }
    models.push(...(data.models ?? []));
    pageToken = data.nextPageToken || "";
  } while (pageToken);
  return G.usableModels({ models });
}

// ==== Notion schema and scanning ====
/**
 * Resolves a Notion database URL, database UUID, or data source UUID to one
 * data source. extractNotionId takes a UUID from notionTarget or the stored
 * dataSourceId (hyphenated or compact). GET /v1/data_sources/{id} first; a
 * 404 means treat the same UUID as a database and GET /v1/databases/{id}.
 * A database must have exactly one data_sources entry or this throws
 * DATA_SOURCE_MISSING / MULTIPLE_DATA_SOURCES (paste the Data Source ID).
 * Other API errors are rethrown. GET only: no schema PATCH. Returns the
 * data source plus dataSourceId and databaseId.
 */
async function resolveDataSource(config, token) {
  const rawId = S.extractNotionId(config.notionTarget || config.dataSourceId);
  if (!rawId) {
    throw new AppError("請填入 Notion 資料庫網址或 Data Source ID", { code: "NOTION_TARGET_MISSING" });
  }

  try {
    const dataSource = await notionRequest(`/v1/data_sources/${rawId}`, { token });
    return {
      dataSource,
      dataSourceId: dataSource.id,
      databaseId: dataSource.parent?.database_id || config.databaseId || ""
    };
  } catch (error) {
    if (error.status !== 404) throw error;
  }

  const database = await notionRequest(`/v1/databases/${rawId}`, { token });
  const sources = database.data_sources ?? [];
  if (sources.length === 0) {
    throw new AppError("這個 Notion 資料庫沒有可用的 Data Source", { code: "DATA_SOURCE_MISSING" });
  }
  if (sources.length > 1) {
    throw new AppError("這個資料庫含有多個 Data Source，請改填擷取工具設定頁顯示的 Data Source ID", {
      code: "MULTIPLE_DATA_SOURCES"
    });
  }
  const dataSource = await notionRequest(`/v1/data_sources/${sources[0].id}`, { token });
  return { dataSource, dataSourceId: dataSource.id, databaseId: database.id };
}

/**
 * Makes the configured data source usable for analysis. Prefers GET of the
 * stored dataSourceId; on 404 or a missing id, calls resolveDataSource. Any
 * schemaPlan error throws before PATCH: missing 整理狀態, a non-select
 * 整理狀態, a select without 待分析, or a wrong type on AI 標題 / AI 主題 /
 * AI 暫定主題 / AI 關鍵字 / AI 摘要. Those failures block analysis. Missing
 * analysis properties other than 整理狀態 may be PATCHed in unless
 * options.mutateSchema is false (INSPECT_PAGE / popup open). If 整理狀態
 * already has 待分析, missing other status options may be PATCHed while
 * existing option ids are kept; 整理狀態 is never created or type-converted
 * here. Copies preferExistingTopics from the notionTarget UUID key onto the
 * data source key, then writeConfig with resolved ids.
 */
async function ensureSchema(config, token, options = {}) {
  let resolved;
  if (config.dataSourceId) {
    try {
      const dataSource = await notionRequest(`/v1/data_sources/${config.dataSourceId}`, { token });
      resolved = { dataSource, dataSourceId: dataSource.id, databaseId: config.databaseId };
    } catch (error) {
      if (error.status !== 404) throw error;
    }
  }
  if (!resolved) resolved = await resolveDataSource(config, token);

  const plan = N.schemaPlan(resolved.dataSource.properties ?? {});
  if (plan.errors.length) {
    throw new AppError(plan.setupIssue?.message || `${plan.errors.join("；")}。請在 Notion 修正上述欄位後再試。`, {
      code: plan.setupIssue?.code || "NOTION_FIELDS_INVALID"
    });
  }
  let dataSource = resolved.dataSource;
  if (plan.changed && options.mutateSchema !== false) {
    dataSource = await notionRequest(`/v1/data_sources/${resolved.dataSourceId}`, {
      method: "PATCH",
      body: { properties: plan.properties },
      token
    });
  }
  const preferences = normalizeTopicOrganizerPreferences(config.preferExistingTopicsByDataSource);
  const targetKey = compactNotionId(S.extractNotionId(config.notionTarget));
  const dataSourceKey = compactNotionId(resolved.dataSourceId);
  if (dataSourceKey && targetKey && Object.hasOwn(preferences, targetKey)) {
    preferences[dataSourceKey] = preferences[targetKey];
  }
  const nextConfig = {
    ...config,
    dataSourceId: resolved.dataSourceId,
    databaseId: resolved.databaseId || config.databaseId,
    preferExistingTopicsByDataSource: preferences
  };
  await writeConfig(nextConfig);
  return { config: nextConfig, dataSource, plan };
}

/**
 * Explicit, user-approved preparation for 整理狀態. Resolves the configured
 * data source, then PATCHes only that property according to
 * statusFieldSetupPlan. Existing Select options are preserved; a same-name
 * non-Select field is rejected. This action does not create other analysis
 * properties or write article pages.
 */
async function prepareNotionStatusField() {
  const token = await requireNotionToken();
  const config = await readConfig();
  let resolved;
  if (config.dataSourceId) {
    try {
      const dataSource = await notionRequest(`/v1/data_sources/${config.dataSourceId}`, { token });
      resolved = { dataSource, dataSourceId: dataSource.id, databaseId: config.databaseId };
    } catch (error) {
      if (error.status !== 404) throw error;
    }
  }
  if (!resolved) resolved = await resolveDataSource(config, token);

  const plan = N.statusFieldSetupPlan(resolved.dataSource.properties ?? {});
  if (plan.errors.length) {
    throw new AppError(plan.setupIssue?.message || plan.errors.join("；"), {
      code: plan.setupIssue?.code || "NOTION_STATUS_FIELD_INVALID"
    });
  }
  if (plan.changed) {
    await notionRequest(`/v1/data_sources/${resolved.dataSourceId}`, {
      method: "PATCH",
      body: { properties: plan.properties },
      token
    });
  }

  const nextConfig = {
    ...config,
    dataSourceId: resolved.dataSourceId,
    databaseId: resolved.databaseId || config.databaseId
  };
  await writeConfig(nextConfig);
  preparedDataSourceId = compactNotionId(resolved.dataSourceId);
  if (["NOTION_STATUS_FIELD_MISSING", "NOTION_PENDING_OPTION_MISSING"].includes(stateCache.databaseCheck?.code)) {
    stateCache.databaseCheck = null;
    stateCache.lastError = "";
    await persistState();
  }
  return {
    addedOptions: plan.addedOptions,
    changed: plan.changed,
    created: plan.created,
    dataSourceId: resolved.dataSourceId
  };
}

/**
 * Shared credentials/config/schema gate for scans, queue start, organizer
 * apply, page inspection, and connection tests. Requires a Notion token,
 * reads config, then ensureSchema. Default mutateSchema is true (may PATCH
 * missing schema and persists resolved ids). Pass { mutateSchema: false }
 * for INSPECT_PAGE / popup open: GET and persist ids only, no schema PATCH,
 * and do not mark preparedDataSourceId so later analysis can still repair.
 * On NOTION_STATUS_FIELD_MISSING, NOTION_STATUS_FIELD_TYPE, or
 * NOTION_PENDING_OPTION_MISSING, records databaseCheck before rethrowing so
 * the UI can show the 整理狀態 setup failure. Other setup errors propagate
 * without that write.
 */
async function readyNotion(options = {}) {
  const token = await requireNotionToken();
  const config = await readConfig();
  try {
    const ready = await ensureSchema(config, token, options);
    if (options.mutateSchema !== false) {
      preparedDataSourceId = compactNotionId(ready.config.dataSourceId);
    }
    return { ...ready, token };
  } catch (error) {
    if (["NOTION_STATUS_FIELD_MISSING", "NOTION_STATUS_FIELD_TYPE", "NOTION_PENDING_OPTION_MISSING"].includes(error.code)) {
      stateCache.databaseCheck = {
        checkedAt: new Date().toISOString(),
        code: error.code,
        message: error.message,
        ready: false
      };
      stateCache.lastError = error.message;
      await persistState();
    }
    throw error;
  }
}

async function readTopicOptions(config, token, signal) {
  if (!config.dataSourceId) {
    throw new AppError("尚未完成 Notion Data Source 設定", { code: "NOTION_TARGET_MISSING" });
  }
  const dataSource = await notionRequest(`/v1/data_sources/${config.dataSourceId}`, { signal, token });
  return N.topicOptions(dataSource.properties ?? {});
}

async function queryPagesByStatus(dataSourceId, status, token, options = {}) {
  const pages = [];
  const maxPages = Math.max(1, Number(options.maxPages) || MAX_PENDING_PAGES);
  let cursor = "";
  do {
    const remaining = maxPages - pages.length;
    if (remaining <= 0) break;
    const response = await notionRequest(`/v1/data_sources/${dataSourceId}/query`, {
      method: "POST",
      body: N.queryPayload(status, cursor, Math.min(100, remaining)),
      signal: options.signal,
      token
    });
    pages.push(...(response.results ?? []).map(page => ({
      ...N.pageSummary(page),
      sourceDataSourceId: dataSourceId,
      sourceStatus: status
    })));
    if (typeof options.onProgress === "function") await options.onProgress(pages.length, status);
    if (pages.length >= maxPages && response.has_more) {
      if (options.failOnLimit) {
        throw new AppError(`「${status}」頁面超過 ${maxPages} 筆掃描上限，請先縮小待處理範圍`, {
          code: "PAGE_SCAN_LIMIT_EXCEEDED",
          diagnostic: { maxPages, status }
        });
      }
      break;
    }
    cursor = response.has_more ? response.next_cursor || "" : "";
  } while (cursor);
  return pages;
}

async function hasPageByStatus(dataSourceId, status, token) {
  const response = await notionRequest(`/v1/data_sources/${dataSourceId}/query`, {
    method: "POST",
    body: { ...N.queryPayload(status), page_size: 1 },
    token
  });
  return Boolean(response.results?.length);
}

// ==== Settings persistence ====
/**
 * Settings-save target string. Trims the submitted or current notionTarget.
 * A non-empty value must contain a UUID (database URL, database id, or data
 * source id); otherwise NOTION_TARGET_INVALID. Empty is allowed and does
 * not call Notion. Compact UUID comparison for a database change happens in
 * saveSettings, not here.
 */
function resolveNotionTarget(settings, current) {
  const notionTarget = String(settings.notionTarget ?? current.notionTarget).trim();
  if (notionTarget && !S.extractNotionId(notionTarget)) {
    throw new AppError("Notion 資料庫網址或 Data Source ID 格式不正確", { code: "NOTION_TARGET_INVALID" });
  }
  return notionTarget;
}

function resolveProviderSelection(settings, current) {
  if (current.providerReselectionRequired && !Object.hasOwn(settings, "aiProvider")) {
    throw new AppError("舊版 AI 服務已移除，請明確選擇 Google AI Studio 或 Vertex AI", {
      code: "AI_PROVIDER_RESELECTION_REQUIRED"
    });
  }
  const requestedProvider = settings.aiProvider ?? current.aiProvider;
  if (!["gemini", "vertex"].includes(requestedProvider)) {
    throw new AppError("AI 服務商僅支援 Google AI Studio 或 Vertex AI", {
      code: "AI_PROVIDER_INVALID"
    });
  }
  const aiProvider = requestedProvider;
  const geminiModel = S.normalizeModelName(settings.geminiModel ?? current.geminiModel) || G.DEFAULT_MODEL;
  const vertexModel = S.normalizeModelName(settings.vertexModel ?? current.vertexModel) || G.DEFAULT_MODEL;
  return {
    aiProvider,
    geminiModel,
    vertexModel
  };
}

function resolvePromptSettings(settings, current) {
  const outputSpec = P.normalizeOutputSpec(settings.outputSpec ?? current.outputSpec);
  // Custom-prompt UI is gone. Ignore analysisPrompt / analysisPromptCustomized
  // from SAVE_SETTINGS so a partial or forged message cannot restore a hidden
  // prompt. Leftovers are cleared on readConfig and again here on save.
  if (
    hasLeftoverCustomAnalysisPrompt(current)
    || Object.hasOwn(settings, "analysisPrompt")
    || Object.hasOwn(settings, "analysisPromptCustomized")
  ) {
    if (
      hasLeftoverCustomAnalysisPrompt(current)
      || Boolean(S.cleanText(settings.analysisPrompt))
      || Boolean(settings.analysisPromptCustomized)
    ) {
      customAnalysisPromptCleared = true;
    }
  }
  const timeoutValue = Number(settings.requestTimeoutMinutes ?? current.requestTimeoutMinutes);
  const requestTimeoutMinutes = [0, 3, 5, 10].includes(timeoutValue) ? timeoutValue : 5;
  return { analysisPrompt: "", analysisPromptCustomized: false, outputSpec, requestTimeoutMinutes };
}

function notionTargetChanged(current, nextTargetId) {
  const currentTargetIds = [current.notionTarget, current.dataSourceId]
    .map(value => compactNotionId(S.extractNotionId(value)))
    .filter(Boolean);
  if (!nextTargetId) return currentTargetIds.length > 0;
  return !currentTargetIds.includes(nextTargetId);
}

function resolveTopicPreferences(settings, current, targetChanged, nextTargetId) {
  const preferExistingTopicsByDataSource = normalizeTopicOrganizerPreferences(
    current.preferExistingTopicsByDataSource
  );
  const currentPreference = topicOrganizerPreference(current);
  const preferExistingTopics = settings.preferExistingTopics === undefined
    ? targetChanged
      ? Boolean(nextTargetId && preferExistingTopicsByDataSource[nextTargetId])
      : currentPreference
    : Boolean(settings.preferExistingTopics);
  if (nextTargetId) preferExistingTopicsByDataSource[nextTargetId] = preferExistingTopics;
  if (!targetChanged && current.dataSourceId) {
    preferExistingTopicsByDataSource[compactNotionId(current.dataSourceId)] = preferExistingTopics;
  }
  return { preferExistingTopics, preferExistingTopicsByDataSource };
}

/**
 * Blocks a Notion-target UUID change while a single-page topicReview is open
 * (TOPIC_REVIEW_PENDING) or while analysis has running/current
 * (DATABASE_CHANGE_WHILE_RUNNING). Does not mutate state. Must pass before
 * secrets or config are written.
 */
function assertDatabaseChangeAllowed(targetChanged) {
  if (targetChanged && stateCache?.topicReview) {
    throw new AppError("目前有一篇文章等待確認新主題，請先完成確認再更換 Notion 資料庫", {
      code: "TOPIC_REVIEW_PENDING"
    });
  }
  if (targetChanged && (stateCache?.running || stateCache?.current)) {
    throw new AppError("目前仍在分析文章。請先按停止，等目前文章回到待分析後，再更換 Notion 資料庫", {
      code: "DATABASE_CHANGE_WHILE_RUNNING"
    });
  }
}

function buildNextConfig(settings, current, resolved) {
  const { notionTarget, preferExistingTopicsByDataSource, promptSettings, provider, targetChanged } = resolved;
  const next = {
    ...current,
    allowTopicProposals: true,
    excludedPersonTerms: settings.excludedPersonTerms === undefined
      ? normalizeExcludedPersonTerms(current.excludedPersonTerms)
      : normalizeExcludedPersonTerms(settings.excludedPersonTerms),
    analysisPrompt: promptSettings.analysisPrompt,
    analysisPromptCustomized: promptSettings.analysisPromptCustomized,
    promptBaseVersion: CURRENT_PROMPT_VERSION,
    aiProvider: provider.aiProvider,
    providerReselectionRequired: false,
    notionTarget,
    geminiModel: provider.geminiModel,
    vertexModel: provider.vertexModel,
    rememberGeminiKey: Object.hasOwn(settings, "rememberGeminiKey")
      ? Boolean(settings.rememberGeminiKey)
      : Boolean(current.rememberGeminiKey),
    rememberVertexKey: Object.hasOwn(settings, "rememberVertexKey")
      ? Boolean(settings.rememberVertexKey)
      : Boolean(current.rememberVertexKey),
    rememberNotionToken: Object.hasOwn(settings, "rememberNotionToken")
      ? Boolean(settings.rememberNotionToken)
      : Boolean(current.rememberNotionToken),
    requestTimeoutMinutes: promptSettings.requestTimeoutMinutes,
    outputSpec: promptSettings.outputSpec,
    preferExistingTopicsByDataSource,
    topicAliases: targetChanged ? {} : normalizeTopicAliases(current.topicAliases),
    topicPageResolutions: targetChanged ? {} : normalizeTopicPageResolutions(current.topicPageResolutions),
    discardedTopicNames: targetChanged ? [] : normalizeDiscardedTopicNames(current.discardedTopicNames),
    topicDictionary: targetChanged ? [] : normalizeTopicDictionary(current.topicDictionary),
    dataSourceId: targetChanged ? "" : current.dataSourceId,
    databaseId: targetChanged ? "" : current.databaseId
  };
  delete next.autoSelectHighConfidence;
  return next;
}

/**
 * After a saved target UUID change, drops work bound to the previous
 * database: queue, failed, recent, pending scan, organizer, rollback,
 * databaseCheck, and in-flight flags. Topic-resolution config (dictionary,
 * aliases, page resolutions, discardedTopicNames, stored ids) is cleared
 * on the next config object by saveSettings, not here. Does not clear
 * topicReview; a change is refused while a review is open. persistState
 * before returning the previous queue length.
 */
async function resetStateForDatabaseChange() {
  if (!stateCache) return 0;
  const clearedQueueCount = stateCache.queue.length;
  preparedDataSourceId = "";
  stateCache.databaseCheck = null;
  stateCache.queue = [];
  stateCache.failed = [];
  stateCache.recent = [];
  stateCache.knownPending = null;
  stateCache.pendingScan = null;
  stateCache.lastScanAt = "";
  stateCache.lastError = "";
  stateCache.mode = "idle";
  stateCache.paused = true;
  stateCache.running = false;
  stateCache.stopRequested = false;
  stateCache.stage = null;
  stateCache.topicOrganizer = null;
  stateCache.topicRollback = null;
  await persistState();
  return clearedQueueCount;
}

function buildSaveResponse(next, resolved) {
  const { clearedQueueCount, preferExistingTopics, provider, secrets, targetChanged } = resolved;
  const { aiProvider, geminiModel, vertexModel } = provider;
  const { hasGeminiKey, hasNotionToken, hasVertexKey } = secrets;
  const publicNext = { ...next };
  delete publicNext.analysisPrompt;
  delete publicNext.analysisPromptCustomized;
  delete publicNext.promptBaseVersion;
  return {
    ...publicNext,
    preferExistingTopics,
    activeModel: aiProvider === "vertex" ? vertexModel : geminiModel,
    hasAiKey: aiProvider === "vertex" ? hasVertexKey : hasGeminiKey,
    hasGeminiKey,
    hasNotionToken,
    hasVertexKey,
    customPromptCleared: customAnalysisPromptCleared,
    databaseChanged: targetChanged,
    clearedQueueCount
  };
}

/**
 * Persists options-page settings. Guard order: parse notionTarget, provider
 * and model (MODEL_INVALID), prompt
 * and timeout, then assertDatabaseChangeAllowed. All of those must pass
 * before storeSecret or writeConfig. A compact-UUID change versus both the
 * current notionTarget and dataSourceId is a database change: the next config clears
 * dataSourceId, databaseId, topicAliases, topicPageResolutions,
 * discardedTopicNames, and topicDictionary so another database cannot reuse
 * that taxonomy or queue; then resetStateForDatabaseChange. Topic
 * preferences stay keyed per data source / target UUID and are not wiped.
 * Does not call Notion or ensureSchema; schema is checked later by
 * readyNotion. Response includes has*Key booleans, not secret values.
 */
async function saveSettings(settings) {
  const current = await readConfig();
  const notionTarget = resolveNotionTarget(settings, current);
  const provider = resolveProviderSelection(settings, current);
  const promptSettings = resolvePromptSettings(settings, current);
  const nextTargetId = compactNotionId(S.extractNotionId(notionTarget));
  const targetChanged = notionTargetChanged(current, nextTargetId);
  const { preferExistingTopics, preferExistingTopicsByDataSource } = resolveTopicPreferences(
    settings,
    current,
    targetChanged,
    nextTargetId
  );
  assertDatabaseChangeAllowed(targetChanged);
  const next = buildNextConfig(settings, current, {
    notionTarget,
    preferExistingTopicsByDataSource,
    promptSettings,
    provider,
    targetChanged
  });
  const [hasNotionToken, hasGeminiKey, hasVertexKey] = await Promise.all([
    storeSecret(NOTION_TOKEN_KEY, settings.notionToken, next.rememberNotionToken),
    storeSecret(GEMINI_KEY_KEY, settings.geminiKey, next.rememberGeminiKey),
    storeSecret(VERTEX_KEY_KEY, settings.vertexKey, next.rememberVertexKey)
  ]);
  await writeConfig(next);
  const clearedQueueCount = targetChanged ? await resetStateForDatabaseChange() : 0;
  return buildSaveResponse(next, {
    clearedQueueCount,
    preferExistingTopics,
    provider,
    secrets: { hasGeminiKey, hasNotionToken, hasVertexKey },
    targetChanged
  });
}

// ==== Settings UI and connection diagnostics ====
/**
 * Options/popup config payload. Reads stored config and whether secrets exist.
 * Does not return Notion token or AI key values; exposes hasNotionToken and
 * has*Key booleans. Spreads ids, models, topic dictionary,
 * discardedTopicNames, and preferExistingTopicsByDataSource, and adds
 * preferExistingTopics for the current data source. Custom analysis-prompt
 * fields are never returned. customPromptCleared is true after a leftover
 * hidden prompt was detected and cleared in this service-worker lifetime.
 * Does not call Notion or AI.
 */
async function getConfigForUi() {
  const config = await readConfig();
  const [notionToken, geminiKey, vertexKey] = await Promise.all([
    readSecret(NOTION_TOKEN_KEY),
    readSecret(GEMINI_KEY_KEY),
    readSecret(VERTEX_KEY_KEY)
  ]);
  const aiProvider = normalizeAiProvider(config.aiProvider);
  const publicConfig = { ...config };
  delete publicConfig.analysisPrompt;
  delete publicConfig.analysisPromptCustomized;
  delete publicConfig.promptBaseVersion;
  return {
    ...publicConfig,
    preferExistingTopics: topicOrganizerPreference(config),
    aiProvider,
    activeModel: aiProvider === "vertex" ? config.vertexModel : config.geminiModel,
    excludedPersonTerms: normalizeExcludedPersonTerms(config.excludedPersonTerms),
    customPromptCleared: customAnalysisPromptCleared,
    hasAiKey: aiProvider === "vertex" ? Boolean(vertexKey) : Boolean(geminiKey),
    hasGeminiKey: Boolean(geminiKey),
    hasNotionToken: Boolean(notionToken),
    hasVertexKey: Boolean(vertexKey)
  };
}

/**
 * Options connection test. Goes through readyNotion, so it may PATCH missing
 * data-source schema and persist resolved ids; not read-only. Then contacts
 * only the configured AI provider: Vertex countTokens on the selected model
 * or the Gemini model list. Queries whether any 待分析 page exists. No article
 * property writes. Missing pending pages set databaseCheck NO_PENDING_PAGES
 * with ready true and do not throw. Returns plan.added / plan.updated names.
 */
async function testConnections() {
  const { config, dataSource, plan, token } = await readyNotion();
  const provider = normalizeAiProvider(config.aiProvider);
  let models = [];
  let selectedAvailable = false;
  if (provider === "vertex") {
    await testVertexModel(config);
    models = recommendedVertexModels();
    selectedAvailable = true;
  } else {
    const apiKey = await requireGeminiKey();
    models = await listGeminiModels(apiKey);
    selectedAvailable = models.some(model => model.name === config.geminiModel);
  }
  const allTopicOptions = N.topicOptions(dataSource.properties ?? {});
  const usableTopicOptions = validTopicOptions(allTopicOptions);
  const hasPending = await hasPageByStatus(config.dataSourceId, N.STATUS.pending, token);
  stateCache.databaseCheck = {
    checkedAt: new Date().toISOString(),
    code: hasPending ? "READY" : "NO_PENDING_PAGES",
    message: hasPending ? "" : N.DATABASE_SETUP_MESSAGES.noPendingPages,
    ready: true
  };
  stateCache.lastError = hasPending ? "" : N.DATABASE_SETUP_MESSAGES.noPendingPages;
  await persistState();
  return {
    addedProperties: plan.added,
    dataSourceId: config.dataSourceId,
    modelCount: models.length,
    provider,
    selectedAvailable,
    ignoredTopicCount: allTopicOptions.length - usableTopicOptions.length,
    hasPending,
    topicCount: usableTopicOptions.length,
    updatedProperties: plan.updated
  };
}
