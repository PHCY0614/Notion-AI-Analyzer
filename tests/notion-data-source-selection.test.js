"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const root = path.resolve(__dirname, "..");
const CONFIG_KEY = "notionAiAnalyzerConfig";
const STATE_KEY = "notionAiAnalyzerState";
const TOKEN_KEY = "notionAiAnalyzerNotionToken";
const DB_A = "11111111-1111-4111-8111-111111111111";
const DB_B = "22222222-2222-4222-8222-222222222222";
const SOURCE_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const SOURCE_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

function source(name) {
  return fs.readFileSync(path.join(root, name), "utf8");
}

function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

function uuidFor(number) {
  const compact = number.toString(16).padStart(32, "0");
  return [
    compact.slice(0, 8),
    compact.slice(8, 12),
    `4${compact.slice(13, 16)}`,
    `8${compact.slice(17, 20)}`,
    compact.slice(20)
  ].join("-");
}

function dataSource(id, databaseId, title, extra = {}) {
  return {
    object: "data_source",
    id,
    parent: { type: "database_id", database_id: databaseId },
    title: title === null ? [] : [{ plain_text: title }],
    icon: { type: "emoji", emoji: "📚" },
    in_trash: false,
    ...extra
  };
}

function fetchResponse(data, status = 200, responseHeaders = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: {
      get(name) {
        return responseHeaders[String(name).toLowerCase()] ?? null;
      }
    },
    async text() {
      return JSON.stringify(data);
    }
  };
}

const localData = {
  [CONFIG_KEY]: {
    aiProvider: "gemini",
    dataSourceId: SOURCE_A,
    databaseId: DB_A,
    geminiModel: "gemini-test",
    notionTarget: `https://www.notion.so/${DB_A.replaceAll("-", "")}`,
    rememberGeminiKey: false,
    rememberNotionToken: false,
    rememberVertexKey: false,
    vertexModel: "gemini-test"
  },
  [STATE_KEY]: {
    current: null,
    failed: [],
    mode: "idle",
    paused: true,
    queue: [],
    recent: [],
    running: false,
    topicReview: null
  }
};
const sessionData = {};
const storageWrites = {
  localRemove: 0,
  localSet: 0,
  sessionRemove: 0,
  sessionSet: 0
};
let messageListener = null;

function storageArea(data, areaName, session = false) {
  return {
    async get(keys) {
      const names = Array.isArray(keys) ? keys : [keys];
      return Object.fromEntries(names.filter(name => Object.hasOwn(data, name)).map(name => [name, data[name]]));
    },
    async set(value) {
      storageWrites[`${areaName}Set`] += 1;
      Object.assign(data, structuredClone(value));
    },
    async remove(keys) {
      storageWrites[`${areaName}Remove`] += 1;
      for (const key of Array.isArray(keys) ? keys : [keys]) delete data[key];
    },
    ...(session ? { async setAccessLevel() {} } : {})
  };
}

const context = vm.createContext({
  AbortController,
  DOMException,
  TextDecoder,
  TextEncoder,
  URL,
  URLSearchParams,
  clearTimeout,
  console,
  fetch: async () => {
    throw new Error("unexpected network call");
  },
  setTimeout,
  structuredClone,
  chrome: {
    alarms: {
      create() {},
      onAlarm: { addListener() {} }
    },
    runtime: {
      onInstalled: { addListener() {} },
      onMessage: { addListener(listener) { messageListener = listener; } },
      onStartup: { addListener() {} },
      async openOptionsPage() {}
    },
    storage: {
      local: storageArea(localData, "local"),
      session: storageArea(sessionData, "session", true)
    }
  }
});

context.globalThis = context;
context.importScripts = (...names) => {
  for (const name of names) {
    vm.runInContext(source(name), context, { filename: name });
  }
};

function send(message) {
  return new Promise(resolve => messageListener(message, {}, resolve));
}

function resetStorageWrites() {
  for (const key of Object.keys(storageWrites)) storageWrites[key] = 0;
}

