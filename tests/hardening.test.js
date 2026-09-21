"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const S = require(path.join(root, "shared.js"));
const G = require(path.join(root, "gemini.js"));

function source(name) {
  return fs.readFileSync(path.join(root, name), "utf8");
}

function testSafeNotionPageHref() {
  assert.equal(S.safeNotionPageHref("https://www.notion.so/page-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"), "https://www.notion.so/page-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
  assert.equal(S.safeNotionPageHref("https://notion.so/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"), "https://notion.so/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
  assert.equal(S.safeNotionPageHref("https://app.notion.com/workspace/page"), "https://app.notion.com/workspace/page");
  assert.equal(S.safeNotionPageHref("https://www.notion.site/public"), "https://www.notion.site/public");
  assert.equal(S.safeNotionPageHref("https://docs.notion.site/guide"), "https://docs.notion.site/guide");
  assert.equal(S.safeNotionPageHref("http://www.notion.so/page"), "");
  assert.equal(S.safeNotionPageHref("javascript:alert(1)"), "");
  assert.equal(S.safeNotionPageHref("https://example.com/"), "");
  assert.equal(S.safeNotionPageHref("https://evilnotion.so/page"), "");
  assert.equal(S.safeNotionPageHref("https://user:pass@www.notion.so/page"), "");
  assert.equal(S.safeNotionPageHref("https://not-notion.site/page"), "");
  assert.equal(S.safeNotionPageHref(""), "");

  const popup = source("popup.js");
  assert.match(popup, /AnalyzerShared\.safeNotionPageHref\(item\.url\)/);
  assert.match(source("popup.html"), /<script src="shared\.js"><\/script>/);
}

function testArticleCapAllowsChunking() {
  assert.equal(G.DIRECT_TEXT_LIMIT, 180000);
  assert.equal(G.CHUNK_TEXT_LIMIT, 78000);
  assert.match(source("background/constants.js"), /MAX_ARTICLE_CHARACTERS = 780000/);
  assert.ok(780000 > G.DIRECT_TEXT_LIMIT);
  assert.equal(780000, G.CHUNK_TEXT_LIMIT * 10);
  assert.match(source("background/analysis.js"), /S\.chunkText\(articleText, chunkTextLimit\)/);
}

function testRepoLinksAndPromptNotice() {
  for (const name of ["PRIVACY.md", "PRIVACY.zh-TW.md", "options.html", "README.md", "README.zh-TW.md"]) {
    assert.doesNotMatch(source(name), /Notion-AI-Analyzer/, `${name} still points at the old repository`);
  }
  assert.match(source("PRIVACY.md"), /https:\/\/github\.com\/PHCY0614\/siftly\/issues/);
  assert.match(source("PRIVACY.zh-TW.md"), /https:\/\/github\.com\/PHCY0614\/siftly\/issues/);
  assert.match(source("options.html"), /https:\/\/github\.com\/PHCY0614\/siftly\/blob\/main\/PRIVACY\.zh-TW\.md/);
  assert.match(source("options.html"), /id="custom-prompt-cleared-notice"/);
  assert.match(source("options.html"), /先前儲存的自訂分析指示已停用並清除/);
  assert.doesNotMatch(source("options.js"), /analysisPrompt|promptCustomized|GET_PROMPT_PREVIEW/);
}

function testInspectReadOnlySplit() {
  assert.match(source("background/topic-review.js"), /readyNotion\(\{ mutateSchema: false \}\)/);
  assert.match(source("background/settings.js"), /async function testConnections\(\)/);
  assert.match(source("background/settings.js"), /await readyNotion\(\)/);
  assert.match(source("background/messages.js"), /case "PREPARE_NOTION_STATUS_FIELD"/);
  assert.match(source("options.js"), /PREPARE_NOTION_STATUS_FIELD/);
}

testSafeNotionPageHref();
testArticleCapAllowsChunking();
testRepoLinksAndPromptNotice();
testInspectReadOnlySplit();
console.log("hardening tests passed");
