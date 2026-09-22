"use strict";

// Service worker: config normalization, persistence, secrets, and provider routing.

// ==== Configuration normalization ====
function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function sanitizeQueueItem(item = {}) {
  const {
    analyzedAt,
    code,
    diagnostic,
    error,
    failedAt,
    outcome,
    ...safe
  } = item;
  safe.title = S.cleanText(safe.title).slice(0, MAX_STORED_PAGE_TITLE_CHARACTERS);
  if (typeof safe.url === "string") safe.url = safe.url.slice(0, 2000);
  return safe;
}

function sanitizeHistoryItem(item = {}) {
  return {
    ...item,
    title: S.cleanText(item.title).slice(0, MAX_STORED_PAGE_TITLE_CHARACTERS),
    url: typeof item.url === "string" ? item.url.slice(0, 2000) : "",
    error: S.truncateMessage(item.error || ""),
    diagnostic: G.sanitizeDiagnostic(item.diagnostic)
  };
}

function normalizeShortNameList(value) {
  const source = Array.isArray(value)
    ? value
    : String(value ?? "").split(/[\n\r,，、]+/u);
  const seen = new Set();
  return source.reduce((result, item) => {
    const name = S.cleanText(item).slice(0, 50);
    const key = name.normalize("NFKC").toLocaleLowerCase("zh-Hant-TW");
    if (!name || seen.has(key) || result.length >= 80) return result;
    seen.add(key);
    result.push(name);
    return result;
  }, []);
}

function normalizeExcludedPersonTerms(value) {
  return normalizeShortNameList(value);
}

function normalizeTopicAliases(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const result = {};
  for (const [source, target] of Object.entries(value)) {
    const sourceKey = N.topicKey(source);
    const targetName = S.cleanText(target);
    if (!sourceKey || !targetName || Object.keys(result).length >= 300) continue;
    result[sourceKey] = targetName;
  }
  return result;
}

function normalizeDiscardedTopicNames(value) {
  const seen = new Set();
  return (Array.isArray(value) ? value : []).reduce((result, item) => {
    const name = S.cleanText(item).slice(0, 100);
    const key = N.topicKey(name);
    if (!name || !key || seen.has(key) || result.length >= 500) return result;
    seen.add(key);
    result.push(name);
    return result;
  }, []);
}

function validTopicOptions(options = []) {
  return (options ?? []).filter(option => Boolean(S.cleanText(option?.name)));
}

function normalizeTopicPageResolutions(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const result = {};
  for (const [pageId, mappings] of Object.entries(value)) {
    if (!mappings || typeof mappings !== "object" || Array.isArray(mappings)) continue;
    const page = {};
    for (const [candidate, target] of Object.entries(mappings)) {
      const key = N.topicKey(candidate);
      const name = S.cleanText(target);
      if (key && name) page[key] = name;
    }
    if (Object.keys(page).length) result[pageId] = page;
  }
  return result;
}

function normalizeTopicOrganizerPreferences(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const result = {};
  for (const [sourceId, enabled] of Object.entries(value)) {
    const key = compactNotionId(sourceId);
    if (!key || Object.keys(result).length >= 100) continue;
    result[key] = Boolean(enabled);
  }
  return result;
}

function topicOrganizerPreference(config = {}) {
  const preferences = normalizeTopicOrganizerPreferences(config.preferExistingTopicsByDataSource);
  const dataSourceKey = compactNotionId(config.dataSourceId);
  const targetKey = compactNotionId(S.extractNotionId(config.notionTarget));
  if (dataSourceKey && Object.hasOwn(preferences, dataSourceKey)) return preferences[dataSourceKey];
  return Boolean(targetKey && preferences[targetKey]);
}

function legacyCandidate(result = {}) {
  const name = S.cleanText(result.topic_candidate);
  if (!name) return [];
  return [{
    name,
    reason: S.cleanText(result.topic_candidate_reason),
    closest_existing: Array.isArray(result.topic_closest_existing)
      ? result.topic_closest_existing.map(S.cleanText).filter(Boolean)
      : []
  }];
}