function assertNoStorageWrites() {
  assert.deepEqual(storageWrites, {
    localRemove: 0,
    localSet: 0,
    sessionRemove: 0,
    sessionSet: 0
  });
}

function setConfig(overrides = {}) {
  localData[CONFIG_KEY] = {
    aiProvider: "gemini",
    dataSourceId: SOURCE_A,
    databaseId: DB_A,
    geminiModel: "gemini-test",
    notionTarget: `https://www.notion.so/${DB_A.replaceAll("-", "")}`,
    rememberGeminiKey: false,
    rememberNotionToken: false,
    rememberVertexKey: false,
    vertexModel: "gemini-test",
    ...overrides
  };
}

function setState(overrides = {}) {
  const expression = `stateCache = {
    ...clone(DEFAULT_STATE),
    ${Object.entries(overrides).map(([key, value]) => `${key}: ${JSON.stringify(value)}`).join(",\n")}
  }`;
  vm.runInContext(expression, context);
}

function testNotionHelpers() {
  const N = require(path.join(root, "notion.js"));
  assert.deepEqual(N.dataSourceSearchPayload(), {
    page_size: 100,
    filter: {
      property: "object",
      value: "data_source",
      in_trash: false
    }
  });
  assert.equal(N.dataSourceSearchPayload("opaque cursor").start_cursor, "opaque cursor");

  assert.deepEqual(N.dataSourceSummary(dataSource(SOURCE_A, DB_A, "內容資料庫")), {
    id: SOURCE_A,
    databaseId: DB_A,
    title: "內容資料庫",
    emoji: "📚"
  });
  assert.equal(N.dataSourceSummary(dataSource(SOURCE_A, DB_A, null)).title, "未命名資料庫");
  assert.equal(N.dataSourceSummary(dataSource(SOURCE_A, DB_A, null, { title: {} })).title, "未命名資料庫");
  assert.equal(N.dataSourceSummary(dataSource(SOURCE_A, DB_A, "已刪除", { in_trash: true })), null);
  assert.equal(N.dataSourceSummary({ object: "data_source", id: SOURCE_A, title: [] }), null);
  assert.equal(N.dataSourceSummary({ object: "database", id: SOURCE_A, parent: { database_id: DB_A } }), null);
  assert.equal(
    N.dataSourceSummary(dataSource(SOURCE_A, DB_A, "外部圖示", {
      icon: { type: "external", external: { url: "https://example.com/private.png" } }
    })).emoji,
    ""
  );

  const missingStatus = N.statusFieldSetupPlan({});
  assert.equal(missingStatus.changed, true);
  assert.equal(missingStatus.created, true);
  assert.deepEqual(
    missingStatus.properties[N.PROPERTY_NAMES.processingStatus].select.options,
    N.STATUS_OPTIONS
  );

  const customOption = { id: "custom-option-id", name: "自行整理", color: "purple" };
  const missingPending = N.statusFieldSetupPlan({
    [N.PROPERTY_NAMES.processingStatus]: {
      type: "select",
      select: { options: [customOption] }
    }
  });
  assert.equal(missingPending.changed, true);
  assert.equal(missingPending.created, false);
  assert.deepEqual(
    missingPending.properties[N.PROPERTY_NAMES.processingStatus].select.options[0],
    { id: customOption.id }
  );
  assert.ok(missingPending.addedOptions.includes(N.STATUS.pending));

  const completeStatus = N.statusFieldSetupPlan({
    [N.PROPERTY_NAMES.processingStatus]: {
      type: "select",
      select: { options: N.STATUS_OPTIONS }
    }
  });
  assert.equal(completeStatus.changed, false);
  assert.deepEqual(completeStatus.properties, {});

  const wrongType = N.statusFieldSetupPlan({
    [N.PROPERTY_NAMES.processingStatus]: { type: "status", status: {} }
  });
  assert.equal(wrongType.changed, false);
  assert.equal(wrongType.setupIssue.code, "NOTION_STATUS_FIELD_TYPE");
}

