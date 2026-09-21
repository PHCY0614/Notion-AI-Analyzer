"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const G = require(path.join(root, "gemini.js"));
const N = require(path.join(root, "notion.js"));

function source(name) {
  return fs.readFileSync(path.join(root, name), "utf8");
}

function importedScripts(entry = "background.js") {
  const match = source(entry).match(/importScripts\(([\s\S]*?)\)/);
  return match ? [...match[1].matchAll(/"([^"]+\.js)"/g)].map(item => item[1]) : [];
}

function serviceWorkerSource() {
  return [source("background.js"), ...importedScripts().map(source)].join("\n");
}

function testOutputCap() {
  const payloads = [
    G.buildAnalysisRequest("article"),
    G.buildRepairRequest("bad", ["error"]),
    G.buildChunkRequest("chunk", 1, 1),
    G.buildChunkRepairRequest("bad", ["error"]),
    G.buildTopicOrganizerRequest(["主題一"]),
    G.buildTopicStandardMatcherRequest(
      [{ group_id: "group_1", proposed_topic: "主題一", source_topics: ["來源一", "來源二"] }],
      [{ name: "既有主題" }]
    ),
    G.generationPayload("system", "user", {}, { maxOutputTokens: 999999 })
  ];
  assert.equal(G.MAX_OUTPUT_TOKENS, 8192);
  for (const payload of payloads) {
    assert.ok(payload.generationConfig.maxOutputTokens <= G.MAX_OUTPUT_TOKENS);
  }
}

function testDiagnosticsExcludeContent() {
  const canary = "PRIVATE_AI_OUTPUT_CANARY";
  const response = {
    candidates: [{
      content: { parts: [{ text: canary }] },
      finishReason: "STOP",
      safetyRatings: [{ category: "SAFE", probability: "LOW", blocked: false }]
    }],
    usageMetadata: { promptTokenCount: 123, totalTokenCount: 456 }
  };
  const fresh = G.responseDiagnostic(response, canary);
  assert.equal(fresh.outputCharacterCount, canary.length);
  assert.ok(!JSON.stringify(fresh).includes(canary));
  assert.ok(!Object.hasOwn(fresh, "rawOutput"));
  assert.equal(G.responseDiagnostic({
    candidates: [{ finishReason: canary }],
    promptFeedback: { blockReason: canary }
  }).finishReason, "");

  const legacy = G.sanitizeDiagnostic({
    model: "gemini-test",
    provider: "gemini",
    validationErrors: [`bad: ${canary}`],
    attempts: [{ attempt: 1, rawOutput: canary, finishReason: "STOP" }]
  });
  assert.equal(legacy.validationErrorCount, 1);
  assert.equal(legacy.attempts[0].outputCharacterCount, canary.length);
  assert.ok(!JSON.stringify(legacy).includes(canary));
}

function testBoundedPageSummaries() {
  const title = "標".repeat(900);
  const page = {
    id: "page-id",
    url: `https://www.notion.so/${"x".repeat(2500)}`,
    properties: { Name: { type: "title", title: [{ plain_text: title }] } }
  };
  const summary = N.pageSummary(page);
  assert.equal(summary.title.length, 500);
  assert.equal(N.MAX_STORED_PAGE_TITLE_CHARACTERS, 500);
  assert.equal(summary.url.length, 2000);
  assert.equal(N.queryPayload(N.STATUS.pending, "", 999).page_size, 100);
  assert.equal(N.queryPayload(N.STATUS.pending, "", 40).page_size, 40);
}

