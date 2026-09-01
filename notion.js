(function attachAnalyzerNotion(root, factory) {
  const shared = typeof module === "object" && module.exports
    ? require("./shared.js")
    : root.AnalyzerShared;
  const api = factory(shared);
  if (typeof module === "object" && module.exports) {
    module.exports = api;
  } else {
    root.AnalyzerNotion = api;
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function createAnalyzerNotion(shared) {
  "use strict";

  const API_VERSION = "2026-03-11";
  const MAX_STORED_PAGE_TITLE_CHARACTERS = 500;
  const PROPERTY_NAMES = Object.freeze({
    aiTitle: "AI 標題",
    aiTopics: "AI 主題",
    provisionalTopics: "AI 暫定主題",
    aiKeywords: "AI 關鍵字",
    aiSummary: "AI 摘要",
    processingStatus: "整理狀態"
  });
  const STATUS = Object.freeze({
    pending: "待分析",
    processing: "分析中",
    topicOrganize: "待主題整理",
    topicReview: "待主題確認",
    analyzed: "已分析",
    failed: "分析失敗"
  });
  const STATUS_OPTIONS = Object.freeze([
    { name: STATUS.pending, color: "yellow" },
    { name: STATUS.processing, color: "blue" },
    { name: STATUS.topicOrganize, color: "orange" },
    { name: STATUS.topicReview, color: "orange" },
    { name: STATUS.analyzed, color: "green" },
    { name: STATUS.failed, color: "red" }
  ]);
  const DATABASE_SETUP_MESSAGES = Object.freeze({
    statusFieldMissing: "找不到「整理狀態」欄位。請在 Notion 資料庫新增一個名為「整理狀態」的選取欄位，並加入「待分析」選項。",
    statusFieldType: "「整理狀態」欄位類型不正確。請將它設定為 Select，並加入「待分析」選項。",
    pendingOptionMissing: "「整理狀態」尚未加入「待分析」選項。請先在 Notion 加入「待分析」，再將想分析的文章設為「待分析」。",
    noPendingPages: "目前沒有待分析文章。請先在 Notion 將要處理文章的「整理狀態」設為「待分析」。"
  });
  const EXPECTED_TYPES = Object.freeze({
    [PROPERTY_NAMES.aiTitle]: "rich_text",
    [PROPERTY_NAMES.aiTopics]: "multi_select",
    [PROPERTY_NAMES.provisionalTopics]: "rich_text",
    [PROPERTY_NAMES.aiKeywords]: "rich_text",
    [PROPERTY_NAMES.aiSummary]: "rich_text",
    [PROPERTY_NAMES.processingStatus]: "select"
  });
  const TOPIC_COLOR_RULES = Object.freeze([
    { color: "red", terms: ["戰爭", "軍事衝突", "武裝衝突", "犯罪", "災難", "暴力"] },
    { color: "brown", terms: ["環境", "生態環境", "農業", "土地", "自然資源", "氣候", "能源"] },
    { color: "gray", terms: ["政治", "國際", "地緣", "外交", "全球供應鏈", "公共政策", "國家治理"] },
    { color: "yellow", terms: ["階級", "資本", "殖民", "投資", "商業", "金融", "市場", "產業", "貿易"] },
    { color: "green", terms: ["心境", "情感", "生離死別", "心靈", "心理", "情緒", "創傷", "成長", "人生抉擇"] },
    { color: "pink", terms: ["社交", "八卦", "婚姻", "權力關係", "性別", "人際", "親密", "家庭", "愛情"] },
    { color: "purple", terms: ["美髮", "保養", "寵物", "造型", "穿搭", "衛生", "美容", "護膚", "彩妝"] },
    { color: "orange", terms: ["社群", "遊戲", "生物辨識", "隱私", "數位", "網路", "平台", "科技", "資安", "人工智慧", "生活日常"] },
    { color: "blue", terms: ["神祕學", "生物學", "歷史", "社會變遷", "飲食文化", "古董", "文化", "教育", "科學", "學術"] }
  ]);

  function analysisPropertySchema() {
    return {
      [PROPERTY_NAMES.aiTitle]: { rich_text: {} },
      [PROPERTY_NAMES.aiTopics]: { multi_select: { options: [] } },
      [PROPERTY_NAMES.provisionalTopics]: { rich_text: {} },
      [PROPERTY_NAMES.aiKeywords]: { rich_text: {} },
      [PROPERTY_NAMES.aiSummary]: { rich_text: {} },
      [PROPERTY_NAMES.processingStatus]: { select: { options: STATUS_OPTIONS.map(option => ({ ...option })) } }
    };
  }

  function propertyType(property) {
    if (!property || typeof property !== "object") return "";
    if (property.type) return property.type;
    return ["title", "rich_text", "multi_select", "select", "status", "date", "url", "number", "checkbox"]
      .find(type => Object.prototype.hasOwnProperty.call(property, type)) || "";
  }

  /**
   * This module is the only payload layer that binds Chinese Notion property
   * names, expected types, and 整理狀態 values. Builds a data-source schema
   * PATCH plan. Conservative: never creates or type-converts 整理狀態; a
   * missing, non-select, or 待分析-less 整理狀態 is an error for
   * ensureSchema(). Missing AI 標題 / AI 主題 / AI 暫定主題 / AI 關鍵字 /
   * AI 摘要 may be added. If 整理狀態 already has 待分析, missing other
   * status options may be listed while existing option ids are kept. Wrong
   * types on other properties are errors, not conversions.
   */
  function schemaPlan(existingProperties = {}) {
    const required = analysisPropertySchema();
    const properties = {};
    const added = [];
    const updated = [];
    const errors = [];

    let setupIssue = null;
    const statusProperty = existingProperties[PROPERTY_NAMES.processingStatus];
    if (!statusProperty) {
      setupIssue = { code: "NOTION_STATUS_FIELD_MISSING", message: DATABASE_SETUP_MESSAGES.statusFieldMissing };
    } else if (propertyType(statusProperty) !== "select") {
      setupIssue = { code: "NOTION_STATUS_FIELD_TYPE", message: DATABASE_SETUP_MESSAGES.statusFieldType };
    } else {
      const statusNames = new Set((statusProperty.select?.options ?? []).map(option => option?.name).filter(Boolean));
      if (!statusNames.has(STATUS.pending)) {
        setupIssue = { code: "NOTION_PENDING_OPTION_MISSING", message: DATABASE_SETUP_MESSAGES.pendingOptionMissing };
      }
    }

    for (const [name, expectedType] of Object.entries(EXPECTED_TYPES)) {
      const existing = existingProperties[name];
      if (!existing) {
        if (name === PROPERTY_NAMES.processingStatus) {
          errors.push(setupIssue.message);
        } else {
          properties[name] = required[name];
          added.push(name);
        }
        continue;
      }
      const actualType = propertyType(existing);
      if (actualType !== expectedType) {
        errors.push(name === PROPERTY_NAMES.processingStatus
          ? setupIssue.message
          : `「${name}」目前是 ${actualType || "未知"} 欄位，必須改為 ${expectedType}`);
      }
    }

    if (statusProperty && propertyType(statusProperty) === "select") {
      const existingOptions = Array.isArray(statusProperty.select?.options)
        ? statusProperty.select.options.filter(option => option?.name)
        : [];
      const existingNames = new Set(existingOptions.map(option => option?.name).filter(Boolean));
      if (!existingNames.has(STATUS.pending)) {
        errors.push(setupIssue.message);
      }
      const missing = STATUS_OPTIONS.filter(option => !existingNames.has(option.name));
      if (missing.length && existingNames.has(STATUS.pending)) {
        properties[PROPERTY_NAMES.processingStatus] = {
          select: {
            options: [
              ...existingOptions.map(option => option.id
                ? { id: option.id }
                : { name: option.name }),
              ...missing.map(option => ({ ...option }))
            ]
          }
        };
        updated.push(PROPERTY_NAMES.processingStatus);
      }
    }

    return {
      added,
      changed: Object.keys(properties).length > 0,
      errors,
      properties,
      setupIssue,
      updated
    };
  }

  function richText(content) {
    const value = shared.cleanText(content).slice(0, 7600);
    if (!value) return [];
    const items = [];
    for (let index = 0; index < value.length; index += 1900) {
      items.push({ type: "text", text: { content: value.slice(index, index + 1900) } });
    }
    return items;
  }

  function topicKey(value) {
    return shared.cleanText(value).normalize("NFKC").toLocaleLowerCase("zh-Hant-TW");
  }

  function topicOptions(properties = {}) {
    const property = properties?.[PROPERTY_NAMES.aiTopics];
    const options = Array.isArray(property?.multi_select?.options)
      ? property.multi_select.options
      : [];
    const seen = new Set();
    return options.reduce((result, option) => {
      const name = shared.cleanText(option?.name);
      const key = topicKey(name);
      if (!name || !key || seen.has(key)) return result;
      seen.add(key);
      result.push({
        id: String(option?.id ?? ""),
        name,
        color: shared.cleanText(option?.color) || "default"
      });
      return result;
    }, []);
  }

  function topicColor(value) {
    const name = shared.cleanText(value).normalize("NFKC");
    for (const rule of TOPIC_COLOR_RULES) {
      if (rule.terms.some(term => name.includes(term))) return rule.color;
    }
    return "default";
  }

  /**
   * Data-source schema PATCH for the AI 主題 multi_select option list.
   * Preserves existing options by id (or name if id is absent). Deduplicates new
   * topic names against existing options and earlier additions by topicKey.
   * Does not write page properties, 整理狀態, or AI 暫定主題. Page helpers
   * do not call this.
   */
  function topicOptionsUpdatePayload(existingOptions = [], newTopics = []) {
    const existingKeys = new Set(
      (existingOptions ?? []).map(option => topicKey(option?.name)).filter(Boolean)
    );
    const additions = [];
    for (const value of newTopics ?? []) {
      const name = shared.cleanText(value).slice(0, 100);
      const key = topicKey(name);
      if (!name || !key || existingKeys.has(key)) continue;
      existingKeys.add(key);
      additions.push({ name, color: topicColor(name) });
    }
    return {
      properties: {
        [PROPERTY_NAMES.aiTopics]: {
          multi_select: {
            options: [
              ...(existingOptions ?? []).filter(option => option?.name).map(option => option.id
                ? { id: option.id }
                : { name: shared.cleanText(option.name), color: option.color || "default" }),
              ...additions
            ]
          }
        }
      }
    };
  }

  function topicMultiSelect(values, existingOptions = [], allowedNewTopics = []) {
    const existing = new Map(
      (existingOptions ?? [])
        .filter(option => option?.name)
        .map(option => [topicKey(option.name), option])
    );
    const allowedNew = new Map(
      (allowedNewTopics ?? [])
        .map(shared.cleanText)
        .filter(Boolean)
        .map(name => [topicKey(name), name])
    );
    const seen = new Set();
    return (values ?? []).reduce((result, value) => {
      const name = shared.cleanText(value);
      const key = topicKey(name);
      if (!name || !key || seen.has(key)) return result;
      seen.add(key);
      const option = existing.get(key);
      if (option?.id) {
        result.push({ id: option.id });
      } else if (option?.name) {
        result.push({ name: option.name.slice(0, 100) });
      } else if (allowedNew.has(key)) {
        result.push({ name: allowedNew.get(key).slice(0, 100) });
      } else {
        throw new Error(`AI 主題不是既有選項，且尚未獲准新增：${name}`);
      }
      return result;
    }, []);
  }

  /**
   * Page PATCH after AI analysis. Writes AI 標題, AI 關鍵字, AI 摘要, and
   * AI 暫定主題 (result.ai_topics joined by ｜ — not confirmed AI 主題) plus
   * 整理狀態. Batch analysis passes clearFinalTopics false so confirmed
   * AI 主題 is omitted and left unchanged. Single-page reanalysis passes true
   * so AI 主題 is written as an empty multi_select, invalidating previous
   * confirmed topics beside the new provisionals.
   */
  function analysisDraftPayload(result, status = STATUS.topicOrganize, clearFinalTopics = false) {
    const properties = {
      [PROPERTY_NAMES.aiTitle]: { rich_text: richText(result.ai_title) },
      [PROPERTY_NAMES.provisionalTopics]: {
        rich_text: richText((result.ai_topics ?? []).join("｜"))
      },
      [PROPERTY_NAMES.aiKeywords]: { rich_text: richText((result.ai_keywords ?? []).join("｜")) },
      [PROPERTY_NAMES.aiSummary]: { rich_text: richText(result.ai_summary) },
      [PROPERTY_NAMES.processingStatus]: { select: { name: status } }
    };
    if (clearFinalTopics) properties[PROPERTY_NAMES.aiTopics] = { multi_select: [] };
    return { properties };
  }

  /**
   * Reads a full inspection/review page: id, title, url, AI 標題, confirmed
   * AI 主題, AI 暫定主題, AI 關鍵字, and 整理狀態. Used by current-page
   * inspect and single-page topic review, which need display fields the
   * organizer loop does not. Keeps AI 主題 and AI 暫定主題 as separate lists.
   */
  function pagePropertyValues(page) {
    const properties = page?.properties ?? {};
    const topics = properties[PROPERTY_NAMES.aiTopics]?.multi_select ?? [];
    const status = properties[PROPERTY_NAMES.processingStatus]?.select?.name || "";
    return {
      id: page?.id ?? "",
      title: pageTitle(page).slice(0, MAX_STORED_PAGE_TITLE_CHARACTERS),
      url: String(page?.url ?? "").slice(0, 2000),
      aiTitle: richTextPlain(properties[PROPERTY_NAMES.aiTitle]?.rich_text),
      aiTopics: topics.map(item => shared.cleanText(item?.name)).filter(Boolean),
      provisionalTopics: richTextPlain(properties[PROPERTY_NAMES.provisionalTopics]?.rich_text)
        .split(/[｜\n]+/u).map(shared.cleanText).filter(Boolean),
      keywords: richTextPlain(properties[PROPERTY_NAMES.aiKeywords]?.rich_text)
        .split(/[｜\n]+/u).map(shared.cleanText).filter(Boolean),
      status
    };
  }

  /**
   * Narrow organizer/rollback page read: id, confirmed AI 主題, AI 暫定主題,
   * and 整理狀態 only. Omits title, url, AI 標題, and AI 關鍵字 so apply and
   * rollback loops depend only on taxonomy and status. Separate from
   * pagePropertyValues so those callers cannot accidentally require UI fields.
   */
  function topicOrganizerPageValues(page) {
    const properties = page?.properties ?? {};
    const topics = properties[PROPERTY_NAMES.aiTopics]?.multi_select ?? [];
    return {
      id: page?.id ?? "",
      aiTopics: topics.map(item => shared.cleanText(item?.name)).filter(Boolean),
      provisionalTopics: richTextPlain(properties[PROPERTY_NAMES.provisionalTopics]?.rich_text)
        .split(/[｜\n]+/u).map(shared.cleanText).filter(Boolean),
      status: properties[PROPERTY_NAMES.processingStatus]?.select?.name || ""
    };
  }

  function allPagesQueryPayload(startCursor = "", pageSize = 100) {
    const payload = {
      page_size: Math.max(1, Math.min(100, Number(pageSize) || 100)),
      sorts: [{ timestamp: "created_time", direction: "ascending" }]
    };
    if (startCursor) payload.start_cursor = startCursor;
    return payload;
  }

  /**
   * Page PATCH that always replaces confirmed AI 主題 from `topics` and
   * writes 整理狀態. AI 暫定主題 is replaced only when provisionalTopics is an
   * array (including [] to clear it). A non-array (null, used by rollback
   * when current provisionals no longer match the snapshot) omits that
   * property so current AI 暫定主題 is left unchanged. Multi-select values
   * prefer existing option ids, else names; this is a page write, not a
   * data-source option-schema PATCH.
   */
  function topicApplyPayload(topics, status, existingTopicOptions = [], provisionalTopics = null) {
    const properties = {
      [PROPERTY_NAMES.aiTopics]: { multi_select: topicMultiSelect(topics, existingTopicOptions, topics) },
      [PROPERTY_NAMES.processingStatus]: { select: { name: status } }
    };
    if (Array.isArray(provisionalTopics)) {
      properties[PROPERTY_NAMES.provisionalTopics] = {
        rich_text: richText(provisionalTopics.join("｜"))
      };
    }
    return { properties };
  }

  /**
   * Page PATCH that writes only 整理狀態. Rejects names outside STATUS.
   * Does not touch confirmed AI 主題 or AI 暫定主題.
   */
  function statusUpdatePayload(status) {
    if (!Object.values(STATUS).includes(status)) throw new Error(`未知的整理狀態：${status}`);
    return {
      properties: {
        [PROPERTY_NAMES.processingStatus]: { select: { name: status } }
      }
    };
  }

  function queryPayload(status, startCursor = "", pageSize = 100) {
    const payload = {
      page_size: Math.max(1, Math.min(100, Number(pageSize) || 100)),
      filter: {
        property: PROPERTY_NAMES.processingStatus,
        select: { equals: status }
      },
      sorts: [{ timestamp: "created_time", direction: "ascending" }]
    };
    if (startCursor) payload.start_cursor = startCursor;
    return payload;
  }

  function topicOrganizerQueryPayload(startCursor = "", pageSize = 50) {
    if (typeof startCursor === "number") {
      pageSize = startCursor;
      startCursor = "";
    }
    const payload = {
      page_size: Math.max(1, Math.min(100, Number(pageSize) || 50)),
      filter: {
        and: [{
          or: [STATUS.topicOrganize, STATUS.topicReview].map(status => ({
            property: PROPERTY_NAMES.processingStatus,
            select: { equals: status }
          }))
        }, {
          property: PROPERTY_NAMES.provisionalTopics,
          rich_text: { is_not_empty: true }
        }]
      },
      sorts: [{ timestamp: "created_time", direction: "ascending" }]
    };
    if (startCursor) payload.start_cursor = startCursor;
    return payload;
  }

  function richTextPlain(items) {
    return (items ?? []).map(item => {
      if (typeof item?.plain_text === "string") return item.plain_text;
      if (typeof item?.text?.content === "string") return item.text.content;
      if (typeof item?.equation?.expression === "string") return item.equation.expression;
      return "";
    }).join("");
  }

  /**
   * Converts one Notion block into a plain-text record for the AI article.
   * Maps headings, lists, quotes, and similar types to a single cleaned line;
   * image/video/audio/file/pdf/unsupported are ignored. Does not walk children; the
   * caller recurses and passes depth for list indent. Returns null for a
   * non-object block.
   */
  function blockToRecord(block, depth = 0) {
    if (!block || typeof block !== "object") return null;
    const type = block.type;
    const data = block[type] ?? {};
    const indent = "  ".repeat(Math.max(0, depth));
    const text = richTextPlain(data.rich_text);
    let line = "";

    if (type === "paragraph") line = text;
    else if (/^heading_[123]$/.test(type)) line = `${"#".repeat(Number(type.slice(-1)))} ${text}`;
    else if (type === "bulleted_list_item") line = `${indent}- ${text}`;
    else if (type === "numbered_list_item") line = `${indent}1. ${text}`;
    else if (type === "to_do") line = `${indent}- [${data.checked ? "x" : " "}] ${text}`;
    else if (type === "toggle") line = `${indent}${text}`;
    else if (type === "quote") line = `${indent}> ${text}`;
    else if (type === "callout") line = text;
    else if (type === "code") line = text;
    else if (type === "equation") line = data.expression ?? "";
    else if (type === "divider") line = "---";
    else if (type === "bookmark") line = text || data.url || "";
    else if (type === "link_preview" || type === "embed") line = data.url || "";
    else if (type === "table_row") {
      line = (data.cells ?? []).map(richTextPlain).filter(Boolean).join(" | ");
    } else if (type === "child_page") line = data.title ? `## ${data.title}` : "";

    const ignoredMedia = ["image", "video", "audio", "file", "pdf", "unsupported"];
    return {
      ignored: ignoredMedia.includes(type),
      line: shared.cleanText(line),
      type
    };
  }

  function isCaptureMetadataLine(value) {
    const plain = shared.cleanText(value).replace(/^#{1,3}\s*/, "");
    return plain === "擷取提醒"
      || /^⚠️/u.test(plain)
      || plain === "此貼文沒有可擷取的內容。"
      || plain === "此則回覆沒有可擷取的內容。"
      || plain === "附件沒有可擷取的文字。";
  }

  /**
   * Joins blockToRecord lines into the normalized article string the AI layer
   * receives. Drops ignored records, empty lines, and capture-extension
   * metadata (擷取提醒 and empty-content notices). Consecutive dividers
   * collapse to one. Does not read Notion properties or call AI.
   */
  function buildArticleText(records) {
    const lines = [];
    for (const record of records ?? []) {
      if (!record || record.ignored) continue;
      const line = shared.cleanText(typeof record === "string" ? record : record.line);
      if (!line || isCaptureMetadataLine(line)) continue;
      if (line === "---") {
        if (lines.length && lines.at(-1) !== "---") lines.push(line);
      } else {
        lines.push(line);
      }
    }
    return shared.cleanText(lines.join("\n\n"));
  }

  function pageTitle(page) {
    for (const property of Object.values(page?.properties ?? {})) {
      if (propertyType(property) === "title") {
        const title = richTextPlain(property.title);
        if (title) return shared.cleanText(title);
      }
    }
    return "未命名文章";
  }

  function pageSummary(page) {
    return {
      id: page?.id ?? "",
      title: pageTitle(page).slice(0, MAX_STORED_PAGE_TITLE_CHARACTERS),
      url: String(page?.url ?? "").slice(0, 2000),
      lastEditedTime: page?.last_edited_time ?? ""
    };
  }

  return Object.freeze({
    API_VERSION,
    EXPECTED_TYPES,
    MAX_STORED_PAGE_TITLE_CHARACTERS,
    PROPERTY_NAMES,
    STATUS,
    STATUS_OPTIONS,
    DATABASE_SETUP_MESSAGES,
    analysisPropertySchema,
    analysisDraftPayload,
    allPagesQueryPayload,
    blockToRecord,
    buildArticleText,
    isCaptureMetadataLine,
    pageSummary,
    pagePropertyValues,
    propertyType,
    queryPayload,
    richText,
    richTextPlain,
    schemaPlan,
    statusUpdatePayload,
    topicKey,
    topicMultiSelect,
    topicOptions,
    topicColor,
    topicApplyPayload,
    topicOrganizerPageValues,
    topicOrganizerQueryPayload,
    topicOptionsUpdatePayload
  });
});