async function testOneTimeTokenPaginationAndMinimization() {
  delete localData[TOKEN_KEY];
  delete sessionData[TOKEN_KEY];
  const requests = [];
  const rawSecret = "must-not-return";
  context.fetch = async (url, options) => {
    requests.push({ url, options: plain(options) });
    if (requests.length === 1) {
      return fetchResponse({
        has_more: true,
        next_cursor: "opaque cursor",
        results: [
          dataSource(SOURCE_B, DB_A, "資料庫 10", {
            schema: { secret: rawSecret },
            description: [{ plain_text: rawSecret }],
            cover: { external: { url: `https://example.com/${rawSecret}` } }
          }),
          dataSource(SOURCE_A, DB_A, "資料庫 2"),
          dataSource(SOURCE_A, DB_A, "重複項目"),
          dataSource(uuidFor(3), DB_B, null, {
            icon: { type: "external", external: { url: "https://example.com/icon.png" } }
          }),
          { object: "data_source", id: uuidFor(4), title: [] },
          dataSource(uuidFor(5), DB_B, "垃圾桶", { in_trash: true })
        ]
      });
    }
    return fetchResponse({
      has_more: false,
      next_cursor: null,
      results: [
        dataSource(uuidFor(6), DB_A, "資料庫 2")
      ]
    });
  };

  const configBefore = plain(localData[CONFIG_KEY]);
  const stateBefore = plain(localData[STATE_KEY]);
  resetStorageWrites();
  const response = await send({
    type: "LIST_NOTION_DATA_SOURCES",
    notionToken: "draft-token"
  });
  assert.equal(response.ok, true);
  assert.equal(requests.length, 2);
  assert.equal(requests[0].url, "https://api.notion.com/v1/search");
  assert.equal(requests[0].options.method, "POST");
  assert.equal(requests[0].options.headers.Authorization, "Bearer draft-token");
  assert.equal(requests[1].options.headers.Authorization, "Bearer draft-token");
  assert.deepEqual(JSON.parse(requests[0].options.body), {
    page_size: 100,
    filter: {
      property: "object",
      value: "data_source",
      in_trash: false
    }
  });
  assert.equal(JSON.parse(requests[1].options.body).start_cursor, "opaque cursor");
  assert.equal(response.data.dataSources.length, 4);
  assert.equal(response.data.limitReached, false);
  assert.equal(new Set(response.data.dataSources.map(item => item.id)).size, 4);
  assert.equal(response.data.dataSources.filter(item => item.databaseId === DB_A).length, 3);
  const collator = new Intl.Collator("zh-Hant-TW", { numeric: true, sensitivity: "base" });
  const sorted = [...response.data.dataSources].sort((left, right) => (
    collator.compare(left.title, right.title) || left.id.localeCompare(right.id)
  ));
  assert.deepEqual(plain(response.data.dataSources), plain(sorted));
  assert.ok(requests.every(request => request.url.endsWith("/v1/search") && request.options.method === "POST"));
  for (const item of response.data.dataSources) {
    assert.deepEqual(Object.keys(item).sort(), ["databaseId", "emoji", "id", "title"]);
  }
  assert.ok(!JSON.stringify(response).includes(rawSecret));
  assert.deepEqual(localData[CONFIG_KEY], configBefore);
  assert.deepEqual(localData[STATE_KEY], stateBefore);
  assert.equal(localData[TOKEN_KEY], undefined);
  assert.equal(sessionData[TOKEN_KEY], undefined);
  assertNoStorageWrites();
}

async function testStoredTokenFallbacksAndEmptyResult() {
  let authorization = "";
  context.fetch = async (_url, options) => {
    authorization = options.headers.Authorization;
    return fetchResponse({ has_more: false, next_cursor: null, results: [] });
  };

  sessionData[TOKEN_KEY] = "session-token";
  localData[TOKEN_KEY] = "local-token";
  resetStorageWrites();
  let response = await send({ type: "LIST_NOTION_DATA_SOURCES", notionToken: "" });
  assert.equal(response.ok, true);
  assert.equal(authorization, "Bearer session-token");
  assert.deepEqual(plain(response.data.dataSources), []);
  assertNoStorageWrites();

  delete sessionData[TOKEN_KEY];
  resetStorageWrites();
  response = await send({ type: "LIST_NOTION_DATA_SOURCES" });
  assert.equal(response.ok, true);
  assert.equal(authorization, "Bearer local-token");
  assertNoStorageWrites();

  delete localData[TOKEN_KEY];
  resetStorageWrites();
  response = await send({ type: "LIST_NOTION_DATA_SOURCES" });
  assert.equal(response.ok, false);
  assert.equal(response.error.code, "NOTION_TOKEN_MISSING");
  assertNoStorageWrites();
}

