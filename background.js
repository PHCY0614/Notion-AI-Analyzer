"use strict";

importScripts("shared.js", "prompt.js", "notion.js", "gemini.js");

const S = globalThis.AnalyzerShared;
const P = globalThis.AnalyzerPrompt;
const N = globalThis.AnalyzerNotion;
const G = globalThis.AnalyzerGemini;

const CONFIG_KEY = "notionAiAnalyzerConfig";
const STATE_KEY = "notionAiAnalyzerState";
const NOTION_TOKEN_KEY = "notionAiAnalyzerNotionToken";
const GEMINI_KEY_KEY = "notionAiAnalyzerGeminiKey";
const VERTEX_KEY_KEY = "notionAiAnalyzerVertexKey";
const OPENROUTER_KEY_KEY = "notionAiAnalyzerOpenRouterKey";
const PROCESS_ALARM = "notion-ai-analyzer-process";
const MAX_BLOCKS = 10000;
const MAX_RECENT = 40;
const CURRENT_PROMPT_VERSION = "2026-08-26-1";
const TOPIC_ORGANIZER_CACHE_VERSION = 10;
const TOPIC_ORGANIZER_BATCH_LIMIT = G.TOPIC_ORGANIZER_BATCH_LIMIT;
const DEFAULT_EXCLUDED_PERSON_TERMS = Object.freeze([]);
const REQUEUE_TIMEOUT_CODES = new Set([
  "AI_TIMEOUT",
  "PAGE_READ_TIMEOUT",
  "NOTION_WRITE_TIMEOUT"
]);
const RATE_LIMIT_CODES = new Set([
  "GEMINI_RATE_LIMIT",
  "VERTEX_RATE_LIMIT",
  "OPENROUTER_RATE_LIMIT",
  "NOTION_RATE_LIMIT"
]);
const SETUP_ERROR_CODES = new Set([
  "GEMINI_AUTH",
  "GEMINI_KEY_MISSING",
  "VERTEX_AUTH",
  "VERTEX_KEY_MISSING",
  "OPENROUTER_AUTH",
  "OPENROUTER_KEY_MISSING",
  "OPENROUTER_PAID_CONFIRMATION_REQUIRED",
  "MODEL_INVALID",
  "MODEL_NOT_FOUND",
  "SCHEMA_INVALID",
  "NOTION_FIELDS_INVALID",
  "NOTION_STATUS_FIELD_MISSING",
  "NOTION_STATUS_FIELD_TYPE",
  "NOTION_PENDING_OPTION_MISSING",
  "NOTION_AUTH",
  "NOTION_TOKEN_MISSING",
  "TOPIC_OPTIONS_EMPTY"
]);

const DEFAULT_CONFIG = Object.freeze({
  aiProvider: "gemini",
  allowTopicProposals: true,
  analysisPrompt: "",
  analysisPromptCustomized: false,
  promptBaseVersion: CURRENT_PROMPT_VERSION,
  dataSourceId: "",
  databaseId: "",
  discardedTopicNames: [],
  excludedPersonTerms: DEFAULT_EXCLUDED_PERSON_TERMS,
  geminiModel: G.DEFAULT_MODEL,
  openRouterModel: "openrouter/free",
  openRouterFreeModelIds: ["openrouter/free"],
  openRouterPaidConfirmedModel: "",
  vertexModel: "gemini-3.5-flash-lite",
  notionTarget: "",
  rememberGeminiKey: false,
  rememberOpenRouterKey: false,
  rememberVertexKey: false,
  rememberNotionToken: false,
  requestTimeoutMinutes: 5,
  outputSpec: P.DEFAULT_OUTPUT_SPEC,
  preferExistingTopicsByDataSource: {},
  topicAliases: {},
  topicPageResolutions: {},
  topicDictionary: []
});

const DEFAULT_STATE = Object.freeze({
  current: null,
  databaseCheck: null,
  failed: [],
  knownPending: null,
  lastError: "",
  lastScanAt: "",
  pendingScan: null,
  mode: "idle",
  paused: true,
  queue: [],
  recent: [],
  running: false,
  stopRequested: false,
  stage: null,
  topicOrganizer: null,
  topicRollback: null,
  topicReview: null
});

class AppError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = "AppError";
    this.code = options.code || "APP_ERROR";
    this.diagnostic = options.diagnostic || null;
    this.status = options.status || 0;
    this.retryAfter = options.retryAfter || 0;
  }
}

let initializePromise = null;
let stateCache = null;
let activeAbortController = null;
let processingPromise = null;
let preparedDataSourceId = "";

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function normalizeExcludedPersonTerms(value) {
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
    approvedNewTopics: normalizeExcludedPersonTerms(review.approvedNewTopics ?? []),
    candidateTotal: Number(review.candidateTotal) || remainingCandidates.length,
    decisions: Array.isArray(review.decisions) ? review.decisions : [],
    remainingCandidates,
    skippedCandidates: normalizeExcludedPersonTerms(review.skippedCandidates ?? []),
    originalFinalTopics: normalizeExcludedPersonTerms(review.originalFinalTopics ?? []),
    selectedExistingTopics: Array.isArray(review.selectedExistingTopics)
      ? review.selectedExistingTopics
      : Array.isArray(result.ai_topics) ? result.ai_topics : []
  };
}

async function initialize() {
  if (initializePromise) return initializePromise;
  initializePromise = (async () => {
    try {
      await chrome.storage.session.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" });
    } catch {
      // Older Chrome versions may not expose setAccessLevel. No untrusted context is used.
    }
    const stored = await chrome.storage.local.get(STATE_KEY);
    stateCache = {
      ...clone(DEFAULT_STATE),
      ...(stored[STATE_KEY] ?? {})
    };
    stateCache.queue = Array.isArray(stateCache.queue) ? stateCache.queue : [];
    stateCache.failed = Array.isArray(stateCache.failed) ? stateCache.failed : [];
    stateCache.recent = Array.isArray(stateCache.recent) ? stateCache.recent : [];
    stateCache.topicReview = normalizeTopicReview(stateCache.topicReview);
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
    } else if (!stateCache.paused && stateCache.queue.length) {
      scheduleProcessing(500);
    }
  })();
  return initializePromise;
}

async function readConfig() {
  const stored = await chrome.storage.local.get(CONFIG_KEY);
  const merged = { ...clone(DEFAULT_CONFIG), ...(stored[CONFIG_KEY] ?? {}) };
  merged.outputSpec = P.normalizeOutputSpec(merged.outputSpec);
  merged.discardedTopicNames = normalizeDiscardedTopicNames(merged.discardedTopicNames);
  merged.topicDictionary = normalizeTopicDictionary(merged.topicDictionary);
  merged.topicPageResolutions = normalizeTopicPageResolutions(merged.topicPageResolutions);
  merged.preferExistingTopicsByDataSource = normalizeTopicOrganizerPreferences(
    merged.preferExistingTopicsByDataSource
  );
  return merged;
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
  await chrome.storage.local.set({ [CONFIG_KEY]: config });
}

async function persistState() {
  if (!stateCache) return;
  await chrome.storage.local.set({ [STATE_KEY]: stateCache });
}

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
    chrome.storage.local.remove([NOTION_TOKEN_KEY, GEMINI_KEY_KEY, VERTEX_KEY_KEY, OPENROUTER_KEY_KEY]),
    chrome.storage.session.remove([NOTION_TOKEN_KEY, GEMINI_KEY_KEY, VERTEX_KEY_KEY, OPENROUTER_KEY_KEY])
  ]);
  const config = await readConfig();
  config.rememberNotionToken = false;
  config.rememberGeminiKey = false;
  config.rememberOpenRouterKey = false;
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

async function requireOpenRouterKey() {
  const key = await readSecret(OPENROUTER_KEY_KEY);
  if (!key) throw new AppError("尚未設定 OpenRouter API Key", { code: "OPENROUTER_KEY_MISSING" });
  return key;
}

function normalizeAiProvider(value) {
  return ["vertex", "openrouter"].includes(value) ? value : "gemini";
}

async function activeAiContext(config) {
  const provider = normalizeAiProvider(config.aiProvider);
  if (provider === "vertex") {
    return {
      apiKey: await requireVertexKey(),
      model: S.normalizeModelName(config.vertexModel) || "gemini-3.5-flash-lite",
      provider
    };
  }
  if (provider === "openrouter") {
    const model = String(config.openRouterModel || "openrouter/free").trim();
    if (model === "openrouter/free") {
      throw new AppError("OpenRouter 免費隨機路由無法保證目前有端點支援嚴格 JSON。請到設定頁掃描模型，改選一個具體的免費或付費模型", {
        code: "OPENROUTER_MODEL_INCOMPATIBLE"
      });
    }
    const freeModels = new Set(Array.isArray(config.openRouterFreeModelIds)
      ? config.openRouterFreeModelIds
      : ["openrouter/free"]);
    if (!freeModels.has(model) && !model.endsWith(":free")
      && config.openRouterPaidConfirmedModel !== model) {
      throw new AppError("所選 OpenRouter 模型可能產生費用，請回到設定頁確認價格並勾選費用確認", {
        code: "OPENROUTER_PAID_CONFIRMATION_REQUIRED"
      });
    }
    return {
      apiKey: await requireOpenRouterKey(),
      model,
      provider
    };
  }
  return {
    apiKey: await requireGeminiKey(),
    model: S.normalizeModelName(config.geminiModel) || G.DEFAULT_MODEL,
    provider
  };
}

function errorMessage(data, fallback) {
  return data?.message || data?.error?.message || fallback;
}

function retryDelay(response, attempt) {
  const retryAfter = Number(response?.headers?.get("retry-after"));
  return (Number.isFinite(retryAfter) ? retryAfter : Math.min(2 ** attempt, 20)) * 1000
    + Math.floor(Math.random() * 180);
}

// Every HTTP call below reads the response body as text first (so a non-JSON
// error page never throws before we can build a useful AppError), then tries
// to parse it as JSON. `fallbackShape` controls what we return when parsing
// fails: Notion's error helper reads `data.message`, while every AI provider
// helper reads `data.error.message` (see errorMessage() above, which checks
// both paths). Keeping both shapes lets each caller stay unchanged.
async function readJsonResponse(response, fallbackShape = "error") {
  const text = await response.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return fallbackShape === "message" ? { message: text } : { error: { message: text } };
  }
}

function abortableSleep(milliseconds, signal) {
  if (!signal) return S.sleep(milliseconds);
  if (signal.aborted) return Promise.reject(new DOMException("已停止", "AbortError"));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(done, milliseconds);
    signal.addEventListener("abort", aborted, { once: true });
    function done() {
      signal.removeEventListener("abort", aborted);
      resolve();
    }
    function aborted() {
      clearTimeout(timer);
      reject(new DOMException("已停止", "AbortError"));
    }
  });
}

async function notionRequest(path, options = {}) {
  const token = options.token || await requireNotionToken();
  const method = options.method || "GET";
  const retrySafe = options.retrySafe !== false;
  let attempt = 0;
  while (attempt < 4) {
    let response;
    try {
      response = await fetch(`https://api.notion.com${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          "Notion-Version": N.API_VERSION
        },
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
        signal: options.signal
      });
    } catch (error) {
      if (error?.name === "AbortError") throw error;
      if (!retrySafe || attempt >= 3) {
        throw new AppError("無法連線到 Notion API，請檢查網路後再試", { code: "NOTION_NETWORK" });
      }
      await abortableSleep(Math.min(2 ** attempt, 8) * 1000, options.signal);
      attempt += 1;
      continue;
    }

    const data = await readJsonResponse(response, "message");
    if (response.ok) return data;

    const transient = response.status === 429 || [500, 502, 503, 504, 529].includes(response.status);
    if (transient && retrySafe && attempt < 3) {
      await abortableSleep(retryDelay(response, attempt), options.signal);
      attempt += 1;
      continue;
    }

    const code = response.status === 429
      ? "NOTION_RATE_LIMIT"
      : [401, 403].includes(response.status) ? "NOTION_AUTH" : "NOTION_API";
    throw new AppError(errorMessage(data, `Notion API 錯誤 ${response.status}`), {
      code,
      retryAfter: Number(response.headers.get("retry-after")) || 0,
      status: response.status
    });
  }
  throw new AppError("Notion API 重試次數已用完", { code: "NOTION_RETRY_EXHAUSTED" });
}

async function googleGenerativeRequest(model, payload, options, descriptor) {
  const apiKey = options.apiKey || await descriptor.requireKey();
  const safeModel = S.normalizeModelName(model);
  if (!safeModel) throw new AppError(descriptor.modelInvalidMessage, { code: "MODEL_INVALID" });
  let attempt = 0;
  while (attempt < 3) {
    let response;
    try {
      response = await fetch(
        descriptor.buildUrl(safeModel),
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-goog-api-key": apiKey
          },
          body: JSON.stringify(payload),
          signal: options.signal
        }
      );
    } catch (error) {
      if (error?.name === "AbortError") throw error;
      if (attempt >= 2) {
        throw new AppError(descriptor.networkMessage, { code: `${descriptor.codePrefix}_NETWORK` });
      }
      await abortableSleep(Math.min(2 ** attempt, 4) * 1000, options.signal);
      attempt += 1;
      continue;
    }

    const data = await readJsonResponse(response);
    if (response.ok) return data;

    if ([500, 502, 503, 504].includes(response.status) && attempt < 2) {
      await abortableSleep(retryDelay(response, attempt), options.signal);
      attempt += 1;
      continue;
    }

    let code = `${descriptor.codePrefix}_API`;
    if (response.status === 429) code = `${descriptor.codePrefix}_RATE_LIMIT`;
    else if ([400, 401, 403].includes(response.status)
      && descriptor.authPattern.test(errorMessage(data, ""))) code = `${descriptor.codePrefix}_AUTH`;
    else if (response.status === 404) code = "MODEL_NOT_FOUND";
    throw new AppError(errorMessage(data, `${descriptor.apiErrorPrefix} ${response.status}`), {
      code,
      retryAfter: Number(response.headers.get("retry-after")) || 0,
      status: response.status
    });
  }
  throw new AppError(descriptor.retryExhaustedMessage, { code: `${descriptor.codePrefix}_RETRY_EXHAUSTED` });
}

async function geminiRequest(model, payload, options = {}) {
  return googleGenerativeRequest(model, payload, options, {
    requireKey: requireGeminiKey,
    buildUrl(safeModel) {
      return `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(safeModel)}:generateContent`;
    },
    codePrefix: "GEMINI",
    networkMessage: "無法連線到 Gemini API，請檢查網路後再試",
    modelInvalidMessage: "Gemini 模型名稱格式不正確",
    retryExhaustedMessage: "Gemini API 重試次數已用完",
    apiErrorPrefix: "Gemini API 錯誤",
    authPattern: /key|credential|permission|api/i
  });
}

async function vertexRequest(model, payload, options = {}) {
  return googleGenerativeRequest(model, payload, options, {
    requireKey: requireVertexKey,
    buildUrl(safeModel) {
      return `https://aiplatform.googleapis.com/v1/publishers/google/models/${encodeURIComponent(safeModel)}:generateContent`;
    },
    codePrefix: "VERTEX",
    networkMessage: "無法連線到 Vertex AI，請檢查網路後再試",
    modelInvalidMessage: "Vertex AI 模型名稱格式不正確",
    retryExhaustedMessage: "Vertex AI 重試次數已用完",
    apiErrorPrefix: "Vertex AI 錯誤",
    authPattern: /key|credential|permission|api|service account/i
  });
}

