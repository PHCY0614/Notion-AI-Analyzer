"use strict";

// Service worker: topic organizer preparation, apply, rollback, and dictionary.

async function queryTopicOrganizerPages(dataSourceId, token, options = {}) {
  const pages = [];
  const topicKeys = new Set();
  let cursor = "";
  let done = false;
  const eligibleStatuses = new Set([N.STATUS.topicOrganize, N.STATUS.topicReview]);
  const queryPath = `/v1/data_sources/${dataSourceId}/query?${[
    N.PROPERTY_NAMES.processingStatus,
    N.PROPERTY_NAMES.provisionalTopics,
    N.PROPERTY_NAMES.aiTopics
  ].map(name => `filter_properties[]=${encodeURIComponent(name)}`).join("&")}`;
  do {
    const response = await notionRequest(queryPath, {
      method: "POST",
      body: N.topicOrganizerQueryPayload(cursor, 50),
      signal: options.signal,
      token
    });
    for (const rawPage of response.results ?? []) {
      const page = N.topicOrganizerPageValues(rawPage);
      if (!eligibleStatuses.has(page.status) || !page.provisionalTopics.length) continue;
      pages.push(page);
      for (const name of uniqueTopicNames(page.provisionalTopics)) topicKeys.add(N.topicKey(name));
      if (topicKeys.size >= TOPIC_ORGANIZER_BATCH_LIMIT) {
        done = true;
        break;
      }
    }
    cursor = !done && response.has_more ? response.next_cursor || "" : "";
  } while (cursor);
  await setStage("掃描 Notion", { progress: pages.length });
  return pages;
}

// ==== Topic organizer preparation ====
function topicDictionaryLookup(config = {}, allowedTargets = null) {
  const lookup = new Map();
  const allowed = allowedTargets == null
    ? null
    : new Set([...allowedTargets].map(N.topicKey).filter(Boolean));
  for (const entry of normalizeTopicDictionary(config.topicDictionary).filter(item => item.active !== false)) {
    if (allowed && !allowed.has(N.topicKey(entry.name))) continue;
    lookup.set(N.topicKey(entry.name), entry.name);
    for (const alias of entry.aliases ?? []) lookup.set(N.topicKey(alias), entry.name);
  }
  for (const [alias, target] of Object.entries(normalizeTopicAliases(config.topicAliases))) {
    if (allowed && !allowed.has(N.topicKey(target))) continue;
    lookup.set(alias, S.cleanText(target));
  }
  return lookup;
}

function pageResolution(resolutions, pageId, candidate) {
  return S.cleanText(resolutions?.[pageId]?.[N.topicKey(candidate)]);
}

function topicOrganizerCandidates(pages, options = [], config = {}, limit = TOPIC_ORGANIZER_BATCH_LIMIT) {
  const map = new Map();
  const existing = new Map(validTopicOptions(options).map(option => [N.topicKey(option.name), option.name]));
  const dictionary = topicDictionaryLookup(config, existing.keys());
  const discardedKeys = new Set(normalizeDiscardedTopicNames(config.discardedTopicNames).map(N.topicKey));
  const resolutions = normalizeTopicPageResolutions(config.topicPageResolutions);
  for (const page of pages ?? []) {
    const finalKeys = new Set((page.aiTopics ?? []).map(N.topicKey));
    for (const rawName of uniqueTopicNames(page.provisionalTopics ?? [])) {
      const name = S.cleanText(rawName);
      const key = N.topicKey(name);
      if (!key) continue;
      const pageTarget = pageResolution(resolutions, page.id, name);
      const preferredStandard = existing.get(key)
        || (existing.has(N.topicKey(pageTarget)) ? existing.get(N.topicKey(pageTarget)) : "")
        || dictionary.get(key)
        || "";
      if (!map.has(key)) {
        map.set(key, {
          name,
          occurrences: 0,
          pageIds: [],
          preferredStandard,
          alreadyApplied: Boolean(preferredStandard && finalKeys.has(N.topicKey(preferredStandard))),
          permanentlyDiscarded: discardedKeys.has(key)
        });
      }
      const entry = map.get(key);
      entry.occurrences += 1;
      if (!entry.preferredStandard && preferredStandard) entry.preferredStandard = preferredStandard;
      entry.alreadyApplied = entry.alreadyApplied || Boolean(preferredStandard && finalKeys.has(N.topicKey(preferredStandard)));
      if (!entry.pageIds.includes(page.id)) entry.pageIds.push(page.id);
    }
  }
  return [...map.values()]
    .slice(0, Math.max(1, Math.min(TOPIC_ORGANIZER_BATCH_LIMIT, Number(limit) || TOPIC_ORGANIZER_BATCH_LIMIT)))
    .sort((a, b) => a.name.localeCompare(b.name, "zh-Hant-TW"));
}

function organizerGroupEvidence(candidates = [], aliases = []) {
  const aliasKeys = new Set(uniqueTopicNames(aliases).map(N.topicKey));
  const pageIds = new Set();
  for (const candidate of candidates ?? []) {
    if (!aliasKeys.has(N.topicKey(candidate.name))) continue;
    for (const pageId of candidate.pageIds ?? []) pageIds.add(pageId);
  }
  return { impactCount: pageIds.size };
}

function topicOrganizerStandards(options = [], pages = []) {
  return uniqueTopicNames([
    ...validTopicOptions(options).map(option => option.name),
    ...(pages ?? []).flatMap(page => page.aiTopics ?? [])
  ]).map(name => ({ name }));
}

