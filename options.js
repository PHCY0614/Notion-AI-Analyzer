"use strict";

// ==== DOM references and local UI state ====
const form = document.querySelector("#settings-form");
const statusBox = document.querySelector("#status");
const notionToken = document.querySelector("#notion-token");
const notionTarget = document.querySelector("#notion-target");
const rememberNotionToken = document.querySelector("#remember-notion-token");
const aiProvider = document.querySelector("#ai-provider");
const geminiKey = document.querySelector("#gemini-key");
const geminiModel = document.querySelector("#gemini-model");
const rememberGeminiKey = document.querySelector("#remember-gemini-key");
const vertexKey = document.querySelector("#vertex-key");
const vertexModel = document.querySelector("#vertex-model");
const rememberVertexKey = document.querySelector("#remember-vertex-key");
const geminiSettings = document.querySelector("#gemini-settings");
const vertexSettings = document.querySelector("#vertex-settings");
const excludedPersonTerms = document.querySelector("#excluded-person-terms");
const analysisPrompt = document.querySelector("#analysis-prompt");
const titleMax = document.querySelector("#title-max");
const topicMin = document.querySelector("#topic-min");
const topicMax = document.querySelector("#topic-max");
const keywordCount = document.querySelector("#keyword-count");
const summaryMin = document.querySelector("#summary-min");
const summaryMax = document.querySelector("#summary-max");
const outputSpecSummary = document.querySelector("#output-spec-summary");
const requestTimeout = document.querySelector("#request-timeout");
const promptState = document.querySelector("#prompt-state");
const promptPreview = document.querySelector("#prompt-preview");
const preferExistingTopics = document.querySelector("#prefer-existing-topics");
const organizerSummary = document.querySelector("#organizer-summary");
const topicGroups = document.querySelector("#topic-groups");
const unclassifiedPanel = document.querySelector("#unclassified-panel");
const unclassifiedSummary = document.querySelector("#unclassified-summary");
const unclassifiedTopics = document.querySelector("#unclassified-topics");
const manualTopicReview = document.querySelector("#manual-topic-review");
const manualTopicProgress = document.querySelector("#manual-topic-progress");
const manualTopicName = document.querySelector("#manual-topic-name");
const manualTopicImpact = document.querySelector("#manual-topic-impact");
const manualTopicNote = document.querySelector("#manual-topic-note");
const manualExistingTopic = document.querySelector("#manual-existing-topic");
const manualCustomTopic = document.querySelector("#manual-custom-topic");
const modelSummary = document.querySelector("#model-summary");
const saveButton = document.querySelector("#save");
const testButton = document.querySelector("#test");
const loadModelsButton = document.querySelector("#load-models");
const clearButton = document.querySelector("#clear-credentials");
const importDictionary = document.querySelector("#import-dictionary");
const importDictionaryTrigger = document.querySelector("#import-dictionary-trigger");
const importMode = document.querySelector("#import-mode");
const importModeDisplay = document.querySelector("#import-mode-display");
const importModeMenu = document.querySelector("#import-mode-menu");
const importModeToggle = document.querySelector("#import-mode-toggle");
const importSplitButton = document.querySelector("#import-split-btn");
const enhancedSelects = new Map();
let defaultAnalysisPrompt = "";
let promptCustomized = false;
let organizerData = null;
let manualCandidateName = "";
let topicOrganizerPreferences = {};
const NO_PENDING_MESSAGE = "目前沒有待分析文章。請先在 Notion 將要處理文章的「整理狀態」設為「待分析」。";

// ==== Shared custom select ====
function closeEnhancedSelects(except = null) {
  for (const controller of enhancedSelects.values()) {
    if (controller !== except) controller.close();
  }
}

/**
 * Options wrapper around AnalyzerSelect. Five ids get custom-select--regular;
 * all use matchNativeState, emptyLabel 「請選擇」, and onToggle to close other
 * enhanced menus. Document close/Escape is handled on this page, so
 * attachDocumentListeners is false. Extra native change → sync.
 */
function enhanceSelect(select) {
  if (!select || enhancedSelects.has(select)) return enhancedSelects.get(select);
  const extraRootClass = ["gemini-model", "vertex-model", "request-timeout", "manual-existing-topic"]
    .includes(select.id) ? "custom-select--regular" : "";
  const controller = AnalyzerSelect.enhance(select, {
    extraRootClass,
    emptyLabel: "請選擇",
    matchNativeState: true,
    attachDocumentListeners: false,
    onToggle(controller, opening) {
      closeEnhancedSelects(opening ? controller : null);
    }
  });
  enhancedSelects.set(select, controller);
  select.addEventListener("change", () => controller.sync());
  return controller;
}

function syncEnhancedSelects() {
  for (const controller of enhancedSelects.values()) controller.sync();
}

for (const select of [
  aiProvider,
  geminiModel,
  vertexModel,
  requestTimeout,
  manualExistingTopic
]) enhanceSelect(select);

