"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const SUBTITLE = "AI Content Organiser for Notion";
const OLD_PRODUCT_NAME = /Notion AI Analyzer|Notion AI 分析工具|AI 分析工具/;

function source(name) {
  return fs.readFileSync(path.join(root, name), "utf8");
}

function testManifestBrand() {
  const manifest = JSON.parse(source("manifest.json"));
  assert.equal(manifest.name, "Siftly");
  assert.equal(manifest.action.default_title, "Siftly");
  assert.equal(manifest.description, SUBTITLE);
  assert.match(manifest.description, /Organiser/);
  assert.doesNotMatch(manifest.description, /Organizer/);
  assert.ok(manifest.description.length <= 132, "Chrome Web Store short description limit is 132 characters");
}

function testUserFacingCopy() {
  const files = [
    "popup.html",
    "options.html",
    "README.md",
    "README.zh-TW.md",
    "PRIVACY.md",
    "PRIVACY.zh-TW.md",
    "AGENTS.md"
  ];
  for (const name of files) {
    const text = source(name);
    assert.match(text, /Siftly/, `${name} must mention Siftly`);
    assert.doesNotMatch(text, OLD_PRODUCT_NAME, `${name} still uses the old product name`);
  }

  for (const name of ["popup.html", "options.html", "README.md", "README.zh-TW.md", "PRIVACY.md", "PRIVACY.zh-TW.md"]) {
    const text = source(name);
    assert.match(text, /AI Content Organiser for Notion/, `${name} must use the store subtitle`);
    assert.doesNotMatch(text, /AI Content Organizer for Notion/, `${name} must use British Organiser`);
  }
}

function testRuntimeKeysUnchanged() {
  const constants = source("background/constants.js");
  assert.match(constants, /CONFIG_KEY = "notionAiAnalyzerConfig"/);
  assert.match(constants, /STATE_KEY = "notionAiAnalyzerState"/);
  assert.match(constants, /NOTION_TOKEN_KEY = "notionAiAnalyzerNotionToken"/);
  assert.match(constants, /GEMINI_KEY_KEY = "notionAiAnalyzerGeminiKey"/);
  assert.match(constants, /VERTEX_KEY_KEY = "notionAiAnalyzerVertexKey"/);
  assert.match(constants, /PROCESS_ALARM = "notion-ai-analyzer-process"/);
}

testManifestBrand();
testUserFacingCopy();
testRuntimeKeysUnchanged();
console.log("branding tests passed");