function mergeOrganizerGroups(inputGroups = []) {
  const grouped = new Map();
  const confidenceRank = { low: 0, medium: 1, high: 2 };
  for (const input of inputGroups ?? []) {
    const standard = S.cleanText(input.standard_topic ?? input.standardTopic);
    const sources = uniqueTopicNames(input.source_topics ?? input.aliases ?? []);
    if (!standard || !sources.length) continue;
    const key = N.topicKey(standard);
    if (!grouped.has(key)) {
      grouped.set(key, {
        standard_topic: standard,
        definition: S.cleanText(input.definition),
        aliases: [],
        keep_separate: [],
        reasons: [],
        confidence: input.confidence || "low",
        existing: input.existing === true,
        confirmed: input.confirmed === true
      });
    }
    const group = grouped.get(key);
    group.aliases.push(...sources);
    group.keep_separate.push(...(input.keep_separate ?? input.keepSeparate ?? []));
    if (S.cleanText(input.reason)) group.reasons.push(S.cleanText(input.reason));
    group.existing = group.existing || input.existing === true;
    group.confirmed = group.confirmed || input.confirmed === true;
    if (!group.definition && input.definition) group.definition = S.cleanText(input.definition);
    if ((confidenceRank[input.confidence] ?? 0) < (confidenceRank[group.confidence] ?? 0)) {
      group.confidence = input.confidence;
    }
  }
  const groups = [];
  for (const group of grouped.values()) {
    group.aliases = uniqueTopicNames(group.aliases);
    const aliasKeys = new Set(group.aliases.map(N.topicKey));
    group.keep_separate = uniqueTopicNames(group.keep_separate)
      .filter(name => !aliasKeys.has(N.topicKey(name)));
    groups.push({
      standard_topic: group.standard_topic,
      definition: group.definition,
      aliases: group.aliases,
      keep_separate: group.keep_separate,
      reason: uniqueTopicNames(group.reasons).join("；").slice(0, 500),
      confidence: group.confidence,
      existing: group.existing,
      confirmed: group.confirmed
    });
  }
  return groups;
}

function canRetryTopicOrganizerWithoutSchema(error) {
  if (Number(error?.status) !== 400) return false;
  return /invalid[_ ]argument|requested parameters|json|schema|max.?output.?tokens/i
    .test(String(error?.message || ""));
}

/**
 * Asks the AI provider to group unconfirmed AI 暫定主題 without exposing the
 * existing confirmed taxonomy. Tries a strict JSON-schema request first; on a schema/parameter
 * failure it retries in compatibility JSON mode; if the payload still fails
 * validation it sends one repair request (at most three AI calls). Does not
 * read or write Notion. On a second invalid payload it locally treats every
 * candidate as unclassified instead of calling AI again. Updates stage via
 * setStage; does not mutate the queue.
 */
async function requestOrganizerGroups({ aiCandidates, config, controller }) {
  const { apiKey, model, provider } = await activeAiContext(config);
  const aiInput = aiCandidates.map(candidate => ({ name: candidate.name }));
  const candidateNames = aiCandidates.map(candidate => candidate.name);
  const warnings = [];
  let response;
  try {
    response = await timedAiRequest(
      provider,
      model,
      G.buildTopicOrganizerRequest(aiInput, [], model),
      { apiKey, signal: controller.signal, timeoutMinutes: config.requestTimeoutMinutes }
    );
  } catch (error) {
    if (!canRetryTopicOrganizerWithoutSchema(error)) throw error;
    await setStage("改用相容 JSON 模式", { model, provider });
    response = await timedAiRequest(
      provider,
      model,
      G.buildTopicOrganizerCompatibilityRequest(aiInput, [], model),
      { apiKey, signal: controller.signal, timeoutMinutes: config.requestTimeoutMinutes }
    );
  }
  await setStage("驗證暫定主題分組", { model, provider });
  let invalidRaw = "";
  let checked;
  try {
    const parsed = G.parseJsonCandidate(response);
    invalidRaw = parsed.raw;
    checked = G.validateTopicOrganizer(parsed.value, candidateNames, []);
  } catch (error) {
    if (error?.nonRetryable) throw error;
    invalidRaw = error?.rawOutput || "";
    checked = { ok: false, errors: [error?.message || "AI 回傳的內容不是有效 JSON"] };
  }
  if (!checked.ok) {
    await setStage("修復暫定主題分組格式", { model, provider });
    const repairedResponse = await timedAiRequest(
      provider,
      model,
      G.buildTopicOrganizerRepairRequest(
        invalidRaw,
        checked.errors,
        candidateNames,
        [],
        model
      ),
      { apiKey, signal: controller.signal, timeoutMinutes: config.requestTimeoutMinutes }
    );
    let repaired;
    try {
      repaired = G.parseJsonCandidate(repairedResponse);
      checked = G.validateTopicOrganizer(repaired.value, candidateNames, []);
    } catch (error) {
      if (error?.nonRetryable) throw error;
      checked = { ok: false, errors: [error?.message || "修復結果不是有效 JSON"] };
    }
    if (!checked.ok) {
      warnings.push(`模型兩次都未回傳可用格式，本批候選已全部保留未分類：${checked.errors.join("；")}`);
      checked = G.validateTopicOrganizer({ groups: [], unclassified_topics: candidateNames }, candidateNames, []);
    }
  }
  warnings.push(...(checked.warnings ?? []));
  return {
    groups: checked.value.groups,
    unclassifiedTopics: checked.value.unclassified_topics,
    warnings
  };
}

/**
 * Compares already-validated provisional groups with existing AI 主題. This
 * stage may replace only standard_topic; it cannot alter group membership.
 * Invalid decisions safely keep the first-stage proposed name.
 */