function normalizeTopicReview(review) {
  if (!review || typeof review !== "object") return null;
  const result = review.result && typeof review.result === "object" ? review.result : {};
  const remainingCandidates = Array.isArray(review.remainingCandidates)
    ? review.remainingCandidates
    : Array.isArray(result.topic_candidates) ? result.topic_candidates : legacyCandidate(result);
  return {
    ...review,
    approvedNewTopics: normalizeShortNameList(review.approvedNewTopics ?? []),
    candidateTotal: Number(review.candidateTotal) || remainingCandidates.length,
    decisions: Array.isArray(review.decisions) ? review.decisions : [],
    remainingCandidates,
    skippedCandidates: normalizeShortNameList(review.skippedCandidates ?? []),
    originalFinalTopics: normalizeShortNameList(review.originalFinalTopics ?? []),
    selectedExistingTopics: Array.isArray(review.selectedExistingTopics)
      ? review.selectedExistingTopics
      : Array.isArray(result.ai_topics) ? result.ai_topics : []
  };
}

// ==== State initialization and persistence ====
async function initialize() {
  if (initializePromise) return initializePromise;
  initializePromise = (async () => {
    try {
      await chrome.storage.session.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" });
    } catch {
      // Older Chrome versions may not expose setAccessLevel. No untrusted context is used.
    }
    await Promise.all([
      chrome.storage.local.remove(LEGACY_PROVIDER_KEY),
      chrome.storage.session.remove(LEGACY_PROVIDER_KEY)
    ]);
    const stored = await chrome.storage.local.get(STATE_KEY);
    stateCache = {
      ...clone(DEFAULT_STATE),
      ...(stored[STATE_KEY] ?? {})
    };
    stateCache.queue = uniqueItems(Array.isArray(stateCache.queue) ? stateCache.queue : [])
      .slice(0, MAX_PENDING_PAGES);
    stateCache.failed = (Array.isArray(stateCache.failed) ? stateCache.failed : [])
      .slice(0, MAX_RECENT)
      .map(sanitizeHistoryItem);
    stateCache.recent = (Array.isArray(stateCache.recent) ? stateCache.recent : [])
      .slice(0, MAX_RECENT)
      .map(sanitizeHistoryItem);
    if (stateCache.pendingScan?.pages) {
      stateCache.pendingScan.pages = uniqueItems(stateCache.pendingScan.pages)
        .slice(0, MAX_PENDING_PAGES);
    }
    stateCache.topicReview = normalizeTopicReview(stateCache.topicReview);
    const config = await readConfig();
    if (config.providerReselectionRequired) await writeConfig(config);
    if (stateCache.topicOrganizer && stateCache.topicOrganizer.version !== TOPIC_ORGANIZER_CACHE_VERSION) {
      stateCache.topicOrganizer = null;
      stateCache.topicRollback = null;
      await persistState();
    }
    if (stateCache.topicReview && stateCache.topicReview.version !== 2) {
      const reviewId = stateCache.topicReview.item?.id || "";
      stateCache.queue = uniqueItems([
        stateCache.topicReview.item,
        ...(stateCache.current?.id && stateCache.current.id !== reviewId ? [stateCache.current] : []),
        ...stateCache.queue
      ]);
      stateCache.topicReview = null;
      stateCache.current = null;
      stateCache.paused = true;
      stateCache.mode = "paused";
      stateCache.running = false;
      stateCache.stopRequested = false;
      stateCache.lastError = "舊版尚未確認的文章已放回本機佇列；新版會改用暫定主題流程，按「繼續」即可重新分析。";
      await persistState();
    } else if (stateCache.topicReview?.version === 2) {
      stateCache.current = null;
      stateCache.running = false;
      stateCache.paused = true;
      stateCache.stopRequested = false;
      await persistState();
    } else if (stateCache.current) {
      stateCache.queue = uniqueItems([stateCache.current, ...stateCache.queue]);
      stateCache.current = null;
      stateCache.running = false;
      stateCache.paused = true;
      stateCache.stopRequested = false;
      stateCache.lastError = "上次處理在瀏覽器中斷，文章已放回本機佇列；按「繼續」即可重新分析。";
      await persistState();
    } else if (config.providerReselectionRequired) {
      stateCache.paused = true;
      stateCache.running = false;
      stateCache.stopRequested = false;
      stateCache.mode = stateCache.queue.length ? "paused" : stateCache.mode;
      stateCache.lastError = "舊版 AI 服務已移除。請到設定頁選擇 Google AI Studio 或 Vertex AI 並儲存後，再繼續分析。";
      await persistState();
    } else if (!stateCache.paused && stateCache.queue.length) {
      scheduleProcessing(500);
    }
  })();
  return initializePromise;
}