const DEFAULT_OUTPUT_SPEC = Object.freeze({
  titleMax: 12,
  topicMin: 1,
  topicMax: 3,
  keywordCount: 5,
  summaryMin: 100,
  summaryMax: 250
});
const OUTPUT_SPEC_LIMITS = Object.freeze({
  titleMax: Object.freeze({ input: titleMax, min: 6, max: 30 }),
  topicMin: Object.freeze({ input: topicMin, min: 1, max: 5 }),
  topicMax: Object.freeze({ input: topicMax, min: 1, max: 5 }),
  keywordCount: Object.freeze({ input: keywordCount, min: 3, max: 10 }),
  summaryMin: Object.freeze({ input: summaryMin, min: 50, max: 500 }),
  summaryMax: Object.freeze({ input: summaryMax, min: 100, max: 800 })
});

function clampOutputValue(key, value) {
  const limit = OUTPUT_SPEC_LIMITS[key];
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return DEFAULT_OUTPUT_SPEC[key];
  return Math.max(limit.min, Math.min(limit.max, Math.round(parsed)));
}

function normalizeFormOutputSpec(writeBack = false) {
  const spec = {};
  for (const [key, limit] of Object.entries(OUTPUT_SPEC_LIMITS)) {
    spec[key] = clampOutputValue(key, limit.input.value);
    if (writeBack) limit.input.value = String(spec[key]);
  }
  return spec;
}

// ==== Background messaging ====
/**
 * chrome.runtime.sendMessage wrapper. Throws on ok false. Settings UI uses
 * GET_CONFIG / SAVE_SETTINGS; organizer UI uses GET_TOPIC_ORGANIZER and
 * apply/skip/rollback/manual messages. Does not poll.
 */
async function send(type, extra = {}) {
  const response = await chrome.runtime.sendMessage({ type, ...extra });
  if (!response?.ok) throw new Error(response?.error?.message || "操作失敗");
  return response.data;
}

function showStatus(message, kind = "info") {
  statusBox.textContent = message;
  statusBox.className = `status visible ${kind}`;
}

function closeImportModeMenu() {
  importModeMenu.hidden = true;
  importModeToggle.setAttribute("aria-expanded", "false");
}

function setImportMode(value) {
  const normalized = value === "overwrite" ? "overwrite" : "merge";
  importMode.value = normalized;
  importModeDisplay.textContent = normalized === "overwrite" ? "取代" : "合併";
  for (const option of importModeMenu.querySelectorAll(".split-btn__option")) {
    const selected = option.dataset.value === normalized;
    option.setAttribute("aria-selected", String(selected));
    option.querySelector(".split-btn__check")?.classList.toggle("split-btn__check--empty", !selected);
  }
  closeImportModeMenu();
}

function settingsFromForm() {
  const outputSpec = normalizeFormOutputSpec(true);
  return {
    aiProvider: aiProvider.value,
    geminiKey: geminiKey.value.trim(),
    geminiModel: geminiModel.value.trim(),
    vertexKey: vertexKey.value.trim(),
    vertexModel: vertexModel.value.trim(),
    excludedPersonTerms: excludedPersonTerms.value,
    preferExistingTopics: preferExistingTopics.checked,
    analysisPrompt: analysisPrompt.value,
    analysisPromptCustomized: promptCustomized,
    outputSpec,
    requestTimeoutMinutes: Number(requestTimeout.value),
    notionTarget: notionTarget.value.trim(),
    notionToken: notionToken.value.trim(),
    rememberGeminiKey: rememberGeminiKey.checked,
    rememberVertexKey: rememberVertexKey.checked,
    rememberNotionToken: rememberNotionToken.checked
  };
}

// ==== AI provider and model discovery ====
/**
 * Returns the model <select> for the currently chosen provider. Sends no
 * messages. Does not change values; LIST_MODELS and TEST_CONNECTIONS are
 * sent by the scan/test buttons. Provider tests, schema, and AI calls stay
 * in background.js.
 */
function activeModelElement() {
  if (aiProvider.value === "vertex") return vertexModel;
  return geminiModel;
}

/**
 * Shows the selected provider's key/model fields and hides the others, then
 * syncs enhanced selects. Sends no messages. Updates Gemini/Vertex settings
 * and model-select hidden state, the
 * load-models button label, and modelSummary. LIST_MODELS is sent by the
 * scan/load-models button; TEST_CONNECTIONS by the test button. Provider tests,
 * schema PATCHes, and AI calls stay in background.js.
 */
function updateProviderUi() {
  const provider = aiProvider.value;
  geminiSettings.hidden = provider !== "gemini";
  vertexSettings.hidden = provider !== "vertex";
  geminiModel.hidden = provider !== "gemini";
  vertexModel.hidden = provider !== "vertex";
  loadModelsButton.textContent = provider === "vertex" ? "載入建議模型" : "掃描可用模型";
  modelSummary.textContent = provider === "vertex"
      ? "載入 Vertex AI 建議模型；按「測試連線並準備欄位」會使用免費的 Token 計數要求驗證所選模型與金鑰。"
      : "掃描會讀取這把 Google AI Studio Key 可見、支援純文字 generateContent 的模型。";
  syncEnhancedSelects();
}

