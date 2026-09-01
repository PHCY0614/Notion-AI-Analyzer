"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const root = path.resolve(__dirname, "..");
const removedProvider = "open" + "router";
const removedProviderCamel = "open" + "Router";
const removedKey = `notionAiAnalyzer${"Open" + "Router"}Key`;
const localData = {
  notionAiAnalyzerConfig: {
    aiProvider: removedProvider,
    [`${removedProviderCamel}Model`]: `${removedProvider}/free`,
    [`remember${"Open" + "Router"}Key`]: true
  },
  notionAiAnalyzerState: {
    mode: "batch",
    paused: false,
    queue: [{ id: "queued-page", title: "queued" }],
    running: false
  },
  [removedKey]: "legacy-secret"
};
const sessionData = { [removedKey]: "legacy-session-secret" };
let messageListener = null;
let fetchCount = 0;

function storageArea(data, session = false) {
  return {
    async get(keys) {
      const names = Array.isArray(keys) ? keys : [keys];
      return Object.fromEntries(names.filter(name => Object.hasOwn(data, name)).map(name => [name, data[name]]));
    },
    async set(value) {
      Object.assign(data, structuredClone(value));
    },
    async remove(keys) {
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
    fetchCount += 1;
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
      local: storageArea(localData),
      session: storageArea(sessionData, true)
    }
  }
});

context.globalThis = context;
context.importScripts = (...names) => {
  for (const name of names) {
    vm.runInContext(fs.readFileSync(path.join(root, name), "utf8"), context, { filename: name });
  }
};

function send(message) {
  return new Promise(resolve => messageListener(message, {}, resolve));
}

async function main() {
  vm.runInContext(fs.readFileSync(path.join(root, "background.js"), "utf8"), context, {
    filename: "background.js"
  });
  for (let attempt = 0; attempt < 50 && localData.notionAiAnalyzerState.paused !== true; attempt += 1) {
    await new Promise(resolve => setTimeout(resolve, 5));
  }

  assert.equal(fetchCount, 0, "startup migration must not call Notion or an AI provider");
  assert.equal(localData[removedKey], undefined);
  assert.equal(sessionData[removedKey], undefined);
  assert.equal(localData.notionAiAnalyzerConfig.aiProvider, "gemini");
  assert.equal(localData.notionAiAnalyzerConfig.providerReselectionRequired, true);
  assert.ok(!Object.keys(localData.notionAiAnalyzerConfig).some(key => key.toLowerCase().includes(removedProvider)));
  assert.equal(localData.notionAiAnalyzerState.paused, true);
  assert.equal(localData.notionAiAnalyzerState.queue[0].id, "queued-page");

  const resume = await send({ type: "RESUME_ANALYSIS" });
  assert.equal(resume.ok, false);
  assert.equal(resume.error.code, "AI_PROVIDER_RESELECTION_REQUIRED");
  assert.equal(fetchCount, 0);

  const emptySave = await send({ type: "SAVE_SETTINGS", settings: {} });
  assert.equal(emptySave.ok, false);
  assert.equal(emptySave.error.code, "AI_PROVIDER_RESELECTION_REQUIRED");
  assert.equal(localData.notionAiAnalyzerConfig.providerReselectionRequired, true);

  const forgedSave = await send({
    type: "SAVE_SETTINGS",
    settings: { aiProvider: removedProvider }
  });
  assert.equal(forgedSave.ok, false);
  assert.equal(forgedSave.error.code, "AI_PROVIDER_INVALID");
  assert.equal(fetchCount, 0);

  const supportedSave = await send({
    type: "SAVE_SETTINGS",
    settings: { aiProvider: "gemini", geminiModel: "gemini-test" }
  });
  assert.equal(supportedSave.ok, true);
  assert.equal(supportedSave.data.providerReselectionRequired, false);
  assert.equal(localData.notionAiAnalyzerConfig.providerReselectionRequired, false);
  assert.equal(fetchCount, 0);

  let countedBody = null;
  context.fetch = async (_url, options) => {
    fetchCount += 1;
    countedBody = JSON.parse(options.body);
    return {
      headers: { get() { return null; } },
      ok: true,
      status: 200,
      async text() { return JSON.stringify({ totalTokens: 350001 }); }
    };
  };
  const beforeShort = fetchCount;
  await vm.runInContext(`assertAiInputTokenLimit(
    "gemini",
    "gemini-test",
    AnalyzerGemini.buildAnalysisRequest("字".repeat(1000)),
    { apiKey: "test-key" }
  )`, context);
  assert.equal(fetchCount, beforeShort, "ordinary-sized prompts must not add a countTokens request");

  let tokenError = null;
  try {
    await vm.runInContext(`assertAiInputTokenLimit(
      "gemini",
      "gemini-test",
      AnalyzerGemini.buildAnalysisRequest("字".repeat(80000)),
      { apiKey: "test-key" }
    )`, context);
  } catch (error) {
    tokenError = error;
  }
  assert.equal(tokenError?.code, "AI_INPUT_TOKEN_LIMIT");
  assert.ok(countedBody?.generateContentRequest?.systemInstruction);
  assert.ok(countedBody?.generateContentRequest?.contents);

  assert.doesNotThrow(() => vm.runInContext('assertArticleSize("字".repeat(120000))', context));
  let articleError = null;
  try {
    vm.runInContext('assertArticleSize("字".repeat(120001))', context);
  } catch (error) {
    articleError = error;
  }
  assert.equal(articleError?.code, "ARTICLE_TOO_LARGE");

  let queryCalls = 0;
  let queryBody = null;
  context.fetch = async (_url, options) => {
    queryCalls += 1;
    queryBody = JSON.parse(options.body);
    return {
      headers: { get() { return null; } },
      ok: true,
      status: 200,
      async text() {
        return JSON.stringify({
          has_more: true,
          next_cursor: "must-not-follow",
          results: [{ id: "one" }, { id: "two" }]
        });
      }
    };
  };
  let scanError = null;
  try {
    await vm.runInContext(`queryPagesByStatus("source", AnalyzerNotion.STATUS.pending, "token", {
      maxPages: 2,
      failOnLimit: true
    })`, context);
  } catch (error) {
    scanError = error;
  }
  assert.equal(scanError?.code, "PAGE_SCAN_LIMIT_EXCEEDED");
  assert.equal(queryCalls, 1);
  assert.equal(queryBody.page_size, 2);

  vm.runInContext("stateCache = clone(DEFAULT_STATE)", context);
  let rollbackPreflightError = null;
  try {
    vm.runInContext(`assertRollbackSnapshotSize({
      pages: [],
      snapshot: "x".repeat(5 * 1024 * 1024)
    })`, context);
  } catch (error) {
    rollbackPreflightError = error;
  }
  assert.equal(rollbackPreflightError?.code, "STATE_SIZE_LIMIT");
  assert.equal(vm.runInContext("stateCache.topicRollback", context), null);

  let stateError = null;
  try {
    await vm.runInContext(`stateCache = {
      ...clone(DEFAULT_STATE),
      current: { id: "must-survive" },
      topicRollback: { snapshot: "x".repeat(5 * 1024 * 1024) }
    }; persistState()`, context);
  } catch (error) {
    stateError = error;
  }
  assert.equal(stateError?.code, "STATE_SIZE_LIMIT");
  assert.equal(vm.runInContext("stateCache.current.id", context), "must-survive");
  assert.equal(vm.runInContext("stateCache.topicRollback.snapshot.length", context), 5 * 1024 * 1024);
  console.log("legacy provider migration tests passed");
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
