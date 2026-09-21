"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");

function source(name) {
  return fs.readFileSync(path.join(root, name), "utf8");
}

function importedScripts(entry = "background.js") {
  const text = source(entry);
  const match = text.match(/importScripts\(([\s\S]*?)\)/);
  assert.ok(match, `${entry} must load scripts with importScripts()`);
  return [...match[1].matchAll(/"([^"]+\.js)"/g)].map(item => item[1]);
}

function serviceWorkerSource() {
  return [source("background.js"), ...importedScripts().map(source)].join("\n");
}

function testManifestAndEntrypoint() {
  const manifest = JSON.parse(source("manifest.json"));
  assert.equal(manifest.manifest_version, 3);
  assert.equal(manifest.background.service_worker, "background.js");
  assert.equal(manifest.background.type, undefined, "service worker stays a classic script, not an ES module");
  assert.equal(manifest.version, "1.1.0");
}

function testImportMap() {
  const imported = importedScripts();
  assert.deepEqual(imported, [
    "shared.js",
    "prompt.js",
    "notion.js",
    "gemini.js",
    "background/constants.js",
    "background/state.js",
    "background/transport.js",
    "background/settings.js",
    "background/analysis.js",
    "background/queue.js",
    "background/topic-organizer.js",
    "background/topic-review.js",
    "background/messages.js"
  ]);
  for (const name of imported) {
    assert.equal(fs.existsSync(path.join(root, name)), true, `missing imported script: ${name}`);
  }

  const entry = source("background.js");
  assert.match(entry, /chrome\.runtime\.onMessage\.addListener/);
  assert.match(entry, /chrome\.alarms\.onAlarm\.addListener/);
  assert.match(entry, /chrome\.runtime\.onInstalled\.addListener/);
  assert.match(entry, /chrome\.runtime\.onStartup\.addListener/);
  assert.match(entry, /void initialize\(\);/);
  assert.doesNotMatch(entry, /\bexport\b|\bimport\s+/);
}

function testCriticalWiring() {
  const messages = source("background/messages.js");
  for (const action of [
    "GET_STATUS",
    "GET_CONFIG",
    "LIST_NOTION_DATA_SOURCES",
    "SAVE_SETTINGS",
    "TEST_CONNECTIONS",
    "PREPARE_NOTION_STATUS_FIELD",
    "SCAN_PENDING",
    "ANALYZE_ALL",
    "STOP_ANALYSIS",
    "RESUME_ANALYSIS",
    "RETRY_FAILED",
    "PREPARE_TOPIC_ORGANIZER",
    "APPLY_TOPIC_GROUPS",
    "ROLLBACK_TOPIC_APPLY",
    "RESOLVE_TOPIC_REVIEW",
    "GET_PROMPT_PREVIEW"
  ]) {
    assert.match(messages, new RegExp(`case "${action}"`));
  }

  const sw = serviceWorkerSource();
  assert.match(sw, /MAX_ARTICLE_CHARACTERS = 120000/);
  assert.match(sw, /assertArticleSize\(articleText\)/);
  assert.match(sw, /MAX_INPUT_TOKENS = 350000/);
  assert.match(sw, /:countTokens/);
  assert.match(sw, /MAX_PENDING_PAGES = 2000/);
  assert.match(sw, /MAX_FAILED_PAGES_TO_LOAD = 40/);
  assert.match(sw, /MAX_PERSISTED_STATE_BYTES = 4 \* 1024 \* 1024/);
  assert.match(sw, /new TextEncoder\(\)\.encode\(JSON\.stringify/);
  assert.match(sw, /CONFIG_KEY = "notionAiAnalyzerConfig"/);
  assert.match(sw, /STATE_KEY = "notionAiAnalyzerState"/);
  assert.match(sw, /PROCESS_ALARM = "notion-ai-analyzer-process"/);
}

function testListSourcesStaysReadOnly() {
  const transport = source("background/transport.js");
  const listFunction = transport.slice(
    transport.indexOf("async function listNotionDataSources"),
    transport.indexOf("// ==== AI transport ====")
  );
  assert.notEqual(transport.indexOf("async function listNotionDataSources"), -1);
  assert.notEqual(transport.indexOf("// ==== AI transport ===="), -1);
  assert.doesNotMatch(listFunction, /writeConfig|persistState|storeSecret|ensureSchema/);
  assert.match(listFunction, /MAX_NOTION_DATA_SOURCES/);
}

testManifestAndEntrypoint();
testImportMap();
testCriticalWiring();
testListSourcesStaysReadOnly();
console.log("service worker module tests passed");