async function testLimitAndRepeatedCursor() {
  let calls = 0;
  context.fetch = async () => {
    calls += 1;
    const offset = (calls - 1) * 100;
    return fetchResponse({
      has_more: true,
      next_cursor: `cursor-${calls}`,
      results: Array.from({ length: 100 }, (_, index) => (
        dataSource(uuidFor(offset + index + 10), DB_A, `資料庫 ${offset + index + 1}`)
      ))
    });
  };
  let response = await send({ type: "LIST_NOTION_DATA_SOURCES", notionToken: "draft-token" });
  assert.equal(response.ok, true);
  assert.equal(calls, 3);
  assert.equal(response.data.dataSources.length, 300);
  assert.equal(response.data.limitReached, true);

  calls = 0;
  context.fetch = async () => {
    calls += 1;
    return fetchResponse({
      has_more: true,
      next_cursor: "repeated",
      results: [dataSource(uuidFor(400 + calls), DB_A, `重複游標 ${calls}`)]
    });
  };
  response = await send({ type: "LIST_NOTION_DATA_SOURCES", notionToken: "draft-token" });
  assert.equal(response.ok, true);
  assert.equal(calls, 2);
  assert.equal(response.data.dataSources.length, 2);
}

async function testSafeErrors() {
  const cases = [
    { expression: 'new AppError("RAW 401", { code: "NOTION_AUTH", status: 401 })', code: "NOTION_AUTH", text: "Token 無效" },
    { expression: 'new AppError("RAW 403", { code: "NOTION_AUTH", status: 403 })', code: "NOTION_AUTH", text: "權限不足" },
    { expression: 'new AppError("RAW 429", { code: "NOTION_RATE_LIMIT", status: 429 })', code: "NOTION_RATE_LIMIT", text: "過於頻繁" },
    { expression: 'new AppError("RAW 529", { code: "NOTION_API", status: 529 })', code: "NOTION_API", text: "暫時無法使用" },
    { expression: 'new AppError("RAW network", { code: "NOTION_NETWORK" })', code: "NOTION_NETWORK", text: "檢查網路" }
  ];
  for (const item of cases) {
    const safe = vm.runInContext(`safeNotionDataSourceListError(${item.expression})`, context);
    assert.equal(safe.code, item.code);
    assert.match(safe.message, new RegExp(item.text));
    assert.doesNotMatch(safe.message, /RAW/);
  }

  context.fetch = async () => fetchResponse({
    code: "unauthorized",
    message: "RAW secret diagnostic"
  }, 401);
  const response = await send({ type: "LIST_NOTION_DATA_SOURCES", notionToken: "bad-token" });
  assert.equal(response.ok, false);
  assert.equal(response.error.code, "NOTION_AUTH");
  assert.doesNotMatch(JSON.stringify(response), /RAW secret diagnostic|bad-token/);
}