async function requestTopicStandardMatches({ groups, standards, config, controller, promptOptions }) {
  if (!groups.length || !standards.length) return { groups, warnings: [] };
  const { apiKey, model, provider } = await activeAiContext(config);
  const matcherGroups = groups.map((group, index) => ({
    group_id: `group_${index + 1}`,
    proposed_topic: group.standard_topic,
    source_topics: group.source_topics,
    definition: group.definition
  }));
  const warnings = [];
  let response;
  await setStage("比對既有 AI 主題", { model, provider });
  try {
    response = await timedAiRequest(
      provider,
      model,
      G.buildTopicStandardMatcherRequest(matcherGroups, standards, model, promptOptions),
      { apiKey, signal: controller.signal, timeoutMinutes: config.requestTimeoutMinutes }
    );
  } catch (error) {
    if (!canRetryTopicOrganizerWithoutSchema(error)) throw error;
    await setStage("既有主題比對改用相容 JSON 模式", { model, provider });
    response = await timedAiRequest(
      provider,
      model,
      G.buildTopicStandardMatcherCompatibilityRequest(matcherGroups, standards, model, promptOptions),
      { apiKey, signal: controller.signal, timeoutMinutes: config.requestTimeoutMinutes }
    );
  }
  await setStage("驗證既有主題比對", { model, provider });
  let invalidRaw = "";
  let checked;
  try {
    const parsed = G.parseJsonCandidate(response);
    invalidRaw = parsed.raw;
    checked = G.validateTopicStandardMatches(parsed.value, matcherGroups, standards);
  } catch (error) {
    if (error?.nonRetryable) throw error;
    invalidRaw = error?.rawOutput || "";
    checked = { ok: false, errors: [error?.message || "AI 回傳的內容不是有效 JSON"] };
  }
  if (!checked.ok) {
    await setStage("修復既有主題比對格式", { model, provider });
    const repairedResponse = await timedAiRequest(
      provider,
      model,
      G.buildTopicStandardMatcherRepairRequest(
        invalidRaw,
        checked.errors,
        matcherGroups,
        standards,
        model,
        promptOptions
      ),
      { apiKey, signal: controller.signal, timeoutMinutes: config.requestTimeoutMinutes }
    );
    try {
      const repaired = G.parseJsonCandidate(repairedResponse);
      checked = G.validateTopicStandardMatches(repaired.value, matcherGroups, standards);
    } catch (error) {
      if (error?.nonRetryable) throw error;
      checked = { ok: false, errors: [error?.message || "修復結果不是有效 JSON"] };
    }
    if (!checked.ok) {
      warnings.push(`既有主題比對兩次都未回傳可用格式，已保留第一階段建議名稱：${checked.errors.join("；")}`);
      checked = G.validateTopicStandardMatches({ matches: [] }, matcherGroups, standards);
    }
  }
  warnings.push(...(checked.warnings ?? []));
  const matchById = new Map(checked.value.matches.map(match => [match.group_id, match]));
  const confidenceRank = { low: 0, medium: 1, high: 2 };
  const confidenceName = ["low", "medium", "high"];
  return {
    groups: groups.map((group, index) => {
      const match = matchById.get(`group_${index + 1}`);
      if (!match) return group;
      const matchedExisting = match.decision === "reuse_existing";
      const confidence = confidenceName[Math.min(
        confidenceRank[group.confidence] ?? 0,
        confidenceRank[match.confidence] ?? 0
      )];
      const themeName = S.cleanText(match.matched_topic);
      const matchReason = S.cleanText(match.reason).replace(/『([^』]*)』/g, "「$1」");
      if (matchedExisting) {
        // Reuse: UI shows「既有主題」+ 說明. Skip redundant same-theme compare lines.
        const strip = value => String(value || "")
          .replace(/[「」『』《》【】（）()：:。.\s]/g, "")
          .toLocaleLowerCase("zh-Hant-TW");
        const themeKey = strip(themeName);
        const reasonKey = strip(matchReason);
        const redundant = !reasonKey
          || (themeKey && (reasonKey === themeKey
            || reasonKey === `既有主題${themeKey}`
            || reasonKey === `建議沿用既有主題${themeKey}`
            || reasonKey === `沿用既有主題${themeKey}`));
        const reasonParts = [group.reason];
        if (!redundant) reasonParts.push(matchReason);
        return {
          ...group,
          standard_topic: match.matched_topic,
          reason: reasonParts.filter(Boolean).join("；").slice(0, 500),
          confidence,
          existing: true
        };
      }
      const compareDetail = matchReason || "未找到合適的既有主題，保留第一階段建議名稱。";
      const compareSegment = `既有主題比對：${compareDetail}`;
      return {
        ...group,
        standard_topic: group.standard_topic,
        reason: [group.reason, compareSegment].filter(Boolean).join("；").slice(0, 500),
        confidence,
        existing: false
      };
    }),
    warnings
  };
}

/**
 * Turns validated organizer groups into the local review-card shape (ids,
 * selectedAliases, impactCount, selected:false). No AI or Notion I/O.
 */
function buildOrganizerReviewGroups(groups, candidates) {
  return groups.map((group, index) => {
    const aliases = uniqueTopicNames(group.aliases);
    const evidence = organizerGroupEvidence(candidates, aliases);
    return {
      id: `group-${Date.now()}-${index}`,
      standardTopic: group.standard_topic,
      definition: group.definition,
      aliases,
      selectedAliases: [...aliases],
      keepSeparate: group.keep_separate,
      reason: group.reason,
      confidence: group.confidence,
      existing: group.existing,
      confirmed: group.confirmed,
      impactCount: evidence.impactCount,
      selected: false
    };
  });
}

/**
 * Builds a local topic-organizer review session from pages in 待主題整理 /
 * 待主題確認. Reads Notion (and may update missing data source schema via
 * readyNotion). Does not write AI 暫定主題 or AI 主題 on article pages.
 * Candidates already mapped by existing options, page resolutions, or the
 * confirmed dictionary skip AI and become confirmed groups. Remaining names
 * are first grouped independently, then those fixed groups are compared with
 * existing AI 主題. Stores the session in topicOrganizer.
 */