function setBusy(isBusy) {
  for (const button of [saveButton, testButton, loadModelsButton, clearButton]) button.disabled = isBusy;
}

function formatTokenLimit(value) {
  if (!Number.isFinite(value)) return "";
  return new Intl.NumberFormat("zh-TW", { notation: "compact", maximumFractionDigits: 1 }).format(value);
}

function modelLabel(model) {
  const limits = [
    Number.isFinite(model.inputTokenLimit) ? `輸入 ${formatTokenLimit(model.inputTokenLimit)}` : "",
    Number.isFinite(model.outputTokenLimit) ? `輸出 ${formatTokenLimit(model.outputTokenLimit)}` : ""
  ].filter(Boolean).join("／");
  const recommended = model.name === "gemini-3.5-flash-lite" ? "｜建議" : "";
  const display = model.displayName && model.displayName !== model.name
    ? `${model.displayName}｜${model.name}`
    : model.name;
  return `${display}${recommended}${limits ? `｜${limits}` : ""}`;
}

/**
 * Ensures a stored model name exists as an option before loadConfig assigns
 * select.value. Sends no messages. Appends one option onto the given model
 * select when missing. Does not call LIST_MODELS; provider tests, schema, and
 * AI calls stay in background.js.
 */
function ensureModelOption(select, name, label = name) {
  if ([...select.options].some(option => option.value === name)) return;
  const option = document.createElement("option");
  option.value = name;
  option.textContent = label;
  select.append(option);
}

/**
 * Replaces one model <select> from a LIST_MODELS result array and syncs its
 * AnalyzerSelect. Sends no messages. Rebuilds options, then selects the
 * previous value, else gemini-3.5-flash-lite, else
 * the first model. The load-models click handler is what sends LIST_MODELS
 * after SAVE_SETTINGS. Provider tests, schema, and AI calls stay in
 * background.js.
 */
function renderModels(select, models, selected) {
  const options = models.map(model => {
    const option = document.createElement("option");
    option.value = model.name;
    option.textContent = modelLabel(model);
    return option;
  });
  select.replaceChildren(...options);
  if (models.some(model => model.name === selected)) {
    select.value = selected;
  } else if (models.some(model => model.name === "gemini-3.5-flash-lite")) {
    select.value = "gemini-3.5-flash-lite";
  } else if (models[0]) {
    select.value = models[0].name;
  }
  enhancedSelects.get(select)?.sync();
}

// ==== Settings form ====
/**
 * SAVE_SETTINGS from the form. Local guards for empty target/model and
 * output-spec ranges run first. Secrets are not
 * written back into the inputs; placeholders show has*Key. Does not call
 * TEST_CONNECTIONS or ensureSchema.
 */
async function saveSettings(showConfirmation = true) {
  if (!notionTarget.value.trim()) throw new Error("請填入 Notion 資料庫網址或 Data Source ID");
  if (!activeModelElement().value.trim()) throw new Error("請選擇分析模型");
  const outputSpec = normalizeFormOutputSpec(true);
  updateOutputSpecSummary();
  if (outputSpec.topicMin > outputSpec.topicMax) throw new Error("主題最少數不可大於主題最多數");
  if (outputSpec.summaryMin > outputSpec.summaryMax) throw new Error("摘要最少字數不可大於摘要最多字數");
  const config = await send("SAVE_SETTINGS", { settings: settingsFromForm() });
  topicOrganizerPreferences = config.preferExistingTopicsByDataSource ?? topicOrganizerPreferences;
  preferExistingTopics.checked = Boolean(config.preferExistingTopics);
  notionToken.value = "";
  geminiKey.value = "";
  vertexKey.value = "";
  notionToken.placeholder = config.hasNotionToken ? "已設定（留白會保留）" : "secret_…";
  geminiKey.placeholder = config.hasGeminiKey ? "已設定（留白會保留）" : "AIza…";
  vertexKey.placeholder = config.hasVertexKey ? "已設定（留白會保留）" : "AIza…";
  if (showConfirmation) {
    const queueNotice = config.databaseChanged
      ? ` 已切換資料庫${config.clearedQueueCount ? `，並清除 ${config.clearedQueueCount} 篇舊佇列` : ""}；開始前請掃描資料庫。`
      : "";
    showStatus(`設定已儲存。金鑰欄已清空顯示，但目前設定仍保留。${queueNotice}`, "success");
  }
  return config;
}

/**
 * GET_CONFIG into the form, then GET_TOPIC_ORGANIZER and renderOrganizer.
 * Secret values are not returned; placeholders show whether keys exist.
 */