function hasLeftoverCustomAnalysisPrompt(config) {
  return Boolean(config?.analysisPromptCustomized) || Boolean(S.cleanText(config?.analysisPrompt));
}

function stripCustomAnalysisPrompt(config) {
  return {
    ...config,
    analysisPrompt: "",
    analysisPromptCustomized: false
  };
}

async function readConfig() {
  const stored = await chrome.storage.local.get(CONFIG_KEY);
  const saved = stored[CONFIG_KEY] ?? {};
  const legacyProvider = saved.aiProvider === "openrouter";
  const merged = { ...clone(DEFAULT_CONFIG), ...saved };
  merged.aiProvider = legacyProvider ? "gemini" : normalizeAiProvider(merged.aiProvider);
  merged.providerReselectionRequired = legacyProvider || saved.providerReselectionRequired === true;
  delete merged.openRouterModel;
  delete merged.openRouterFreeModelIds;
  delete merged.openRouterPaidConfirmedModel;
  delete merged.rememberOpenRouterKey;
  merged.outputSpec = P.normalizeOutputSpec(merged.outputSpec);
  merged.discardedTopicNames = normalizeDiscardedTopicNames(merged.discardedTopicNames);
  merged.topicDictionary = normalizeTopicDictionary(merged.topicDictionary);
  merged.topicPageResolutions = normalizeTopicPageResolutions(merged.topicPageResolutions);
  merged.preferExistingTopicsByDataSource = normalizeTopicOrganizerPreferences(
    merged.preferExistingTopicsByDataSource
  );
  if (hasLeftoverCustomAnalysisPrompt(merged)) {
    customAnalysisPromptCleared = true;
    const next = stripCustomAnalysisPrompt(merged);
    await writeConfig(next);
    return next;
  }
  return stripCustomAnalysisPrompt(merged);
}

function normalizeTopicDictionary(value) {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  return value.reduce((result, item) => {
    const name = S.cleanText(item?.name).slice(0, 100);
    const key = N.topicKey(name);
    if (!name || !key || seen.has(key) || result.length >= 500) return result;
    seen.add(key);
    result.push({
      name,
      definition: S.cleanText(item?.definition).slice(0, 500),
      aliases: uniqueTopicNames(item?.aliases ?? []).filter(alias => N.topicKey(alias) !== key).slice(0, 50),
      color: S.cleanText(item?.color) || N.topicColor(name),
      active: item?.active !== false
    });
    return result;
  }, []);
}

async function writeConfig(config) {
  const next = { ...config };
  delete next.openRouterModel;
  delete next.openRouterFreeModelIds;
  delete next.openRouterPaidConfirmedModel;
  delete next.rememberOpenRouterKey;
  await chrome.storage.local.set({ [CONFIG_KEY]: next });
}

function persistedStateBytes(state) {
  return new TextEncoder().encode(JSON.stringify({ [STATE_KEY]: state })).byteLength;
}

function compactStoredPageMetadata(item = {}) {
  return {
    ...item,
    title: S.cleanText(item.title).slice(0, 120),
    url: typeof item.url === "string" ? item.url.slice(0, 512) : ""
  };
}

function rollbackSnapshotSize(snapshot) {
  return persistedStateBytes({ ...stateCache, topicRollback: snapshot });
}

function assertRollbackSnapshotSize(snapshot) {
  const bytes = rollbackSnapshotSize(snapshot);
  if (bytes <= MAX_PERSISTED_STATE_BYTES) return;
  throw new AppError("主題回復快照會超過 4 MiB 安全上限，已在寫入 Notion 前停止", {
    code: "STATE_SIZE_LIMIT",
    diagnostic: { stateBytes: bytes, stateLimitBytes: MAX_PERSISTED_STATE_BYTES }
  });
}

