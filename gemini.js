(function attachAnalyzerGemini(root, factory) {
  const shared = typeof module === "object" && module.exports
    ? require("./shared.js")
    : root.AnalyzerShared;
  const prompt = typeof module === "object" && module.exports
    ? require("./prompt.js")
    : root.AnalyzerPrompt;
  const api = factory(shared, prompt);
  if (typeof module === "object" && module.exports) {
    module.exports = api;
  } else {
    root.AnalyzerGemini = api;
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function createAnalyzerGemini(shared, prompt) {
  "use strict";

  const DEFAULT_MODEL = "gemini-3.5-flash-lite";
  const DIRECT_TEXT_LIMIT = 180000;
  const CHUNK_TEXT_LIMIT = 78000;
  const RAW_LOG_LIMIT = 12000;

  function analysisJsonSchema(outputSpec = prompt.DEFAULT_OUTPUT_SPEC) {
    const spec = prompt.normalizeOutputSpec(outputSpec);
    return {
    type: "object",
    additionalProperties: false,
    required: [
      "ai_title",
      "ai_topics",
      "ai_keywords",
      "ai_summary"
    ],
    properties: {
      ai_title: { type: "string", description: `${spec.titleMax} 個可見字元以內的精簡繁體中文標題` },
      ai_topics: {
        type: "array",
        minItems: spec.topicMin,
        maxItems: spec.topicMax,
        items: { type: "string", description: "由正文直接支持、可跨文章分類，且能涵蓋核心關鍵字或主要摘要內容的完整主題概念" }
      },
      ai_keywords: {
        type: "array",
        minItems: spec.keywordCount,
        maxItems: spec.keywordCount,
        items: { type: "string", description: "一個不可再拆分或合併的搜尋概念" }
      },
      ai_summary: { type: "string", description: `${spec.summaryMin} 至 ${spec.summaryMax} 字、依原文脈絡順序撰寫且直接進入核心內容的摘要` }
    }
    };
  }
  const ANALYSIS_JSON_SCHEMA = Object.freeze(analysisJsonSchema());

  const CHUNK_JSON_SCHEMA = Object.freeze({
    type: "object",
    additionalProperties: false,
    required: ["details", "terms", "transitions"],
    properties: {
      details: {
        type: "array",
        maxItems: 24,
        items: { type: "string", description: "一項忠於原文的具體事件、案例或細節，保持精簡" }
      },
      terms: {
        type: "array",
        maxItems: 20,
        items: { type: "string", description: "一個原文中的專有名詞、方法或術語" }
      },
      transitions: {
        type: "array",
        maxItems: 12,
        items: { type: "string", description: "一項本段內的話題轉折，保持精簡" }
      }
    }
  });

  const TOPIC_ORGANIZER_BATCH_LIMIT = 75;
  const TOPIC_ORGANIZER_JSON_SCHEMA = Object.freeze({
    type: "object",
    additionalProperties: false,
    required: ["groups", "unclassified_topics"],
    properties: {
      groups: {
        type: "array",
        maxItems: TOPIC_ORGANIZER_BATCH_LIMIT,
        items: {
          type: "object",
          additionalProperties: false,
          required: ["standard_topic", "source_topics", "definition", "keep_separate", "reason", "confidence"],
          properties: {
            standard_topic: { type: "string" },
            source_topics: { type: "array", minItems: 1, maxItems: TOPIC_ORGANIZER_BATCH_LIMIT, items: { type: "string" } },
            definition: { type: "string" },
            keep_separate: { type: "array", maxItems: TOPIC_ORGANIZER_BATCH_LIMIT, items: { type: "string" } },
            reason: { type: "string" },
            confidence: { type: "string", enum: ["high", "medium", "low"] }
          }
        }
      },
      unclassified_topics: {
        type: "array",
        maxItems: TOPIC_ORGANIZER_BATCH_LIMIT,
        items: { type: "string" }
      }
    }
  });

  function thinkingConfigForModel(model) {
    const normalized = shared.normalizeModelName(model);
    if (/^gemini-(?:3\.5-flash-lite|3\.1-flash-lite|3-flash)(?:-|$)/i.test(normalized)) {
      return { thinkingLevel: "minimal" };
    }
    if (/^gemini-3(?:\.|-)/i.test(normalized)) return { thinkingLevel: "low" };
    if (/^gemini-2\.5-flash(?:-lite)?(?:-|$)/i.test(normalized)) {
      return { thinkingBudget: 0 };
    }
    return null;
  }

  function generationPayload(systemInstruction, userText, schema, options = {}) {
    const thinkingConfig = thinkingConfigForModel(options.model);
    const generationConfig = {
      maxOutputTokens: options.maxOutputTokens ?? 8192,
      responseJsonSchema: schema,
      responseMimeType: "application/json"
    };
    if (thinkingConfig) generationConfig.thinkingConfig = thinkingConfig;
    return {
      systemInstruction: {
        parts: [{ text: systemInstruction }]
      },
      contents: [{
        role: "user",
        parts: [{ text: userText }]
      }],
      generationConfig
    };
  }

  function buildAnalysisRequest(userPrompt, model = DEFAULT_MODEL, options = {}) {
    return generationPayload(prompt.buildSystemPrompt(options.customPrompt, options.outputSpec), userPrompt, analysisJsonSchema(options.outputSpec), {
      maxOutputTokens: 8192,
      model
    });
  }

  function buildRepairRequest(invalidOutput, errors, model = DEFAULT_MODEL, options = {}) {
    return generationPayload(
      prompt.buildSystemPrompt(options.customPrompt, options.outputSpec),
      prompt.buildRepairPrompt(invalidOutput, errors),
      analysisJsonSchema(options.outputSpec),
      { maxOutputTokens: 4096, model }
    );
  }

  function buildChunkRequest(chunkText, index, total, model = DEFAULT_MODEL) {
    return generationPayload(
      prompt.CHUNK_SYSTEM_PROMPT,
      prompt.buildChunkPrompt(chunkText, index, total),
      CHUNK_JSON_SCHEMA,
      { maxOutputTokens: 12288, model }
    );
  }

  function buildChunkRepairRequest(invalidOutput, errors, model = DEFAULT_MODEL) {
    return generationPayload(
      prompt.CHUNK_SYSTEM_PROMPT,
      prompt.buildChunkRepairPrompt(invalidOutput, errors),
      CHUNK_JSON_SCHEMA,
      { maxOutputTokens: 4096, model }
    );
  }

  function buildTopicOrganizerRequest(candidates, existingStandards = [], model = DEFAULT_MODEL, options = {}) {
    if (typeof existingStandards === "string") {
      model = existingStandards;
      existingStandards = [];
    }
    return generationPayload(
      prompt.TOPIC_ORGANIZER_SYSTEM_PROMPT,
      prompt.buildTopicOrganizerPrompt(candidates, existingStandards, options.allCandidates ?? candidates, options),
      TOPIC_ORGANIZER_JSON_SCHEMA,
      { maxOutputTokens: 8192, model }
    );
  }

  function buildTopicOrganizerCompatibilityRequest(candidates, existingStandards = [], model = DEFAULT_MODEL, options = {}) {
    if (typeof existingStandards === "string") {
      model = existingStandards;
      existingStandards = [];
    }
    const thinkingConfig = thinkingConfigForModel(model);
    return {
      systemInstruction: {
        parts: [{ text: prompt.TOPIC_ORGANIZER_SYSTEM_PROMPT }]
      },
      contents: [{
        role: "user",
        parts: [{ text: prompt.buildTopicOrganizerPrompt(candidates, existingStandards, options.allCandidates ?? candidates, options) }]
      }],
      generationConfig: {
        maxOutputTokens: 8192,
        responseMimeType: "application/json",
        ...(thinkingConfig ? { thinkingConfig } : {})
      }
    };
  }

  function buildTopicOrganizerRepairRequest(
    invalidOutput,
    errors,
    candidateNames,
    existingStandards = [],
    model = DEFAULT_MODEL,
    options = {}
  ) {
    if (typeof existingStandards === "string") {
      model = existingStandards;
      existingStandards = [];
    }
    const thinkingConfig = thinkingConfigForModel(model);
    return {
      systemInstruction: {
        parts: [{ text: prompt.TOPIC_ORGANIZER_SYSTEM_PROMPT }]
      },
      contents: [{
        role: "user",
        parts: [{ text: prompt.buildTopicOrganizerRepairPrompt(
          invalidOutput,
          errors,
          candidateNames,
          existingStandards,
          options
        ) }]
      }],
      generationConfig: {
        maxOutputTokens: 8192,
        responseMimeType: "application/json",
        ...(thinkingConfig ? { thinkingConfig } : {})
      }
    };
  }

  function normalizeTopicOrganizerShape(value) {
    let source = value;
    if (Array.isArray(source)) {
      source = source.some(entry => entry && typeof entry === "object" && (entry.source_topics || entry.aliases || entry.sources))
        ? { groups: source, unclassified_topics: [] }
        : { decisions: source };
    }
    if (!source || typeof source !== "object") return source;
    const confidenceMap = { 高: "high", 中: "medium", 低: "low" };
    let groups = source.groups;
    if (!Array.isArray(groups)) {
      const alternateKeys = ["topic_groups", "topicGroups", "clusters", "suggestions", "recommendations", "分類建議"];
      groups = alternateKeys.map(key => source[key]).find(Array.isArray);
    }
    if (!Array.isArray(groups) && source.result && typeof source.result === "object") {
      groups = Array.isArray(source.result.groups) ? source.result.groups : null;
    }
    let unclassified = source.unclassified_topics ?? source.unclassifiedTopics
      ?? source.ungrouped_topics ?? source.ungroupedTopics ?? source.unclassified ?? [];
    if (!Array.isArray(unclassified)) unclassified = [];
    if (!Array.isArray(groups) && Array.isArray(source.decisions)) {
      const grouped = new Map();
      for (const entry of source.decisions) {
        if (!entry || typeof entry !== "object") continue;
        const sourceTopic = entry.source_topic ?? entry.sourceTopic ?? entry.source ?? entry.candidate ?? "";
        const standard = entry.standard_topic ?? entry.standardTopic ?? entry.standard ?? entry.topic ?? "";
        const relation = entry.relation ?? entry.action ?? entry.decision ?? "";
        if (!sourceTopic) continue;
        if (/keep|separate|independent|保持獨立/u.test(String(relation)) || topicKey(sourceTopic) === topicKey(standard)) {
          unclassified.push(sourceTopic);
          continue;
        }
        const key = topicKey(standard);
        if (!key) {
          unclassified.push(sourceTopic);
          continue;
        }
        if (!grouped.has(key)) grouped.set(key, {
          standard_topic: standard,
          source_topics: [],
          definition: entry.definition ?? entry.description ?? "",
          keep_separate: entry.keep_separate ?? entry.keepSeparate ?? [],
          reason: entry.reason ?? entry.rationale ?? entry.explanation ?? "",
          confidence: entry.confidence ?? "low"
        });
        grouped.get(key).source_topics.push(sourceTopic);
      }
      groups = [...grouped.values()];
    }
    if (!Array.isArray(groups)) return source;
    return {
      groups: groups.map(entry => {
        if (!entry || typeof entry !== "object" || Array.isArray(entry)) return entry;
        return {
          standard_topic: entry.standard_topic ?? entry.standardTopic ?? entry.standard ?? entry.name ?? entry.topic ?? "",
          source_topics: entry.source_topics ?? entry.sourceTopics ?? entry.sources ?? entry.aliases ?? entry.provisional_topics ?? entry.provisionalTopics ?? [],
          definition: entry.definition ?? entry.description ?? entry.scope ?? "",
          keep_separate: entry.keep_separate ?? entry.keepSeparate ?? entry.separate_topics ?? entry.separateTopics ?? [],
          reason: entry.reason ?? entry.rationale ?? entry.explanation ?? "",
          confidence: confidenceMap[entry.confidence] ?? entry.confidence ?? "low"
        };
      }),
      unclassified_topics: unclassified
    };
  }

  function validateTopicOrganizer(value, candidateNames = [], existingStandards = []) {
    value = normalizeTopicOrganizerShape(value);
    const errors = [];
    const warnings = [];
    const allowed = new Map((candidateNames ?? []).map(name => [topicKey(name), shared.cleanText(name)]));
    const standards = existingTopicMap(existingStandards);
    const used = new Set();
    if (!value || typeof value !== "object" || !Array.isArray(value.groups) || !Array.isArray(value.unclassified_topics)) {
      return { ok: false, errors: ["groups 與 unclassified_topics 必須是陣列"], warnings, value: null };
    }
    const groups = [];
    const unclassifiedKeys = new Set();
    const stats = { unknown: 0, duplicate: 0, invalidName: 0, singleNew: 0, missingReason: 0, malformed: 0 };
    const markUnclassified = names => {
      for (const name of names ?? []) {
        const canonical = allowed.get(topicKey(name));
        if (canonical && !used.has(topicKey(canonical))) unclassifiedKeys.add(topicKey(canonical));
      }
    };
    for (const entry of value.groups) {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
        stats.malformed += 1;
        continue;
      }
      let standard = shared.cleanText(entry.standard_topic).slice(0, 100);
      const sourceTopics = [];
      const sourceKeys = new Set();
      for (const name of cleanStringArray(entry.source_topics)) {
        const key = topicKey(name);
        const canonical = allowed.get(key);
        if (!canonical) {
          stats.unknown += 1;
          continue;
        }
        if (used.has(key) || sourceKeys.has(key)) {
          stats.duplicate += 1;
          continue;
        }
        sourceKeys.add(key);
        sourceTopics.push(canonical);
      }
      if (!sourceTopics.length) continue;
      const reason = shared.cleanText(entry.reason).slice(0, 500);
      const existingStandard = standards.get(topicKey(standard));
      if (existingStandard) standard = existingStandard;
      if (!reason) {
        stats.missingReason += 1;
        markUnclassified(sourceTopics);
        continue;
      }
      if (!existingStandard && !isOrganizerTopicLabel(standard)) {
        stats.invalidName += 1;
        markUnclassified(sourceTopics);
        continue;
      }
      if (!existingStandard && sourceTopics.length < 2) {
        stats.singleNew += 1;
        markUnclassified(sourceTopics);
        continue;
      }
      for (const key of sourceKeys) {
        used.add(key);
        unclassifiedKeys.delete(key);
      }
      const keepSeparate = [];
      const seenSeparate = new Set();
      for (const name of cleanStringArray(entry.keep_separate)) {
        const key = topicKey(name);
        const canonical = allowed.get(key);
        if (!canonical) stats.unknown += 1;
        else if (!sourceKeys.has(key) && !seenSeparate.has(key)) {
          seenSeparate.add(key);
          keepSeparate.push(canonical);
        }
      }
      groups.push({
        standard_topic: standard,
        source_topics: sourceTopics,
        definition: shared.cleanText(entry.definition).slice(0, 500),
        keep_separate: keepSeparate,
        reason,
        confidence: ["high", "medium", "low"].includes(entry.confidence) ? entry.confidence : "low",
        existing: Boolean(existingStandard)
      });
    }
    for (const name of cleanStringArray(value.unclassified_topics)) markUnclassified([name]);
    for (const [key] of allowed) {
      if (!used.has(key)) unclassifiedKeys.add(key);
    }
    if (stats.malformed) warnings.push(`已略過 ${stats.malformed} 組格式不正確的建議`);
    if (stats.unknown) warnings.push(`已忽略 ${stats.unknown} 個不在本批候選中的名稱`);
    if (stats.duplicate) warnings.push(`已忽略 ${stats.duplicate} 個重複分組的來源`);
    if (stats.invalidName) warnings.push(`${stats.invalidName} 組新名稱不符合 2～6 字規格，來源已保留未分類`);
    if (stats.singleNew) warnings.push(`${stats.singleNew} 個單一來源沒有既有分類可沿用，已保留未分類`);
    if (stats.missingReason) warnings.push(`${stats.missingReason} 組缺少建議說明，來源已保留未分類`);
    const unclassified = [...allowed.entries()]
      .filter(([key]) => unclassifiedKeys.has(key) && !used.has(key))
      .map(([, name]) => name);
    return { ok: true, errors, warnings, value: { groups, unclassified_topics: unclassified } };
  }

  function candidateText(response) {
    const parts = response?.candidates?.[0]?.content?.parts ?? [];
    const text = parts
      .filter(part => part?.thought !== true)
      .map(part => typeof part?.text === "string" ? part.text : "")
      .join("")
      .trim();
    if (text) return text;
    const reason = response?.candidates?.[0]?.finishReason;
    const blocked = response?.promptFeedback?.blockReason;
    if (blocked) {
      const error = new Error(`AI 拒絕處理內容：${blocked}`);
      error.blockReason = blocked;
      error.nonRetryable = true;
      throw error;
    }
    if (reason) {
      const error = new Error(`AI 沒有回傳分析結果：${reason}`);
      error.finishReason = reason;
      error.nonRetryable = ["SAFETY", "PROHIBITED_CONTENT", "BLOCKLIST"].includes(reason);
      throw error;
    }
    const error = new Error("AI 沒有回傳分析結果");
    error.nonRetryable = true;
    throw error;
  }

  function parseJsonCandidate(response) {
    const raw = candidateText(response);
    const withoutFence = raw
      .replace(/^```(?:json)?\s*/i, "")
      .replace(/\s*```$/, "")
      .trim();
    try {
      return { raw, value: JSON.parse(withoutFence) };
    } catch {
      const start = withoutFence.indexOf("{");
      const end = withoutFence.lastIndexOf("}");
      if (start >= 0 && end > start) {
        try {
          return { raw, value: JSON.parse(withoutFence.slice(start, end + 1)) };
        } catch {
          // Fall through to the clear error below.
        }
      }
      const error = new Error("AI 回傳的內容不是有效 JSON");
      error.rawOutput = raw;
      throw error;
    }
  }

  function responseDiagnostic(response, raw = "") {
    const candidate = response?.candidates?.[0] ?? {};
    let output = raw;
    if (!output) {
      try {
        output = candidateText(response);
      } catch {
        output = "";
      }
    }
    return {
      blockReason: response?.promptFeedback?.blockReason || "",
      finishReason: candidate.finishReason || "",
      rawOutput: String(output ?? "").slice(0, RAW_LOG_LIMIT),
      safetyRatings: Array.isArray(candidate.safetyRatings) ? candidate.safetyRatings : [],
      usageMetadata: response?.usageMetadata ?? null
    };
  }

  function cleanStringArray(value) {
    if (!Array.isArray(value)) return null;
    if (!value.every(item => typeof item === "string")) return null;
    return value.map(shared.cleanText);
  }

  function hasDuplicates(values) {
    return new Set(values.map(value => value.toLocaleLowerCase("zh-Hant-TW"))).size !== values.length;
  }

  function topicKey(value) {
    return shared.cleanText(value).normalize("NFKC").toLocaleLowerCase("zh-Hant-TW");
  }

  function existingTopicMap(existingTopics = []) {
    const map = new Map();
    for (const item of existingTopics ?? []) {
      const name = shared.cleanText(typeof item === "string" ? item : item?.name);
      if (name && !map.has(topicKey(name))) map.set(topicKey(name), name);
    }
    return map;
  }

  function isAtomicTopicLabel(value) {
    const name = shared.cleanText(value);
    return Boolean(name)
      && shared.visibleLength(name) <= 5
      && !/[\r\n|｜]/u.test(name);
  }

  function isOrganizerTopicLabel(value) {
    const name = shared.cleanText(value);
    const length = shared.visibleLength(name);
    return Boolean(name)
      && length >= 2
      && length <= 6
      && !/[\r\n|｜]/u.test(name);
  }

  function excludedPersonMap(values = []) {
    return new Map(
      [...new Set((values ?? []).map(shared.cleanText).filter(Boolean))]
        .map(name => [topicKey(name), name])
    );
  }

  function isExcludedPersonKeyword(value, excludedPersonTerms = []) {
    const keyword = shared.cleanText(value);
    if (!keyword) return false;
    const normalized = keyword.normalize("NFKC").replace(/\p{Cf}/gu, "").trim();
    const excluded = excludedPersonMap(excludedPersonTerms);
    if (excluded.has(topicKey(normalized))) return true;

    const compact = normalized.replace(/[\s\/／、\\,，;；+＋&＆.-]/gu, "");
    if (!/^[A-Za-z]+$/u.test(compact)) return false;
    const excludedInitials = new Set(
      [...excluded.keys()].filter(name => /^[a-z]$/u.test(name))
    );
    return compact.length > 0
      && [...compact.toLocaleLowerCase("zh-Hant-TW")].every(letter => excludedInitials.has(letter));
  }

  function validateAnalysis(
    value,
    existingTopics = [],
    allowTopicProposals = true,
    excludedPersonTerms = [],
    outputSpec = prompt.DEFAULT_OUTPUT_SPEC
  ) {
    const spec = prompt.normalizeOutputSpec(outputSpec);
    const errors = [];
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return { errors: ["最外層必須是 JSON 物件"], ok: false, value: null };
    }

    const expectedKeys = [
      "ai_title",
      "ai_topics",
      "ai_keywords",
      "ai_summary"
    ];
    const actualKeys = Object.keys(value);
    const missing = expectedKeys.filter(key => !actualKeys.includes(key));
    const extra = actualKeys.filter(key => !expectedKeys.includes(key));
    if (missing.length) errors.push(`缺少欄位：${missing.join("、")}`);
    if (extra.length) errors.push(`包含多餘欄位：${extra.join("、")}`);

    const title = typeof value.ai_title === "string" ? shared.cleanText(value.ai_title) : "";
    if (!title) errors.push("AI 標題不可空白");
    if (shared.visibleLength(title) > spec.titleMax) errors.push(`AI 標題超過 ${spec.titleMax} 字`);
    if (/^[A-Za-z]$/.test(title)) errors.push("AI 標題不可使用人物匿名代稱");

    const knownTopics = existingTopicMap(existingTopics);
    let topics = cleanStringArray(value.ai_topics);
    if (!topics) errors.push("AI 主題必須是文字陣列");
    else {
      topics = topics.map(item => knownTopics.get(topicKey(item)) || item);
      if (topics.length < spec.topicMin || topics.length > spec.topicMax) errors.push(`AI 主題必須有 ${spec.topicMin} 至 ${spec.topicMax} 個`);
      if (topics.some(item => !item)) errors.push("AI 主題不可包含空白項目");
      if (topics.some(item => !isAtomicTopicLabel(item))) {
        errors.push("每個 AI 暫定主題必須是最多 5 字的完整概念，且不可包含換行或「｜」");
      }
      if (hasDuplicates(topics)) errors.push("AI 主題不可重複");
      const unknownTopics = topics.filter(item => !knownTopics.has(topicKey(item)));
      if (unknownTopics.length && !allowTopicProposals) {
        errors.push(`目前不允許新主題，請改用既有選項：${unknownTopics.join("、")}`);
      }
    }

    const keywords = cleanStringArray(value.ai_keywords);
    if (!keywords) errors.push("AI 關鍵字必須是文字陣列");
    else {
      if (keywords.length !== spec.keywordCount) errors.push(`AI 關鍵字必須恰好 ${spec.keywordCount} 個`);
      if (keywords.some(item => !item)) errors.push("AI 關鍵字不可包含空白項目");
      if (keywords.some(item => item.length > 100)) errors.push("AI 關鍵字單項不可超過 100 字");
      if (hasDuplicates(keywords)) errors.push("AI 關鍵字不可重複");
      if (keywords.some(item => /[\r\n|｜]/u.test(item))) {
        errors.push("AI 關鍵字不可包含換行或「｜」分隔字元");
      }
      const excludedKeywords = keywords.filter(item => isExcludedPersonKeyword(item, excludedPersonTerms));
      if (excludedKeywords.length) {
        errors.push(`AI 關鍵字不可使用敘事角色或人物代稱：${excludedKeywords.join("、")}`);
      }
    }

    const summary = typeof value.ai_summary === "string" ? shared.cleanText(value.ai_summary) : "";
    const summaryLength = shared.visibleLength(summary);
    if (!summary) errors.push("AI 摘要不可空白");
    if (summaryLength < spec.summaryMin || summaryLength > spec.summaryMax) errors.push(`AI 摘要必須為 ${spec.summaryMin} 至 ${spec.summaryMax} 字，目前為 ${summaryLength} 字`);
    if (/^(?:本文|文章|此文|本篇|這篇文章)/u.test(summary)) {
      errors.push("AI 摘要不可用本文、文章、此文、本篇或這篇文章作為引介開頭");
    }

    return {
      errors,
      ok: errors.length === 0,
      value: errors.length ? null : {
        ai_title: title,
        ai_topics: topics,
        ai_keywords: keywords,
        ai_summary: summary
      }
    };
  }

  function validateChunkNotes(value) {
    const errors = [];
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return { errors: ["片段筆記必須是 JSON 物件"], ok: false, value: null };
    }
    const keys = ["details", "terms", "transitions"];
    const extra = Object.keys(value).filter(key => !keys.includes(key));
    if (extra.length) errors.push(`片段筆記包含多餘欄位：${extra.join("、")}`);
    const normalized = {};
    for (const key of keys) {
      const list = cleanStringArray(value[key]);
      if (!list) errors.push(`${key} 必須是文字陣列`);
      else normalized[key] = list.filter(Boolean);
    }
    if (normalized.details?.length > 24) errors.push("details 不可超過 24 項");
    if (normalized.details?.some(item => item.length > 240)) errors.push("details 單項不可超過 240 字");
    if (normalized.terms?.length > 20) errors.push("terms 不可超過 20 項");
    if (normalized.terms?.some(item => item.length > 80)) errors.push("terms 單項不可超過 80 字");
    if (normalized.transitions?.length > 12) errors.push("transitions 不可超過 12 項");
    if (normalized.transitions?.some(item => item.length > 180)) errors.push("transitions 單項不可超過 180 字");
    return { errors, ok: errors.length === 0, value: errors.length ? null : normalized };
  }

  function formatChunkNotes(notes) {
    return notes.map((note, index) => {
      const sections = [
        `第 ${index + 1} 段`,
        `具體內容：\n${note.details.map(item => `- ${item}`).join("\n") || "- 無"}`,
        `詞彙：${note.terms.join("、") || "無"}`,
        `話題轉折：\n${note.transitions.map(item => `- ${item}`).join("\n") || "- 無"}`
      ];
      return sections.join("\n");
    }).join("\n\n");
  }

  function usableModels(response) {
    const excluded = /(embedding|imagen|veo|lyria|tts|live|audio|image|computer-use|robotics|omni|coder|codex|code-specialized)/i;
    const priority = [
      "gemini-3.5-flash-lite",
      "gemini-3.1-flash-lite",
      "gemini-2.5-flash-lite",
      "gemini-3.6-flash",
      "gemini-3.5-flash",
      "gemini-2.5-flash"
    ];
    const models = (response?.models ?? [])
      .filter(model => (model.supportedGenerationMethods ?? [])
        .some(method => String(method).toLowerCase() === "generatecontent"))
      .map(model => ({
        displayName: model.displayName || model.name,
        inputTokenLimit: model.inputTokenLimit ?? null,
        name: shared.normalizeModelName(model.name),
        outputTokenLimit: model.outputTokenLimit ?? null,
        thinking: Boolean(model.thinking)
      }))
      .filter(model => /^gemini-/i.test(model.name) && !excluded.test(model.name));
    const unique = [...new Map(models.map(model => [model.name, model])).values()];
    return unique.sort((a, b) => {
      const aPriority = priority.indexOf(a.name);
      const bPriority = priority.indexOf(b.name);
      if (aPriority >= 0 || bPriority >= 0) {
        if (aPriority < 0) return 1;
        if (bPriority < 0) return -1;
        return aPriority - bPriority;
      }
      const aFlash = /flash/i.test(a.name) ? 0 : 1;
      const bFlash = /flash/i.test(b.name) ? 0 : 1;
      return aFlash - bFlash || a.name.localeCompare(b.name);
    });
  }

  return Object.freeze({
    ANALYSIS_JSON_SCHEMA,
    analysisJsonSchema,
    CHUNK_JSON_SCHEMA,
    TOPIC_ORGANIZER_BATCH_LIMIT,
    TOPIC_ORGANIZER_JSON_SCHEMA,
    CHUNK_TEXT_LIMIT,
    DEFAULT_MODEL,
    DIRECT_TEXT_LIMIT,
    buildAnalysisRequest,
    buildChunkRepairRequest,
    buildChunkRequest,
    buildRepairRequest,
    buildTopicOrganizerCompatibilityRequest,
    buildTopicOrganizerRepairRequest,
    buildTopicOrganizerRequest,
    candidateText,
    formatChunkNotes,
    generationPayload,
    isAtomicTopicLabel,
    isOrganizerTopicLabel,
    isExcludedPersonKeyword,
    normalizeTopicOrganizerShape,
    parseJsonCandidate,
    responseDiagnostic,
    thinkingConfigForModel,
    usableModels,
    validateAnalysis,
    validateChunkNotes,
    validateTopicOrganizer
  });
});
