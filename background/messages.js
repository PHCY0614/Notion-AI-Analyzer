"use strict";

// Service worker: message routing. Chrome listeners stay in background.js.

// ==== Message routing ====
async function handleMessage(message) {
  await initialize();
  switch (message?.type) {
    case "GET_STATUS":
      return publicStatus();
    case "GET_CONFIG":
      return getConfigForUi();
    case "LIST_NOTION_DATA_SOURCES":
      return listNotionDataSources(message.notionToken);
    case "SAVE_SETTINGS":
      return saveSettings(message.settings ?? {});
    case "TEST_CONNECTIONS":
      return testConnections();
    case "PREPARE_NOTION_STATUS_FIELD":
      return prepareNotionStatusField();
    case "LIST_MODELS": {
      const config = await readConfig();
      const provider = normalizeAiProvider(config.aiProvider);
      let models;
      if (provider === "vertex") models = recommendedVertexModels();
      else models = await listGeminiModels();
      return {
        models,
        provider,
        recommended: G.recommendedModelName(models)
      };
    }
    case "SCAN_PENDING":
      await scanPending();
      return publicStatus();
    case "ANALYZE_ALL":
      return queueAll();
    case "STOP_ANALYSIS":
      return stopAnalysis();
    case "RESUME_ANALYSIS":
      return resumeAnalysis();
    case "RETRY_FAILED":
      return retryFailed();
    case "REANALYZE_PAGE":
      return reanalyzePage(message.pageId, message.force === true);
    case "REVIEW_CURRENT_PAGE_TOPICS":
      return reviewCurrentPageTopics(message.pageId);
    case "INSPECT_PAGE":
      return inspectPage(message.pageId);
    case "PREPARE_TOPIC_ORGANIZER":
      return prepareTopicOrganizer();
    case "GET_TOPIC_ORGANIZER":
      return topicOrganizerForUi();
    case "APPLY_TOPIC_GROUPS":
      return applyTopicOrganizerGroups(message.groups ?? []);
    case "SKIP_TOPIC_GROUP":
      return skipTopicOrganizerGroup(message.groupId, message.groups ?? []);
    case "RESOLVE_ORGANIZER_UNCLASSIFIED":
      return resolveOrganizerUnclassified(
        message.candidate,
        message.action,
        message.replacementTopic,
        message.customTopic
      );
    case "CLEAR_TOPIC_ORGANIZER":
      return clearTopicOrganizer();
    case "ROLLBACK_TOPIC_APPLY":
      return rollbackTopicOrganizer();
    case "EXPORT_TOPIC_DICTIONARY":
      return dictionaryExport(await readConfig());
    case "PREVIEW_TOPIC_DICTIONARY_IMPORT":
      return previewDictionaryImport(message.value, await readConfig());
    case "IMPORT_TOPIC_DICTIONARY": {
      const config = await readConfig();
      const preview = previewDictionaryImport(message.value, config);
      config.topicDictionary = message.mode === "overwrite"
        ? preview.incoming
        : mergeDictionaryEntries(config.topicDictionary, preview.incoming);
      await writeConfig(config);
      return { imported: preview.incoming.length, total: config.topicDictionary.length };
    }
    case "RESOLVE_TOPIC_REVIEW":
      return resolveTopicReview(
        message.action,
        message.replacementTopic,
        message.customTopic,
        message.rememberMapping !== false
      );
    case "CLEAR_RECENT":
      stateCache.recent = [];
      stateCache.failed = stateCache.failed.map(entry => ({
        ...entry,
        diagnostic: null
      }));
      await persistState();
      return publicStatus();
    case "CLEAR_CREDENTIALS":
      await clearCredentials();
      return { cleared: true };
    case "OPEN_OPTIONS":
      await chrome.runtime.openOptionsPage();
      return { opened: true };
    default:
      throw new AppError("未知的操作", { code: "UNKNOWN_MESSAGE" });
  }
}