async function prepareTopicOrganizer() {
  if (stateCache.running) throw new AppError("目前正在分析文章，請先停止或等候完成", { code: "BUSY" });
  const controller = new AbortController();
  activeAbortController = controller;
  try {
    const { config, token } = await readyNotion();
    await setStage("掃描 Notion", { progress: 0 });
    const [pages, options] = await Promise.all([
      queryTopicOrganizerPages(config.dataSourceId, token, { signal: controller.signal }),
      readTopicOptions(config, token, controller.signal)
    ]);
    const candidates = topicOrganizerCandidates(pages, options, config);
    if (!candidates.length) {
      stateCache.topicOrganizer = {
        version: TOPIC_ORGANIZER_CACHE_VERSION,
        status: "review",
        scannedAt: new Date().toISOString(),
        candidates: [], pages, groups: [], unclassified: [], manualSkipped: [],
        existingTopics: validTopicOptions(options).map(option => option.name), warnings: [], progress: null,
        appliedCandidateCount: 0
      };
      stateCache.lastError = "";
      await persistState();
      return topicOrganizerForUi();
    }
    const organizerWarnings = [];
    const standards = topicOrganizerStandards(options, pages);
    const preferExistingTopics = topicOrganizerPreference(config);
    const organizerPromptOptions = { preferExistingTopics };
    const confirmedGroups = candidates.filter(item => item.preferredStandard).map(candidate => ({
        standard_topic: candidate.preferredStandard,
        source_topics: [candidate.name],
        definition: "",
        keep_separate: [],
        reason: `已有經使用者確認的主題對照「${candidate.preferredStandard}」。`,
        confidence: "high",
        existing: true,
        confirmed: true
      }));
    const permanentlyDiscarded = candidates.filter(item => item.permanentlyDiscarded && !item.preferredStandard);
    const aiCandidates = candidates.filter(item => !item.preferredStandard && !item.permanentlyDiscarded);
    let aiGroups = [];
    let unclassified = permanentlyDiscarded.map(candidate => candidate.name);
    if (aiCandidates.length) {
      const requested = await requestOrganizerGroups({
        aiCandidates,
        config,
        controller
      });
      aiGroups = requested.groups;
      unclassified = uniqueTopicNames([...unclassified, ...requested.unclassifiedTopics]);
      organizerWarnings.push(...requested.warnings);
      if (aiGroups.length && standards.length) {
        const matched = await requestTopicStandardMatches({
          groups: aiGroups,
          standards,
          config,
          controller,
          promptOptions: organizerPromptOptions
        });
        aiGroups = matched.groups;
        organizerWarnings.push(...matched.warnings);
      }
    }
    const groups = mergeOrganizerGroups([...confirmedGroups, ...aiGroups]);
    const groupedKeys = new Set(groups.flatMap(group => group.aliases).map(N.topicKey));
    unclassified = uniqueTopicNames(unclassified)
      .filter(name => !groupedKeys.has(N.topicKey(name)));
    const reviewGroups = buildOrganizerReviewGroups(groups, candidates);
    stateCache.topicOrganizer = {
      version: TOPIC_ORGANIZER_CACHE_VERSION,
      status: "review",
      scannedAt: new Date().toISOString(),
      candidates,
      pages,
      groups: reviewGroups,
      unclassified,
      manualSkipped: [],
      existingTopics: validTopicOptions(options).map(option => option.name),
      warnings: organizerWarnings,
      progress: null,
      appliedCandidateCount: 0
    };
    stateCache.lastError = "";
    stateCache.stage = null;
    await persistState();
    return topicOrganizerForUi();
  } finally {
    if (activeAbortController === controller) activeAbortController = null;
    stateCache.stage = null;
    await persistState();
  }
}

// ==== Topic organizer session and drafts ====
/**
 * Projects topicOrganizer (and canRollback from topicRollback) for the
 * options UI. Local only: no AI or Notion I/O. Omits applied/skipped groups
 * and skipped unclassified names from the active lists.
 */
function topicOrganizerForUi() {
  const organizer = stateCache.topicOrganizer;
  if (!organizer) {
    return stateCache.topicRollback ? {
      status: "cleared",
      scannedAt: "",
      candidateCount: 0,
      occurrenceCount: 0,
      pageCount: 0,
      groups: [],
      unclassified: [],
      manualItems: [],
      existingTopics: [],
      appliedCount: 0,
      skippedCount: 0,
      warnings: [],
      progress: null,
      canRollback: true
    } : null;
  }
  const allGroups = organizer.groups ?? [];
  const groups = allGroups.filter(group => group.applied !== true && group.skipped !== true);
  const skippedManualKeys = new Set((organizer.manualSkipped ?? []).map(N.topicKey));
  const activeUnclassified = (organizer.unclassified ?? [])
    .filter(name => !skippedManualKeys.has(N.topicKey(name)));
  const candidatesByKey = new Map((organizer.candidates ?? []).map(candidate => [N.topicKey(candidate.name), candidate]));
  return {
    status: organizer.status,
    scannedAt: organizer.scannedAt,
    candidateCount: organizer.candidates?.length ?? 0,
    occurrenceCount: (organizer.candidates ?? []).reduce((total, candidate) => total + (Number(candidate.occurrences) || 0), 0),
    pageCount: organizer.pages?.length ?? 0,
    groups,
    unclassified: activeUnclassified,
    manualItems: activeUnclassified.map(name => {
      const candidate = candidatesByKey.get(N.topicKey(name));
      return {
        name,
        impactCount: candidate?.pageIds?.length ?? 0,
        permanentlyDiscarded: candidate?.permanentlyDiscarded === true
      };
    }),
    existingTopics: organizer.existingTopics ?? [],
    appliedCount: Number(organizer.appliedCandidateCount) || 0,
    skippedCount: allGroups.filter(group => group.skipped === true).length,
    manualSkippedCount: (organizer.manualSkipped ?? []).length,
    warnings: organizer.warnings ?? [],
    progress: organizer.progress ?? null,
    canRollback: Boolean(stateCache.topicRollback)
  };
}

/**
 * Drops the local organizer review session. Does not write Notion, call AI,
 * or clear topicRollback.
 */
async function clearTopicOrganizer() {
  if (stateCache.running) throw new AppError("目前正在處理其他工作，請稍後再清除建議", { code: "BUSY" });
  stateCache.topicOrganizer = null;
  await persistState();
  return topicOrganizerForUi();
}

/**
 * Copies checkbox, standard-topic, and selected-alias drafts from the UI
 * into the in-memory organizer groups. Local review state only; does not
 * persist unless the caller does, and does not write Notion.
 */
function saveTopicOrganizerDrafts(organizer, groupsInput = []) {
  const storedGroups = new Map((organizer?.groups ?? []).map(group => [group.id, group]));
  for (const draft of groupsInput ?? []) {
    const stored = storedGroups.get(S.cleanText(draft?.id).slice(0, 120));
    if (!stored) continue;
    const allowedAliases = new Map((stored.aliases ?? []).map(name => [N.topicKey(name), name]));
    const selectedAliases = uniqueTopicNames(draft.selectedAliases ?? [])
      .map(name => allowedAliases.get(N.topicKey(name)) || "")
      .filter(Boolean);
    stored.standardTopic = S.cleanText(draft.standardTopic).slice(0, 100);
    stored.selectedAliases = selectedAliases;
    stored.selected = draft.selected === true;
  }
}