async function testSameTargetAndDatabaseChangeGuards() {
  const databaseUrl = `https://www.notion.so/${DB_A.replaceAll("-", "")}`;
  setConfig({ notionTarget: databaseUrl, dataSourceId: SOURCE_A, databaseId: DB_A });
  setState({ queue: [{ id: "keep-me" }] });
  let response = await send({
    type: "SAVE_SETTINGS",
    settings: { notionTarget: SOURCE_A.replaceAll("-", "") }
  });
  assert.equal(response.ok, true);
  assert.equal(response.data.databaseChanged, false);
  assert.equal(response.data.dataSourceId, SOURCE_A);
  assert.equal(vm.runInContext("stateCache.queue.length", context), 1);

  setConfig({ notionTarget: SOURCE_A, dataSourceId: SOURCE_A, databaseId: DB_A });
  setState({
    queue: [{ id: "remove-me" }],
    recent: [{ id: "recent" }],
    topicOrganizer: { version: 10 }
  });
  response = await send({
    type: "SAVE_SETTINGS",
    settings: { notionTarget: SOURCE_B }
  });
  assert.equal(response.ok, true);
  assert.equal(response.data.databaseChanged, true);
  assert.equal(response.data.dataSourceId, "");
  assert.equal(vm.runInContext("stateCache.queue.length", context), 0);
  assert.equal(vm.runInContext("stateCache.recent.length", context), 0);
  assert.equal(vm.runInContext("stateCache.topicOrganizer", context), null);

  const manualDatabaseUrl = `https://www.notion.so/${DB_B.replaceAll("-", "")}`;
  setConfig({ notionTarget: SOURCE_A, dataSourceId: SOURCE_A, databaseId: DB_A });
  setState();
  response = await send({
    type: "SAVE_SETTINGS",
    settings: { notionTarget: manualDatabaseUrl }
  });
  assert.equal(response.ok, true);
  assert.equal(response.data.databaseChanged, true);
  assert.equal(response.data.notionTarget, manualDatabaseUrl);

  for (const blockedState of [
    { topicReview: { version: 2 } },
    { running: true },
    { current: { id: "current-page" } }
  ]) {
    setConfig({ notionTarget: SOURCE_A, dataSourceId: SOURCE_A, databaseId: DB_A });
    setState(blockedState);
    const configBefore = plain(localData[CONFIG_KEY]);
    resetStorageWrites();
    response = await send({
      type: "SAVE_SETTINGS",
      settings: { notionTarget: SOURCE_B, notionToken: "must-not-store" }
    });
    assert.equal(response.ok, false);
    assert.ok(["TOPIC_REVIEW_PENDING", "DATABASE_CHANGE_WHILE_RUNNING"].includes(response.error.code));
    assert.deepEqual(localData[CONFIG_KEY], configBefore);
    assert.equal(localData[TOKEN_KEY], undefined);
    assert.equal(sessionData[TOKEN_KEY], undefined);
    assertNoStorageWrites();
  }
}

async function testConfirmedStatusFieldPreparation() {
  const N = require(path.join(root, "notion.js"));
  setConfig({ notionTarget: SOURCE_A, dataSourceId: SOURCE_A, databaseId: DB_A });
  setState();
  sessionData[TOKEN_KEY] = "session-token";
  let properties = { Name: { type: "title", title: {} } };
  const requests = [];
  context.fetch = async (url, options) => {
    const request = { url, options: plain(options) };
    requests.push(request);
    if (options.method === "GET") {
      return fetchResponse(dataSource(SOURCE_A, DB_A, "內容資料庫", { properties }));
    }
    if (options.method === "PATCH") {
      const body = JSON.parse(options.body);
      properties = { ...properties, ...body.properties };
      return fetchResponse(dataSource(SOURCE_A, DB_A, "內容資料庫", { properties }));
    }
    throw new Error(`unexpected request: ${options.method} ${url}`);
  };

  let response = await send({ type: "TEST_CONNECTIONS" });
  assert.equal(response.ok, false);
  assert.equal(response.error.code, "NOTION_STATUS_FIELD_MISSING");
  assert.equal(requests.filter(request => request.options.method === "PATCH").length, 0);

  requests.length = 0;
  response = await send({ type: "PREPARE_NOTION_STATUS_FIELD" });
  assert.equal(response.ok, true);
  assert.equal(response.data.created, true);
  assert.equal(response.data.changed, true);
  assert.ok(response.data.addedOptions.includes(N.STATUS.pending));
  const patchRequests = requests.filter(request => request.options.method === "PATCH");
  assert.equal(patchRequests.length, 1);
  const patchBody = JSON.parse(patchRequests[0].options.body);
  assert.deepEqual(Object.keys(patchBody.properties), [N.PROPERTY_NAMES.processingStatus]);
  assert.deepEqual(
    patchBody.properties[N.PROPERTY_NAMES.processingStatus].select.options,
    N.STATUS_OPTIONS
  );

  requests.length = 0;
  response = await send({ type: "PREPARE_NOTION_STATUS_FIELD" });
  assert.equal(response.ok, true);
  assert.equal(response.data.changed, false);
  assert.equal(requests.filter(request => request.options.method === "PATCH").length, 0);

  properties = {
    ...properties,
    [N.PROPERTY_NAMES.processingStatus]: { type: "status", status: {} }
  };
  requests.length = 0;
  response = await send({ type: "PREPARE_NOTION_STATUS_FIELD" });
  assert.equal(response.ok, false);
  assert.equal(response.error.code, "NOTION_STATUS_FIELD_TYPE");
  assert.equal(requests.filter(request => request.options.method === "PATCH").length, 0);
}