async function loadConfig() {
  try {
    const config = await send("GET_CONFIG");
    aiProvider.value = config.aiProvider || "gemini";
    notionTarget.value = config.notionTarget || config.dataSourceId || "";
    const selectedModel = config.geminiModel || "gemini-3.5-flash-lite";
    ensureModelOption(geminiModel, selectedModel);
    geminiModel.value = selectedModel;
    const selectedVertexModel = config.vertexModel || "gemini-3.5-flash-lite";
    ensureModelOption(vertexModel, selectedVertexModel);
    vertexModel.value = selectedVertexModel;
    rememberNotionToken.checked = Boolean(config.rememberNotionToken);
    rememberGeminiKey.checked = Boolean(config.rememberGeminiKey);
    rememberVertexKey.checked = Boolean(config.rememberVertexKey);
    excludedPersonTerms.value = (config.excludedPersonTerms ?? []).join("\n");
    defaultAnalysisPrompt = config.defaultAnalysisPrompt || "";
    analysisPrompt.value = config.analysisPrompt || defaultAnalysisPrompt;
    promptCustomized = Boolean(config.analysisPromptCustomized);
    promptState.textContent = promptCustomized
      ? config.defaultPromptUpdated
        ? "目前使用自訂提示詞；本版本的預設提示詞已更新，你的內容仍完整保留。"
        : "目前使用自訂提示詞；版本更新時會保留。"
      : "目前使用本版本預設提示詞。";
    const spec = config.outputSpec || DEFAULT_OUTPUT_SPEC;
    titleMax.value = spec.titleMax;
    topicMin.value = spec.topicMin;
    topicMax.value = spec.topicMax;
    keywordCount.value = spec.keywordCount;
    summaryMin.value = spec.summaryMin;
    summaryMax.value = spec.summaryMax;
    updateOutputSpecSummary();
    requestTimeout.value = String(config.requestTimeoutMinutes ?? 5);
    topicOrganizerPreferences = config.preferExistingTopicsByDataSource ?? {};
    preferExistingTopics.checked = Boolean(config.preferExistingTopics);
    notionToken.placeholder = config.hasNotionToken ? "已設定（留白會保留）" : "secret_…";
    geminiKey.placeholder = config.hasGeminiKey ? "已設定（留白會保留）" : "AIza…";
    vertexKey.placeholder = config.hasVertexKey ? "已設定（留白會保留）" : "AIza…";
    updateProviderUi();
    syncEnhancedSelects();
    if (config.providerReselectionRequired) {
      showStatus("舊版 AI 服務已移除。請選擇 Google AI Studio 或 Vertex AI，填入金鑰後儲存設定。", "info");
    }
    organizerData = await send("GET_TOPIC_ORGANIZER");
    renderOrganizer();
  } catch (error) {
    showStatus(error.message, "error");
  }
}

function compactTargetId(value) {
  const compact = String(value ?? "").replaceAll("-", "");
  return compact.match(/[0-9a-f]{32}/i)?.[0]?.toLowerCase() || "";
}

notionTarget.addEventListener("input", () => {
  const key = compactTargetId(notionTarget.value);
  preferExistingTopics.checked = Boolean(key && topicOrganizerPreferences[key]);
});

form.addEventListener("submit", async event => {
  event.preventDefault();
  setBusy(true);
  try {
    await saveSettings(true);
  } catch (error) {
    showStatus(error.message, "error");
  } finally {
    setBusy(false);
  }
});

testButton.addEventListener("click", async () => {
  setBusy(true);
  showStatus("正在儲存、連接 Notion、準備欄位並驗證 AI 服務…", "info");
  try {
    await saveSettings(false);
    const result = await send("TEST_CONNECTIONS");
    const changes = [
      result.addedProperties.length ? `新增 ${result.addedProperties.join("、")}` : "欄位已齊全",
      result.updatedProperties.length ? `補上 ${result.updatedProperties.join("、")} 的狀態選項` : "狀態選項已齊全"
    ].join("；");
    const modelNote = result.selectedAvailable
      ? "目前模型可用"
      : "目前模型未出現在清單，請按「掃描所有可用模型」改選";
    const ignoredNote = result.ignoredTopicCount
      ? `，另有 ${result.ignoredTopicCount} 個過長或格式不符的舊主題已忽略`
      : "";
    const providerName = result.provider === "vertex" ? "Vertex AI" : "Google AI Studio";
    const pendingNote = result.hasPending ? "" : ` ${NO_PENDING_MESSAGE}`;
    showStatus(`連線成功。${changes}；目前有 ${result.topicCount} 個可用 AI 主題${ignoredNote}；${providerName} ${modelNote}。${pendingNote}`, result.selectedAvailable && result.hasPending ? "success" : "info");
  } catch (error) {
    showStatus(error.message, "error");
  } finally {
    setBusy(false);
  }
});

/**
 * SAVE_SETTINGS then LIST_MODELS. renderModels replaces options on the
 * active provider's model select and syncs its AnalyzerSelect. Provider tests
 * (TEST_CONNECTIONS), schema PATCHes, and AI calls stay in background.js.
 */
