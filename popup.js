"use strict";

const setupWarning = document.querySelector("#setup-warning");
const runStatus = document.querySelector("#run-status");
const statusDot = document.querySelector("#status-dot");
const currentTitle = document.querySelector("#current-title");
const stageDetail = document.querySelector("#stage-detail");
const pendingCount = document.querySelector("#pending-count");
const queueCount = document.querySelector("#queue-count");
const failedCount = document.querySelector("#failed-count");
const errorBox = document.querySelector("#error-box");
const recentList = document.querySelector("#recent-list");
const topicReview = document.querySelector("#topic-review");
const reviewPageTitle = document.querySelector("#review-page-title");
const topicCandidate = document.querySelector("#topic-candidate");
const topicProgress = document.querySelector("#topic-progress");
const reviewExisting = document.querySelector("#review-existing");
const replacementTopic = document.querySelector("#replacement-topic");
const customTopic = document.querySelector("#custom-topic");
const rememberTopicMapping = document.querySelector("#remember-topic-mapping");

function enhanceTopicSelect(select) {
  return AnalyzerSelect.enhance(select, {
    extraRootClass: "custom-select--amber",
    emptyLabel: "請選擇主題",
    attachDocumentListeners: true
  });
}

const replacementTopicDropdown = enhanceTopicSelect(replacementTopic);
const buttons = {
  current: document.querySelector("#analyze-current"),
  all: document.querySelector("#analyze-all"),
  scan: document.querySelector("#scan"),
  queueControl: document.querySelector("#queue-control"),
  retry: document.querySelector("#retry"),
  approveTopic: document.querySelector("#approve-topic"),
  replaceTopic: document.querySelector("#replace-topic"),
  useCustomTopic: document.querySelector("#use-custom-topic"),
  discardTopic: document.querySelector("#discard-topic")
};
const organizeTopicsButton = document.querySelector("#organize-topics");
let configured = false;
let actionBusy = false;
let renderedReviewKey = "";
let currentPageInfo = null;
let currentSurface = "other";
let currentAction = "analyze";
let queueControlAction = "resume";

function currentPageAction(info) {
  if (!info) return { action: "analyze", label: "分析目前頁面" };
  if (info.status === "分析失敗") return { action: "retry", label: "重試目前頁面" };
  if (info.status === "待主題整理") return { action: "review", label: "整理主題" };
  if (info.status === "待主題確認") return { action: "review", label: "繼續確認主題" };
  if (info.status === "已分析" || info.analyzed) return { action: "reanalyze", label: "重新分析" };
  return { action: "analyze", label: "分析目前頁面" };
}

async function send(type, extra = {}) {
  const response = await chrome.runtime.sendMessage({ type, ...extra });
  if (!response?.ok) throw new Error(response?.error?.message || "操作失敗");
  return response.data;
}

function formatTime(value) {
  if (!value) return "";
  try {
    return new Intl.DateTimeFormat("zh-TW", {
      hour: "2-digit",
      minute: "2-digit",
      month: "numeric",
      day: "numeric"
    }).format(new Date(value));
  } catch {
    return "";
  }
}

function failureLog(item) {
  return JSON.stringify({
    extensionVersion: chrome.runtime.getManifest().version,
    page: {
      id: item.id || "",
      title: item.title || "未命名文章",
      url: item.url || ""
    },
    failure: {
      code: item.code || "",
      error: item.error || "",
      failedAt: item.failedAt || ""
    },
    ai: item.diagnostic || null
  }, null, 2);
}

async function copyText(value) {
  try {
    await navigator.clipboard.writeText(value);
    return;
  } catch {
    const textarea = document.createElement("textarea");
    textarea.value = value;
    textarea.setAttribute("readonly", "");
    textarea.style.position = "fixed";
    textarea.style.opacity = "0";
    document.body.append(textarea);
    textarea.select();
    const copied = document.execCommand("copy");
    textarea.remove();
    if (!copied) throw new Error("無法複製紀錄");
  }
}