function testRepositoryGuards() {
  const transport = source("background/transport.js");
  const listFunction = transport.slice(
    transport.indexOf("async function listNotionDataSources"),
    transport.indexOf("// ==== AI transport ====")
  );
  assert.doesNotMatch(listFunction, /writeConfig|persistState|storeSecret|ensureSchema/);
  assert.match(listFunction, /MAX_NOTION_DATA_SOURCES/);
  const messages = source("background/messages.js");
  assert.match(messages, /case "LIST_NOTION_DATA_SOURCES"/);
  assert.match(messages, /case "PREPARE_NOTION_STATUS_FIELD"/);

  const options = source("options.js");
  const loadConfig = options.slice(options.indexOf("async function loadConfig"), options.indexOf("function compactTargetId"));
  assert.doesNotMatch(loadConfig, /LIST_NOTION_DATA_SOURCES/);
  assert.match(options, /notionDataSourcesLoading/);
  assert.ok(options.includes("placeholder.disabled = true"));
  assert.match(options, /notionTarget[.]dispatchEvent/);
  assert.match(options, /aiProvider,\s+notionDataSourceSelect,\s+geminiModel/);
  assert.match(options, /enhancedSelects[.]get\(notionDataSourceSelect\)[?][.]sync\(\)/);
  assert.match(options, /error[.]code = response[?][.]error[?][.]code/);
  assert.match(options, /confirmNotionStatusPreparation/);
  assert.match(options, /notionStatusDialog[.]showModal\(\)/);
  assert.match(options, /PREPARE_NOTION_STATUS_FIELD/);

  const html = source("options.html");
  assert.match(html, /id="notion-data-source-status"[^>]*aria-live="polite"/);
  assert.match(html, /<details class="notion-advanced">/);
  assert.match(html, /Notion 中既有內容不會被刪除/);
  assert.match(html, /id="notion-status-dialog"/);
  assert.match(html, /value="cancel" autofocus>暫不新增/);
  assert.match(html, /value="confirm">新增並繼續/);

  const manifest = JSON.parse(source("manifest.json"));
  assert.equal(manifest.version, "1.1.0");
  assert.deepEqual(manifest.permissions, ["storage", "alarms", "activeTab"]);
  assert.deepEqual(manifest.host_permissions, [
    "https://api.notion.com/*",
    "https://generativelanguage.googleapis.com/*",
    "https://aiplatform.googleapis.com/*"
  ]);
}

async function main() {
  testNotionHelpers();
  vm.runInContext(source("background.js"), context, { filename: "background.js" });
  await send({ type: "GET_CONFIG" });
  resetStorageWrites();

  await testOneTimeTokenPaginationAndMinimization();
  await testStoredTokenFallbacksAndEmptyResult();
  await testLimitAndRepeatedCursor();
  await testSafeErrors();
  await testSameTargetAndDatabaseChangeGuards();
  await testConfirmedStatusFieldPreparation();
  testRepositoryGuards();
  console.log("Notion data source selection tests passed");
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