loadModelsButton.addEventListener("click", async () => {
  setBusy(true);
  showStatus("正在讀取目前服務商的可用模型…", "info");
  try {
    await saveSettings(false);
    const result = await send("LIST_MODELS");
    const select = activeModelElement();
    const previous = select.value.trim();
    renderModels(select, result.models, previous);
    modelSummary.textContent = `完成，共有 ${result.models.length} 個可選模型。目前選擇：${select.value}。`;
    showStatus(`已完整掃描 ${result.models.length} 個可用文字模型。選好後請按「儲存設定」。`, "success");
  } catch (error) {
    showStatus(error.message, "error");
  } finally {
    setBusy(false);
  }
});

clearButton.addEventListener("click", async () => {
  if (!confirm("確定要從這個 Chrome 使用者設定中清除 Notion Token 與所有 AI API Key 嗎？")) return;
  setBusy(true);
  try {
    await send("CLEAR_CREDENTIALS");
    notionToken.value = "";
    geminiKey.value = "";
    vertexKey.value = "";
    notionToken.placeholder = "secret_…";
    geminiKey.placeholder = "AIza…";
    vertexKey.placeholder = "AIza…";
    rememberNotionToken.checked = false;
    rememberGeminiKey.checked = false;
    rememberVertexKey.checked = false;
    showStatus("所有金鑰已清除。", "success");
  } catch (error) {
    showStatus(error.message, "error");
  } finally {
    setBusy(false);
  }
});

aiProvider.addEventListener("change", updateProviderUi);

// ==== Prompt and output-spec editing ====
function currentOutputSpec() {
  return normalizeFormOutputSpec(false);
}

function updateOutputSpecSummary() {
  const spec = currentOutputSpec();
  outputSpecSummary.textContent = `目前分析規格：標題最多 ${spec.titleMax} 字｜主題 ${spec.topicMin}～${spec.topicMax} 個｜關鍵字 ${spec.keywordCount} 個｜摘要 ${spec.summaryMin}～${spec.summaryMax} 字`;
}

for (const [key, limit] of Object.entries(OUTPUT_SPEC_LIMITS)) {
  limit.input.addEventListener("input", () => {
    const value = Number(limit.input.value);
    if (Number.isFinite(value) && value > limit.max) limit.input.value = String(limit.max);
    updateOutputSpecSummary();
  });
  limit.input.addEventListener("change", () => {
    limit.input.value = String(clampOutputValue(key, limit.input.value));
    updateOutputSpecSummary();
  });
}
document.querySelector("#reset-output-spec").addEventListener("click", () => {
  titleMax.value = DEFAULT_OUTPUT_SPEC.titleMax;
  topicMin.value = DEFAULT_OUTPUT_SPEC.topicMin;
  topicMax.value = DEFAULT_OUTPUT_SPEC.topicMax;
  keywordCount.value = DEFAULT_OUTPUT_SPEC.keywordCount;
  summaryMin.value = DEFAULT_OUTPUT_SPEC.summaryMin;
  summaryMax.value = DEFAULT_OUTPUT_SPEC.summaryMax;
  updateOutputSpecSummary();
  showStatus("輸出規格已恢復預設值；儲存後生效。", "info");
});
analysisPrompt.addEventListener("input", () => {
  promptCustomized = analysisPrompt.value.trim() !== defaultAnalysisPrompt.trim();
  promptState.textContent = promptCustomized ? "目前使用自訂提示詞；版本更新時會保留。" : "目前使用本版本預設提示詞。";
});
document.querySelector("#reset-prompt").addEventListener("click", () => {
  analysisPrompt.value = defaultAnalysisPrompt;
  promptCustomized = false;
  promptState.textContent = "已恢復本版本預設提示詞；儲存後生效。";
});
document.querySelector("#copy-prompt").addEventListener("click", async () => {
  await navigator.clipboard.writeText(analysisPrompt.value);
  showStatus("提示詞已複製。", "success");
});
document.querySelector("#preview-prompt").addEventListener("click", async () => {
  try {
    const result = await send("GET_PROMPT_PREVIEW", {
      prompt: analysisPrompt.value,
      customized: promptCustomized,
      outputSpec: currentOutputSpec()
    });
    promptPreview.textContent = result.prompt;
    promptPreview.hidden = !promptPreview.hidden;
  } catch (error) {
    showStatus(error.message, "error");
  }
});

// ==== Topic organizer rendering ====
/**
 * Unclassified AI 暫定主題 pills. Clicking one sets manualCandidateName and
 * re-renders the manual panel. Does not send messages.
 */
function renderUnclassifiedPills(manualItems, unclassified) {
  unclassifiedTopics.replaceChildren(...manualItems.map(item => {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = item.name;
    button.classList.toggle("active", item.name === manualCandidateName);
    button.addEventListener("click", () => {
      manualCandidateName = item.name;
      renderOrganizer();
    });
    return button;
  }));
  unclassifiedSummary.textContent = `本輪未分類 ${unclassified.length} 個暫定主題`;
  unclassifiedPanel.hidden = unclassified.length === 0;
}

/**
 * Manual panel for one unclassified AI 暫定主題. skip stays local; discard
 * / approve / replace / custom write Notion via resolveManualTopic.
 */