function renderRecent(items) {
  if (!items?.length) {
    recentList.innerHTML = '<p class="empty">尚無分析紀錄</p>';
    return;
  }
  recentList.replaceChildren(...items.map(item => {
    const row = document.createElement("article");
    row.className = `recent-item${item.outcome === "failed" ? " failed" : ""}`;

    const title = document.createElement(item.url ? "a" : "span");
    title.className = "recent-title";
    title.textContent = item.title || "未命名文章";
    if (item.url) {
      title.href = item.url;
      title.target = "_blank";
      title.rel = "noreferrer";
    }

    const reanalyze = document.createElement("button");
    reanalyze.className = "reanalyze";
    reanalyze.type = "button";
    reanalyze.textContent = item.outcome === "failed" ? "重試" : "重新分析";
    reanalyze.addEventListener("click", () => {
      if (item.outcome !== "failed" && !confirm("重新分析會重新產生 AI 分析結果；既有 AI 主題將被清除，之後需要重新確認主題。確定繼續嗎？")) return;
      void runAction("REANALYZE_PAGE", { pageId: item.id, force: item.outcome !== "failed" });
    });

    const rowActions = document.createElement("div");
    rowActions.className = "recent-actions";
    rowActions.append(reanalyze);
    if (item.outcome === "failed" && item.diagnostic) {
      const copyLog = document.createElement("button");
      copyLog.className = "copy-log";
      copyLog.type = "button";
      copyLog.textContent = "複製 Log";
      copyLog.addEventListener("click", async () => {
        const original = copyLog.textContent;
        try {
          await copyText(failureLog(item));
          copyLog.textContent = "已複製";
        } catch {
          copyLog.textContent = "複製失敗";
        }
        setTimeout(() => { copyLog.textContent = original; }, 1600);
      });
      rowActions.append(copyLog);
    }

    const meta = document.createElement("span");
    meta.className = "recent-meta";
    meta.textContent = `${item.outcome === "failed" ? "分析失敗" : "已分析"} · ${formatTime(item.analyzedAt || item.failedAt)}`;

    row.append(title, rowActions, meta);
    if (item.error) {
      const error = document.createElement("span");
      error.className = "recent-error";
      error.textContent = item.error;
      row.append(error);
    }
    return row;
  }));
}

function renderTopicReview(review) {
  topicReview.hidden = !review;
  if (!review) {
    renderedReviewKey = "";
    return;
  }

  const item = review.item || {};
  reviewPageTitle.textContent = item.title || "未命名文章";
  if (item.url) {
    reviewPageTitle.href = item.url;
    reviewPageTitle.removeAttribute("aria-disabled");
  } else {
    reviewPageTitle.removeAttribute("href");
    reviewPageTitle.setAttribute("aria-disabled", "true");
  }
  topicCandidate.textContent = review.candidate || "未命名候選";
  topicProgress.textContent = review.candidateTotal > 1
    ? `候選主題 ${review.candidatePosition}/${review.candidateTotal}`
    : "候選主題";
  const retainedTopicChips = (review.existingTopics ?? []).map(name => {
    const chip = document.createElement("span");
    chip.className = "topic-chip";
    chip.textContent = name;
    return chip;
  });
  reviewExisting.classList.toggle("empty-topics", retainedTopicChips.length === 0);
  reviewExisting.replaceChildren(...(retainedTopicChips.length
    ? retainedTopicChips
    : [document.createTextNode("無")]));

  const reviewKey = `${item.id || ""}:${review.candidatePosition || 1}:${review.candidate || ""}`;
  const isNewReview = reviewKey !== renderedReviewKey;
  const previousReplacement = isNewReview ? "" : replacementTopic.value;
  if (isNewReview) {
    customTopic.value = "";
    renderedReviewKey = reviewKey;
  }

  const closestRanks = new Map(
    (review.closestExisting ?? []).map((name, index) => [
      name.toLocaleLowerCase("zh-Hant-TW"),
      index
    ])
  );
  const options = (review.topicOptions ?? [])
    .filter(option => option?.name)
    .sort((a, b) => {
      const aRank = closestRanks.get(a.name.toLocaleLowerCase("zh-Hant-TW"));
      const bRank = closestRanks.get(b.name.toLocaleLowerCase("zh-Hant-TW"));
      if (aRank === undefined && bRank === undefined) return 0;
      if (aRank === undefined) return 1;
      if (bRank === undefined) return -1;
      return aRank - bRank;
    })
    .map(option => {
      const element = document.createElement("option");
      element.value = option.name;
      element.textContent = option.name;
      return element;
    });
  replacementTopic.replaceChildren(...options);
  if (previousReplacement && options.some(option => option.value === previousReplacement)) {
    replacementTopic.value = previousReplacement;
  }
  replacementTopicDropdown.sync();
  buttons.replaceTopic.disabled = actionBusy || options.length === 0;
  buttons.useCustomTopic.disabled = actionBusy || !customTopic.value.trim();
  buttons.discardTopic.disabled = actionBusy || review.canDiscard === false;
  buttons.approveTopic.disabled = actionBusy;
}