/**
 * Marks one organizer group skipped, moves its aliases into unclassified,
 * and persists local review state. Does not call AI or write article pages.
 */
async function skipTopicOrganizerGroup(groupId, groupsInput = []) {
  const organizer = stateCache.topicOrganizer;
  saveTopicOrganizerDrafts(organizer, groupsInput);
  const group = organizer?.groups?.find(item => item.id === groupId);
  if (!group) throw new AppError("找不到要暫不處理的建議", { code: "TOPIC_GROUP_MISSING" });
  group.skipped = true;
  group.selected = false;
  organizer.unclassified = uniqueTopicNames([...(organizer.unclassified ?? []), ...(group.aliases ?? [])]);
  organizer.status = "review";
  await persistState();
  return topicOrganizerForUi();
}

// ==== Topic organizer application ====
function mergeDictionaryEntries(existing, additions) {
  const map = new Map(normalizeTopicDictionary(existing).map(item => [N.topicKey(item.name), item]));
  for (const addition of normalizeTopicDictionary(additions)) {
    const key = N.topicKey(addition.name);
    const previous = map.get(key);
    map.set(key, previous ? {
      ...previous,
      ...addition,
      definition: S.cleanText(addition.definition) || previous.definition || "",
      aliases: uniqueTopicNames([...(previous.aliases ?? []), ...(addition.aliases ?? [])])
    } : addition);
  }
  return [...map.values()];
}

/**
 * Applies selected organizer groups: maps AI 暫定主題 aliases to confirmed
 * AI 主題 on affected pages. Does not call AI. May PATCH the data source to
 * add new topic options, then writes pages incrementally. Remaining unmatched
 * provisionals stay as AI 暫定主題; status becomes 已分析 only when none remain
 * on that page, otherwise 待主題確認. Persists progress after each successful
 * page and retains an incomplete snapshot on interruption or failure. A later
 * apply with the same operationKey resumes from that snapshot.
 */