async function persistState() {
  if (!stateCache) return;
  let bytes = persistedStateBytes(stateCache);
  if (bytes > MAX_PERSISTED_STATE_BYTES) {
    stateCache.queue = stateCache.queue.map(compactStoredPageMetadata);
    if (stateCache.pendingScan?.pages) {
      stateCache.pendingScan.pages = stateCache.pendingScan.pages.map(compactStoredPageMetadata);
    }
    bytes = persistedStateBytes(stateCache);
  }
  if (bytes > MAX_PERSISTED_STATE_BYTES && stateCache.pendingScan) {
    stateCache.pendingScan = null;
    bytes = persistedStateBytes(stateCache);
  }
  if (bytes > MAX_PERSISTED_STATE_BYTES) {
    throw new AppError("本機分析狀態超過 4 MiB 安全上限，已停止寫入；請清除近期紀錄後再重試", {
      code: "STATE_SIZE_LIMIT",
      diagnostic: { stateBytes: bytes, stateLimitBytes: MAX_PERSISTED_STATE_BYTES }
    });
  }
  await chrome.storage.local.set({ [STATE_KEY]: stateCache });
}

// ==== Secret management ====
async function readSecret(key) {
  const sessionValue = (await chrome.storage.session.get(key))[key];
  if (sessionValue) return sessionValue;
  return (await chrome.storage.local.get(key))[key] || "";
}

async function storeSecret(key, suppliedValue, remember) {
  const supplied = String(suppliedValue ?? "").trim();
  const value = supplied || await readSecret(key);
  if (remember) {
    if (value) await chrome.storage.local.set({ [key]: value });
    await chrome.storage.session.remove(key);
  } else {
    if (value) await chrome.storage.session.set({ [key]: value });
    await chrome.storage.local.remove(key);
  }
  return Boolean(value);
}

async function clearCredentials() {
  await Promise.all([
    chrome.storage.local.remove([NOTION_TOKEN_KEY, GEMINI_KEY_KEY, VERTEX_KEY_KEY, LEGACY_PROVIDER_KEY]),
    chrome.storage.session.remove([NOTION_TOKEN_KEY, GEMINI_KEY_KEY, VERTEX_KEY_KEY, LEGACY_PROVIDER_KEY])
  ]);
  const config = await readConfig();
  config.rememberNotionToken = false;
  config.rememberGeminiKey = false;
  config.rememberVertexKey = false;
  await writeConfig(config);
}

async function requireNotionToken() {
  const token = await readSecret(NOTION_TOKEN_KEY);
  if (!token) throw new AppError("尚未設定 Notion Integration Token", { code: "NOTION_TOKEN_MISSING" });
  return token;
}

async function requireGeminiKey() {
  const key = await readSecret(GEMINI_KEY_KEY);
  if (!key) throw new AppError("尚未設定 Gemini API Key", { code: "GEMINI_KEY_MISSING" });
  return key;
}

async function requireVertexKey() {
  const key = await readSecret(VERTEX_KEY_KEY);
  if (!key) throw new AppError("尚未設定 Vertex AI API Key", { code: "VERTEX_KEY_MISSING" });
  return key;
}

// ==== AI provider routing ====
function normalizeAiProvider(value) {
  return value === "vertex" ? "vertex" : "gemini";
}

function assertProviderReady(config) {
  if (!config.providerReselectionRequired) return;
  throw new AppError("請先到設定頁選擇 Google AI Studio 或 Vertex AI 並儲存", {
    code: "AI_PROVIDER_RESELECTION_REQUIRED"
  });
}

async function activeAiContext(config) {
  assertProviderReady(config);
  const provider = normalizeAiProvider(config.aiProvider);
  if (provider === "vertex") {
    return {
      apiKey: await requireVertexKey(),
      model: S.normalizeModelName(config.vertexModel) || G.DEFAULT_MODEL,
      provider
    };
  }
  return {
    apiKey: await requireGeminiKey(),
    model: S.normalizeModelName(config.geminiModel) || G.DEFAULT_MODEL,
    provider
  };
}
