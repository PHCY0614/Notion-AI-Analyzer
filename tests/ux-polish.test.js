"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const root = path.resolve(__dirname, "..");

function source(name) {
  return fs.readFileSync(path.join(root, name), "utf8");
}

function testNotionStatusDialogHierarchy() {
  const html = source("options.html");
  const css = source("options.css");
  assert.match(html, /id="notion-status-dialog-message" class="confirm-dialog__message"/);
  assert.match(html, /id="notion-status-dialog-scope" class="confirm-dialog__scope"/);
  assert.match(html, /只會新增或補齊「整理狀態」這個欄位及分析流程需要的狀態選項；既有欄位、既有選項與文章內容都會保留。/);
  assert.match(source("options.js"), /找不到「整理狀態」欄位。要讓擴充功能自動建立這個欄位嗎？/);
  assert.match(css, /\.confirm-dialog__message \{[^}]*font-size:\s*15px;/s);
  assert.match(css, /\.confirm-dialog__scope \{[^}]*font-size:\s*13px;/s);
}

function testNotionWebAndFieldsTips() {
  const html = source("options.html");
  assert.match(html, /notion\.so 分頁/);
  assert.match(html, /Notion 桌面應用程式不受支援/);
  assert.match(html, /id="fields-view-tip"/);
  assert.match(html, /新欄位可能在既有資料庫檢視中被隱藏/);
  assert.doesNotMatch(html, /Views API|自動取消隱藏/);
  assert.match(source("options.js"), /若看不到新建欄位，請到 Notion 既有資料庫檢視中把它們顯示出來/);
}

function testDictionaryButtonFontMatches() {
  const css = source("options.css");
  assert.match(css, /\.dictionary-actions > \.button \{[^}]*font:\s*inherit;/s);
  assert.doesNotMatch(css, /\.dictionary-actions > \.button \{[^}]*font-size:\s*14px;/s);
  assert.doesNotMatch(css, /\.split-btn__trigger,\s*\.split-btn__arrow \{[^}]*font-size:\s*14px;/s);
}