async function applyTopicOrganizerGroups(groupsInput = []) {
  const organizer = stateCache.topicOrganizer;
  if (!organizer?.pages || stateCache.running) {
    throw new AppError(stateCache.running ? "目前正在處理其他工作" : "請先產生主題整理建議", { code: "BUSY" });
  }
  const storedGroups = new Map((organizer.groups ?? []).map(group => [group.id, group]));
  const selected = (groupsInput ?? []).filter(group => group?.selected).map(group => {
    const id = S.cleanText(group.id).slice(0, 120);
    const stored = storedGroups.get(id);
    const allowedAliases = new Map((stored?.aliases ?? []).map(name => [N.topicKey(name), name]));
    const aliases = uniqueTopicNames(group.selectedAliases ?? [])
      .map(name => allowedAliases.get(N.topicKey(name)) || "")
      .filter(Boolean);
    const standardTopic = S.cleanText(group.standardTopic).slice(0, 100);
    const definition = S.cleanText(group.definition)
      || S.cleanText(stored?.definition)
      || S.cleanText(stored?.reason)
      || (standardTopic ? `由主題整理套用建立的對照「${standardTopic}」。` : "");
    return {
      id,
      standardTopic,
      definition: definition.slice(0, 500),
      aliases
    };
  }).filter(group => group.id && group.standardTopic && group.aliases.length);
  if (!selected.length) throw new AppError("請至少勾選一組要套用的建議", { code: "NO_TOPIC_GROUP_SELECTED" });

  const aliasMap = new Map();
  for (const group of selected) {
    for (const alias of group.aliases) {
      const key = N.topicKey(alias);
      if (aliasMap.has(key) && aliasMap.get(key) !== group.standardTopic) {
        throw new AppError(`「${alias}」同時被分到多個標準主題`, { code: "TOPIC_MAPPING_CONFLICT" });
      }
      aliasMap.set(key, group.standardTopic);
    }
  }
  const controller = new AbortController();
  const { config, token } = await readyNotion();
  let options = validTopicOptions(await readTopicOptions(config, token));
  const optionKeys = new Set(options.map(item => N.topicKey(item.name)));
  const newStandards = uniqueTopicNames(selected.map(group => group.standardTopic))
    .filter(name => !optionKeys.has(N.topicKey(name)));
  const invalidNewStandards = newStandards.filter(name => !G.isOrganizerTopicLabel(name));
  if (invalidNewStandards.length) {
    throw new AppError(`主題整理新增的分類名稱必須為 2～6 字，並優先使用 2～4 字：${invalidNewStandards.join("、")}`, {
      code: "ORGANIZER_TOPIC_LENGTH_INVALID"
    });
  }
  if (newStandards.length) {
    await notionRequest(`/v1/data_sources/${config.dataSourceId}`, {
      method: "PATCH",
      body: N.topicOptionsUpdatePayload(options, newStandards),
      retrySafe: true,
      token
    });
    options = validTopicOptions(await readTopicOptions(config, token));
  }

  activeAbortController = controller;
  stateCache.running = true;
  organizer.previousMode = stateCache.mode;
  organizer.previousPaused = stateCache.paused;
  stateCache.mode = "topic_apply";

  const operationKey = JSON.stringify(selected.map(group => [group.id, group.standardTopic, [...group.aliases].sort()]).sort());
  const snapshot = stateCache.topicRollback?.incomplete && stateCache.topicRollback.operationKey === operationKey
    ? stateCache.topicRollback
    : {
        appliedAt: new Date().toISOString(),
        pages: [],
        dictionary: config.topicDictionary,
        discardedTopicNames: config.discardedTopicNames,
        unclassifiedBefore: clone(organizer.unclassified ?? []),
        manualSkippedBefore: clone(organizer.manualSkipped ?? []),
        groupIds: selected.map(group => group.id).filter(Boolean),
        groupsBefore: selected.map(group => clone(storedGroups.get(group.id))).filter(Boolean),
        appliedCandidateCountBefore: Number(organizer.appliedCandidateCount) || 0,
        incomplete: true,
        operationKey
      };
  const affectedPages = (organizer.pages ?? []).filter(page =>
    (page.provisionalTopics ?? []).some(name => aliasMap.has(N.topicKey(name)))
  );
  organizer.status = "applying";
  organizer.applyGroups = selected;
  organizer.progress = { done: 0, total: affectedPages.length };
  await persistState();
  try {
    const nextDictionary = mergeDictionaryEntries(config.topicDictionary, selected.map(group => ({
      name: group.standardTopic,
      definition: group.definition,
      aliases: group.aliases,
      color: N.topicColor(group.standardTopic),
      active: true
    })));
    for (let index = 0; index < affectedPages.length; index += 1) {
      if (controller.signal.aborted) throw new DOMException("已停止", "AbortError");
      const page = affectedPages[index];
      const currentPage = await notionRequest(`/v1/pages/${page.id}`, { signal: controller.signal, token });
      const current = N.topicOrganizerPageValues(currentPage);
      const additions = uniqueTopicNames((current.provisionalTopics ?? [])
        .map(name => aliasMap.get(N.topicKey(name)) || "")
        .filter(Boolean))
        .filter(name => !(current.aiTopics ?? []).some(old => N.topicKey(old) === N.topicKey(name)));
      const finalTopics = uniqueTopicNames([...(current.aiTopics ?? []), ...additions]);
      const processedKeys = new Set(aliasMap.keys());
      const unresolved = (current.provisionalTopics ?? [])
        .filter(name => !processedKeys.has(N.topicKey(name)));
      const status = unresolved.length ? N.STATUS.topicReview : N.STATUS.analyzed;
      let saved = snapshot.pages.find(item => item.id === page.id);
      const savedBefore = saved ? clone(saved) : null;
      if (!saved) {
        saved = {
          id: page.id,
          addedTopics: additions,
          provisionalBefore: current.provisionalTopics ?? [],
          provisionalAfter: unresolved,
          statusBefore: current.status,
          statusAfter: status
        };
        snapshot.pages.push(saved);
      } else {
        saved.addedTopics = uniqueTopicNames([...(saved.addedTopics ?? []), ...additions]);
        saved.provisionalAfter = unresolved;
        saved.statusAfter = status;
      }
      try {
        assertRollbackSnapshotSize(snapshot);
      } catch (error) {
        if (savedBefore) Object.assign(saved, savedBefore);
        else snapshot.pages.pop();
        throw error;
      }
      if (additions.length || current.status !== status || unresolved.length !== (current.provisionalTopics ?? []).length) {
        await notionRequest(`/v1/pages/${page.id}`, {
          method: "PATCH",
          body: N.topicApplyPayload(finalTopics, status, options, unresolved),
          retrySafe: true,
          signal: controller.signal,
          token
        });
      }
      page.provisionalTopics = unresolved;
      page.aiTopics = finalTopics;
      page.status = status;
      organizer.progress.done = index + 1;
      stateCache.topicRollback = snapshot;
      await persistState();
    }

    assertRollbackSnapshotSize(snapshot);
    config.topicDictionary = nextDictionary;
    await writeConfig(config);
    snapshot.incomplete = false;
    stateCache.topicRollback = snapshot;
    organizer.status = "applied";
    organizer.progress = { done: affectedPages.length, total: affectedPages.length };
    try {
      options = validTopicOptions(await readTopicOptions(config, token));
    } catch { /* keep last options */ }
    organizer.existingTopics = uniqueTopicNames([
      ...(options ?? []).map(option => option.name),
      ...selected.map(group => group.standardTopic)
    ]);
    const appliedById = new Map(selected.map(group => [group.id, group]));
    const appliedAliasKeys = new Set(selected.flatMap(group => group.aliases).map(N.topicKey));
    organizer.appliedCandidateCount = (Number(organizer.appliedCandidateCount) || 0) + appliedAliasKeys.size;
    organizer.groups = (organizer.groups ?? []).map(group => {
      const applied = appliedById.get(group.id);
      if (!applied) return group;
      const selectedKeys = new Set(applied.aliases.map(N.topicKey));
      const remaining = (group.aliases ?? []).filter(name => !selectedKeys.has(N.topicKey(name)));
      if (!remaining.length) {
        return { ...group, applied: true, selected: false, selectedAliases: [] };
      }
      const evidence = organizerGroupEvidence(organizer.candidates, remaining);
      return {
        ...group,
        aliases: remaining,
        selectedAliases: [],
        selected: false,
        applied: false,
        impactCount: evidence.impactCount
      };
    });
    stateCache.mode = organizer.previousMode || "idle";
    stateCache.paused = organizer.previousPaused !== false;
  } catch (error) {
    if (rollbackSnapshotSize(snapshot) <= MAX_PERSISTED_STATE_BYTES) {
      stateCache.topicRollback = snapshot;
    }
    organizer.status = "error";
    organizer.existingTopics = uniqueTopicNames([
      ...(organizer.existingTopics ?? []),
      ...selected.map(group => group.standardTopic)
    ]);
    stateCache.mode = organizer.previousMode || "idle";
    stateCache.lastError = isAbort(error)
      ? "主題套用已停止；可重新按套用安全續跑，或回復上一次。"
      : `主題套用遇到錯誤：${S.truncateMessage(error.message || "未知錯誤")}。可重新按套用安全續跑，或回復上一次。`;
    throw error;
  } finally {
    if (activeAbortController === controller) activeAbortController = null;
    stateCache.running = false;
    stateCache.stopRequested = false;
    await persistState();
  }
  return topicOrganizerForUi();
}

/**
 * Resolves one unclassified AI 暫定主題 from the organizer session. skip is
 * local-only. approve/replace/custom/discard write affected pages like apply
 * (one candidate, incremental rollback snapshots) but do not use group
 * cards: discard adds the name to discardedTopicNames instead of AI 主題.
 * Does not call AI. readyNotion may update missing schema.
 */
