"use strict";

// Service worker: HTTP helpers plus Notion and AI transport.

// ==== HTTP helpers ====
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

// ==== Notion transport ====
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

function safeNotionDataSourceListError(error) {
  if (error?.code === "NOTION_NETWORK") {
    return new AppError("無法連線到 Notion，請檢查網路後重新整理", { code: "NOTION_NETWORK" });
  }
  if (error?.status === 401) {
    return new AppError("Notion Token 無效，請重新輸入後再試", {
      code: "NOTION_AUTH",
      status: 401
    });
  }
  if (error?.status === 403) {
    return new AppError("這個 Integration 權限不足，或受到 Notion 工作區限制", {
      code: "NOTION_AUTH",
      status: 403
    });
  }
  if (error?.status === 429 || error?.code === "NOTION_RATE_LIMIT") {
    return new AppError("Notion 請求過於頻繁，請稍後再重新整理", {
      code: "NOTION_RATE_LIMIT",
      retryAfter: error?.retryAfter || 0,
      status: 429
    });
  }
  if (error?.status === 529 || (error?.status >= 500 && error?.status < 600)) {
    return new AppError("Notion 服務暫時無法使用，請稍後再重新整理", {
      code: "NOTION_API",
      status: error.status
    });
  }
  return new AppError("無法載入 Notion 資料庫，請稍後再試", {
    code: error?.code === "NOTION_RETRY_EXHAUSTED" ? "NOTION_RETRY_EXHAUSTED" : "NOTION_API",
    status: error?.status || 0
  });
}

async function listNotionDataSources(suppliedToken = "") {
  const oneTimeToken = String(suppliedToken ?? "").trim();
  const token = oneTimeToken || await readSecret(NOTION_TOKEN_KEY);
  if (!token) {
    throw new AppError("請先輸入 Notion Integration Token", { code: "NOTION_TOKEN_MISSING" });
  }

  const byId = new Map();
  const seenCursors = new Set();
  let cursor = "";
  let scannedCount = 0;
  let limitReached = false;

  try {
    while (scannedCount < MAX_NOTION_DATA_SOURCES) {
      const response = await notionRequest("/v1/search", {
        method: "POST",
        body: N.dataSourceSearchPayload(cursor),
        token
      });
      const remaining = MAX_NOTION_DATA_SOURCES - scannedCount;
      const results = Array.isArray(response.results) ? response.results.slice(0, remaining) : [];
      scannedCount += results.length;
      for (const result of results) {
        const summary = N.dataSourceSummary(result);
        if (summary && !byId.has(compactNotionId(summary.id))) {
          byId.set(compactNotionId(summary.id), summary);
        }
      }

      if (scannedCount >= MAX_NOTION_DATA_SOURCES) {
        limitReached = Boolean(response.has_more);
        break;
      }
      const nextCursor = typeof response.next_cursor === "string" ? response.next_cursor : "";
      if (!response.has_more || !nextCursor || seenCursors.has(nextCursor)) break;
      seenCursors.add(nextCursor);
      cursor = nextCursor;
    }
  } catch (error) {
    throw safeNotionDataSourceListError(error);
  }

  const collator = new Intl.Collator("zh-Hant-TW", { numeric: true, sensitivity: "base" });
  const dataSources = [...byId.values()].sort((left, right) => {
    const byTitle = collator.compare(left.title, right.title);
    return byTitle || left.id.localeCompare(right.id);
  });
  return { dataSources, limitReached };
}

// ==== AI transport ====
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

function payloadTextCharacters(value) {
  if (typeof value === "string") return value.length;
  if (Array.isArray(value)) return value.reduce((total, item) => total + payloadTextCharacters(item), 0);
  if (!value || typeof value !== "object") return 0;
  return Object.values(value).reduce((total, item) => total + payloadTextCharacters(item), 0);
}

function assertArticleSize(articleText) {
  if (articleText.length <= MAX_ARTICLE_CHARACTERS) return;
  throw new AppError(`文章純文字共 ${articleText.length.toLocaleString()} 字元，超過 ${MAX_ARTICLE_CHARACTERS.toLocaleString()} 的安全上限`, {
    code: "ARTICLE_TOO_LARGE",
    diagnostic: {
      articleCharacters: articleText.length,
      articleCharacterLimit: MAX_ARTICLE_CHARACTERS
    }
  });
}

async function assertAiInputTokenLimit(provider, model, payload, options = {}) {
  const inputCharacters = payloadTextCharacters(payload);
  if (inputCharacters < TOKEN_PREFLIGHT_CHARACTERS) return null;
  const safeModel = S.normalizeModelName(model);
  if (!safeModel) throw new AppError("AI 模型名稱格式不正確", { code: "MODEL_INVALID" });
  const apiKey = options.apiKey || (provider === "vertex" ? await requireVertexKey() : await requireGeminiKey());
  const url = provider === "vertex"
    ? `https://aiplatform.googleapis.com/v1/publishers/google/models/${encodeURIComponent(safeModel)}:countTokens`
    : `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(safeModel)}:countTokens`;
  const body = provider === "vertex"
    ? payload
    : { generateContentRequest: { model: `models/${safeModel}`, ...payload } };
  let response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": apiKey
      },
      body: JSON.stringify(body),
      signal: options.signal
    });
  } catch (error) {
    if (error?.name === "AbortError") throw error;
    throw new AppError("無法確認 AI 輸入 token 數，請檢查網路後再試", {
      code: provider === "vertex" ? "VERTEX_NETWORK" : "GEMINI_NETWORK"
    });
  }
  const data = await readJsonResponse(response);
  if (!response.ok) {
    const prefix = provider === "vertex" ? "VERTEX" : "GEMINI";
    const code = response.status === 429
      ? `${prefix}_RATE_LIMIT`
      : [400, 401, 403].includes(response.status) ? `${prefix}_AUTH` : `${prefix}_API`;
    throw new AppError(errorMessage(data, `無法確認 AI 輸入 token 數（${response.status}）`), {
      code,
      status: response.status
    });
  }
  const totalTokens = Number(data?.totalTokens);
  if (!Number.isFinite(totalTokens) || totalTokens < 0) {
    throw new AppError("AI 未回傳可辨識的輸入 token 數", { code: "TOKEN_COUNT_INVALID" });
  }
  if (totalTokens > MAX_INPUT_TOKENS) {
    throw new AppError(`完整 prompt 約 ${totalTokens.toLocaleString()} tokens，超過 ${MAX_INPUT_TOKENS.toLocaleString()} 的安全上限`, {
      code: "AI_INPUT_TOKEN_LIMIT",
      diagnostic: { inputCharacters, inputTokens: totalTokens, inputTokenLimit: MAX_INPUT_TOKENS }
    });
  }
  return totalTokens;
}

async function aiRequest(provider, model, payload, options = {}) {
  if (provider === "vertex") return vertexRequest(model, payload, options);
  return geminiRequest(model, payload, options);
}

// ==== Processing stage updates ====
async function setStage(name, detail = {}) {
  if (!stateCache) return;
  stateCache.stage = {
    name,
    startedAt: new Date().toISOString(),
    ...detail
  };
  await persistState();
}

// ==== Timeout and cancellation utilities ====
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
