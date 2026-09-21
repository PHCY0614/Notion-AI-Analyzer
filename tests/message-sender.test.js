"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const root = path.resolve(__dirname, "..");
const CONFIG_KEY = "notionAiAnalyzerConfig";
const STATE_KEY = "notionAiAnalyzerState";
const EXTENSION_ID = "siftly-test-extension";

function source(name) {
  return fs.readFileSync(path.join(root, name), "utf8");
}

function storageArea(data) {
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
    }
  };
}

const localData = {
  [CONFIG_KEY]: {
    aiProvider: "gemini",
    analysisPrompt: "舊版自訂分析提示詞",
    analysisPromptCustomized: true,
    geminiModel: "gemini-test",
    notionTarget: "",
    promptBaseVersion: "old",
    rememberGeminiKey: true,
    rememberNotionToken: true,
    rememberVertexKey: false
  },
  [STATE_KEY]: {
    current: null,
    failed: [],
    mode: "idle",
    paused: true,
    queue: [],
    recent: [],
    running: false
  }
};

let messageListener = null;
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
      id: EXTENSION_ID,
      onInstalled: { addListener() {} },
      onMessage: { addListener(listener) { messageListener = listener; } },
      onStartup: { addListener() {} },
      async openOptionsPage() {}
    },
    storage: {
      local: storageArea(localData),
      session: {
        ...storageArea({}),
        async setAccessLevel() {}
      }
    }
  }
});

context.globalThis = context;
context.importScripts = (...names) => {
  for (const name of names) {
    vm.runInContext(source(name), context, { filename: name });
  }
};

function send(message, sender = { id: EXTENSION_ID }) {
  return new Promise(resolve => {
    const keepChannel = messageListener(message, sender, resolve);
    if (keepChannel === false && resolve) return;
  });
}

async function main() {
  vm.runInContext(source("background.js"), context, { filename: "background.js" });

  const trusted = await send({ type: "GET_STATUS" });
  assert.equal(trusted.ok, true, "popup/options messages from this extension must be accepted");
  assert.equal(typeof trusted.data.queueCount, "number");

  const foreign = await send({ type: "GET_STATUS" }, { id: "other-extension" });
  assert.equal(foreign.ok, false);
  assert.equal(foreign.error.code, "UNTRUSTED_SENDER");

  const missingSender = await send({ type: "GET_STATUS" }, {});
  assert.equal(missingSender.ok, false);
  assert.equal(missingSender.error.code, "UNTRUSTED_SENDER");

  const preview = await send({ type: "GET_PROMPT_PREVIEW", prompt: "x", customized: true });
  assert.equal(preview.ok, false);
  assert.equal(preview.error.code, "UNKNOWN_MESSAGE");

  const config = await send({ type: "GET_CONFIG" });
  assert.equal(config.ok, true);
  assert.equal(config.data.analysisPrompt, undefined);
  assert.equal(config.data.analysisPromptCustomized, undefined);
  assert.equal(config.data.promptBaseVersion, undefined);
  assert.equal(config.data.finalPromptPreview, undefined);
  assert.equal(config.data.defaultAnalysisPrompt, undefined);
  assert.equal(config.data.defaultPromptUpdated, undefined);
  assert.equal(config.data.geminiModel, "gemini-test");
  assert.equal(config.data.customPromptCleared, true);
  assert.equal(localData[CONFIG_KEY].analysisPrompt, "");
  assert.equal(localData[CONFIG_KEY].analysisPromptCustomized, false);
  assert.equal(localData[CONFIG_KEY].rememberGeminiKey, true);

  const saved = await send({
    type: "SAVE_SETTINGS",
    settings: {
      geminiModel: "gemini-test-2",
      analysisPrompt: "不應再寫入的自訂提示詞",
      analysisPromptCustomized: true
    }
  });
  assert.equal(saved.ok, true);
  assert.equal(saved.data.analysisPrompt, undefined);
  assert.equal(saved.data.analysisPromptCustomized, undefined);
  assert.equal(localData[CONFIG_KEY].analysisPromptCustomized, false);
  assert.equal(localData[CONFIG_KEY].analysisPrompt, "");
  assert.equal(localData[CONFIG_KEY].geminiModel, "gemini-test-2");
  assert.equal(localData[CONFIG_KEY].rememberGeminiKey, true);
  assert.equal(localData[CONFIG_KEY].rememberNotionToken, true);
  assert.equal(localData[CONFIG_KEY].rememberVertexKey, false);

  console.log("message sender tests passed");
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