function testApplyProgressUi() {
  const html = source("options.html");
  const css = source("options.css");
  const js = source("options.js");
  assert.match(html, /id="apply-progress"/);
  assert.match(css, /\.apply-progress__fill/);
  assert.match(js, /function updateApplyProgressUi\(/);
  assert.match(js, /GET_TOPIC_ORGANIZER/);
  assert.match(js, /正在寫入 Notion/);
}

function testThemeSuggestionFormatting() {
  const optionsJs = source("options.js");
  const optionsCss = source("options.css");
  const organizer = source("background/topic-organizer.js");
  assert.match(optionsJs, /function formatOrganizerReasonText\(/);
  assert.match(optionsJs, /function normalizeThemeNameQuotes\(/);
  assert.match(optionsJs, /function fillOrganizerReasonElement\(/);
  assert.match(optionsJs, /topic-group-reason/);
  assert.match(optionsJs, /topic-group-reason__label/);
  assert.match(optionsJs, /既有主題\\n說明：/);
  assert.match(optionsJs, /建議：/);
  assert.match(optionsJs, /createElement\("strong"\)/);
  assert.match(optionsJs, /refreshOrganizerAfterTargetChange/);
  assert.match(optionsJs, /config\.databaseChanged/);
  assert.match(optionsJs, /GET_TOPIC_ORGANIZER/);
  assert.match(optionsJs, /已有經使用者確認的主題對照/);
  assert.match(optionsCss, /\.topic-group-reason \{[^}]*white-space:\s*pre-line;/s);
  assert.match(optionsCss, /\.topic-group-reason__label \{[^}]*font-weight:\s*700;/s);
  assert.match(organizer, /建議：\$\{/);
  assert.match(organizer, /existing: true/);
  assert.doesNotMatch(organizer, /既有主題比對：/);
  assert.doesNotMatch(organizer, /reason: `已有經使用者確認的主題對照/);
  assert.match(source("prompt.js"), /keep_proposed reasons must name the closest unsuitable existing topic/);
  assert.match(source("prompt.js"), /與既有主題「/);
  assert.match(source("prompt.js"), /Use 「」 around topic names, never 『』|never 『』/);
  assert.match(source("prompt.js"), /reuse_existing reasons must briefly explain why reuse is appropriate/);

  // Behavioral checks for display formatting.
  const start = optionsJs.indexOf("function normalizeThemeNameQuotes");
  const end = optionsJs.indexOf("function updateApplyProgressUi");
  assert.ok(start >= 0 && end > start, "formatter helpers present");
  const sandbox = {
    console,
    document: {
      createElement(tag) {
        return {
          tagName: String(tag).toUpperCase(),
          className: "",
          textContent: "",
          childNodes: [],
          appendChild(node) { this.childNodes.push(node); return node; },
          replaceChildren(...nodes) { this.childNodes = nodes; }
        };
      },
      createTextNode(text) { return { nodeType: 3, textContent: String(text) }; }
    }
  };
  vm.createContext(sandbox);
  vm.runInContext(optionsJs.slice(start, end), sandbox);

  // 1) Layout A — different existing theme → 說明 + 建議；keep「與既有主題「…」」
  const layoutA = sandbox.formatOrganizerReasonText(
    "兩者皆與服飾穿著的實用指南及美學欣賞直接相關。；既有主題比對：與既有主題「生活日常」範圍不同，專注於服飾穿著的實用指南及美學欣賞。",
    { existing: false, standardTopic: "穿搭美學" }
  );
  assert.equal(
    layoutA,
    "說明：兩者皆與服飾穿著的實用指南及美學欣賞直接相關。\n建議：與既有主題「生活日常」範圍不同，專注於服飾穿著的實用指南及美學欣賞。"
  );
  assert.doesNotMatch(layoutA, /；/);
  assert.doesNotMatch(layoutA, /既有主題比對/);
  assert.match(layoutA, /與既有主題「生活日常」/);

  // 1b) already using「建議：」prefix
  assert.equal(
    sandbox.formatOrganizerReasonText(
      "皆與實際的旅遊經驗分享與行程攻略相關。；建議：與既有主題「生活日常」範圍不同，既有主題無法突顯旅遊攻略與行程經驗分享的專門檢索範疇。",
      { existing: false, standardTopic: "旅遊攻略" }
    ),
    "說明：皆與實際的旅遊經驗分享與行程攻略相關。\n建議：與既有主題「生活日常」範圍不同，既有主題無法突顯旅遊攻略與行程經驗分享的專門檢索範疇。"
  );

  // 2) Layout B — reuse: bold 既有主題 + stage-1 說明; drop stage-2 fluff
  const layoutB = sandbox.formatOrganizerReasonText(
    "皆探討社會階層結構、貴族現象與階級帶來的差異。；既有主題比對：與既有主題「社會觀察」範圍相符，可沿用既有主題。",
    { existing: false, standardTopic: "社會觀察" }
  );
  assert.equal(
    layoutB,
    "既有主題\n說明：皆探討社會階層結構、貴族現象與階級帶來的差異。"
  );
  assert.doesNotMatch(layoutB, /既有主題比對/);
  assert.doesNotMatch(layoutB, /；/);
  assert.doesNotMatch(layoutB, /建議：/);

  // 2b) messy user reports — first content segment only
  assert.equal(
    sandbox.formatOrganizerReasonText(
      "皆探討社會階層結構、貴族現象與階級帶來的差異。；探討社會階層結構、貴族現象與階級帶來的差異，符合社會現象與結構的觀察範疇。",
      { existing: true, standardTopic: "社會觀察" }
    ),
    "既有主題\n說明：皆探討社會階層結構、貴族現象與階級帶來的差異。"
  );
  assert.equal(
    sandbox.formatOrganizerReasonText(
      "這些主題皆環繞著人際互動與情感交流。；涵蓋人與人之間的互動與情感，與該主題的檢索範圍相符。",
      { existing: true, standardTopic: "人際關係" }
    ),
    "既有主題\n說明：這些主題皆環繞著人際互動與情感交流。"
  );

  // 2c) genuine stage-2 reuse rationale is kept as 建議
  assert.equal(
    sandbox.formatOrganizerReasonText(
      "皆探討社會階層結構、貴族現象與階級帶來的差異。；建議：讀者會以社會結構與階級關鍵字找到這批文章，與既有主題「社會觀察」的用途相符。",
      { existing: false, standardTopic: "社會觀察" }
    ),
    "既有主題\n說明：皆探討社會階層結構、貴族現象與階級帶來的差異。\n建議：讀者會以社會結構與階級關鍵字找到這批文章，與既有主題「社會觀察」的用途相符。"
  );

  // 2d) confirmed-mapping boilerplate must never be 說明/建議
  assert.equal(
    sandbox.formatOrganizerReasonText(
      "已有經使用者確認的主題對照「兩性情感」。",
      { existing: true, standardTopic: "兩性情感", definition: "探討兩性之間的情感互動、親密關係與溝通模式。" }
    ),
    "既有主題\n說明：探討兩性之間的情感互動、親密關係與溝通模式。"
  );
  assert.doesNotMatch(
    sandbox.formatOrganizerReasonText(
      "已有經使用者確認的主題對照「兩性情感」。",
      { existing: true, standardTopic: "兩性情感" }
    ),
    /已有經使用者確認/
  );

  assert.equal(
    sandbox.formatOrganizerReasonText("日常紀錄；既有主題比對（生活日常）：生活日常", { existing: true }),
    "既有主題\n說明：日常紀錄"
  );
  assert.equal(
    sandbox.formatOrganizerReasonText("偏旅行規劃；既有主題比對：與既有主題『旅行』範圍不同", { existing: false, standardTopic: "旅行規劃" }),
    "說明：偏旅行規劃\n建議：與既有主題「旅行」範圍不同"
  );
  assert.equal(
    sandbox.formatOrganizerReasonText("既有主題比對（生活日常）：生活日常", {}),
    "既有主題\n說明：未提供說明"
  );

  // 3) Bold styling for「既有主題」label
  const el = sandbox.document.createElement("p");
  sandbox.fillOrganizerReasonElement(
    el,
    "皆探討社會階層。；既有主題比對：與既有主題「社會觀察」範圍相符",
    { standardTopic: "社會觀察" }
  );
  assert.equal(el.childNodes[0].tagName, "STRONG");
  assert.equal(el.childNodes[0].className, "topic-group-reason__label");
  assert.equal(el.childNodes[0].textContent, "既有主題");
  assert.equal(el.childNodes[1].textContent, "\n");
  assert.match(el.childNodes[2].textContent, /^說明：/);
}

function testConfirmDialogBoldWeight() {
  const optionsCss = source("options.css");
  const popupCss = source("popup.css");
  assert.match(optionsCss, /\.confirm-dialog__body h2 \{[^}]*font-weight:\s*700;/s);
  assert.match(optionsCss, /\.confirm-dialog__message \{[^}]*font-weight:\s*400;/s);
  assert.match(popupCss, /\.confirm-dialog__body h2 \{[^}]*font-weight:\s*700;/s);
  assert.match(popupCss, /\.confirm-dialog__message \{[^}]*font-weight:\s*400;/s);
}

function testDictionaryDefinitionPreservation() {
  // Evaluate mergeDictionaryEntries logic via a minimal sandbox of the helpers it needs.
  const shared = fs.readFileSync(path.join(root, "shared.js"), "utf8");
  const notion = fs.readFileSync(path.join(root, "notion.js"), "utf8");
  const state = fs.readFileSync(path.join(root, "background/state.js"), "utf8");
  const organizer = fs.readFileSync(path.join(root, "background/topic-organizer.js"), "utf8");
  const sandbox = {
    console,
    chrome: { storage: { local: { get: async () => ({}), set: async () => {} } } },
    setTimeout,
    clearTimeout,
    AbortController,
    DOMException,
    TextEncoder,
    URL
  };
  vm.createContext(sandbox);
  vm.runInContext(shared, sandbox);
  vm.runInContext(notion, sandbox);
  // Minimal stubs expected by background modules
  vm.runInContext(`
    const S = globalThis.AnalyzerShared;
    const P = { normalizeOutputSpec: (v) => v || {} };
    const N = globalThis.AnalyzerNotion;
    const G = {
      TOPIC_ORGANIZER_BATCH_LIMIT: 75,
      isOrganizerTopicLabel: () => true
    };
    const CONFIG_KEY = "cfg";
    const STATE_KEY = "state";
    class AppError extends Error {
      constructor(message, options = {}) {
        super(message);
        Object.assign(this, options);
      }
    }
    function uniqueTopicNames(values) {
      const seen = new Set();
      return (values ?? []).filter(value => {
        const key = N.topicKey(value);
        if (!key || seen.has(key)) return false;
        seen.add(key);
        return true;
      });
    }
    function normalizeTopicDictionary(value) {
      if (!Array.isArray(value)) return [];
      const seen = new Set();
      return value.reduce((result, item) => {
        const name = S.cleanText(item?.name).slice(0, 100);
        const key = N.topicKey(name);
        if (!name || !key || seen.has(key) || result.length >= 500) return result;
        seen.add(key);
        result.push({
          name,
          definition: S.cleanText(item?.definition).slice(0, 500),
          aliases: uniqueTopicNames(item?.aliases ?? []).filter(alias => N.topicKey(alias) !== key).slice(0, 50),
          color: S.cleanText(item?.color) || N.topicColor(name),
          active: item?.active !== false
        });
        return result;
      }, []);
    }
  `, sandbox);
  const mergeSrc = organizer.match(/function mergeDictionaryEntries\([\s\S]*?\n\}/);
  assert.ok(mergeSrc, "mergeDictionaryEntries source");
  vm.runInContext(mergeSrc[0], sandbox);
  const merged = vm.runInContext(`mergeDictionaryEntries(
    [{ name: "旅遊", definition: "旅遊相關內容", aliases: ["旅行"], color: "blue", active: true }],
    [{ name: "旅遊", definition: "", aliases: ["出遊"], color: "blue", active: true }]
  )`, sandbox);
  assert.equal(merged[0].definition, "旅遊相關內容");
  assert.ok(merged[0].aliases.includes("出遊"));
  assert.match(organizer, /由主題整理套用建立的對照/);
  assert.match(organizer, /organizer\.existingTopics = uniqueTopicNames/);
}

function testRateLimitBackoffAndThrottle() {
  const transport = source("background/transport.js");
  const queue = source("background/queue.js");
  const constants = source("background/constants.js");
  assert.match(constants, /AI_STUDIO_PAGE_GAP_MS = 12000/);
  assert.match(constants, /已達 Google AI 速率或額度上限，請稍後再繼續/);
  assert.match(transport, /response\.status === 429 && attempt < 4/);
  assert.match(transport, /已達 Google AI 速率或額度上限，請稍後再繼續/);
  assert.match(queue, /AI_STUDIO_PAGE_GAP_MS/);
  assert.match(queue, /等待速率配額/);
  assert.match(queue, /AI_RATE_LIMIT_USER_MESSAGE/);
  assert.doesNotMatch(source("options.html"), /自訂 RPM|faster-vs-steadier|更快與更穩/);
}

testNotionStatusDialogHierarchy();
testNotionWebAndFieldsTips();
testDictionaryButtonFontMatches();
testApplyProgressUi();
testThemeSuggestionFormatting();
testConfirmDialogBoldWeight();
testDictionaryDefinitionPreservation();
testRateLimitBackoffAndThrottle();
console.log("ux polish tests passed");