function renderStatus(state) {
  const running = Boolean(state.running || state.current || state.stage);
  const paused = Boolean(state.paused);
  const reviewing = Boolean(state.topicReview);
  const batchActive = state.mode === "batch"
    && !paused
    && Boolean(state.running || state.current || state.queueCount);
  const singleActive = state.mode === "single_review"
    && !paused
    && Boolean(state.running || state.current || state.queueCount);
  const singlePage = currentSurface === "single";
  const databasePage = currentSurface === "database";
  const stageName = state.stage?.name || "";
  runStatus.textContent = reviewing ? "等待確認主題" : running && stageName ? stageName : running ? "分析中" : paused && state.queueCount ? "已暫停" : state.queueCount ? "等待處理" : "待命";
  statusDot.className = `dot${reviewing ? " review" : running ? " running" : paused && state.queueCount ? " paused" : ""}`;
  currentTitle.textContent = state.current
    ? `正在分析：${state.current.title || "未命名文章"}`
    : reviewing ? `等待確認：${state.topicReview.item?.title || "未命名文章"}` : "目前沒有正在分析的文章";
  if (state.stage?.startedAt) {
    const seconds = Math.max(0, Math.floor((Date.now() - new Date(state.stage.startedAt).getTime()) / 1000));
    const model = state.stage.model ? ` · ${state.stage.model}` : "";
    const progress = Number.isFinite(state.stage.progress) ? ` · 已讀取 ${state.stage.progress} 篇` : "";
    const detail = state.stage.detail ? ` · ${state.stage.detail}` : "";
    stageDetail.textContent = `${stageName}${model}${progress}${detail} · 已等待 ${seconds} 秒`;
    stageDetail.hidden = false;
  } else {
    stageDetail.hidden = true;
  }
  pendingCount.textContent = Number.isFinite(state.knownPending) ? String(state.knownPending) : "—";
  queueCount.textContent = String(state.queueCount || 0);
  failedCount.textContent = String(state.failed?.length || 0);
  const databaseMessage = state.databaseCheck?.message || "";
  const databaseMessageActive = Boolean(databaseMessage && state.lastError === databaseMessage);
  const visibleError = databaseMessageActive && !databasePage ? "" : state.lastError || "";
  errorBox.hidden = !visibleError;
  errorBox.textContent = visibleError;
  errorBox.classList.toggle("notice", databaseMessageActive);
  renderTopicReview(state.topicReview);
  renderRecent(state.recent);

  buttons.current.hidden = !singlePage;
  buttons.scan.hidden = !databasePage;
  buttons.all.hidden = !databasePage;
  buttons.retry.hidden = !databasePage;
  organizeTopicsButton.hidden = !databasePage;
  const canResumeBatch = databasePage && paused && Boolean(state.queueCount) && !reviewing;
  const databaseBlocked = databasePage && state.databaseCheck?.ready === false;
  const noPendingPages = databasePage && state.databaseCheck?.code === "NO_PENDING_PAGES";
  buttons.queueControl.hidden = !(databasePage || batchActive);
  buttons.queueControl.classList.toggle("wide-action", !databasePage && batchActive);
  queueControlAction = batchActive ? "stop" : "resume";
  buttons.queueControl.textContent = batchActive ? "停止分析" : "繼續分析";
  buttons.queueControl.title = batchActive
    ? "停止目前的批次分析"
    : canResumeBatch
      ? "繼續先前暫停的批次分析"
      : "目前沒有暫停中的分析佇列";

  buttons.queueControl.disabled = actionBusy || !(batchActive || canResumeBatch);
  buttons.retry.disabled = actionBusy || reviewing || !configured || running || batchActive || databaseBlocked;
  buttons.all.disabled = actionBusy || reviewing || !configured || running || batchActive || databaseBlocked || noPendingPages;
  buttons.scan.disabled = actionBusy || reviewing || !configured || running || batchActive;
  organizeTopicsButton.disabled = actionBusy || reviewing || !configured || running || batchActive || databaseBlocked;
  const pageAction = currentPageAction(currentPageInfo);
  currentAction = singleActive ? "stop" : pageAction.action;
  buttons.current.disabled = singleActive
    ? actionBusy
    : actionBusy || reviewing || !configured || running || !currentPageInfo;
  buttons.current.textContent = singleActive
    ? "停止分析"
    : pageAction.label;
}