function renderManualReviewPanel(manualItems) {
  const manualItem = manualItems.find(item => item.name === manualCandidateName);
  manualTopicReview.hidden = !manualItem;
  if (manualItem) {
    const index = manualItems.indexOf(manualItem);
    manualTopicProgress.textContent = `人工確認 ${index + 1}／${manualItems.length}`;
    manualTopicName.textContent = manualItem.name;
    manualTopicImpact.textContent = `影響 ${manualItem.impactCount} 篇`;
    manualTopicNote.textContent = manualItem.permanentlyDiscarded
      ? "這個名稱先前已設為永久捨棄；再次確認後會從本批受影響頁面移除。"
      : "建立、改用既有或永久捨棄會立即完成處置；暫時跳過不會修改 Notion。";
    const previousSelection = manualExistingTopic.value;
    manualExistingTopic.replaceChildren(...(organizerData?.existingTopics ?? []).map(topic => {
      const option = document.createElement("option");
      option.value = topic;
      option.textContent = topic;
      return option;
    }));
    if ([...manualExistingTopic.options].some(option => option.value === previousSelection)) {
      manualExistingTopic.value = previousSelection;
    }
  }
}

/**
 * Status line for the organizer panel from organizerData: page/candidate
 * counts, remaining groups, unclassified AI 暫定主題, applied/skipped counts,
 * warnings, and apply progress. Local string only; does not send messages.
 */
function organizerSummaryText(unclassified) {
  if (!organizerData?.groups?.length) {
    return organizerData?.status === "cleared"
      ? "目前的整理建議已清除；Notion 主題、文章內容與本機主題字典都沒有變動。"
      : organizerData
      ? `已掃描 ${organizerData.pageCount} 篇頁面，讀取 ${organizerData.occurrenceCount} 次暫定主題（去重後 ${organizerData.candidateCount} 個）；${unclassified.length ? `本輪 ${unclassified.length} 個未找到合適分類。` : "目前沒有尚待確認的建議。"}`
      : "尚未產生建議。";
  }
  let text = `已掃描 ${organizerData.pageCount} 篇頁面，讀取 ${organizerData.occurrenceCount} 次暫定主題（去重後 ${organizerData.candidateCount} 個），尚有 ${organizerData.groups.length} 組建議待確認；本輪未分類 ${unclassified.length} 個。${organizerData.appliedCount ? ` 已套用 ${organizerData.appliedCount} 個暫定主題。` : ""}${organizerData.skippedCount ? ` 本次暫不處理 ${organizerData.skippedCount} 組。` : ""}`;
  if (organizerData.warnings?.length) {
    text += ` 另有 ${organizerData.warnings.length} 項安全提醒。`;
  }
  if (organizerData.progress) {
    text += ` 目前進度：${organizerData.progress.done}/${organizerData.progress.total}（${organizerData.status}）。`;
  }
  return text;
}

function updateRollbackButton() {
  document.querySelector("#rollback-topics").disabled = !organizerData?.canRollback;
}

/**
 * One organizer group card: standard name (may become confirmed AI 主題),
 * alias checkboxes for AI 暫定主題, skip via SKIP_TOPIC_GROUP. Draft
 * selected / selectedAliases / standardTopic live on the group object; skip
 * sends organizerData.groups to the background and persists them, as apply
 * does. They do not remain local until apply.
 */