async function resolveOrganizerUnclassified(candidateName, action, replacementTopic = "", customTopic = "") {
  const organizer = stateCache.topicOrganizer;
  if (!organizer?.pages || stateCache.running) {
    throw new AppError(stateCache.running ? "目前正在處理其他工作" : "請先產生主題整理建議", { code: "BUSY" });
  }
  const candidate = (organizer.unclassified ?? [])
    .find(name => N.topicKey(name) === N.topicKey(candidateName));
  if (!candidate) throw new AppError("找不到要人工處理的暫存主題", { code: "MANUAL_TOPIC_MISSING" });
  if (action === "skip") {
    organizer.manualSkipped = uniqueTopicNames([...(organizer.manualSkipped ?? []), candidate]);
    organizer.status = "review";
    await persistState();
    return topicOrganizerForUi();
  }

  const { config, token } = await readyNotion();
  let options = validTopicOptions(await readTopicOptions(config, token));
  const byKey = new Map(options.map(option => [N.topicKey(option.name), option.name]));
  let selectedTopic = "";
  if (action === "approve") {
    if (!G.isOrganizerTopicLabel(candidate)) {
      throw new AppError("建立的新正式主題必須為 2～6 字，請改用自訂名稱", { code: "MANUAL_TOPIC_INVALID" });
    }
    selectedTopic = byKey.get(N.topicKey(candidate)) || candidate;
  } else if (action === "replace") {
    selectedTopic = byKey.get(N.topicKey(replacementTopic)) || "";
    if (!selectedTopic) {
      throw new AppError("請從目前的 Notion 既有主題中選擇對應項目", { code: "MANUAL_REPLACEMENT_INVALID" });
    }
  } else if (action === "custom") {
    const custom = S.cleanText(customTopic);
    if (!G.isOrganizerTopicLabel(custom)) {
      throw new AppError("自訂正式主題必須為 2～6 字，並優先使用 2～4 字", { code: "MANUAL_CUSTOM_INVALID" });
    }
    selectedTopic = byKey.get(N.topicKey(custom)) || custom;
  } else if (action !== "discard") {
    throw new AppError("未知的人工主題處理方式", { code: "MANUAL_TOPIC_ACTION_INVALID" });
  }

  if (selectedTopic && !byKey.has(N.topicKey(selectedTopic))) {
    await notionRequest(`/v1/data_sources/${config.dataSourceId}`, {
      method: "PATCH",
      body: N.topicOptionsUpdatePayload(options, [selectedTopic]),
      retrySafe: true,
      token
    });
    options = validTopicOptions(await readTopicOptions(config, token));
  }

  const candidateKey = N.topicKey(candidate);
  const affectedPages = (organizer.pages ?? []).filter(page =>
    (page.provisionalTopics ?? []).some(name => N.topicKey(name) === candidateKey)
  );
  const snapshot = {
    type: "manual",
    appliedAt: new Date().toISOString(),
    pages: [],
    dictionary: config.topicDictionary,
    discardedTopicNames: config.discardedTopicNames,
    groupsBefore: [],
    unclassifiedBefore: clone(organizer.unclassified ?? []),
    manualSkippedBefore: clone(organizer.manualSkipped ?? []),
    appliedCandidateCountBefore: Number(organizer.appliedCandidateCount) || 0,
    incomplete: true,
    operationKey: JSON.stringify(["manual", candidate, action, selectedTopic])
  };

  stateCache.running = true;
  stateCache.mode = "topic_apply";
  organizer.status = "applying";
  organizer.progress = { done: 0, total: affectedPages.length };
  await persistState();
  try {
    for (let index = 0; index < affectedPages.length; index += 1) {
      const cachedPage = affectedPages[index];
      const currentPage = await notionRequest(`/v1/pages/${cachedPage.id}`, { token });
      const current = N.topicOrganizerPageValues(currentPage);
      if (!(current.provisionalTopics ?? []).some(name => N.topicKey(name) === candidateKey)) {
        organizer.progress.done = index + 1;
        continue;
      }
      const unresolved = (current.provisionalTopics ?? [])
        .filter(name => N.topicKey(name) !== candidateKey);
      const additions = selectedTopic && !(current.aiTopics ?? []).some(name => N.topicKey(name) === N.topicKey(selectedTopic))
        ? [selectedTopic]
        : [];
      const finalTopics = uniqueTopicNames([...(current.aiTopics ?? []), ...additions]);
      const status = unresolved.length ? N.STATUS.topicReview : N.STATUS.analyzed;
      snapshot.pages.push({
        id: cachedPage.id,
        addedTopics: additions,
        provisionalBefore: current.provisionalTopics ?? [],
        provisionalAfter: unresolved,
        statusBefore: current.status,
        statusAfter: status
      });
      try {
        assertRollbackSnapshotSize(snapshot);
      } catch (error) {
        snapshot.pages.pop();
        throw error;
      }
      await notionRequest(`/v1/pages/${cachedPage.id}`, {
        method: "PATCH",
        body: N.topicApplyPayload(finalTopics, status, options, unresolved),
        retrySafe: true,
        token
      });
      cachedPage.provisionalTopics = unresolved;
      cachedPage.aiTopics = finalTopics;
      cachedPage.status = status;
      organizer.progress.done = index + 1;
      stateCache.topicRollback = snapshot;
      await persistState();
    }

    assertRollbackSnapshotSize(snapshot);
    if (selectedTopic) {
      config.topicDictionary = mergeDictionaryEntries(config.topicDictionary, [{
        name: selectedTopic,
        definition: "由未分類主題的人工確認建立的對照。",
        aliases: [candidate],
        color: N.topicColor(selectedTopic),
        active: true
      }]);
    } else {
      config.discardedTopicNames = normalizeDiscardedTopicNames([
        ...(config.discardedTopicNames ?? []),
        candidate
      ]);
    }
    await writeConfig(config);
    snapshot.incomplete = false;
    stateCache.topicRollback = snapshot;
    organizer.unclassified = (organizer.unclassified ?? [])
      .filter(name => N.topicKey(name) !== candidateKey);
    organizer.manualSkipped = (organizer.manualSkipped ?? [])
      .filter(name => N.topicKey(name) !== candidateKey);
    organizer.existingTopics = uniqueTopicNames([...(organizer.existingTopics ?? []), selectedTopic].filter(Boolean));
    organizer.appliedCandidateCount = (Number(organizer.appliedCandidateCount) || 0) + 1;
    organizer.status = "applied";
    organizer.progress = { done: affectedPages.length, total: affectedPages.length };
    stateCache.mode = "idle";
    stateCache.lastError = "";
  } catch (error) {
    if (rollbackSnapshotSize(snapshot) <= MAX_PERSISTED_STATE_BYTES) {
      stateCache.topicRollback = snapshot;
    }
    organizer.status = "error";
    stateCache.mode = "idle";
    throw error;
  } finally {
    stateCache.running = false;
    await persistState();
  }
  return topicOrganizerForUi();
}

