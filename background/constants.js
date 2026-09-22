"use strict";

// Service worker: constants, defaults, AppError, and runtime state.

// ==== Constants and defaults ====
const S = globalThis.AnalyzerShared;
const P = globalThis.AnalyzerPrompt;
const N = globalThis.AnalyzerNotion;
const G = globalThis.AnalyzerGemini;

const CONFIG_KEY = "notionAiAnalyzerConfig";
const STATE_KEY = "notionAiAnalyzerState";
const NOTION_TOKEN_KEY = "notionAiAnalyzerNotionToken";
const GEMINI_KEY_KEY = "notionAiAnalyzerGeminiKey";
const VERTEX_KEY_KEY = "notionAiAnalyzerVertexKey";
// Retained only to erase credentials saved by older releases.
const LEGACY_PROVIDER_KEY = "notionAiAnalyzerOpenRouterKey";
const PROCESS_ALARM = "notion-ai-analyzer-process";
const MAX_BLOCKS = 10000;
const MAX_RECENT = 40;
const MAX_FAILED_PAGES_TO_LOAD = 40;
const MAX_STORED_PAGE_TITLE_CHARACTERS = N.MAX_STORED_PAGE_TITLE_CHARACTERS;
// Hard cap after DIRECT_TEXT_LIMIT (180k) so long articles can use the
// chunk-notes pipeline. About ten CHUNK_TEXT_LIMIT (78k) pieces.
const MAX_ARTICLE_CHARACTERS = 780000;
const MAX_INPUT_TOKENS = 350000;
const TOKEN_PREFLIGHT_CHARACTERS = 80000;
const MAX_PENDING_PAGES = 2000;
const MAX_NOTION_DATA_SOURCES = 300;
const MAX_PERSISTED_STATE_BYTES = 4 * 1024 * 1024;
const CURRENT_PROMPT_VERSION = "2026-08-26-1";
const TOPIC_ORGANIZER_CACHE_VERSION = 10;
const TOPIC_ORGANIZER_BATCH_LIMIT = G.TOPIC_ORGANIZER_BATCH_LIMIT;
const DEFAULT_EXCLUDED_PERSON_TERMS = Object.freeze([]);
const REQUEUE_TIMEOUT_CODES = new Set([
  "AI_TIMEOUT",
  "PAGE_READ_TIMEOUT",
  "NOTION_WRITE_TIMEOUT"
]);
const RATE_LIMIT_CODES = new Set([
  "GEMINI_RATE_LIMIT",
  "VERTEX_RATE_LIMIT",
  "NOTION_RATE_LIMIT"
]);
const SETUP_ERROR_CODES = new Set([
  "GEMINI_AUTH",
  "GEMINI_KEY_MISSING",
  "VERTEX_AUTH",
  "VERTEX_KEY_MISSING",
  "AI_PROVIDER_RESELECTION_REQUIRED",
  "MODEL_INVALID",
  "MODEL_NOT_FOUND",
  "SCHEMA_INVALID",
  "NOTION_FIELDS_INVALID",
  "NOTION_STATUS_FIELD_MISSING",
  "NOTION_STATUS_FIELD_TYPE",
  "NOTION_PENDING_OPTION_MISSING",
  "NOTION_AUTH",
  "NOTION_TOKEN_MISSING",
  "TOPIC_OPTIONS_EMPTY"
]);

const DEFAULT_CONFIG = Object.freeze({
  aiProvider: "gemini",
  allowTopicProposals: true,
  analysisPrompt: "",
  analysisPromptCustomized: false,
  promptBaseVersion: CURRENT_PROMPT_VERSION,
  dataSourceId: "",
  databaseId: "",
  discardedTopicNames: [],
  excludedPersonTerms: DEFAULT_EXCLUDED_PERSON_TERMS,
  geminiModel: G.DEFAULT_MODEL,
  vertexModel: G.DEFAULT_MODEL,
  notionTarget: "",
  rememberGeminiKey: false,
  rememberVertexKey: false,
  rememberNotionToken: false,
  requestTimeoutMinutes: 5,
  outputSpec: P.DEFAULT_OUTPUT_SPEC,
  preferExistingTopicsByDataSource: {},
  topicAliases: {},
  topicPageResolutions: {},
  topicDictionary: [],
  providerReselectionRequired: false
});

const DEFAULT_STATE = Object.freeze({
  current: null,
  databaseCheck: null,
  failed: [],
  knownPending: null,
  lastError: "",
  lastScanAt: "",
  pendingScan: null,
  mode: "idle",
  paused: true,
  queue: [],
  recent: [],
  running: false,
  stopRequested: false,
  stage: null,
  topicOrganizer: null,
  topicRollback: null,
  topicReview: null
});

class AppError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = "AppError";
    this.code = options.code || "APP_ERROR";
    this.diagnostic = options.diagnostic || null;
    this.status = options.status || 0;
    this.retryAfter = options.retryAfter || 0;
  }
}

// ==== Runtime module state ====
let initializePromise = null;
let stateCache = null;
let activeAbortController = null;
let processingPromise = null;
let preparedDataSourceId = "";
let customAnalysisPromptCleared = false;
