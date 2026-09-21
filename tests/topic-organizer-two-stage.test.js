"use strict";

const assert = require("node:assert/strict");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const G = require(path.join(root, "gemini.js"));

function userText(payload) {
  return payload.contents?.[0]?.parts?.[0]?.text ?? "";
}

function testFirstStageCannotSeeExistingTopics() {
  const candidates = [{ name: "生成式AI" }, { name: "大型語言模型" }];
  const standards = [{ name: "人工智慧" }];
  const options = { preferExistingTopics: true };
  const payloads = [
    G.buildTopicOrganizerRequest(candidates, standards, "gemini-test", options),
    G.buildTopicOrganizerCompatibilityRequest(candidates, standards, "gemini-test", options),
    G.buildTopicOrganizerRepairRequest("bad", ["error"], candidates.map(item => item.name), standards, "gemini-test", options)
  ];
  for (const payload of payloads) {
    assert.match(userText(payload), /生成式AI/);
    assert.match(userText(payload), /大型語言模型/);
    assert.doesNotMatch(userText(payload), /人工智慧/);
    assert.doesNotMatch(userText(payload), /既有主題優先模式/);
  }
  assert.equal(payloads[0].generationConfig.responseJsonSchema, G.TOPIC_ORGANIZER_JSON_SCHEMA);
}

function testSecondStageReceivesOnlyFixedGroupsAndStandards() {
  const groups = [{
    group_id: "group_1",
    proposed_topic: "語言模型",
    source_topics: ["生成式AI", "大型語言模型"],
    definition: "生成式語言模型相關內容"
  }];
  const payload = G.buildTopicStandardMatcherRequest(
    groups,
    [{ name: "人工智慧" }],
    "gemini-test",
    { preferExistingTopics: true }
  );
  const text = userText(payload);
  assert.match(text, /group_1/);
  assert.match(text, /語言模型/);
  assert.match(text, /生成式AI/);
  assert.match(text, /人工智慧/);
  assert.match(text, /既有主題優先模式：已開啟/);
  assert.equal(payload.generationConfig.responseJsonSchema, G.TOPIC_STANDARD_MATCHER_JSON_SCHEMA);
}

function testInvalidMatchesKeepFirstStageNames() {
  const groups = [
    { group_id: "group_1", proposed_topic: "語言模型" },
    { group_id: "group_2", proposed_topic: "外交政治" },
    { group_id: "group_3", proposed_topic: "藝術史" }
  ];
  const checked = G.validateTopicStandardMatches({ matches: [
    {
      group_id: "group_1",
      decision: "reuse_existing",
      matched_topic: "人工智慧",
      reason: "檢索範圍可由既有主題涵蓋。",
      confidence: "high"
    },
    {
      group_id: "group_2",
      decision: "reuse_existing",
      matched_topic: "不存在的主題",
      reason: "錯誤比對",
      confidence: "high"
    }
  ] }, groups, [{ name: "人工智慧" }]);
  assert.equal(checked.ok, true);
  assert.deepEqual(checked.value.matches.map(match => [match.group_id, match.decision, match.matched_topic]), [
    ["group_1", "reuse_existing", "人工智慧"],
    ["group_2", "keep_proposed", ""],
    ["group_3", "keep_proposed", ""]
  ]);
  assert.ok(checked.warnings.some(message => message.includes("不在既有 AI 主題")));
  assert.ok(checked.warnings.some(message => message.includes("缺少比對結果")));
}

function testFirstStageDoesNotPromoteAFormerExistingSingleton() {
  const checked = G.validateTopicOrganizer({
    groups: [{
      standard_topic: "人工智慧",
      source_topics: ["人工智慧應用"],
      definition: "",
      keep_separate: [],
      reason: "單一來源",
      confidence: "high"
    }],
    unclassified_topics: []
  }, ["人工智慧應用"], []);
  assert.equal(checked.ok, true);
  assert.equal(checked.value.groups.length, 0);
  assert.deepEqual(checked.value.unclassified_topics, ["人工智慧應用"]);
}

testFirstStageCannotSeeExistingTopics();
testSecondStageReceivesOnlyFixedGroupsAndStandards();
testInvalidMatchesKeepFirstStageNames();
testFirstStageDoesNotPromoteAFormerExistingSingleton();
console.log("topic organizer two-stage tests passed");
