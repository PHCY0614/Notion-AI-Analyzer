"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const EN_SUBTITLE = "AI Content Organiser for Notion";
const ZH_SUBTITLE = "Notion x AI 內容整理工具";
const OLD_PRODUCT_NAME = /Notion AI Analyzer|Notion AI 分析工具|AI 分析工具/;

function source(name) {
  return fs.readFileSync(path.join(root, name), "utf8");
}

function testManifestBrand() {
  const manifest = JSON.parse(source("manifest.json"));
  assert.equal(manifest.name, "Siftly");
  assert.equal(manifest.action.default_title, "Siftly");
  assert.equal(manifest.description, EN_SUBTITLE);
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

  const englishFiles = ["README.md", "PRIVACY.md"];
  for (const name of englishFiles) {
    const text = source(name);
    assert.match(text, new RegExp(EN_SUBTITLE), `${name} must use the English subtitle`);
    assert.doesNotMatch(text, /AI Content Organizer for Notion/, `${name} must use British Organiser`);
    assert.doesNotMatch(text, new RegExp(ZH_SUBTITLE), `${name} should not use the Chinese subtitle`);
  }

  const chineseFiles = ["popup.html", "options.html", "README.zh-TW.md", "PRIVACY.zh-TW.md"];
  for (const name of chineseFiles) {
    const text = source(name);
    assert.match(text, new RegExp(ZH_SUBTITLE), `${name} must use the Chinese subtitle`);
    assert.doesNotMatch(text, new RegExp(EN_SUBTITLE), `${name} should not use the English subtitle`);
  }
}

function testSettingsPageCopy() {
  const html = source("options.html");
  const css = source("options.css");
  const popup = source("popup.html");
  const popupCss = source("popup.css");

  assert.match(html, /class="hero-title-row"/);
  assert.match(popup, /class="hero-title-row"/);
  assert.match(html, /class="hero-subtitle">Notion x AI 內容整理工具</);
  assert.match(popup, /class="hero-subtitle">Notion x AI 內容整理工具</);
  assert.doesNotMatch(html, /class="eyebrow"/);
  assert.doesNotMatch(popup, /class="eyebrow"/);
  assert.match(css, /\.hero-subtitle \{[\s\S]*?font-size: 17px;/);
  assert.match(css, /\.hero-summary \{[\s\S]*?font-size: 16px;/);
  assert.match(popupCss, /\.hero-subtitle \{[\s\S]*?font-size: 14px;/);

  assert.match(html, /整理主題時只傳送主題名稱，不傳送完整文章/);
  assert.match(html, /不經過開發者營運的中介伺服器/);
  assert.doesNotMatch(html, /分析提示詞/);

  assert.match(html, /id="fields-heading">準備 Notion 欄位/);
  assert.match(html, /這個工具會用到的欄位，不會影響你的內容與現有欄位。/);
  assert.match(
    html,
    /按「測試連線並準備欄位」會補齊缺少的欄位；缺少「整理狀態」時會先詢問，接著請在 Notion 把文章標成「待分析」，才能開始整理。分析後工具會先寫暫定主題，正式主題須你確認整理後才寫入。/
  );
  assert.doesNotMatch(html, /<small>(?:rich_text|select|multi_select)<\/small>/);
  assert.doesNotMatch(html, /必要欄位檢查通過後/);
  assert.doesNotMatch(html, /狀態流程：/);

  assert.match(html, /把暫定主題收成可共用的分類，再由你確認。/);
  assert.match(
    html,
    /適合已有穩定分類的資料庫。開啟後，只要能由既有主題合理涵蓋，就會優先建議沿用；不適合時仍可建立新主題。/
  );
  assert.doesNotMatch(html, /75 個去重/);
  assert.doesNotMatch(html, /下次掃描建議時生效/);
  assert.match(html, /Notion 中既有內容不會被刪除/);
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
testSettingsPageCopy();
testRuntimeKeysUnchanged();
console.log("branding tests passed");