function renderOrganizerGroupCard(group) {
  const card = document.createElement("article");
  card.className = `topic-group${group.selected ? " selected" : ""}`;
  const head = document.createElement("div");
  head.className = "topic-group-head";
  const selected = document.createElement("input");
  selected.type = "checkbox";
  selected.checked = Boolean(group.selected);
  selected.addEventListener("change", () => {
    group.selected = selected.checked;
    if (selected.checked && !(group.selectedAliases ?? []).length) {
      group.selectedAliases = [...(group.aliases ?? [])];
      renderOrganizer();
      return;
    }
    card.classList.toggle("selected", selected.checked);
  });
  const name = document.createElement("input");
  name.type = "text";
  name.value = group.standardTopic;
  name.setAttribute("aria-label", "標準主題名稱");
  name.addEventListener("input", () => { group.standardTopic = name.value.trim(); });
  const confidence = document.createElement("span");
  confidence.className = "confidence";
  confidence.textContent = `${group.confidence === "high" ? "高" : group.confidence === "medium" ? "中" : "低"}信心`;
  head.append(selected, name, confidence);
  const reason = document.createElement("p");
  reason.className = "hint";
  reason.textContent = `建議說明：${group.reason || group.definition || "未提供說明"}`;
  const source = document.createElement("p");
  source.className = "topic-source";
  source.textContent = (group.aliases ?? []).length > 1
    ? "可合併為此分類的暫定主題（可分開勾選）"
    : "建議加入此既有 AI 主題";
  const aliasList = document.createElement("div");
  aliasList.className = "alias-list";
  const selectedAliasKeys = new Set((group.selectedAliases ?? []).map(topic => topic.normalize("NFKC").toLocaleLowerCase("zh-Hant-TW")));
  aliasList.append(...(group.aliases ?? []).map(alias => {
    const label = document.createElement("label");
    const checkbox = document.createElement("input");
    const key = alias.normalize("NFKC").toLocaleLowerCase("zh-Hant-TW");
    checkbox.type = "checkbox";
    checkbox.checked = selectedAliasKeys.has(key);
    checkbox.addEventListener("change", () => {
      if (checkbox.checked) selectedAliasKeys.add(key);
      else selectedAliasKeys.delete(key);
      group.selectedAliases = (group.aliases ?? []).filter(topic =>
        selectedAliasKeys.has(topic.normalize("NFKC").toLocaleLowerCase("zh-Hant-TW"))
      );
    });
    label.append(checkbox, document.createTextNode(alias));
    return label;
  }));
  const separate = document.createElement("p");
  separate.className = "hint topic-separate";
  separate.textContent = (group.keepSeparate ?? []).length
    ? `建議保持獨立：${group.keepSeparate.join("、")}`
    : "";
  separate.hidden = !(group.keepSeparate ?? []).length;
  const impact = document.createElement("p");
  impact.className = "hint topic-impact";
  impact.textContent = `若套用，將更新 ${group.impactCount} 篇`;
  const skip = document.createElement("button");
  skip.type = "button";
  skip.className = "text-button topic-skip";
  skip.textContent = "暫不處理這個建議";
  skip.addEventListener("click", async () => {
    try {
      organizerData = await send("SKIP_TOPIC_GROUP", { groupId: group.id, groups: organizerData.groups });
      renderOrganizer();
      showStatus("這次先不處理；下次重新掃描時仍可能以其他方向出現。", "info");
    } catch (error) { showStatus(error.message, "error"); }
  });
  card.append(head, reason, source, aliasList, separate, impact, skip);
  return card;
}

/**
 * Rebuilds unclassified pills, the manual panel, group cards, summary, and
 * rollback enabled state from organizerData. Draft values (selected,
 * selectedAliases, standardTopic) live on those objects and are sent with
 * SKIP_TOPIC_GROUP as well as APPLY_TOPIC_GROUPS, so skip also persists them.
 */
function renderOrganizer() {
  topicGroups.replaceChildren();
  const unclassified = organizerData?.unclassified ?? [];
  const manualItems = organizerData?.manualItems ?? unclassified.map(name => ({ name, impactCount: 0 }));
  if (!manualItems.some(item => item.name === manualCandidateName)) {
    manualCandidateName = manualItems[0]?.name || "";
  }
  renderUnclassifiedPills(manualItems, unclassified);
  renderManualReviewPanel(manualItems);
  if (!organizerData?.groups?.length) {
    organizerSummary.textContent = organizerSummaryText(unclassified);
    updateRollbackButton();
    return;
  }
  organizerSummary.textContent = organizerSummaryText(unclassified);
  topicGroups.append(...organizerData.groups.map(group => renderOrganizerGroupCard(group)));
  updateRollbackButton();
}

// ==== Manual unclassified-topic resolution ====
/**
 * RESOLVE_ORGANIZER_UNCLASSIFIED. skip is local-only. discard permanently
 * removes the AI 暫定主題 from affected pages without adding AI 主題.
 * approve / replace / custom write pages like apply.
 */
async function resolveManualTopic(action) {
  const candidate = manualCandidateName;
  if (!candidate) return showStatus("目前沒有等待人工確認的暫定主題。", "error");
  if (action === "discard" && !confirm(`確定永久捨棄「${candidate}」嗎？它會從本批受影響頁面的 AI 暫定主題中移除，且不會新增正式主題。`)) return;
  try {
    organizerData = await send("RESOLVE_ORGANIZER_UNCLASSIFIED", {
      candidate,
      action,
      replacementTopic: manualExistingTopic.value,
      customTopic: manualCustomTopic.value.trim()
    });
    manualCustomTopic.value = "";
    renderOrganizer();
    showStatus(action === "skip"
      ? `已暫時跳過「${candidate}」，Notion 內容保持不變。`
      : `已處理「${candidate}」，並更新受影響頁面的剩餘暫定主題。`, action === "skip" ? "info" : "success");
  } catch (error) {
    showStatus(error.message, "error");
  }
}

document.querySelector("#manual-approve-topic").addEventListener("click", () => resolveManualTopic("approve"));
document.querySelector("#manual-use-existing").addEventListener("click", () => resolveManualTopic("replace"));
document.querySelector("#manual-use-custom").addEventListener("click", () => resolveManualTopic("custom"));
document.querySelector("#manual-discard-topic").addEventListener("click", () => resolveManualTopic("discard"));
document.querySelector("#manual-skip-topic").addEventListener("click", () => resolveManualTopic("skip"));