function openRouterPayload(model, payload) {
  const systemText = (payload?.systemInstruction?.parts ?? [])
    .map(part => part?.text || "")
    .join("\n")
    .trim();
  const userText = (payload?.contents ?? [])
    .flatMap(content => content?.parts ?? [])
    .map(part => part?.text || "")
    .join("\n")
    .trim();
  const schema = payload?.generationConfig?.responseJsonSchema;
  const body = {
    model,
    messages: [
      ...(systemText ? [{ role: "system", content: systemText }] : []),
      { role: "user", content: userText }
    ],
    max_tokens: Math.min(Number(payload?.generationConfig?.maxOutputTokens) || 4096, 8192),
    stream: false
  };
  if (schema) {
    body.response_format = {
      type: "json_schema",
      json_schema: {
        name: "notion_ai_analysis",
        strict: true,
        schema
      }
    };
    body.provider = { require_parameters: true };
  }
  return body;
}

function normalizeOpenRouterResponse(data) {
  const choice = data?.choices?.[0] ?? {};
  const content = typeof choice?.message?.content === "string"
    ? choice.message.content
    : Array.isArray(choice?.message?.content)
      ? choice.message.content.map(part => part?.text || "").join("")
      : "";
  const refusal = choice?.message?.refusal || "";
  return {
    candidates: content ? [{
      content: { parts: [{ text: content }] },
      finishReason: choice.finish_reason || ""
    }] : [],
    modelVersion: data?.model || "",
    promptFeedback: refusal ? { blockReason: refusal } : undefined,
    usageMetadata: data?.usage ? {
      promptTokenCount: data.usage.prompt_tokens ?? null,
      candidatesTokenCount: data.usage.completion_tokens ?? null,
      totalTokenCount: data.usage.total_tokens ?? null
    } : null
  };
}