async function inspectCurrentPage() {
  currentPageInfo = null;
  currentSurface = "other";
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const url = tab?.url || "";
    const isNotion = /^https:\/\/(?:www\.)?notion\.so\//i.test(url)
      || /^https:\/\/[^/]+\.notion\.site\//i.test(url)
      || /^https:\/\/app\.notion\.com\//i.test(url);
    if (!isNotion) return;
    currentSurface = "database";
    currentPageInfo = await send("INSPECT_PAGE", { pageId: url });
    currentSurface = "single";
  } catch {
    currentPageInfo = null;
  }
}

async function refresh() {
  try {
    const [config, state] = await Promise.all([send("GET_CONFIG"), send("GET_STATUS")]);
    configured = Boolean(config.notionTarget && config.hasNotionToken && config.hasAiKey && config.activeModel);
    setupWarning.hidden = configured;
    renderStatus(state);
  } catch (error) {
    errorBox.hidden = false;
    errorBox.textContent = error.message;
  }
}

async function runAction(type, extra = {}) {
  if (actionBusy) return;
  actionBusy = true;
  for (const button of Object.values(buttons)) button.disabled = true;
  errorBox.hidden = true;
  let actionError = "";
  try {
    const state = await send(type, extra);
    if (state?.recent) renderStatus(state);
  } catch (error) {
    actionError = error.message;
  } finally {
    actionBusy = false;
    if (["REVIEW_CURRENT_PAGE_TOPICS", "RESOLVE_TOPIC_REVIEW"].includes(type)) {
      await inspectCurrentPage();
    }
    await refresh();
    if (actionError && errorBox.hidden) {
      errorBox.classList.remove("notice");
      errorBox.hidden = false;
      errorBox.textContent = actionError;
    }
  }
}

buttons.current.addEventListener("click", () => {
  if (currentAction === "stop") {
    void runAction("STOP_ANALYSIS");
    return;
  }
  if (!currentPageInfo) return;
  if (currentAction === "review") {
    void runAction("REVIEW_CURRENT_PAGE_TOPICS", { pageId: currentPageInfo.id });
    return;
  }
  if (currentAction === "reanalyze"
    && !confirm("重新分析會重新產生 AI 分析結果；既有 AI 主題將被清除，之後需要重新確認主題。確定繼續嗎？")) return;
  void runAction("REANALYZE_PAGE", {
    pageId: currentPageInfo.id,
    force: currentAction === "reanalyze" || currentAction === "retry" || currentPageInfo.analyzed
  });
});
buttons.all.addEventListener("click", () => runAction("ANALYZE_ALL"));
buttons.scan.addEventListener("click", () => runAction("SCAN_PENDING"));
buttons.queueControl.addEventListener("click", () => runAction(
  queueControlAction === "stop" ? "STOP_ANALYSIS" : "RESUME_ANALYSIS"
));
buttons.retry.addEventListener("click", () => runAction("RETRY_FAILED"));
buttons.approveTopic.addEventListener("click", () => runAction("RESOLVE_TOPIC_REVIEW", {
  action: "approve",
  rememberMapping: rememberTopicMapping.checked
}));
buttons.replaceTopic.addEventListener("click", () => runAction("RESOLVE_TOPIC_REVIEW", {
  action: "replace",
  replacementTopic: replacementTopic.value,
  rememberMapping: rememberTopicMapping.checked
}));
buttons.useCustomTopic.addEventListener("click", () => runAction("RESOLVE_TOPIC_REVIEW", {
  action: "custom",
  customTopic: customTopic.value,
  rememberMapping: rememberTopicMapping.checked
}));
buttons.discardTopic.addEventListener("click", () => runAction("RESOLVE_TOPIC_REVIEW", { action: "skip" }));
customTopic.addEventListener("input", () => {
  buttons.useCustomTopic.disabled = actionBusy || !customTopic.value.trim();
});
document.querySelector("#settings").addEventListener("click", () => send("OPEN_OPTIONS"));
document.querySelector("#setup-link").addEventListener("click", () => send("OPEN_OPTIONS"));
document.querySelector("#clear-recent").addEventListener("click", () => runAction("CLEAR_RECENT"));
organizeTopicsButton.addEventListener("click", () => send("OPEN_OPTIONS"));

void (async () => { await inspectCurrentPage(); await refresh(); })();
setInterval(() => { if (!actionBusy) void refresh(); }, 1500);