function testRepositoryGuards() {
  const background = serviceWorkerSource();
  assert.match(background, /MAX_ARTICLE_CHARACTERS = 120000/);
  assert.match(background, /assertArticleSize\(articleText\)/);
  assert.match(background, /MAX_INPUT_TOKENS = 350000/);
  assert.match(background, /:countTokens/);
  assert.match(background, /MAX_PENDING_PAGES = 2000/);
  assert.match(background, /MAX_FAILED_PAGES_TO_LOAD = 40/);
  assert.match(background, /MAX_PERSISTED_STATE_BYTES = 4 \* 1024 \* 1024/);
  assert.match(background, /new TextEncoder\(\)\.encode\(JSON\.stringify/);
  assert.doesNotMatch(background, /openrouter\.ai/i);

  const manifest = JSON.parse(source("manifest.json"));
  assert.deepEqual(manifest.host_permissions, [
    "https://api.notion.com/*",
    "https://generativelanguage.googleapis.com/*",
    "https://aiplatform.googleapis.com/*"
  ]);

  for (const name of ["options.html", "options.js", "README.md", "README.zh-TW.md", "PRIVACY.md", "PRIVACY.zh-TW.md"]) {
    assert.doesNotMatch(source(name), /openrouter/i, `${name} still advertises the removed provider`);
  }

  const popup = source("popup.js");
  const logFunction = popup.slice(popup.indexOf("function failureLog"), popup.indexOf("async function copyText"));
  assert.doesNotMatch(logFunction, /item\.(?:id|title|url|error)|rawOutput/);

  const normalizedPrompt = source("prompt.js").replace(/\r\n/g, "\n");
  const promptHash = crypto.createHash("sha256").update(normalizedPrompt).digest("hex").toUpperCase();
  assert.equal(promptHash, "22C652000655892B43B3F7FD5F4E01AB170AAD44B660FC53FD592479E593CF50");
}

function testAdvancedSettingsHidePromptControls() {
  const html = source("options.html");
  const options = source("options.js");
  assert.match(html, /<section class="panel" id="advanced-settings" aria-labelledby="advanced-heading">/);
  assert.match(html, /<span class="step">4<\/span>[\s\S]*<h2 id="advanced-heading">進階分析設定<\/h2>/);
  assert.match(html, /id="reset-output-spec"/);
  for (const id of ["analysis-prompt", "reset-prompt", "copy-prompt", "preview-prompt", "prompt-state", "prompt-preview"]) {
    assert.doesNotMatch(html, new RegExp(`id="${id}"`));
  }
  assert.doesNotMatch(options, /analysisPrompt|promptCustomized|GET_PROMPT_PREVIEW/);
}

function testCustomSelectArrow() {
  const uiSelect = source("ui-select.js");
  assert.doesNotMatch(uiSelect, /⌄/);
  assert.match(uiSelect, /createElementNS\("http:\/\/www\.w3\.org\/2000\/svg", "svg"\)/);
  for (const attribute of [
    ["width", "11"],
    ["height", "11"],
    ["viewBox", "0 0 12 12"],
    ["fill", "none"],
    ["stroke", "currentColor"],
    ["stroke-width", "2.2"],
    ["stroke-linecap", "round"],
    ["stroke-linejoin", "round"],
    ["aria-hidden", "true"]
  ]) {
    assert.match(uiSelect, new RegExp(`setAttribute\\("${attribute[0]}", "${attribute[1]}"\\)`));
  }
  assert.match(uiSelect, /createElementNS\("http:\/\/www\.w3\.org\/2000\/svg", "polyline"\)/);
  assert.match(uiSelect, /setAttribute\("points", "2,4 6,8 10,4"\)/);
  assert.match(source("options.css"), /\.custom-select__arrow \{[^}]*flex: 0 0 11px;[^}]*width: 11px;[^}]*height: 11px;/);
  assert.match(source("popup.css"), /\.custom-select__arrow \{[^}]*flex: 0 0 11px;[^}]*width: 11px;[^}]*height: 11px;/);
}

testOutputCap();
testDiagnosticsExcludeContent();
testBoundedPageSummaries();
testRepositoryGuards();
testAdvancedSettingsHidePromptControls();
testCustomSelectArrow();
console.log("security regression tests passed");