// ==== Topic organizer rollback ====
/**
 * Reverts the last organizer apply or manual unclassified write. Reads each
 * snapshotted page and writes only when needed. Removes only topics recorded
 * in addedTopics; restores 整理狀態 only if it still equals statusAfter;
 * restores AI 暫定主題 only when the current value still matches
 * provisionalAfter. These guards skip those fields when they have changed,
 * but do not preserve every later edit. The topic dictionary and discarded-name
 * list are restored from the snapshot. When an organizer session still exists,
 * its saved group drafts, unclassified and manual-skipped state, and
 * applied-candidate count are also restored. Does not call AI.
 */
async function rollbackTopicOrganizer() {
  if (stateCache.running) throw new AppError("請先停止目前的主題套用", { code: "BUSY" });
  const snapshot = stateCache.topicRollback;
  if (!snapshot?.pages?.length) throw new AppError("目前沒有可回復的上一次套用紀錄", { code: "NO_ROLLBACK" });
  const { config, token } = await readyNotion();
  const options = validTopicOptions(await readTopicOptions(config, token));
  for (const page of snapshot.pages) {
    const currentPage = await notionRequest(`/v1/pages/${page.id}`, { token });
    const current = N.topicOrganizerPageValues(currentPage);
    const removeKeys = new Set((page.addedTopics ?? []).map(N.topicKey));
    const topics = (current.aiTopics ?? []).filter(name => !removeKeys.has(N.topicKey(name)));
    const status = current.status === page.statusAfter ? page.statusBefore : current.status;
    const currentProvisionalKeys = (current.provisionalTopics ?? []).map(N.topicKey);
    const expectedProvisionalKeys = (page.provisionalAfter ?? []).map(N.topicKey);
    const restoreProvisional = currentProvisionalKeys.length === expectedProvisionalKeys.length
      && currentProvisionalKeys.every((key, index) => key === expectedProvisionalKeys[index])
      ? page.provisionalBefore ?? []
      : null;
    if (topics.length !== (current.aiTopics ?? []).length || status !== current.status || restoreProvisional) {
      await notionRequest(`/v1/pages/${page.id}`, {
        method: "PATCH",
        body: N.topicApplyPayload(topics, status || N.STATUS.topicReview, options, restoreProvisional),
        retrySafe: true,
        token
      });
    }
    const cachedPage = stateCache.topicOrganizer?.pages?.find(item => item.id === page.id);
    if (cachedPage) {
      cachedPage.aiTopics = topics;
      cachedPage.status = status || N.STATUS.topicReview;
      cachedPage.provisionalTopics = Array.isArray(restoreProvisional)
        ? restoreProvisional
        : current.provisionalTopics ?? [];
    }
  }
  config.topicDictionary = normalizeTopicDictionary(snapshot.dictionary);
  config.discardedTopicNames = normalizeDiscardedTopicNames(snapshot.discardedTopicNames);
  await writeConfig(config);
  if (stateCache.topicOrganizer) {
    const beforeById = new Map((snapshot.groupsBefore ?? []).map(group => [group.id, group]));
    stateCache.topicOrganizer.groups = (stateCache.topicOrganizer.groups ?? []).map(group =>
      beforeById.has(group.id) ? clone(beforeById.get(group.id)) : group
    );
    stateCache.topicOrganizer.appliedCandidateCount = Number(snapshot.appliedCandidateCountBefore) || 0;
    stateCache.topicOrganizer.unclassified = clone(snapshot.unclassifiedBefore ?? stateCache.topicOrganizer.unclassified ?? []);
    stateCache.topicOrganizer.manualSkipped = clone(snapshot.manualSkippedBefore ?? stateCache.topicOrganizer.manualSkipped ?? []);
  }
  stateCache.topicRollback = null;
  if (stateCache.topicOrganizer) stateCache.topicOrganizer.status = "rolled_back";
  await persistState();
  return topicOrganizerForUi();
}

// ==== Topic dictionary import and export ====
function dictionaryExport(config) {
  return {
    format: "notion-ai-analyzer-topic-dictionary",
    version: 1,
    exportedAt: new Date().toISOString(),
    topics: normalizeTopicDictionary(config.topicDictionary)
  };
}

function previewDictionaryImport(value, config) {
  if (value?.format !== "notion-ai-analyzer-topic-dictionary" || !Array.isArray(value?.topics)) {
    throw new AppError("這不是有效的主題字典檔案", { code: "DICTIONARY_INVALID" });
  }
  const incoming = normalizeTopicDictionary(value.topics);
  const existing = new Map(normalizeTopicDictionary(config.topicDictionary).map(item => [N.topicKey(item.name), item]));
  const existingAliases = new Map();
  for (const item of existing.values()) {
    existingAliases.set(N.topicKey(item.name), item.name);
    for (const alias of item.aliases ?? []) existingAliases.set(N.topicKey(alias), item.name);
  }
  const conflicts = [];
  for (const item of incoming) {
    for (const alias of [item.name, ...(item.aliases ?? [])]) {
      const oldTarget = existingAliases.get(N.topicKey(alias));
      if (oldTarget && N.topicKey(oldTarget) !== N.topicKey(item.name)) {
        conflicts.push({ alias, existing: oldTarget, incoming: item.name });
      }
    }
  }
  return {
    incoming,
    conflicts,
    conflictCount: conflicts.length,
    newCount: incoming.filter(item => !existing.has(N.topicKey(item.name))).length,
    updateCount: incoming.filter(item => existing.has(N.topicKey(item.name))
      && JSON.stringify(existing.get(N.topicKey(item.name))) !== JSON.stringify(item)).length,
    unchangedCount: incoming.filter(item => JSON.stringify(existing.get(N.topicKey(item.name))) === JSON.stringify(item)).length
  };
}