document.querySelector("#prepare-topics").addEventListener("click", async () => {
  setBusy(true);
  showStatus("正在收集最多 75 個去重後的 AI 暫定主題；不會讀取文章或其他 AI 欄位…", "info");
  try {
    await saveSettings(false);
    organizerData = await send("PREPARE_TOPIC_ORGANIZER");
    renderOrganizer();
    showStatus("整理建議已產生。無法安全分組的項目可在本輪未分類區逐項人工確認。", "success");
  } catch (error) { showStatus(error.message, "error"); }
  finally { setBusy(false); }
});
document.querySelector("#select-high").addEventListener("click", () => {
  for (const group of organizerData?.groups ?? []) {
    group.selected = group.confidence === "high";
    if (group.selected) group.selectedAliases = [...(group.aliases ?? [])];
  }
  renderOrganizer();
});
document.querySelector("#apply-topics").addEventListener("click", async () => {
  const selectedGroups = (organizerData?.groups ?? []).filter(group => group.selected && (group.selectedAliases ?? []).length);
  const count = selectedGroups.length;
  const candidateCount = selectedGroups.reduce((total, group) => total + group.selectedAliases.length, 0);
  if (!count) return showStatus("請先勾選至少一組建議，並保留至少一個暫定主題。", "error");
  if (!confirm(`確定套用 ${count} 組、共 ${candidateCount} 個暫定主題嗎？工具會批次更新受影響頁面，並保留可回復快照。`)) return;
  try {
    organizerData.status = "applying";
    renderOrganizer();
    organizerData = await send("APPLY_TOPIC_GROUPS", { groups: organizerData.groups });
    renderOrganizer();
    showStatus(
      organizerData.status === "applied" ? "已套用主題對照並更新本機字典。" : "尚未完成，可重新套用或回復。",
      organizerData.status === "applied" ? "success" : "info"
    );
  } catch (error) { showStatus(error.message, "error"); }
});
document.querySelector("#clear-topic-suggestions").addEventListener("click", async () => {
  if (!organizerData || !confirm("確定清除目前的主題整理建議嗎？這不會刪除 Notion 主題、不會改動文章，也不會清除本機主題字典。")) return;
  try {
    organizerData = await send("CLEAR_TOPIC_ORGANIZER");
    renderOrganizer();
    showStatus("目前的主題整理建議已清除。", "success");
  } catch (error) { showStatus(error.message, "error"); }
});
document.querySelector("#rollback-topics").addEventListener("click", async () => {
  if (!confirm("確定回復上一次主題套用嗎？新建的 Notion 選項不會自動刪除，但頁面內容與本機字典會復原。")) return;
  try {
    organizerData = await send("ROLLBACK_TOPIC_APPLY");
    renderOrganizer();
    showStatus("已回復上一次套用。", "success");
  } catch (error) { showStatus(error.message, "error"); }
});
// ==== Topic dictionary import and export ====
document.querySelector("#export-dictionary").addEventListener("click", async () => {
  try {
    const value = await send("EXPORT_TOPIC_DICTIONARY");
    const url = URL.createObjectURL(new Blob([JSON.stringify(value, null, 2)], { type: "application/json" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = `notion-ai-topic-dictionary-${new Date().toISOString().slice(0, 10)}.json`;
    link.click();
    URL.revokeObjectURL(url);
  } catch (error) { showStatus(error.message, "error"); }
});
importDictionaryTrigger.addEventListener("click", () => {
  closeImportModeMenu();
  importDictionary.click();
});
importModeToggle.addEventListener("click", () => {
  const opening = importModeMenu.hidden;
  importModeMenu.hidden = !opening;
  importModeToggle.setAttribute("aria-expanded", String(opening));
});
for (const option of importModeMenu.querySelectorAll(".split-btn__option")) {
  option.addEventListener("click", () => setImportMode(option.dataset.value));
}
document.addEventListener("mousedown", event => {
  if (!importSplitButton.contains(event.target)) closeImportModeMenu();
  for (const [select, controller] of enhancedSelects) {
    const root = select.closest(".custom-select");
    if (root && !root.contains(event.target)) controller.close();
  }
});
document.addEventListener("keydown", event => {
  if (event.key === "Escape") {
    closeImportModeMenu();
    closeEnhancedSelects();
  }
});
setImportMode(importMode.value);

importDictionary.addEventListener("change", async event => {
  const file = event.target.files?.[0];
  if (!file) return;
  try {
    const value = JSON.parse(await file.text());
    const preview = await send("PREVIEW_TOPIC_DICTIONARY_IMPORT", { value });
    const mode = importMode.value;
    if (!confirm(`字典包含 ${preview.incoming.length} 個主題：新增 ${preview.newCount}、更新 ${preview.updateCount}、衝突 ${preview.conflictCount}、不變 ${preview.unchangedCount}。確定${mode === "overwrite" ? "取代" : "合併"}嗎？`)) return;
    const result = await send("IMPORT_TOPIC_DICTIONARY", { value, mode });
    showStatus(`已匯入 ${result.imported} 個主題，目前字典共有 ${result.total} 個。`, "success");
  } catch (error) { showStatus(error.message, "error"); }
  finally { event.target.value = ""; }
});

void loadConfig();
