"use strict";

// Service worker: pending scan, queue processing, and queue commands.

// ==== Pending-page scanning ====
/**
 * Discovers Notion pages in 待分析 and 分析失敗 so the UI and batch queue
 * know what work exists. Used by the explicit scan flow, and by queueAll when
 * no fresh pending-scan cache is available. May update missing data source
 * schema through readyNotion; queries pending and failed pages. Does not call
 * AI or write analysis properties to article pages. Updates failed, recent,
 * knownPending, lastScanAt, pendingScan, databaseCheck, lastError, and stage.
 * Only a paused batch that already has queued work has its queue replaced;
 * otherwise the queue is cleared when nothing is in flight. Refuses to run
 * while an unpaused batch is actively processing. Status queries are bounded
 * by a 90s cancellation timeout.
 */
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
      queryPagesByStatus(config.dataSourceId, N.STATUS.pending, token, {
        signal,
        onProgress,
        maxPages: MAX_PENDING_PAGES,
        failOnLimit: true
      }),
      queryPagesByStatus(config.dataSourceId, N.STATUS.failed, token, {
        signal,
        onProgress,
        maxPages: MAX_FAILED_PAGES_TO_LOAD
      })
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

// ==== Queue state and UI-facing responses ====
function uniqueItems(items) {
  const seen = new Set();
  const result = [];
  for (const item of items ?? []) {
    if (!item?.id || seen.has(item.id)) continue;
    seen.add(item.id);
    result.push(sanitizeQueueItem(item));
  }
  return result.slice(0, MAX_PENDING_PAGES);
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
  stateCache.recent = [sanitizeHistoryItem({
    ...sanitizeQueueItem(item),
    analyzedAt: new Date().toISOString(),
    outcome: "success",
    ...extra
  }), ...stateCache.recent.filter(entry => entry.id !== item.id)].slice(0, MAX_RECENT);
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

// ==== Queue processing ====
/**
 * Wakes the service worker so processOne can drain the local queue. Uses both
 * chrome.alarms and a short setTimeout in case the worker sleeps. Does not
 * call AI or Notion; processOne still decides whether an item may run.
 */
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
    ...sanitizeQueueItem(item),
    code: error.code || "APP_ERROR",
    diagnostic: G.sanitizeDiagnostic(error.diagnostic),
    error: `${S.truncateMessage(error.message || "未知錯誤")}${statusError}`,
    failedAt: new Date().toISOString()
  };
  stateCache.failed = [sanitizeHistoryItem(failure), ...stateCache.failed.filter(entry => entry.id !== item.id)].slice(0, MAX_RECENT);
  stateCache.recent = [sanitizeHistoryItem({ ...failure, outcome: "failed" }), ...stateCache.recent.filter(entry => entry.id !== item.id)].slice(0, MAX_RECENT);
  stateCache.lastError = failure.error;
  decrementKnownPending(item);
}

/**
 * Runs the per-page pipeline for one queued item: mark 分析中, read blocks,
 * call AI, write the analysis draft, then record success or classify the error.
 *
 * Writes AI 標題, AI 關鍵字, AI 摘要, and AI 暫定主題. The batch path sets
 * 整理狀態 to 待主題整理 and leaves confirmed AI 主題 unchanged so the topic
 * organizer can apply taxonomy later. Single-page review (popup reanalysis)
 * writes 待主題確認, clears confirmed AI 主題, and opens topicReview: reanalysis
 * must invalidate previous final topics rather than leave stale confirmed
 * values beside new provisionals.
 *
 * Mutates current, running, lastError, stage, and (on the single path)
 * topicReview and paused; failed/recent/queue are updated through helpers.
 * stopRequested is checked after the 分析中 write, after the page read, and
 * after AI so a stop already requested at those boundaries is handled before
 * the next processing phase. The abort path requeues the item and attempts to
 * restore its Notion status to 待分析. Timeout, rate-limit, and setup errors
 * also requeue and pause; other errors record 分析失敗. A queue/database
 * mismatch drops the local queue without writing pages.
 */
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
    assertArticleSize(articleText);
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

/**
 * Serial worker that takes at most one queue item. Skips when paused, already
 * running, empty, or waiting on topicReview. After processItem, schedules the
 * next item unless paused. An unexpected throw requeues that item and pauses
 * so the rest of the batch does not continue blindly.
 */
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

// ==== Queue commands ====
/**
 * User command to start a batch: reuses a pending scan no more than two
 * minutes old, or calls scanPending. Notion readiness may update missing data
 * source schema. Does not call AI or write analysis results to article pages.
 * Blocked while a single-page topic review is open. When pages exist, enters
 * batch mode, unpauses, stores knownPending, and schedules processOne. When
 * no pages exist, returns idle and paused with the no-pending result.
 */
async function queueAll() {
  ensureNoTopicReview();
  const config = await readConfig();
  assertProviderReady(config);
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

/**
 * User command to pause the batch. Sets paused and mode paused. For an
 * in-flight item, sets stopRequested and aborts the active controller; the
 * processItem abort path then requeues the item and attempts to restore 待分析.
 * Does not itself guarantee that a draft write already in progress is skipped.
 */
async function stopAnalysis() {
  stateCache.paused = true;
  stateCache.stopRequested = Boolean(stateCache.current);
  stateCache.mode = "paused";
  await persistState();
  if (activeAbortController) activeAbortController.abort();
  return publicStatus();
}

/**
 * User command to continue a paused batch. Blocked while topicReview is open.
 * Clears pause, sets mode to batch, and schedules processOne when the queue
 * still has items. Does not call AI or Notion.
 */
async function resumeAnalysis() {
  ensureNoTopicReview();
  assertProviderReady(await readConfig());
  stateCache.paused = false;
  stateCache.stopRequested = false;
  stateCache.mode = "batch";
  await persistState();
  if (stateCache.queue.length) scheduleProcessing();
  return publicStatus();
}

/**
 * Rebuilds the queue from Notion pages marked 分析失敗 plus the local failed
 * list, then starts a batch. readyNotion may update missing data source schema.
 * Does not write analysis results to article pages or call AI until queued
 * work reaches processItem. Blocked while topicReview is open. Clears the
 * local failed list once those items are queued.
 */
async function retryFailed() {
  ensureNoTopicReview();
  assertProviderReady(await readConfig());
  const { config, token } = await readyNotion();
  const remoteFailed = await queryPagesByStatus(config.dataSourceId, N.STATUS.failed, token, {
    maxPages: MAX_FAILED_PAGES_TO_LOAD
  });
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