async function openRouterRequest(model, payload, options = {}) {
  const apiKey = options.apiKey || await requireOpenRouterKey();
  const safeModel = String(model || "").trim();
  if (!/^[a-z0-9_.:-]+\/[a-z0-9_.:@/-]+$/i.test(safeModel)) {
    throw new AppError("OpenRouter 模型名稱格式不正確", { code: "MODEL_INVALID" });
  }
  let attempt = 0;
  while (attempt < 3) {
    let response;
    try {
      response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${apiKey}`,
          "Content-Type": "application/json",
          "X-OpenRouter-Title": "Notion AI Analyzer"
        },
        body: JSON.stringify(openRouterPayload(safeModel, payload)),
        signal: options.signal
      });
    } catch (error) {
      if (error?.name === "AbortError") throw error;
      if (attempt >= 2) {
        throw new AppError("無法連線到 OpenRouter，請檢查網路後再試", { code: "OPENROUTER_NETWORK" });
      }
      await abortableSleep(Math.min(2 ** attempt, 4) * 1000, options.signal);
      attempt += 1;
      continue;
    }

    const data = await readJsonResponse(response);
    if (response.ok) return normalizeOpenRouterResponse(data);

    if ([500, 502, 503, 504].includes(response.status) && attempt < 2) {
      await abortableSleep(retryDelay(response, attempt), options.signal);
      attempt += 1;
      continue;
    }
    const message = errorMessage(data, `OpenRouter 錯誤 ${response.status}`);
    let code = "OPENROUTER_API";
    if (response.status === 429) code = "OPENROUTER_RATE_LIMIT";
    else if ([401, 403].includes(response.status)) code = "OPENROUTER_AUTH";
    else if (/no endpoints found.*requested parameters|requested parameters.*no endpoints found/i.test(message)) {
      code = "OPENROUTER_MODEL_INCOMPATIBLE";
    }
    else if (response.status === 404) code = "MODEL_NOT_FOUND";
    const userMessage = code === "OPENROUTER_MODEL_INCOMPATIBLE"
      ? "所選 OpenRouter 模型目前沒有可處理嚴格 JSON 的端點。請重新掃描模型並改選其他項目"
      : message;
    throw new AppError(userMessage, {
      code,
      retryAfter: Number(response.headers.get("retry-after")) || 0,
      status: response.status
    });
  }
  throw new AppError("OpenRouter 重試次數已用完", { code: "OPENROUTER_RETRY_EXHAUSTED" });
}

async function aiRequest(provider, model, payload, options = {}) {
  if (provider === "vertex") return vertexRequest(model, payload, options);
  if (provider === "openrouter") return openRouterRequest(model, payload, options);
  return geminiRequest(model, payload, options);
}

async function setStage(name, detail = {}) {
  if (!stateCache) return;
  stateCache.stage = {
    name,
    startedAt: new Date().toISOString(),
    ...detail
  };
  await persistState();
}

async function timedAiRequest(provider, model, payload, options = {}) {
  const minutes = Number(options.timeoutMinutes);
  const timeoutMs = Number.isFinite(minutes) && minutes > 0 ? minutes * 60 * 1000 : 0;
  const controller = new AbortController();
  let parentAborted = false;
  const abortFromParent = () => {
    parentAborted = true;
    controller.abort();
  };
  if (options.signal?.aborted) abortFromParent();
  else options.signal?.addEventListener("abort", abortFromParent, { once: true });
  const timer = timeoutMs ? setTimeout(() => controller.abort(), timeoutMs) : null;
  await setStage("等待 AI 回應", { model, provider });
  try {
    return await aiRequest(provider, model, payload, { ...options, signal: controller.signal });
  } catch (error) {
    if (error?.name === "AbortError" && !parentAborted && timeoutMs) {
      throw new AppError(`AI 單次請求等待超過 ${minutes} 分鐘，已停止且不會自動重送文章`, {
        code: "AI_TIMEOUT"
      });
    }
    throw error;
  } finally {
    if (timer) clearTimeout(timer);
    options.signal?.removeEventListener("abort", abortFromParent);
  }
}

async function withAbortTimeout(task, parentSignal, timeoutMs, timeoutCode, timeoutMessage) {
  const controller = new AbortController();
  let parentAborted = false;
  const onParentAbort = () => {
    parentAborted = true;
    controller.abort();
  };
  if (parentSignal?.aborted) onParentAbort();
  else parentSignal?.addEventListener("abort", onParentAbort, { once: true });
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await task(controller.signal);
  } catch (error) {
    if (error?.name === "AbortError" && !parentAborted) {
      throw new AppError(timeoutMessage, { code: timeoutCode });
    }
    throw error;
  } finally {
    clearTimeout(timer);
    parentSignal?.removeEventListener("abort", onParentAbort);
  }
}

function notionWriteWithTimeout(path, options, parentSignal) {
  return withAbortTimeout(
    signal => notionRequest(path, { ...options, signal }),
    parentSignal,
    60000,
    "NOTION_WRITE_TIMEOUT",
    "寫回 Notion 超過 60 秒，已停止以避免重複更新"
  );
}

async function listOpenRouterModels(apiKey = "") {
  const key = apiKey || await requireOpenRouterKey();
  let response;
  try {
    response = await fetch("https://openrouter.ai/api/v1/models", {
      headers: { "Authorization": `Bearer ${key}` }
    });
  } catch {
    throw new AppError("無法連線到 OpenRouter，請檢查網路後再試", { code: "OPENROUTER_NETWORK" });
  }
  const data = await readJsonResponse(response);
  if (!response.ok) {
    throw new AppError(errorMessage(data, `OpenRouter 模型清單錯誤 ${response.status}`), {
      code: [401, 403].includes(response.status) ? "OPENROUTER_AUTH" : "OPENROUTER_API",
      status: response.status
    });
  }
  const models = (data?.data ?? []).filter(model => {
    if (model?.id === "openrouter/free") return false;
    const parameters = model?.supported_parameters ?? [];
    const outputs = model?.architecture?.output_modalities ?? ["text"];
    const identity = `${model?.id || ""} ${model?.name || ""}`.toLocaleLowerCase("en-US");
    const specialized = /(?:^|[\s/_.:@-])(?:code|coder|codex|codestral|devstral|starcoder|embedding|embed|rerank|ocr|imagen|imagegen|tts|speech|audio|music|video)(?:$|[\s/_.:@-])/i;
    const contextLength = Number(model?.context_length);
    return parameters.includes("structured_outputs")
      && outputs.includes("text")
      && !specialized.test(identity)
      && (!Number.isFinite(contextLength) || contextLength >= 16000);
  }).map(model => {
    const promptPrice = Number(model?.pricing?.prompt);
    const completionPrice = Number(model?.pricing?.completion);
    const requestPrice = Number(model?.pricing?.request);
    const reasoningPrice = Number(model?.pricing?.internal_reasoning);
    const isFree = model?.id === "openrouter/free"
      || (promptPrice === 0 && completionPrice === 0
        && (!Number.isFinite(requestPrice) || requestPrice === 0)
        && (!Number.isFinite(reasoningPrice) || reasoningPrice === 0));
    const reasoningEfforts = Array.isArray(model?.reasoning?.supported_efforts)
      ? model.reasoning.supported_efforts
      : [];
    const analysisRank = model?.reasoning?.mandatory
      ? 30
      : reasoningEfforts.some(effort => ["none", "minimal", "low"].includes(effort))
        ? 0
        : model?.reasoning?.default_enabled ? 20 : 10;
    return {
      analysisRank,
      completionPricePerMillion: Number.isFinite(completionPrice) ? completionPrice * 1000000 : null,
      displayName: model.name || model.id,
      inputTokenLimit: Number(model.context_length) || null,
      isFree,
      name: model.id,
      outputTokenLimit: Number(model?.top_provider?.max_completion_tokens) || null,
      promptPricePerMillion: Number.isFinite(promptPrice) ? promptPrice * 1000000 : null,
      reasoningPricePerMillion: Number.isFinite(reasoningPrice) ? reasoningPrice * 1000000 : null,
      requestPrice: Number.isFinite(requestPrice) ? requestPrice : null,
      thinking: false
    };
  });
  return [...new Map(models.map(model => [model.name, model])).values()].sort((a, b) => {
    if (a.isFree !== b.isFree) return a.isFree ? -1 : 1;
    if (a.analysisRank !== b.analysisRank) return a.analysisRank - b.analysisRank;
    return a.displayName.localeCompare(b.displayName);
  });
}

function recommendedVertexModels() {
  return [
    { name: "gemini-3.7-flash", displayName: "Gemini 3.7 Flash", inputTokenLimit: null, outputTokenLimit: null },
    { name: "gemini-3.6-flash", displayName: "Gemini 3.6 Flash", inputTokenLimit: null, outputTokenLimit: null },
    { name: "gemini-3.5-flash-lite", displayName: "Gemini 3.5 Flash-Lite", inputTokenLimit: null, outputTokenLimit: null },
    { name: "gemini-3.5-flash", displayName: "Gemini 3.5 Flash", inputTokenLimit: null, outputTokenLimit: null },
    { name: "gemini-3.1-flash-lite", displayName: "Gemini 3.1 Flash-Lite", inputTokenLimit: null, outputTokenLimit: null },
    { name: "gemini-3.1-pro-preview", displayName: "Gemini 3.1 Pro Preview", inputTokenLimit: null, outputTokenLimit: null },
    { name: "gemini-3-flash-preview", displayName: "Gemini 3 Flash Preview", inputTokenLimit: null, outputTokenLimit: null },
    { name: "gemini-2.5-flash-lite", displayName: "Gemini 2.5 Flash-Lite", inputTokenLimit: null, outputTokenLimit: null },
    { name: "gemini-2.5-flash", displayName: "Gemini 2.5 Flash", inputTokenLimit: null, outputTokenLimit: null },
    { name: "gemini-2.5-pro", displayName: "Gemini 2.5 Pro", inputTokenLimit: null, outputTokenLimit: null }
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

async function ensureSchema(config, token) {
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
  if (plan.changed) {
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

async function readyNotion() {
  const token = await requireNotionToken();
  const config = await readConfig();
  try {
    const ready = await ensureSchema(config, token);
    preparedDataSourceId = compactNotionId(ready.config.dataSourceId);
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
  let cursor = "";
  do {
    const response = await notionRequest(`/v1/data_sources/${dataSourceId}/query`, {
      method: "POST",
      body: N.queryPayload(status, cursor),
      signal: options.signal,
      token
    });
    pages.push(...(response.results ?? []).map(page => ({
      ...N.pageSummary(page),
      sourceDataSourceId: dataSourceId,
      sourceStatus: status
    })));
    if (typeof options.onProgress === "function") await options.onProgress(pages.length, status);
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

async function queryTopicOrganizerPages(dataSourceId, token, options = {}) {
  const pages = [];
  const topicKeys = new Set();
  let cursor = "";
  let done = false;
  const eligibleStatuses = new Set([N.STATUS.topicOrganize, N.STATUS.topicReview]);
  do {
    const response = await notionRequest(`/v1/data_sources/${dataSourceId}/query`, {
      method: "POST",
      body: N.topicOrganizerQueryPayload(cursor, 50),
      signal: options.signal,
      token
    });
    for (const rawPage of response.results ?? []) {
      const page = N.topicOrganizerPageValues(rawPage);
      if (!eligibleStatuses.has(page.status) || !page.provisionalTopics.length) continue;
      pages.push(page);
      for (const name of uniqueTopicNames(page.provisionalTopics)) topicKeys.add(N.topicKey(name));
      if (topicKeys.size >= TOPIC_ORGANIZER_BATCH_LIMIT) {
        done = true;
        break;
      }
    }
    cursor = !done && response.has_more ? response.next_cursor || "" : "";
  } while (cursor);
  await setStage("掃描 Notion", { progress: pages.length });
  return pages;
}

function topicDictionaryLookup(config = {}, allowedTargets = null) {
  const lookup = new Map();
  const allowed = allowedTargets == null
    ? null
    : new Set([...allowedTargets].map(N.topicKey).filter(Boolean));
  for (const entry of normalizeTopicDictionary(config.topicDictionary).filter(item => item.active !== false)) {
    if (allowed && !allowed.has(N.topicKey(entry.name))) continue;
    lookup.set(N.topicKey(entry.name), entry.name);
    for (const alias of entry.aliases ?? []) lookup.set(N.topicKey(alias), entry.name);
  }
  for (const [alias, target] of Object.entries(normalizeTopicAliases(config.topicAliases))) {
    if (allowed && !allowed.has(N.topicKey(target))) continue;
    lookup.set(alias, S.cleanText(target));
  }
  return lookup;
}

function pageResolution(resolutions, pageId, candidate) {
  return S.cleanText(resolutions?.[pageId]?.[N.topicKey(candidate)]);
}

function topicOrganizerCandidates(pages, options = [], config = {}, limit = TOPIC_ORGANIZER_BATCH_LIMIT) {
  const map = new Map();
  const existing = new Map(validTopicOptions(options).map(option => [N.topicKey(option.name), option.name]));
  const dictionary = topicDictionaryLookup(config, existing.keys());
  const discardedKeys = new Set(normalizeDiscardedTopicNames(config.discardedTopicNames).map(N.topicKey));
  const resolutions = normalizeTopicPageResolutions(config.topicPageResolutions);
  for (const page of pages ?? []) {
    const finalKeys = new Set((page.aiTopics ?? []).map(N.topicKey));
    for (const rawName of uniqueTopicNames(page.provisionalTopics ?? [])) {
      const name = S.cleanText(rawName);
      const key = N.topicKey(name);
      if (!key) continue;
      const pageTarget = pageResolution(resolutions, page.id, name);
      const preferredStandard = existing.get(key)
        || (existing.has(N.topicKey(pageTarget)) ? existing.get(N.topicKey(pageTarget)) : "")
        || dictionary.get(key)
        || "";
      if (!map.has(key)) {
        map.set(key, {
          name,
          occurrences: 0,
          pageIds: [],
          preferredStandard,
          alreadyApplied: Boolean(preferredStandard && finalKeys.has(N.topicKey(preferredStandard))),
          permanentlyDiscarded: discardedKeys.has(key)
        });
      }
      const entry = map.get(key);
      entry.occurrences += 1;
      if (!entry.preferredStandard && preferredStandard) entry.preferredStandard = preferredStandard;
      entry.alreadyApplied = entry.alreadyApplied || Boolean(preferredStandard && finalKeys.has(N.topicKey(preferredStandard)));
      if (!entry.pageIds.includes(page.id)) entry.pageIds.push(page.id);
    }
  }
  return [...map.values()]
    .slice(0, Math.max(1, Math.min(TOPIC_ORGANIZER_BATCH_LIMIT, Number(limit) || TOPIC_ORGANIZER_BATCH_LIMIT)))
    .sort((a, b) => a.name.localeCompare(b.name, "zh-Hant-TW"));
}

function organizerGroupEvidence(candidates = [], aliases = []) {
  const aliasKeys = new Set(uniqueTopicNames(aliases).map(N.topicKey));
  const pageIds = new Set();
  for (const candidate of candidates ?? []) {
    if (!aliasKeys.has(N.topicKey(candidate.name))) continue;
    for (const pageId of candidate.pageIds ?? []) pageIds.add(pageId);
  }
  return { impactCount: pageIds.size };
}

function topicOrganizerStandards(options = [], pages = []) {
  return uniqueTopicNames([
    ...validTopicOptions(options).map(option => option.name),
    ...(pages ?? []).flatMap(page => page.aiTopics ?? [])
  ]).map(name => ({ name }));
}

function mergeOrganizerGroups(inputGroups = []) {
  const grouped = new Map();
  const confidenceRank = { low: 0, medium: 1, high: 2 };
  for (const input of inputGroups ?? []) {
    const standard = S.cleanText(input.standard_topic ?? input.standardTopic);
    const sources = uniqueTopicNames(input.source_topics ?? input.aliases ?? []);
    if (!standard || !sources.length) continue;
    const key = N.topicKey(standard);
    if (!grouped.has(key)) {
      grouped.set(key, {
        standard_topic: standard,
        definition: S.cleanText(input.definition),
        aliases: [],
        keep_separate: [],
        reasons: [],
        confidence: input.confidence || "low",
        existing: input.existing === true,
        confirmed: input.confirmed === true
      });
    }
    const group = grouped.get(key);
    group.aliases.push(...sources);
    group.keep_separate.push(...(input.keep_separate ?? input.keepSeparate ?? []));
    if (S.cleanText(input.reason)) group.reasons.push(S.cleanText(input.reason));
    group.existing = group.existing || input.existing === true;
    group.confirmed = group.confirmed || input.confirmed === true;
    if (!group.definition && input.definition) group.definition = S.cleanText(input.definition);
    if ((confidenceRank[input.confidence] ?? 0) < (confidenceRank[group.confidence] ?? 0)) {
      group.confidence = input.confidence;
    }
  }
  const groups = [];
  for (const group of grouped.values()) {
    group.aliases = uniqueTopicNames(group.aliases);
    const aliasKeys = new Set(group.aliases.map(N.topicKey));
    group.keep_separate = uniqueTopicNames(group.keep_separate)
      .filter(name => !aliasKeys.has(N.topicKey(name)));
    groups.push({
      standard_topic: group.standard_topic,
      definition: group.definition,
      aliases: group.aliases,
      keep_separate: group.keep_separate,
      reason: uniqueTopicNames(group.reasons).join("；").slice(0, 500),
      confidence: group.confidence,
      existing: group.existing,
      confirmed: group.confirmed
    });
  }
  return groups;
}

function canRetryTopicOrganizerWithoutSchema(error) {
  if (error?.code === "OPENROUTER_MODEL_INCOMPATIBLE") return true;
  if (Number(error?.status) !== 400) return false;
  return /invalid[_ ]argument|requested parameters|json|schema|max.?output.?tokens/i
    .test(String(error?.message || ""));
}

async function prepareTopicOrganizer() {
  if (stateCache.running) throw new AppError("目前正在分析文章，請先停止或等候完成", { code: "BUSY" });
  const controller = new AbortController();
  activeAbortController = controller;
  try {
    const { config, token } = await readyNotion();
    await setStage("掃描 Notion", { progress: 0 });
    const [pages, options] = await Promise.all([
      queryTopicOrganizerPages(config.dataSourceId, token, { signal: controller.signal }),
      readTopicOptions(config, token, controller.signal)
    ]);
    const candidates = topicOrganizerCandidates(pages, options, config);
    if (!candidates.length) {
      stateCache.topicOrganizer = {
        version: TOPIC_ORGANIZER_CACHE_VERSION,
        status: "review",
        scannedAt: new Date().toISOString(),
        candidates: [], pages, groups: [], unclassified: [], manualSkipped: [],
        existingTopics: validTopicOptions(options).map(option => option.name), warnings: [], progress: null,
        appliedCandidateCount: 0
      };
      stateCache.lastError = "";
      await persistState();
      return topicOrganizerForUi();
    }
    const organizerWarnings = [];
    const standards = topicOrganizerStandards(options, pages);
    const preferExistingTopics = topicOrganizerPreference(config);
    const organizerPromptOptions = { preferExistingTopics };
    const confirmedGroups = candidates.filter(item => item.preferredStandard).map(candidate => ({
        standard_topic: candidate.preferredStandard,
        source_topics: [candidate.name],
        definition: "",
        keep_separate: [],
        reason: `已有經使用者確認的主題對照「${candidate.preferredStandard}」。`,
        confidence: "high",
        existing: true,
        confirmed: true
      }));
    const permanentlyDiscarded = candidates.filter(item => item.permanentlyDiscarded && !item.preferredStandard);
    const aiCandidates = candidates.filter(item => !item.preferredStandard && !item.permanentlyDiscarded);
    const candidateNames = aiCandidates.map(candidate => candidate.name);
    let aiGroups = [];
    let unclassified = permanentlyDiscarded.map(candidate => candidate.name);
    if (aiCandidates.length) {
      const { apiKey, model, provider } = await activeAiContext(config);
      const aiInput = aiCandidates.map(candidate => ({ name: candidate.name }));
      let response;
      try {
        response = await timedAiRequest(
          provider,
          model,
          G.buildTopicOrganizerRequest(aiInput, standards, model, organizerPromptOptions),
          { apiKey, signal: controller.signal, timeoutMinutes: config.requestTimeoutMinutes }
        );
      } catch (error) {
        if (!canRetryTopicOrganizerWithoutSchema(error)) throw error;
        await setStage("改用相容 JSON 模式", { model, provider });
        response = await timedAiRequest(
          provider,
          model,
          G.buildTopicOrganizerCompatibilityRequest(aiInput, standards, model, organizerPromptOptions),
          { apiKey, signal: controller.signal, timeoutMinutes: config.requestTimeoutMinutes }
        );
      }
      await setStage("驗證主題建議", { model, provider });
      let invalidRaw = "";
      let checked;
      try {
        const parsed = G.parseJsonCandidate(response);
        invalidRaw = parsed.raw;
        checked = G.validateTopicOrganizer(parsed.value, candidateNames, standards);
      } catch (error) {
        if (error?.nonRetryable) throw error;
        invalidRaw = error?.rawOutput || "";
        checked = { ok: false, errors: [error?.message || "AI 回傳的內容不是有效 JSON"] };
      }
      if (!checked.ok) {
        await setStage("修復主題建議格式", { model, provider });
        const repairedResponse = await timedAiRequest(
          provider,
          model,
          G.buildTopicOrganizerRepairRequest(
            invalidRaw,
            checked.errors,
            candidateNames,
            standards,
            model,
            organizerPromptOptions
          ),
          { apiKey, signal: controller.signal, timeoutMinutes: config.requestTimeoutMinutes }
        );
        let repaired;
        try {
          repaired = G.parseJsonCandidate(repairedResponse);
          checked = G.validateTopicOrganizer(repaired.value, candidateNames, standards);
        } catch (error) {
          if (error?.nonRetryable) throw error;
          checked = { ok: false, errors: [error?.message || "修復結果不是有效 JSON"] };
        }
        if (!checked.ok) {
          organizerWarnings.push(`模型兩次都未回傳可用格式，本批候選已全部保留未分類：${checked.errors.join("；")}`);
          checked = G.validateTopicOrganizer({ groups: [], unclassified_topics: candidateNames }, candidateNames, standards);
        }
      }
      aiGroups = checked.value.groups;
      unclassified = uniqueTopicNames([...unclassified, ...checked.value.unclassified_topics]);
      organizerWarnings.push(...(checked.warnings ?? []));
    }
    const groups = mergeOrganizerGroups([...confirmedGroups, ...aiGroups]);
    const groupedKeys = new Set(groups.flatMap(group => group.aliases).map(N.topicKey));
    unclassified = uniqueTopicNames(unclassified)
      .filter(name => !groupedKeys.has(N.topicKey(name)));
    const reviewGroups = groups.map((group, index) => {
      const aliases = uniqueTopicNames(group.aliases);
      const evidence = organizerGroupEvidence(candidates, aliases);
      return {
        id: `group-${Date.now()}-${index}`,
        standardTopic: group.standard_topic,
        definition: group.definition,
        aliases,
        selectedAliases: [...aliases],
        keepSeparate: group.keep_separate,
        reason: group.reason,
        confidence: group.confidence,
        existing: group.existing,
        confirmed: group.confirmed,
        impactCount: evidence.impactCount,
        selected: false
      };
    });
    stateCache.topicOrganizer = {
      version: TOPIC_ORGANIZER_CACHE_VERSION,
      status: "review",
      scannedAt: new Date().toISOString(),
      candidates,
      pages,
      groups: reviewGroups,
      unclassified,
      manualSkipped: [],
      existingTopics: validTopicOptions(options).map(option => option.name),
      warnings: organizerWarnings,
      progress: null,
      appliedCandidateCount: 0
    };
    stateCache.lastError = "";
    stateCache.stage = null;
    await persistState();
    return topicOrganizerForUi();
  } finally {
    if (activeAbortController === controller) activeAbortController = null;
    stateCache.stage = null;
    await persistState();
  }
}

function topicOrganizerForUi() {
  const organizer = stateCache.topicOrganizer;
  if (!organizer) {
    return stateCache.topicRollback ? {
      status: "cleared",
      scannedAt: "",
      candidateCount: 0,
      occurrenceCount: 0,
      pageCount: 0,
      groups: [],
      unclassified: [],
      manualItems: [],
      existingTopics: [],
      appliedCount: 0,
      skippedCount: 0,
      warnings: [],
      progress: null,
      canRollback: true
    } : null;
  }
  const allGroups = organizer.groups ?? [];
  const groups = allGroups.filter(group => group.applied !== true && group.skipped !== true);
  const skippedManualKeys = new Set((organizer.manualSkipped ?? []).map(N.topicKey));
  const activeUnclassified = (organizer.unclassified ?? [])
    .filter(name => !skippedManualKeys.has(N.topicKey(name)));
  const candidatesByKey = new Map((organizer.candidates ?? []).map(candidate => [N.topicKey(candidate.name), candidate]));
  return {
    status: organizer.status,
    scannedAt: organizer.scannedAt,
    candidateCount: organizer.candidates?.length ?? 0,
    occurrenceCount: (organizer.candidates ?? []).reduce((total, candidate) => total + (Number(candidate.occurrences) || 0), 0),
    pageCount: organizer.pages?.length ?? 0,
    groups,
    unclassified: activeUnclassified,
    manualItems: activeUnclassified.map(name => {
      const candidate = candidatesByKey.get(N.topicKey(name));
      return {
        name,
        impactCount: candidate?.pageIds?.length ?? 0,
        permanentlyDiscarded: candidate?.permanentlyDiscarded === true
      };
    }),
    existingTopics: organizer.existingTopics ?? [],
    appliedCount: Number(organizer.appliedCandidateCount) || 0,
    skippedCount: allGroups.filter(group => group.skipped === true).length,
    manualSkippedCount: (organizer.manualSkipped ?? []).length,
    warnings: organizer.warnings ?? [],
    progress: organizer.progress ?? null,
    canRollback: Boolean(stateCache.topicRollback)
  };
}

async function clearTopicOrganizer() {
  if (stateCache.running) throw new AppError("目前正在處理其他工作，請稍後再清除建議", { code: "BUSY" });
  stateCache.topicOrganizer = null;
  await persistState();
  return topicOrganizerForUi();
}

function saveTopicOrganizerDrafts(organizer, groupsInput = []) {
  const storedGroups = new Map((organizer?.groups ?? []).map(group => [group.id, group]));
  for (const draft of groupsInput ?? []) {
    const stored = storedGroups.get(S.cleanText(draft?.id).slice(0, 120));
    if (!stored) continue;
    const allowedAliases = new Map((stored.aliases ?? []).map(name => [N.topicKey(name), name]));
    const selectedAliases = uniqueTopicNames(draft.selectedAliases ?? [])
      .map(name => allowedAliases.get(N.topicKey(name)) || "")
      .filter(Boolean);
    stored.standardTopic = S.cleanText(draft.standardTopic).slice(0, 100);
    stored.selectedAliases = selectedAliases;
    stored.selected = draft.selected === true;
  }
}

async function skipTopicOrganizerGroup(groupId, groupsInput = []) {
  const organizer = stateCache.topicOrganizer;
  saveTopicOrganizerDrafts(organizer, groupsInput);
  const group = organizer?.groups?.find(item => item.id === groupId);
  if (!group) throw new AppError("找不到要暫不處理的建議", { code: "TOPIC_GROUP_MISSING" });
  group.skipped = true;
  group.selected = false;
  organizer.unclassified = uniqueTopicNames([...(organizer.unclassified ?? []), ...(group.aliases ?? [])]);
  organizer.status = "review";
  await persistState();
  return topicOrganizerForUi();
}

function mergeDictionaryEntries(existing, additions) {
  const map = new Map(normalizeTopicDictionary(existing).map(item => [N.topicKey(item.name), item]));
  for (const addition of normalizeTopicDictionary(additions)) {
    const key = N.topicKey(addition.name);
    const previous = map.get(key);
    map.set(key, previous ? {
      ...previous,
      ...addition,
      aliases: uniqueTopicNames([...(previous.aliases ?? []), ...(addition.aliases ?? [])])
    } : addition);
  }
  return [...map.values()];
}

async function applyTopicOrganizerGroups(groupsInput = []) {
  const organizer = stateCache.topicOrganizer;
  if (!organizer?.pages || stateCache.running) {
    throw new AppError(stateCache.running ? "目前正在處理其他工作" : "請先產生主題整理建議", { code: "BUSY" });
  }
  const storedGroups = new Map((organizer.groups ?? []).map(group => [group.id, group]));
  const selected = (groupsInput ?? []).filter(group => group?.selected).map(group => {
    const id = S.cleanText(group.id).slice(0, 120);
    const stored = storedGroups.get(id);
    const allowedAliases = new Map((stored?.aliases ?? []).map(name => [N.topicKey(name), name]));
    const aliases = uniqueTopicNames(group.selectedAliases ?? [])
      .map(name => allowedAliases.get(N.topicKey(name)) || "")
      .filter(Boolean);
    return {
      id,
      standardTopic: S.cleanText(group.standardTopic).slice(0, 100),
      definition: S.cleanText(group.definition).slice(0, 500),
      aliases
    };
  }).filter(group => group.id && group.standardTopic && group.aliases.length);
  if (!selected.length) throw new AppError("請至少勾選一組要套用的建議", { code: "NO_TOPIC_GROUP_SELECTED" });

  const aliasMap = new Map();
  for (const group of selected) {
    for (const alias of group.aliases) {
      const key = N.topicKey(alias);
      if (aliasMap.has(key) && aliasMap.get(key) !== group.standardTopic) {
        throw new AppError(`「${alias}」同時被分到多個標準主題`, { code: "TOPIC_MAPPING_CONFLICT" });
      }
      aliasMap.set(key, group.standardTopic);
    }
  }
  const controller = new AbortController();
  const { config, token } = await readyNotion();
  let options = validTopicOptions(await readTopicOptions(config, token));
  const optionKeys = new Set(options.map(item => N.topicKey(item.name)));
  const newStandards = uniqueTopicNames(selected.map(group => group.standardTopic))
    .filter(name => !optionKeys.has(N.topicKey(name)));
  const invalidNewStandards = newStandards.filter(name => !G.isOrganizerTopicLabel(name));
  if (invalidNewStandards.length) {
    throw new AppError(`主題整理新增的分類名稱必須為 2～6 字，並優先使用 2～4 字：${invalidNewStandards.join("、")}`, {
      code: "ORGANIZER_TOPIC_LENGTH_INVALID"
    });
  }
  if (newStandards.length) {
    await notionRequest(`/v1/data_sources/${config.dataSourceId}`, {
      method: "PATCH",
      body: N.topicOptionsUpdatePayload(options, newStandards),
      retrySafe: true,
      token
    });
    options = validTopicOptions(await readTopicOptions(config, token));
  }

  activeAbortController = controller;
  stateCache.running = true;
  organizer.previousMode = stateCache.mode;
  organizer.previousPaused = stateCache.paused;
  stateCache.mode = "topic_apply";

  const operationKey = JSON.stringify(selected.map(group => [group.id, group.standardTopic, [...group.aliases].sort()]).sort());
  const snapshot = stateCache.topicRollback?.incomplete && stateCache.topicRollback.operationKey === operationKey
    ? stateCache.topicRollback
    : {
        appliedAt: new Date().toISOString(),
        pages: [],
        dictionary: config.topicDictionary,
        discardedTopicNames: config.discardedTopicNames,
        unclassifiedBefore: clone(organizer.unclassified ?? []),
        manualSkippedBefore: clone(organizer.manualSkipped ?? []),
        groupIds: selected.map(group => group.id).filter(Boolean),
        groupsBefore: selected.map(group => clone(storedGroups.get(group.id))).filter(Boolean),
        appliedCandidateCountBefore: Number(organizer.appliedCandidateCount) || 0,
        incomplete: true,
        operationKey
      };
  const affectedPages = (organizer.pages ?? []).filter(page =>
    (page.provisionalTopics ?? []).some(name => aliasMap.has(N.topicKey(name)))
  );
  organizer.status = "applying";
  organizer.applyGroups = selected;
  organizer.progress = { done: 0, total: affectedPages.length };
  await persistState();
  try {
    const nextDictionary = mergeDictionaryEntries(config.topicDictionary, selected.map(group => ({
      name: group.standardTopic,
      definition: group.definition,
      aliases: group.aliases,
      color: N.topicColor(group.standardTopic),
      active: true
    })));
    for (let index = 0; index < affectedPages.length; index += 1) {
      if (controller.signal.aborted) throw new DOMException("已停止", "AbortError");
      const page = affectedPages[index];
      const currentPage = await notionRequest(`/v1/pages/${page.id}`, { signal: controller.signal, token });
      const current = N.topicOrganizerPageValues(currentPage);
      const additions = uniqueTopicNames((current.provisionalTopics ?? [])
        .map(name => aliasMap.get(N.topicKey(name)) || "")
        .filter(Boolean))
        .filter(name => !(current.aiTopics ?? []).some(old => N.topicKey(old) === N.topicKey(name)));
      const finalTopics = uniqueTopicNames([...(current.aiTopics ?? []), ...additions]);
      const processedKeys = new Set(aliasMap.keys());
      const unresolved = (current.provisionalTopics ?? [])
        .filter(name => !processedKeys.has(N.topicKey(name)));
      const status = unresolved.length ? N.STATUS.topicReview : N.STATUS.analyzed;
      let saved = snapshot.pages.find(item => item.id === page.id);
      if (!saved) {
        saved = {
          id: page.id,
          addedTopics: additions,
          provisionalBefore: current.provisionalTopics ?? [],
          provisionalAfter: unresolved,
          statusBefore: current.status,
          statusAfter: status
        };
        snapshot.pages.push(saved);
      } else {
        saved.addedTopics = uniqueTopicNames([...(saved.addedTopics ?? []), ...additions]);
        saved.provisionalAfter = unresolved;
        saved.statusAfter = status;
      }
      if (additions.length || current.status !== status || unresolved.length !== (current.provisionalTopics ?? []).length) {
        await notionRequest(`/v1/pages/${page.id}`, {
          method: "PATCH",
          body: N.topicApplyPayload(finalTopics, status, options, unresolved),
          retrySafe: true,
          signal: controller.signal,
          token
        });
      }
      page.provisionalTopics = unresolved;
      page.aiTopics = finalTopics;
      page.status = status;
      organizer.progress.done = index + 1;
      stateCache.topicRollback = snapshot;
      await persistState();
    }

    config.topicDictionary = nextDictionary;
    await writeConfig(config);
    snapshot.incomplete = false;
    stateCache.topicRollback = snapshot;
    organizer.status = "applied";
    organizer.progress = { done: affectedPages.length, total: affectedPages.length };
    const appliedById = new Map(selected.map(group => [group.id, group]));
    const appliedAliasKeys = new Set(selected.flatMap(group => group.aliases).map(N.topicKey));
    organizer.appliedCandidateCount = (Number(organizer.appliedCandidateCount) || 0) + appliedAliasKeys.size;
    organizer.groups = (organizer.groups ?? []).map(group => {
      const applied = appliedById.get(group.id);
      if (!applied) return group;
      const selectedKeys = new Set(applied.aliases.map(N.topicKey));
      const remaining = (group.aliases ?? []).filter(name => !selectedKeys.has(N.topicKey(name)));
      if (!remaining.length) {
        return { ...group, applied: true, selected: false, selectedAliases: [] };
      }
      const evidence = organizerGroupEvidence(organizer.candidates, remaining);
      return {
        ...group,
        aliases: remaining,
        selectedAliases: [],
        selected: false,
        applied: false,
        impactCount: evidence.impactCount
      };
    });
    stateCache.mode = organizer.previousMode || "idle";
    stateCache.paused = organizer.previousPaused !== false;
  } catch (error) {
    stateCache.topicRollback = snapshot;
    organizer.status = "error";
    stateCache.mode = organizer.previousMode || "idle";
    stateCache.lastError = isAbort(error)
      ? "主題套用已停止；可重新按套用安全續跑，或回復上一次。"
      : `主題套用遇到錯誤：${S.truncateMessage(error.message || "未知錯誤")}。可重新按套用安全續跑，或回復上一次。`;
    throw error;
  } finally {
    if (activeAbortController === controller) activeAbortController = null;
    stateCache.running = false;
    stateCache.stopRequested = false;
    await persistState();
  }
  return topicOrganizerForUi();
}

async function resolveOrganizerUnclassified(candidateName, action, replacementTopic = "", customTopic = "") {
  const organizer = stateCache.topicOrganizer;
  if (!organizer?.pages || stateCache.running) {
    throw new AppError(stateCache.running ? "目前正在處理其他工作" : "請先產生主題整理建議", { code: "BUSY" });
  }
  const candidate = (organizer.unclassified ?? [])
    .find(name => N.topicKey(name) === N.topicKey(candidateName));
  if (!candidate) throw new AppError("找不到要人工處理的暫存主題", { code: "MANUAL_TOPIC_MISSING" });
  if (action === "skip") {
    organizer.manualSkipped = uniqueTopicNames([...(organizer.manualSkipped ?? []), candidate]);
    organizer.status = "review";
    await persistState();
    return topicOrganizerForUi();
  }

  const { config, token } = await readyNotion();
  let options = validTopicOptions(await readTopicOptions(config, token));
  const byKey = new Map(options.map(option => [N.topicKey(option.name), option.name]));
  let selectedTopic = "";
  if (action === "approve") {
    if (!G.isOrganizerTopicLabel(candidate)) {
      throw new AppError("建立的新正式主題必須為 2～6 字，請改用自訂名稱", { code: "MANUAL_TOPIC_INVALID" });
    }
    selectedTopic = byKey.get(N.topicKey(candidate)) || candidate;
  } else if (action === "replace") {
    selectedTopic = byKey.get(N.topicKey(replacementTopic)) || "";
    if (!selectedTopic) {
      throw new AppError("請從目前的 Notion 既有主題中選擇對應項目", { code: "MANUAL_REPLACEMENT_INVALID" });
    }
  } else if (action === "custom") {
    const custom = S.cleanText(customTopic);
    if (!G.isOrganizerTopicLabel(custom)) {
      throw new AppError("自訂正式主題必須為 2～6 字，並優先使用 2～4 字", { code: "MANUAL_CUSTOM_INVALID" });
    }
    selectedTopic = byKey.get(N.topicKey(custom)) || custom;
  } else if (action !== "discard") {
    throw new AppError("未知的人工主題處理方式", { code: "MANUAL_TOPIC_ACTION_INVALID" });
  }

  if (selectedTopic && !byKey.has(N.topicKey(selectedTopic))) {
    await notionRequest(`/v1/data_sources/${config.dataSourceId}`, {
      method: "PATCH",
      body: N.topicOptionsUpdatePayload(options, [selectedTopic]),
      retrySafe: true,
      token
    });
    options = validTopicOptions(await readTopicOptions(config, token));
  }

  const candidateKey = N.topicKey(candidate);
  const affectedPages = (organizer.pages ?? []).filter(page =>
    (page.provisionalTopics ?? []).some(name => N.topicKey(name) === candidateKey)
  );
  const snapshot = {
    type: "manual",
    appliedAt: new Date().toISOString(),
    pages: [],
    dictionary: config.topicDictionary,
    discardedTopicNames: config.discardedTopicNames,
    groupsBefore: [],
    unclassifiedBefore: clone(organizer.unclassified ?? []),
    manualSkippedBefore: clone(organizer.manualSkipped ?? []),
    appliedCandidateCountBefore: Number(organizer.appliedCandidateCount) || 0,
    incomplete: true,
    operationKey: JSON.stringify(["manual", candidate, action, selectedTopic])
  };

  stateCache.running = true;
  stateCache.mode = "topic_apply";
  organizer.status = "applying";
  organizer.progress = { done: 0, total: affectedPages.length };
  await persistState();
  try {
    for (let index = 0; index < affectedPages.length; index += 1) {
      const cachedPage = affectedPages[index];
      const currentPage = await notionRequest(`/v1/pages/${cachedPage.id}`, { token });
      const current = N.topicOrganizerPageValues(currentPage);
      if (!(current.provisionalTopics ?? []).some(name => N.topicKey(name) === candidateKey)) {
        organizer.progress.done = index + 1;
        continue;
      }
      const unresolved = (current.provisionalTopics ?? [])
        .filter(name => N.topicKey(name) !== candidateKey);
      const additions = selectedTopic && !(current.aiTopics ?? []).some(name => N.topicKey(name) === N.topicKey(selectedTopic))
        ? [selectedTopic]
        : [];
      const finalTopics = uniqueTopicNames([...(current.aiTopics ?? []), ...additions]);
      const status = unresolved.length ? N.STATUS.topicReview : N.STATUS.analyzed;
      snapshot.pages.push({
        id: cachedPage.id,
        addedTopics: additions,
        provisionalBefore: current.provisionalTopics ?? [],
        provisionalAfter: unresolved,
        statusBefore: current.status,
        statusAfter: status
      });
      await notionRequest(`/v1/pages/${cachedPage.id}`, {
        method: "PATCH",
        body: N.topicApplyPayload(finalTopics, status, options, unresolved),
        retrySafe: true,
        token
      });
      cachedPage.provisionalTopics = unresolved;
      cachedPage.aiTopics = finalTopics;
      cachedPage.status = status;
      organizer.progress.done = index + 1;
      stateCache.topicRollback = snapshot;
      await persistState();
    }

    if (selectedTopic) {
      config.topicDictionary = mergeDictionaryEntries(config.topicDictionary, [{
        name: selectedTopic,
        definition: "由未分類主題的人工確認建立的對照。",
        aliases: [candidate],
        color: N.topicColor(selectedTopic),
        active: true
      }]);
    } else {
      config.discardedTopicNames = normalizeDiscardedTopicNames([
        ...(config.discardedTopicNames ?? []),
        candidate
      ]);
    }
    await writeConfig(config);
    snapshot.incomplete = false;
    stateCache.topicRollback = snapshot;
    organizer.unclassified = (organizer.unclassified ?? [])
      .filter(name => N.topicKey(name) !== candidateKey);
    organizer.manualSkipped = (organizer.manualSkipped ?? [])
      .filter(name => N.topicKey(name) !== candidateKey);
    organizer.existingTopics = uniqueTopicNames([...(organizer.existingTopics ?? []), selectedTopic].filter(Boolean));
    organizer.appliedCandidateCount = (Number(organizer.appliedCandidateCount) || 0) + 1;
    organizer.status = "applied";
    organizer.progress = { done: affectedPages.length, total: affectedPages.length };
    stateCache.mode = "idle";
    stateCache.lastError = "";
  } catch (error) {
    stateCache.topicRollback = snapshot;
    organizer.status = "error";
    stateCache.mode = "idle";
    throw error;
  } finally {
    stateCache.running = false;
    await persistState();
  }
  return topicOrganizerForUi();
}

async function rollbackTopicOrganizer() {
  if (stateCache.running) throw new AppError("請先停止目前的主題套用", { code: "BUSY" });
  const snapshot = stateCache.topicRollback;
  if (!snapshot?.pages?.length) throw new AppError("目前沒有可回復的上一次套用紀錄", { code: "NO_ROLLBACK" });
  const { config, token } = await readyNotion();
  const options = validTopicOptions(await readTopicOptions(config, token));
  for (const page of snapshot.pages) {
    const currentPage = await notionRequest(`/v1/pages/${page.id}`, { token });
    const current = N.topicOrganizerPageValues(currentPage);
    const removeKeys = new Set((page.addedTopics ?? []).map(N.topicKey));
    const topics = (current.aiTopics ?? []).filter(name => !removeKeys.has(N.topicKey(name)));
    const status = current.status === page.statusAfter ? page.statusBefore : current.status;
    const currentProvisionalKeys = (current.provisionalTopics ?? []).map(N.topicKey);
    const expectedProvisionalKeys = (page.provisionalAfter ?? []).map(N.topicKey);
    const restoreProvisional = currentProvisionalKeys.length === expectedProvisionalKeys.length
      && currentProvisionalKeys.every((key, index) => key === expectedProvisionalKeys[index])
      ? page.provisionalBefore ?? []
      : null;
    if (topics.length !== (current.aiTopics ?? []).length || status !== current.status || restoreProvisional) {
      await notionRequest(`/v1/pages/${page.id}`, {
        method: "PATCH",
        body: N.topicApplyPayload(topics, status || N.STATUS.topicReview, options, restoreProvisional),
        retrySafe: true,
        token
      });
    }
    const cachedPage = stateCache.topicOrganizer?.pages?.find(item => item.id === page.id);
    if (cachedPage) {
      cachedPage.aiTopics = topics;
      cachedPage.status = status || N.STATUS.topicReview;
      cachedPage.provisionalTopics = Array.isArray(restoreProvisional)
        ? restoreProvisional
        : current.provisionalTopics ?? [];
    }
  }
  config.topicDictionary = normalizeTopicDictionary(snapshot.dictionary);
  config.discardedTopicNames = normalizeDiscardedTopicNames(snapshot.discardedTopicNames);
  await writeConfig(config);
  if (stateCache.topicOrganizer) {
    const beforeById = new Map((snapshot.groupsBefore ?? []).map(group => [group.id, group]));
    stateCache.topicOrganizer.groups = (stateCache.topicOrganizer.groups ?? []).map(group =>
      beforeById.has(group.id) ? clone(beforeById.get(group.id)) : group
    );
    stateCache.topicOrganizer.appliedCandidateCount = Number(snapshot.appliedCandidateCountBefore) || 0;
    stateCache.topicOrganizer.unclassified = clone(snapshot.unclassifiedBefore ?? stateCache.topicOrganizer.unclassified ?? []);
    stateCache.topicOrganizer.manualSkipped = clone(snapshot.manualSkippedBefore ?? stateCache.topicOrganizer.manualSkipped ?? []);
  }
  stateCache.topicRollback = null;
  if (stateCache.topicOrganizer) stateCache.topicOrganizer.status = "rolled_back";
  await persistState();
  return topicOrganizerForUi();
}

function dictionaryExport(config) {
  return {
    format: "notion-ai-analyzer-topic-dictionary",
    version: 1,
    exportedAt: new Date().toISOString(),
    topics: normalizeTopicDictionary(config.topicDictionary)
  };
}

function previewDictionaryImport(value, config) {
  if (value?.format !== "notion-ai-analyzer-topic-dictionary" || !Array.isArray(value?.topics)) {
    throw new AppError("這不是有效的主題字典檔案", { code: "DICTIONARY_INVALID" });
  }
  const incoming = normalizeTopicDictionary(value.topics);
  const existing = new Map(normalizeTopicDictionary(config.topicDictionary).map(item => [N.topicKey(item.name), item]));
  const existingAliases = new Map();
  for (const item of existing.values()) {
    existingAliases.set(N.topicKey(item.name), item.name);
    for (const alias of item.aliases ?? []) existingAliases.set(N.topicKey(alias), item.name);
  }
  const conflicts = [];
  for (const item of incoming) {
    for (const alias of [item.name, ...(item.aliases ?? [])]) {
      const oldTarget = existingAliases.get(N.topicKey(alias));
      if (oldTarget && N.topicKey(oldTarget) !== N.topicKey(item.name)) {
        conflicts.push({ alias, existing: oldTarget, incoming: item.name });
      }
    }
  }
  return {
    incoming,
    conflicts,
    conflictCount: conflicts.length,
    newCount: incoming.filter(item => !existing.has(N.topicKey(item.name))).length,
    updateCount: incoming.filter(item => existing.has(N.topicKey(item.name))
      && JSON.stringify(existing.get(N.topicKey(item.name))) !== JSON.stringify(item)).length,
    unchangedCount: incoming.filter(item => JSON.stringify(existing.get(N.topicKey(item.name))) === JSON.stringify(item)).length
  };
}

async function scanPending() {
  if (stateCache.mode === "batch" && !stateCache.paused
    && Boolean(stateCache.running || stateCache.current || stateCache.queue.length)) {
    throw new AppError("批次分析正在執行中。請先按「停止分析」，再重新掃描資料庫。", {
      code: "BATCH_RUNNING"
    });
  }
  await setStage("掃描 Notion", { progress: 0 });
  let config;
  let token;
  try {
    ({ config, token } = await readyNotion());
  } catch (error) {
    stateCache.stage = null;
    await persistState();
    throw error;
  }
  let pendingFound = 0;
  let failedFound = 0;
  const onProgress = async (count, status) => {
    if (status === N.STATUS.pending) pendingFound = count;
    if (status === N.STATUS.failed) failedFound = count;
    await setStage("掃描 Notion", {
      progress: pendingFound + failedFound,
      detail: `待分析 ${pendingFound}、分析失敗 ${failedFound}`
    });
  };
  const [pages, remoteFailed] = await withAbortTimeout(
    signal => Promise.all([
      queryPagesByStatus(config.dataSourceId, N.STATUS.pending, token, { signal, onProgress }),
      queryPagesByStatus(config.dataSourceId, N.STATUS.failed, token, { signal, onProgress })
    ]),
    null,
    90000,
    "SCAN_TIMEOUT",
    "掃描 Notion 超過 90 秒，請檢查網路或稍後重試"
  ).catch(async error => {
    stateCache.stage = null;
    await persistState();
    throw error;
  });
  const localFailures = new Map(stateCache.failed.map(item => [item.id, item]));
  stateCache.failed = remoteFailed.map(item => {
    const local = localFailures.get(item.id);
    return {
      ...item,
      ...(local ?? {}),
      error: local?.error || "Notion 中標記為分析失敗；擴充功能本機沒有保留原始錯誤紀錄。",
      failedAt: local?.failedAt || item.lastEditedTime || new Date().toISOString(),
      sourceStatus: N.STATUS.failed
    };
  }).slice(0, MAX_RECENT);
  const failedIds = new Set(stateCache.failed.map(item => item.id));
  stateCache.recent = [
    ...stateCache.failed.map(item => ({ ...item, outcome: "failed" })),
    ...stateCache.recent.filter(item => !failedIds.has(item.id))
  ].slice(0, MAX_RECENT);
  stateCache.knownPending = pages.length;
  stateCache.lastScanAt = new Date().toISOString();
  stateCache.pendingScan = {
    dataSourceId: config.dataSourceId,
    pages,
    scannedAt: stateCache.lastScanAt
  };
  const pausedBatch = stateCache.paused
    && stateCache.queue.length > 0
    && ["batch", "paused"].includes(stateCache.mode);
  if (pausedBatch) {
    stateCache.queue = uniqueItems(pages);
  } else if (!stateCache.running && !stateCache.current) {
    stateCache.queue = [];
    if (["batch", "paused"].includes(stateCache.mode)) stateCache.mode = "idle";
  }
  const noPending = pages.length === 0;
  stateCache.databaseCheck = {
    checkedAt: stateCache.lastScanAt,
    code: noPending ? "NO_PENDING_PAGES" : "READY",
    message: noPending ? N.DATABASE_SETUP_MESSAGES.noPendingPages : "",
    ready: true
  };
  stateCache.lastError = noPending ? N.DATABASE_SETUP_MESSAGES.noPendingPages : "";
  stateCache.stage = null;
  await persistState();
  return pages;
}

async function readPageRecords(pageId, token, signal) {
  const records = [];
  let blockCount = 0;
  const nonRecursive = new Set(["child_page", "child_database", "image", "video", "audio", "file", "pdf"]);

  async function walk(parentId, depth) {
    if (depth > 25) throw new AppError("Notion 頁面巢狀層級過深，已停止以避免讀取異常", { code: "BLOCK_DEPTH" });
    let cursor = "";
    do {
      const query = new URLSearchParams({ page_size: "100" });
      if (cursor) query.set("start_cursor", cursor);
      const response = await notionRequest(`/v1/blocks/${parentId}/children?${query}`, {
        signal,
        token
      });
      for (const block of response.results ?? []) {
        blockCount += 1;
        if (blockCount > MAX_BLOCKS) {
          throw new AppError(`頁面超過 ${MAX_BLOCKS} 個區塊，為避免失控已停止`, { code: "TOO_MANY_BLOCKS" });
        }
        records.push(N.blockToRecord(block, depth));
        if (block.has_children && !nonRecursive.has(block.type)) await walk(block.id, depth + 1);
      }
      cursor = response.has_more ? response.next_cursor || "" : "";
    } while (cursor);
  }

  await walk(pageId, 0);
  return records;
}

async function generateAndValidate(
  sourcePrompt,
  provider,
  model,
  apiKey,
  signal,
  topicNames = [],
  allowTopicProposals = true,
  excludedPersonTerms = [],
  analysisOptions = {}
) {
  let raw = "";
  let errors = [];
  let firstResponse = null;
  const diagnostic = { attempts: [], model, provider };
  try {
    firstResponse = await timedAiRequest(
      provider,
      model,
      G.buildAnalysisRequest(sourcePrompt, model, analysisOptions),
      { apiKey, signal, timeoutMinutes: analysisOptions.requestTimeoutMinutes }
    );
    await setStage("驗證輸出", { model, provider });
    const parsed = G.parseJsonCandidate(firstResponse);
    raw = parsed.raw;
    diagnostic.attempts.push({ attempt: 1, ...G.responseDiagnostic(firstResponse, raw) });
    const checked = G.validateAnalysis(
      parsed.value,
      topicNames,
      allowTopicProposals,
      excludedPersonTerms,
      analysisOptions.outputSpec
    );
    if (checked.ok) return checked.value;
    errors = checked.errors;
  } catch (error) {
    if (error instanceof AppError || error?.name === "AbortError") throw error;
    raw = error.rawOutput || "";
    errors = [error.message || "輸出無法解析"];
    if (firstResponse && !diagnostic.attempts.length) {
      diagnostic.attempts.push({ attempt: 1, ...G.responseDiagnostic(firstResponse, raw) });
    }
    if (error?.nonRetryable || !raw) {
      throw new AppError(error.message || "AI 沒有回傳可修正的結果", {
        code: error?.blockReason ? "CONTENT_BLOCKED" : "OUTPUT_EMPTY",
        diagnostic
      });
    }
  }

  let repairResponse;
  try {
    repairResponse = await timedAiRequest(
      provider,
      model,
      G.buildRepairRequest(raw, errors, model, analysisOptions),
      { apiKey, signal, timeoutMinutes: analysisOptions.requestTimeoutMinutes }
    );
  } catch (error) {
    if (error instanceof AppError && !error.diagnostic) error.diagnostic = diagnostic;
    throw error;
  }
  let parsedRepair;
  try {
    parsedRepair = G.parseJsonCandidate(repairResponse);
    diagnostic.attempts.push({ attempt: 2, ...G.responseDiagnostic(repairResponse, parsedRepair.raw) });
  } catch (error) {
    diagnostic.attempts.push({
      attempt: 2,
      ...G.responseDiagnostic(repairResponse, error.rawOutput || "")
    });
    throw new AppError(`AI 修正輸出仍無法解析：${error.message}`, {
      code: "OUTPUT_INVALID",
      diagnostic
    });
  }
  const checkedRepair = G.validateAnalysis(
    parsedRepair.value,
    topicNames,
    allowTopicProposals,
    excludedPersonTerms,
    analysisOptions.outputSpec
  );
  if (!checkedRepair.ok) {
    throw new AppError(`AI 修正輸出仍未符合規則：${checkedRepair.errors.join("；")}`, {
      code: "OUTPUT_INVALID",
      diagnostic: { ...diagnostic, validationErrors: checkedRepair.errors }
    });
  }
  return checkedRepair.value;
}

async function extractChunkNote(chunk, index, total, provider, model, apiKey, signal, requestTimeoutMinutes) {
  let payload = G.buildChunkRequest(chunk, index, total, model);
  let lastError = null;
  const diagnostic = { attempts: [], chunk: index, model, provider };
  for (let attempt = 0; attempt < 2; attempt += 1) {
    let response = null;
    try {
      response = await timedAiRequest(provider, model, payload, { apiKey, signal, timeoutMinutes: requestTimeoutMinutes });
      await setStage("驗證輸出", { model, provider });
      const parsed = G.parseJsonCandidate(response);
      diagnostic.attempts.push({ attempt: attempt + 1, ...G.responseDiagnostic(response, parsed.raw) });
      const checked = G.validateChunkNotes(parsed.value);
      if (checked.ok) return checked.value;
      lastError = new Error(checked.errors.join("；"));
      payload = G.buildChunkRepairRequest(parsed.raw, checked.errors, model);
    } catch (error) {
      if (error instanceof AppError || error?.name === "AbortError") {
        if (error instanceof AppError && !error.diagnostic && diagnostic.attempts.length) {
          error.diagnostic = diagnostic;
        }
        throw error;
      }
      lastError = error;
      if (response) {
        diagnostic.attempts.push({
          attempt: attempt + 1,
          ...G.responseDiagnostic(response, error.rawOutput || "")
        });
      }
      if (error?.nonRetryable || !error?.rawOutput) break;
      payload = G.buildChunkRepairRequest(error.rawOutput, [error.message || "輸出無法解析"], model);
    }
  }
  throw new AppError(`第 ${index} 段的 AI 筆記無法解析：${lastError?.message || "未知錯誤"}`, {
    code: "CHUNK_OUTPUT_INVALID",
    diagnostic
  });
}

async function analyzeArticle(articleText, config, signal) {
  const { apiKey, model, provider } = await activeAiContext(config);
  const excludedPersonTerms = normalizeExcludedPersonTerms(config.excludedPersonTerms);
  const analysisOptions = {
    customPrompt: config.analysisPromptCustomized ? config.analysisPrompt : "",
    outputSpec: P.normalizeOutputSpec(config.outputSpec),
    requestTimeoutMinutes: Number(config.requestTimeoutMinutes) || 0
  };
  const usesOpenRouterFreeRouter = provider === "openrouter" && model === "openrouter/free";
  const directTextLimit = usesOpenRouterFreeRouter
    ? 150000
    : provider === "openrouter" ? 24000 : G.DIRECT_TEXT_LIMIT;
  const chunkTextLimit = usesOpenRouterFreeRouter
    ? 70000
    : provider === "openrouter" ? 18000 : G.CHUNK_TEXT_LIMIT;
  if (articleText.length <= directTextLimit) {
    return generateAndValidate(
      P.buildArticlePrompt(articleText, [], true, excludedPersonTerms),
      provider,
      model,
      apiKey,
      signal,
      [],
      true,
      excludedPersonTerms,
      analysisOptions
    );
  }

  const chunks = S.chunkText(articleText, chunkTextLimit);
  const notes = [];
  for (let index = 0; index < chunks.length; index += 1) {
    notes.push(await extractChunkNote(
      chunks[index], index + 1, chunks.length, provider, model, apiKey, signal,
      analysisOptions.requestTimeoutMinutes
    ));
  }
  const notesPrompt = P.buildNotesPrompt(
    G.formatChunkNotes(notes),
    [],
    true,
    excludedPersonTerms
  );
  return generateAndValidate(
    notesPrompt,
    provider,
    model,
    apiKey,
    signal,
    [],
    true,
    excludedPersonTerms,
    analysisOptions
  );
}

function uniqueItems(items) {
  const seen = new Set();
  return (items ?? []).filter(item => {
    if (!item?.id || seen.has(item.id)) return false;
    seen.add(item.id);
    return true;
  });
}

function publicTopicReview(review) {
  if (!review) return null;
  const normalized = normalizeTopicReview(review);
  const candidate = normalized.remainingCandidates[0] ?? {};
  const selectedTopics = uniqueTopicNames([
    ...normalized.originalFinalTopics,
    ...normalized.selectedExistingTopics,
    ...normalized.approvedNewTopics,
    ...(normalized.decisions ?? []).map(decision => decision?.selectedTopic).filter(Boolean)
  ]);
  const completedCount = Math.max(0, normalized.candidateTotal - normalized.remainingCandidates.length);
  return {
    canDiscard: true,
    candidate: candidate.name || "",
    candidatePosition: completedCount + 1,
    candidateTotal: normalized.candidateTotal,
    closestExisting: candidate.closest_existing ?? [],
    existingTopics: selectedTopics,
    item: normalized.item ?? null,
    reason: candidate.reason || "",
    requestedAt: normalized.requestedAt || "",
    topicOptions: normalized.topicOptions ?? [],
    rememberMapping: normalized.rememberMapping !== false
  };
}

function decrementKnownPending(item) {
  if (Array.isArray(stateCache.pendingScan?.pages)) {
    stateCache.pendingScan.pages = stateCache.pendingScan.pages.filter(page => page.id !== item?.id);
  }
  if (item?.sourceStatus === N.STATUS.pending && Number.isFinite(stateCache.knownPending)) {
    stateCache.knownPending = Math.max(0, stateCache.knownPending - 1);
  }
}

function recordSuccess(item, extra = {}) {
  stateCache.failed = stateCache.failed.filter(entry => entry.id !== item.id);
  stateCache.recent = [{
    ...item,
    analyzedAt: new Date().toISOString(),
    outcome: "success",
    ...extra
  }, ...stateCache.recent.filter(entry => entry.id !== item.id)].slice(0, MAX_RECENT);
}

function publicStatus() {
  return {
    current: stateCache.current,
    databaseCheck: stateCache.databaseCheck,
    failed: stateCache.failed,
    knownPending: stateCache.knownPending,
    lastError: stateCache.lastError,
    lastScanAt: stateCache.lastScanAt,
    mode: stateCache.mode,
    paused: stateCache.paused,
    queueCount: stateCache.queue.length,
    recent: stateCache.recent,
    running: stateCache.running,
    stage: stateCache.stage,
    topicOrganizer: topicOrganizerForUi(),
    topicReview: publicTopicReview(stateCache.topicReview)
  };
}

function scheduleProcessing(delay = 200) {
  chrome.alarms.create(PROCESS_ALARM, { when: Date.now() + Math.max(50, delay) });
  setTimeout(() => { void processOne(); }, Math.max(25, Math.min(delay, 500)));
}

function isAbort(error) {
  return error?.name === "AbortError" || error?.code === "ABORTED";
}

async function resetPageToPending(item, token) {
  if (!token) return;
  try {
    await notionRequest(`/v1/pages/${item.id}`, {
      method: "PATCH",
      body: N.statusUpdatePayload(N.STATUS.pending),
      retrySafe: true,
      token
    });
  } catch (cleanupError) {
    stateCache.lastError = `${stateCache.lastError || "處理已停止"}；但無法把 Notion 狀態改回待分析：${cleanupError.message}`;
  }
}

async function requeueAndPause(item, message, token, { resetPage } = {}) {
  stateCache.queue = uniqueItems([item, ...stateCache.queue]);
  stateCache.paused = true;
  stateCache.lastError = message;
  if (resetPage) await resetPageToPending(item, token);
}

async function recordFailure(item, error, token) {
  let statusError = "";
  if (token) {
    try {
      await notionRequest(`/v1/pages/${item.id}`, {
        method: "PATCH",
        body: N.statusUpdatePayload(N.STATUS.failed),
        retrySafe: true,
        token
      });
    } catch (failureStatusError) {
      statusError = `；且無法寫入分析失敗狀態：${failureStatusError.message}`;
    }
  } else {
    statusError = "；且目前沒有 Notion Token，無法寫入分析失敗狀態";
  }
  const failure = {
    ...item,
    code: error.code || "APP_ERROR",
    diagnostic: error.diagnostic || null,
    error: `${S.truncateMessage(error.message || "未知錯誤")}${statusError}`,
    failedAt: new Date().toISOString()
  };
  stateCache.failed = [failure, ...stateCache.failed.filter(entry => entry.id !== item.id)].slice(0, MAX_RECENT);
  stateCache.recent = [{ ...failure, outcome: "failed" }, ...stateCache.recent.filter(entry => entry.id !== item.id)].slice(0, MAX_RECENT);
  stateCache.lastError = failure.error;
  decrementKnownPending(item);
}

async function processItem(item) {
  let token = "";
  const controller = new AbortController();
  activeAbortController = controller;
  stateCache.current = item;
  stateCache.running = true;
  stateCache.lastError = "";
  await persistState();

  try {
    let config = await readConfig();
    token = await requireNotionToken();
    if (!config.dataSourceId || preparedDataSourceId !== compactNotionId(config.dataSourceId)) {
      const ready = await ensureSchema(config, token);
      config = ready.config;
      preparedDataSourceId = compactNotionId(config.dataSourceId);
    }
    const expectedSourceId = compactNotionId(config.dataSourceId);
    const queuedSourceId = compactNotionId(item.sourceDataSourceId);
    if (queuedSourceId && queuedSourceId !== expectedSourceId) {
      throw new AppError("本機佇列屬於先前設定的 Notion 資料庫", {
        code: "QUEUE_SOURCE_MISMATCH"
      });
    }
    if (!queuedSourceId) {
      const page = await notionRequest(`/v1/pages/${item.id}`, {
        signal: controller.signal,
        token
      });
      if (!pageBelongsToConfiguredSource(page, config)) {
        throw new AppError("本機佇列中的頁面不屬於目前設定的 Notion 資料庫", {
          code: "QUEUE_SOURCE_MISMATCH"
        });
      }
      item.sourceDataSourceId = config.dataSourceId;
      stateCache.current = item;
      await persistState();
    }
    await setStage("準備頁面", { pageId: item.id });
    await notionRequest(`/v1/pages/${item.id}`, {
      method: "PATCH",
      body: N.statusUpdatePayload(N.STATUS.processing),
      signal: controller.signal,
      token
    });
    if (stateCache.stopRequested) throw new DOMException("已停止", "AbortError");

    await setStage("讀取頁面", { pageId: item.id });
    const records = await withAbortTimeout(
      signal => readPageRecords(item.id, token, signal),
      controller.signal,
      90000,
      "PAGE_READ_TIMEOUT",
      "讀取單一 Notion 頁面超過 90 秒，已停止"
    );
    const articleText = N.buildArticleText(records);
    if (!articleText) {
      throw new AppError("頁面沒有可供分析的純文字內容", { code: "EMPTY_ARTICLE" });
    }
    if (stateCache.stopRequested) throw new DOMException("已停止", "AbortError");

    await setStage("準備 AI", { pageId: item.id });
    const result = await analyzeArticle(articleText, config, controller.signal);
    if (stateCache.stopRequested) throw new DOMException("已停止", "AbortError");

    await setStage("寫回 Notion", { pageId: item.id });
    const isSingleReview = stateCache.mode === "single_review";
    const draftStatus = isSingleReview ? N.STATUS.topicReview : N.STATUS.topicOrganize;
    const singleTopicOptions = isSingleReview
      ? validTopicOptions(await readTopicOptions(config, token, controller.signal))
      : [];
    await notionWriteWithTimeout(`/v1/pages/${item.id}`, {
      method: "PATCH",
      body: N.analysisDraftPayload(result, draftStatus, isSingleReview),
      token
    }, controller.signal);

    if (isSingleReview) {
      stateCache.topicReview = normalizeTopicReview({
        version: 2,
        item,
        result,
        requestedAt: new Date().toISOString(),
        candidateTotal: result.ai_topics.length,
        remainingCandidates: result.ai_topics.map(name => ({ name, reason: "", closest_existing: [] })),
        topicOptions: singleTopicOptions,
        originalFinalTopics: [],
        selectedExistingTopics: [],
        approvedNewTopics: [],
        decisions: [],
        skippedCandidates: [],
        previousMode: "single_review"
      });
      stateCache.paused = true;
      recordSuccess(item, { provisionalTopics: result.ai_topics, status: N.STATUS.topicReview });
    } else {
      recordSuccess(item, { provisionalTopics: result.ai_topics, status: N.STATUS.topicOrganize });
    }

    decrementKnownPending(item);
  } catch (error) {
    if (isAbort(error) || stateCache.stopRequested) {
      await requeueAndPause(item, "已停止；目前文章已放回待分析佇列。", token, { resetPage: true });
    } else if (error.code === "QUEUE_SOURCE_MISMATCH") {
      stateCache.queue = [];
      stateCache.failed = [];
      stateCache.knownPending = null;
      stateCache.pendingScan = null;
      stateCache.paused = true;
      stateCache.mode = "paused";
      stateCache.lastError = "已攔截先前資料庫留下的本機佇列，沒有寫入任何頁面。請按「掃描資料庫」後再開始分析。";
    } else if (REQUEUE_TIMEOUT_CODES.has(error.code)) {
      await requeueAndPause(
        item,
        `${S.truncateMessage(error.message)}。文章已放回待分析；請自行決定重試或更換模型。`,
        token,
        { resetPage: true }
      );
    } else if (RATE_LIMIT_CODES.has(error.code)) {
      const wait = error.retryAfter ? `，建議 ${error.retryAfter} 秒後再繼續` : "，請稍後再繼續";
      await requeueAndPause(
        item,
        `API 已達速率或額度限制${wait}：${S.truncateMessage(error.message)}`,
        token,
        { resetPage: true }
      );
    } else if (SETUP_ERROR_CODES.has(error.code)) {
      await requeueAndPause(
        item,
        `設定或授權需要修正，佇列已暫停：${S.truncateMessage(error.message)}`,
        token,
        { resetPage: !["NOTION_AUTH", "NOTION_TOKEN_MISSING"].includes(error.code) }
      );
    } else if (error.code === "OPENROUTER_MODEL_INCOMPATIBLE") {
      await requeueAndPause(
        item,
        `OpenRouter 模型不相容，佇列已暫停：${S.truncateMessage(error.message)}`,
        token,
        { resetPage: true }
      );
    } else {
      await recordFailure(item, error, token);
    }
  } finally {
    if (activeAbortController === controller) activeAbortController = null;
    stateCache.current = null;
    stateCache.running = false;
    stateCache.stopRequested = false;
    stateCache.stage = null;
    if (["single_batch", "single_review"].includes(stateCache.mode)) stateCache.paused = true;
    if (!stateCache.queue.length && !stateCache.running) stateCache.mode = stateCache.paused ? stateCache.mode : "idle";
    await persistState();
  }
}

async function processOne() {
  await initialize();
  if (processingPromise) return processingPromise;
  processingPromise = (async () => {
    if (stateCache.topicReview || stateCache.paused || stateCache.running || !stateCache.queue.length) return;
    const item = stateCache.queue.shift();
    try {
      await persistState();
      await processItem(item);
    } catch (error) {
      stateCache.queue = uniqueItems([item, ...stateCache.queue]);
      stateCache.current = null;
      stateCache.running = false;
      stateCache.paused = true;
      stateCache.lastError = `背景處理意外中斷，文章已放回佇列：${S.truncateMessage(error?.message || "未知錯誤")}`;
      await persistState();
    }
    if (!stateCache.paused && stateCache.queue.length) scheduleProcessing(250);
  })().finally(() => {
    processingPromise = null;
  });
  return processingPromise;
}

function resolveNotionTarget(settings, current) {
  const notionTarget = String(settings.notionTarget ?? current.notionTarget).trim();
  if (notionTarget && !S.extractNotionId(notionTarget)) {
    throw new AppError("Notion 資料庫網址或 Data Source ID 格式不正確", { code: "NOTION_TARGET_INVALID" });
  }
  return notionTarget;
}

function resolveProviderSelection(settings, current) {
  const aiProvider = normalizeAiProvider(settings.aiProvider ?? current.aiProvider);
  const geminiModel = S.normalizeModelName(settings.geminiModel ?? current.geminiModel) || G.DEFAULT_MODEL;
  const openRouterModel = String(settings.openRouterModel ?? current.openRouterModel ?? "openrouter/free").trim();
  if (!/^[a-z0-9_.:-]+\/[a-z0-9_.:@/-]+$/i.test(openRouterModel)) {
    throw new AppError("OpenRouter 模型名稱格式不正確", { code: "MODEL_INVALID" });
  }
  const knownFreeOpenRouterModels = new Set([
    "openrouter/free",
    ...(Array.isArray(current.openRouterFreeModelIds) ? current.openRouterFreeModelIds : [])
  ]);
  const openRouterModelIsFree = knownFreeOpenRouterModels.has(openRouterModel)
    || openRouterModel.endsWith(":free");
  if (aiProvider === "openrouter" && !openRouterModelIsFree
    && settings.openRouterPaidConfirmed !== true
    && current.openRouterPaidConfirmedModel !== openRouterModel) {
    throw new AppError("這是 OpenRouter 付費模型。請勾選費用確認後再儲存", {
      code: "OPENROUTER_PAID_CONFIRMATION_REQUIRED"
    });
  }
  const vertexModel = S.normalizeModelName(settings.vertexModel ?? current.vertexModel) || "gemini-3.5-flash-lite";
  return {
    aiProvider,
    geminiModel,
    knownFreeOpenRouterModels,
    openRouterModel,
    openRouterModelIsFree,
    vertexModel
  };
}

function resolvePromptSettings(settings, current) {
  const outputSpec = P.normalizeOutputSpec(settings.outputSpec ?? current.outputSpec);
  const analysisPrompt = settings.analysisPrompt === undefined
    ? S.cleanText(current.analysisPrompt)
    : String(settings.analysisPrompt ?? "").trim().slice(0, 30000);
  const analysisPromptCustomized = settings.analysisPromptCustomized === undefined
    ? Boolean(current.analysisPromptCustomized)
    : Boolean(settings.analysisPromptCustomized) && Boolean(analysisPrompt);
  const timeoutValue = Number(settings.requestTimeoutMinutes ?? current.requestTimeoutMinutes);
  const requestTimeoutMinutes = [0, 3, 5, 10].includes(timeoutValue) ? timeoutValue : 5;
  return { analysisPrompt, analysisPromptCustomized, outputSpec, requestTimeoutMinutes };
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
    notionTarget,
    geminiModel: provider.geminiModel,
    openRouterModel: provider.openRouterModel,
    openRouterFreeModelIds: [...provider.knownFreeOpenRouterModels].slice(0, 500),
    openRouterPaidConfirmedModel: provider.openRouterModelIsFree ? "" : provider.openRouterModel,
    vertexModel: provider.vertexModel,
    rememberGeminiKey: Boolean(settings.rememberGeminiKey),
    rememberOpenRouterKey: Boolean(settings.rememberOpenRouterKey),
    rememberVertexKey: Boolean(settings.rememberVertexKey),
    rememberNotionToken: Boolean(settings.rememberNotionToken),
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
  const { aiProvider, geminiModel, openRouterModel, openRouterModelIsFree, vertexModel } = provider;
  const { hasGeminiKey, hasNotionToken, hasOpenRouterKey, hasVertexKey } = secrets;
  return {
    ...next,
    preferExistingTopics,
    activeModel: aiProvider === "vertex" ? vertexModel : aiProvider === "openrouter" ? openRouterModel : geminiModel,
    hasAiKey: aiProvider === "vertex" ? hasVertexKey : aiProvider === "openrouter" ? hasOpenRouterKey : hasGeminiKey,
    hasGeminiKey,
    hasNotionToken,
    hasOpenRouterKey,
    openRouterPaidConfirmed: !openRouterModelIsFree,
    hasVertexKey,
    databaseChanged: targetChanged,
    clearedQueueCount
  };
}

async function saveSettings(settings) {
  const current = await readConfig();
  const notionTarget = resolveNotionTarget(settings, current);
  const provider = resolveProviderSelection(settings, current);
  const promptSettings = resolvePromptSettings(settings, current);
  const currentTargetId = compactNotionId(S.extractNotionId(current.notionTarget || current.dataSourceId));
  const nextTargetId = compactNotionId(S.extractNotionId(notionTarget));
  const targetChanged = nextTargetId !== currentTargetId;
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
  const [hasNotionToken, hasGeminiKey, hasVertexKey, hasOpenRouterKey] = await Promise.all([
    storeSecret(NOTION_TOKEN_KEY, settings.notionToken, next.rememberNotionToken),
    storeSecret(GEMINI_KEY_KEY, settings.geminiKey, next.rememberGeminiKey),
    storeSecret(VERTEX_KEY_KEY, settings.vertexKey, next.rememberVertexKey),
    storeSecret(OPENROUTER_KEY_KEY, settings.openRouterKey, next.rememberOpenRouterKey)
  ]);
  await writeConfig(next);
  const clearedQueueCount = targetChanged ? await resetStateForDatabaseChange() : 0;
  return buildSaveResponse(next, {
    clearedQueueCount,
    preferExistingTopics,
    provider,
    secrets: { hasGeminiKey, hasNotionToken, hasOpenRouterKey, hasVertexKey },
    targetChanged
  });
}

async function getConfigForUi() {
  const config = await readConfig();
  const [notionToken, geminiKey, vertexKey, openRouterKey] = await Promise.all([
    readSecret(NOTION_TOKEN_KEY),
    readSecret(GEMINI_KEY_KEY),
    readSecret(VERTEX_KEY_KEY),
    readSecret(OPENROUTER_KEY_KEY)
  ]);
  const aiProvider = normalizeAiProvider(config.aiProvider);
  return {
    ...config,
    preferExistingTopics: topicOrganizerPreference(config),
    aiProvider,
    activeModel: aiProvider === "vertex" ? config.vertexModel : aiProvider === "openrouter" ? config.openRouterModel : config.geminiModel,
    analysisPrompt: config.analysisPromptCustomized ? config.analysisPrompt : P.DEFAULT_ANALYSIS_PROMPT,
    analysisPromptCustomized: Boolean(config.analysisPromptCustomized),
    defaultAnalysisPrompt: P.DEFAULT_ANALYSIS_PROMPT,
    defaultPromptUpdated: Boolean(config.analysisPromptCustomized)
      && config.promptBaseVersion !== CURRENT_PROMPT_VERSION,
    finalPromptPreview: P.buildSystemPrompt(
      config.analysisPromptCustomized ? config.analysisPrompt : "",
      config.outputSpec
    ),
    excludedPersonTerms: normalizeExcludedPersonTerms(config.excludedPersonTerms),
    hasAiKey: aiProvider === "vertex" ? Boolean(vertexKey) : aiProvider === "openrouter" ? Boolean(openRouterKey) : Boolean(geminiKey),
    hasGeminiKey: Boolean(geminiKey),
    hasNotionToken: Boolean(notionToken),
    hasOpenRouterKey: Boolean(openRouterKey),
    openRouterPaidConfirmed: Boolean(config.openRouterModel)
      && config.openRouterPaidConfirmedModel === config.openRouterModel,
    hasVertexKey: Boolean(vertexKey)
  };
}

async function testConnections() {
  const { config, dataSource, plan, token } = await readyNotion();
  const provider = normalizeAiProvider(config.aiProvider);
  let models = [];
  let selectedAvailable = false;
  if (provider === "vertex") {
    await testVertexModel(config);
    models = recommendedVertexModels();
    selectedAvailable = true;
  } else if (provider === "openrouter") {
    const apiKey = await requireOpenRouterKey();
    models = await listOpenRouterModels(apiKey);
    config.openRouterFreeModelIds = models.filter(model => model.isFree).map(model => model.name);
    await writeConfig(config);
    selectedAvailable = models.some(model => model.name === config.openRouterModel);
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

function ensureNoTopicReview() {
  if (stateCache.topicReview) {
    throw new AppError("目前有一篇文章等待確認新主題，請先完成確認", {
      code: "TOPIC_REVIEW_PENDING"
    });
  }
}

function uniqueTopicNames(values) {
  const seen = new Set();
  return (values ?? []).filter(value => {
    const key = N.topicKey(value);
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function resolveTopicReview(action, replacementTopic = "", customTopic = "", rememberMapping = true) {
  if (stateCache.running) throw new AppError("目前仍在處理文章，請稍後再試", { code: "BUSY" });
  const review = normalizeTopicReview(stateCache.topicReview);
  const currentCandidate = review?.remainingCandidates?.[0];
  if (!review?.item || !currentCandidate?.name) {
    throw new AppError("目前沒有等待確認的新主題", { code: "TOPIC_REVIEW_MISSING" });
  }

  const config = await readConfig();
  const token = await requireNotionToken();
  let currentOptions = validTopicOptions(await readTopicOptions(config, token));
  const byKey = new Map(currentOptions.map(option => [N.topicKey(option.name), option.name]));
  const candidate = S.cleanText(currentCandidate.name);
  if (action === "approve" && !G.isOrganizerTopicLabel(candidate)) {
    throw new AppError("建立的新正式主題必須為 2～6 字；若候選名稱不合規，請改用自訂主題", {
      code: "TOPIC_CANDIDATE_INVALID"
    });
  }
  let topicDecision = action;
  let selectedTopic = "";

  if (action === "approve") {
    const existingCandidate = byKey.get(N.topicKey(candidate));
    selectedTopic = existingCandidate || candidate;
    topicDecision = existingCandidate ? "candidate_already_exists" : "approved_new";
  } else if (action === "replace") {
    const replacement = byKey.get(N.topicKey(replacementTopic));
    if (!replacement) {
      throw new AppError("請從目前的 Notion 既有主題中選擇替代項目", {
        code: "TOPIC_REPLACEMENT_INVALID"
      });
    }
    selectedTopic = replacement;
    topicDecision = "replaced_with_existing";
  } else if (action === "custom") {
    const custom = S.cleanText(customTopic);
    if (!G.isOrganizerTopicLabel(custom)) {
      throw new AppError("自訂正式主題必須為 2～6 字，並優先使用 2～4 字", {
        code: "CUSTOM_TOPIC_INVALID"
      });
    }
    const existingCustom = byKey.get(N.topicKey(custom));
    selectedTopic = existingCustom || custom;
    topicDecision = existingCustom ? "custom_existing" : "custom_new";
  } else if (action === "skip" || action === "discard") {
    review.skippedCandidates.push(candidate);
    topicDecision = "temporarily_skipped";
  } else {
    throw new AppError("未知的新主題確認操作", { code: "TOPIC_REVIEW_ACTION_INVALID" });
  }

  if (selectedTopic && !byKey.has(N.topicKey(selectedTopic))) {
    await notionRequest(`/v1/data_sources/${config.dataSourceId}`, {
      method: "PATCH",
      body: N.topicOptionsUpdatePayload(currentOptions, [selectedTopic]),
      retrySafe: true,
      token
    });
    currentOptions = validTopicOptions(await readTopicOptions(config, token));
    const savedName = currentOptions.find(option => N.topicKey(option.name) === N.topicKey(selectedTopic))?.name || selectedTopic;
    selectedTopic = savedName;
    byKey.set(N.topicKey(savedName), savedName);
    review.topicOptions = currentOptions;
  }

  const decision = {
    action: topicDecision,
    candidate,
    selectedTopic,
    rememberMapping: Boolean(rememberMapping) && Boolean(selectedTopic)
  };
  review.decisions.push(decision);
  review.remainingCandidates = review.remainingCandidates.slice(1);

  if (selectedTopic) {
    const currentPage = await notionRequest(`/v1/pages/${review.item.id}`, { token });
    const currentValues = N.pagePropertyValues(currentPage);
    const candidateKey = N.topicKey(candidate);
    const unresolvedTopics = uniqueTopicNames(
      currentValues.provisionalTopics.filter(name => N.topicKey(name) !== candidateKey)
    );
    const finalTopics = uniqueTopicNames([...(currentValues.aiTopics ?? []), selectedTopic]);
    const status = unresolvedTopics.length ? N.STATUS.topicReview : N.STATUS.analyzed;
    await notionRequest(`/v1/pages/${review.item.id}`, {
      method: "PATCH",
      body: N.topicApplyPayload(finalTopics, status, currentOptions, unresolvedTopics),
      retrySafe: true,
      token
    });

    if (decision.rememberMapping) {
      config.topicDictionary = mergeDictionaryEntries(config.topicDictionary, [{
        name: selectedTopic,
        definition: "由單篇主題確認流程建立的主題對照。",
        aliases: [candidate],
        color: N.topicColor(selectedTopic),
        active: true
      }]);
    } else {
      const resolutions = normalizeTopicPageResolutions(config.topicPageResolutions);
      const pageMappings = { ...(resolutions[review.item.id] ?? {}) };
      pageMappings[N.topicKey(candidate)] = selectedTopic;
      resolutions[review.item.id] = pageMappings;
      config.topicPageResolutions = resolutions;
    }
    await writeConfig(config);
  }

  review.topicOptions = currentOptions;
  if (review.remainingCandidates.length) {
    stateCache.topicReview = review;
    stateCache.lastError = "";
    await persistState();
    return publicStatus();
  }

  recordSuccess(review.item, {
    approvedTopics: review.decisions
      .filter(item => ["approved_new", "custom_new"].includes(item.action))
      .map(item => item.selectedTopic),
    topicDecisions: review.decisions
  });
  stateCache.topicReview = null;
  stateCache.lastError = "";
  stateCache.mode = "idle";
  stateCache.paused = true;
  await persistState();
  return publicStatus();
}

async function queueAll() {
  ensureNoTopicReview();
  const config = await readConfig();
  const cached = stateCache.pendingScan;
  const scannedAt = new Date(cached?.scannedAt || "").getTime();
  const cacheFresh = Number.isFinite(scannedAt)
    && Date.now() - scannedAt <= 120000
    && compactNotionId(cached?.dataSourceId) === compactNotionId(config.dataSourceId)
    && Array.isArray(cached?.pages);
  if (cacheFresh) await readyNotion();
  const pages = cacheFresh ? cached.pages : await scanPending();
  stateCache.pendingScan = null;
  stateCache.queue = uniqueItems(pages);
  stateCache.knownPending = pages.length;
  if (!pages.length) {
    stateCache.databaseCheck = {
      checkedAt: new Date().toISOString(),
      code: "NO_PENDING_PAGES",
      message: N.DATABASE_SETUP_MESSAGES.noPendingPages,
      ready: true
    };
    stateCache.lastError = N.DATABASE_SETUP_MESSAGES.noPendingPages;
    stateCache.mode = "idle";
    stateCache.paused = true;
    stateCache.stopRequested = false;
    await persistState();
    return publicStatus();
  }
  stateCache.databaseCheck = {
    checkedAt: new Date().toISOString(),
    code: "READY",
    message: "",
    ready: true
  };
  stateCache.lastError = "";
  stateCache.mode = "batch";
  stateCache.paused = false;
  stateCache.stopRequested = false;
  await persistState();
  if (stateCache.queue.length) scheduleProcessing();
  return publicStatus();
}

async function stopAnalysis() {
  stateCache.paused = true;
  stateCache.stopRequested = Boolean(stateCache.current);
  stateCache.mode = "paused";
  await persistState();
  if (activeAbortController) activeAbortController.abort();
  return publicStatus();
}

async function resumeAnalysis() {
  ensureNoTopicReview();
  stateCache.paused = false;
  stateCache.stopRequested = false;
  stateCache.mode = "batch";
  await persistState();
  if (stateCache.queue.length) scheduleProcessing();
  return publicStatus();
}

async function retryFailed() {
  ensureNoTopicReview();
  const { config, token } = await readyNotion();
  const remoteFailed = await queryPagesByStatus(config.dataSourceId, N.STATUS.failed, token);
  const retryItems = uniqueItems([...remoteFailed, ...stateCache.failed]);
  if (!retryItems.length) {
    stateCache.lastError = "Notion 中目前沒有「分析失敗」的文章可重試。";
    await persistState();
    return publicStatus();
  }
  const retryIds = new Set(retryItems.map(item => item.id));
  stateCache.queue = uniqueItems([
    ...retryItems,
    ...stateCache.queue.filter(item => !retryIds.has(item.id))
  ]);
  stateCache.failed = [];
  stateCache.lastError = "";
  stateCache.paused = false;
  stateCache.stopRequested = false;
  stateCache.mode = "batch";
  await persistState();
  if (stateCache.queue.length) scheduleProcessing();
  return publicStatus();
}

function compactNotionId(value) {
  return String(value ?? "").replace(/-/g, "").toLocaleLowerCase("en-US");
}

function pageBelongsToConfiguredSource(page, config) {
  const parentId = page?.parent?.data_source_id || page?.parent?.database_id || "";
  return [config.dataSourceId, config.databaseId].some(id => id && compactNotionId(id) === compactNotionId(parentId));
}

async function inspectPage(pageId) {
  const id = S.extractNotionId(pageId);
  if (!id) throw new AppError("目前分頁不是可辨識的 Notion 頁面", { code: "PAGE_ID_INVALID" });
  const { config, token } = await readyNotion();
  const page = await notionRequest(`/v1/pages/${id}`, { token });
  if (!pageBelongsToConfiguredSource(page, config)) {
    throw new AppError("這個頁面不屬於目前設定的 Notion 資料庫", { code: "PAGE_OUTSIDE_DATA_SOURCE" });
  }
  const values = N.pagePropertyValues(page);
  return {
    ...N.pageSummary(page),
    sourceDataSourceId: config.dataSourceId,
    status: values.status,
    aiTopics: values.aiTopics,
    provisionalTopics: values.provisionalTopics,
    analyzed: [N.STATUS.analyzed, N.STATUS.topicOrganize, N.STATUS.topicReview].includes(values.status)
      || Boolean(values.aiTitle || values.keywords.length || values.aiTopics.length || values.provisionalTopics.length)
  };
}

async function reviewCurrentPageTopics(pageId) {
  ensureNoTopicReview();
  if (stateCache.running) {
    throw new AppError("目前正在分析其他文章，請先停止或等候完成", { code: "BUSY" });
  }

  const id = S.extractNotionId(pageId);
  if (!id) throw new AppError("頁面 ID 格式不正確", { code: "PAGE_ID_INVALID" });
  const { config, token } = await readyNotion();
  const page = await notionRequest(`/v1/pages/${id}`, { token });
  if (!pageBelongsToConfiguredSource(page, config)) {
    throw new AppError("這個頁面不屬於目前設定的 Notion 資料庫", { code: "PAGE_OUTSIDE_DATA_SOURCE" });
  }

  const values = N.pagePropertyValues(page);
  if (![N.STATUS.topicOrganize, N.STATUS.topicReview].includes(values.status)) {
    throw new AppError("目前頁面的整理狀態不是「待主題整理」或「待主題確認」", {
      code: "PAGE_TOPIC_REVIEW_STATUS_INVALID"
    });
  }

  const provisionalTopics = uniqueTopicNames(values.provisionalTopics);
  if (!provisionalTopics.length) {
    throw new AppError("目前頁面沒有可整理的 AI 暫定主題", {
      code: "PAGE_TOPIC_REVIEW_EMPTY"
    });
  }

  const topicOptions = validTopicOptions(await readTopicOptions(config, token));
  const item = {
    ...N.pageSummary(page),
    sourceDataSourceId: config.dataSourceId,
    sourceStatus: values.status
  };
  const topicReview = normalizeTopicReview({
    version: 2,
    item,
    result: { ai_topics: provisionalTopics },
    requestedAt: new Date().toISOString(),
    candidateTotal: provisionalTopics.length,
    remainingCandidates: provisionalTopics.map(name => ({ name, reason: "", closest_existing: [] })),
    topicOptions,
    originalFinalTopics: values.aiTopics,
    selectedExistingTopics: [],
    approvedNewTopics: [],
    decisions: [],
    skippedCandidates: [],
    previousMode: "single_review"
  });
  if (values.status === N.STATUS.topicOrganize) {
    await notionRequest(`/v1/pages/${id}`, {
      method: "PATCH",
      body: N.statusUpdatePayload(N.STATUS.topicReview),
      retrySafe: true,
      token
    });
  }

  stateCache.topicReview = topicReview;
  stateCache.current = null;
  stateCache.mode = "single_review";
  stateCache.paused = true;
  stateCache.stopRequested = false;
  stateCache.lastError = "";
  await persistState();
  return publicStatus();
}

async function reanalyzePage(pageId, force = false) {
  ensureNoTopicReview();
  if (stateCache.running) throw new AppError("目前正在分析其他文章，請先停止或等候完成", { code: "BUSY" });
  const id = S.extractNotionId(pageId);
  if (!id) throw new AppError("頁面 ID 格式不正確", { code: "PAGE_ID_INVALID" });
  const inspection = await inspectPage(id);
  if (inspection.analyzed && !force) {
    throw new AppError("這個頁面已有分析內容，重新分析會覆寫 AI 欄位", { code: "PAGE_OVERWRITE_CONFIRM_REQUIRED" });
  }
  stateCache.queue = uniqueItems([{ ...inspection, sourceStatus: "重新分析" }, ...stateCache.queue]);
  stateCache.paused = false;
  stateCache.stopRequested = false;
  stateCache.mode = "single_review";
  await persistState();
  scheduleProcessing();
  return publicStatus();
}

async function handleMessage(message) {
  await initialize();
  switch (message?.type) {
    case "GET_STATUS":
      return publicStatus();
    case "GET_CONFIG":
      return getConfigForUi();
    case "GET_PROMPT_PREVIEW":
      return {
        prompt: P.buildSystemPrompt(message.customized ? message.prompt : "", message.outputSpec)
      };
    case "SAVE_SETTINGS":
      return saveSettings(message.settings ?? {});
    case "TEST_CONNECTIONS":
      return testConnections();
    case "LIST_MODELS": {
      const config = await readConfig();
      const provider = normalizeAiProvider(config.aiProvider);
      let models;
      if (provider === "vertex") models = recommendedVertexModels();
      else if (provider === "openrouter") {
        models = await listOpenRouterModels();
        config.openRouterFreeModelIds = models.filter(model => model.isFree).map(model => model.name);
        await writeConfig(config);
      } else models = await listGeminiModels();
      return {
        models,
        provider
      };
    }
    case "SCAN_PENDING":
      await scanPending();
      return publicStatus();
    case "ANALYZE_ALL":
      return queueAll();
    case "STOP_ANALYSIS":
      return stopAnalysis();
    case "RESUME_ANALYSIS":
      return resumeAnalysis();
    case "RETRY_FAILED":
      return retryFailed();
    case "REANALYZE_PAGE":
      return reanalyzePage(message.pageId, message.force === true);
    case "REVIEW_CURRENT_PAGE_TOPICS":
      return reviewCurrentPageTopics(message.pageId);
    case "INSPECT_PAGE":
      return inspectPage(message.pageId);
    case "PREPARE_TOPIC_ORGANIZER":
      return prepareTopicOrganizer();
    case "GET_TOPIC_ORGANIZER":
      return topicOrganizerForUi();
    case "APPLY_TOPIC_GROUPS":
      return applyTopicOrganizerGroups(message.groups ?? []);
    case "SKIP_TOPIC_GROUP":
      return skipTopicOrganizerGroup(message.groupId, message.groups ?? []);
    case "RESOLVE_ORGANIZER_UNCLASSIFIED":
      return resolveOrganizerUnclassified(
        message.candidate,
        message.action,
        message.replacementTopic,
        message.customTopic
      );
    case "CLEAR_TOPIC_ORGANIZER":
      return clearTopicOrganizer();
    case "ROLLBACK_TOPIC_APPLY":
      return rollbackTopicOrganizer();
    case "EXPORT_TOPIC_DICTIONARY":
      return dictionaryExport(await readConfig());
    case "PREVIEW_TOPIC_DICTIONARY_IMPORT":
      return previewDictionaryImport(message.value, await readConfig());
    case "IMPORT_TOPIC_DICTIONARY": {
      const config = await readConfig();
      const preview = previewDictionaryImport(message.value, config);
      config.topicDictionary = message.mode === "overwrite"
        ? preview.incoming
        : mergeDictionaryEntries(config.topicDictionary, preview.incoming);
      await writeConfig(config);
      return { imported: preview.incoming.length, total: config.topicDictionary.length };
    }
    case "RESOLVE_TOPIC_REVIEW":
      return resolveTopicReview(
        message.action,
        message.replacementTopic,
        message.customTopic,
        message.rememberMapping !== false
      );
    case "CLEAR_RECENT":
      stateCache.recent = [];
      stateCache.failed = stateCache.failed.map(entry => ({
        ...entry,
        diagnostic: null
      }));
      await persistState();
      return publicStatus();
    case "CLEAR_CREDENTIALS":
      await clearCredentials();
      return { cleared: true };
    case "OPEN_OPTIONS":
      await chrome.runtime.openOptionsPage();
      return { opened: true };
    default:
      throw new AppError("未知的操作", { code: "UNKNOWN_MESSAGE" });
  }
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  handleMessage(message)
    .then(data => sendResponse({ ok: true, data }))
    .catch(error => sendResponse({
      ok: false,
      error: {
        code: error?.code || "UNEXPECTED",
        message: S.truncateMessage(error?.message || "發生未知錯誤", 600)
      }
    }));
  return true;
});

chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm.name === PROCESS_ALARM) void processOne();
});

chrome.runtime.onInstalled.addListener(details => {
  void initialize();
  if (details.reason === "install") void chrome.runtime.openOptionsPage();
});

chrome.runtime.onStartup.addListener(() => {
  void initialize();
});

void initialize();
