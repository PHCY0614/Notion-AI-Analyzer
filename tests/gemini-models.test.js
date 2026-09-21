"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const G = require(path.join(root, "gemini.js"));

function source(name) {
  return fs.readFileSync(path.join(root, name), "utf8");
}

function listed(name, extra = {}) {
  return {
    name: `models/${name}`,
    displayName: extra.displayName || name,
    supportedGenerationMethods: extra.methods || ["generateContent"],
    inputTokenLimit: extra.inputTokenLimit,
    outputTokenLimit: extra.outputTokenLimit
  };
}

function testDefaultStaysDocumentedLite() {
  assert.equal(G.DEFAULT_MODEL, "gemini-3.5-flash-lite");
  assert.equal(G.MODEL_PRIORITY[0], "gemini-3.5-flash-lite");
  assert.ok(G.MODEL_PRIORITY.includes("gemini-3.8-flash"));
  assert.ok(G.MODEL_PRIORITY.includes("gemini-3.7-flash"));
  assert.ok(G.MODEL_PRIORITY.includes("gemini-2.5-flash-lite"));
}

function testUsableModelsPriorityAndExclusions() {
  const models = G.usableModels({
    models: [
      listed("gemini-3.8-flash"),
      listed("gemini-2.5-pro"),
      listed("gemini-3.5-flash-lite"),
      listed("gemini-3.1-flash-image"),
      listed("gemini-3.8-live"),
      listed("gemini-embedding-001", { methods: ["embedContent"] }),
      listed("gemini-2.5-flash")
    ]
  });
  assert.deepEqual(models.map(model => model.name), [
    "gemini-3.5-flash-lite",
    "gemini-3.8-flash",
    "gemini-2.5-flash",
    "gemini-2.5-pro"
  ]);
  assert.equal(G.recommendedModelName(models), "gemini-3.5-flash-lite");
}

function testRecommendedFollowsLiveList() {
  const withoutDefaultLite = G.usableModels({
    models: [
      listed("gemini-3.8-flash"),
      listed("gemini-2.5-flash"),
      listed("gemini-3.1-flash-lite")
    ]
  });
  assert.equal(withoutDefaultLite[0].name, "gemini-3.1-flash-lite");
  assert.equal(G.recommendedModelName(withoutDefaultLite), "gemini-3.1-flash-lite");
  assert.equal(
    G.pickAvailableModel(withoutDefaultLite, "gemini-3.5-flash-lite"),
    "gemini-3.1-flash-lite"
  );
  assert.equal(
    G.pickAvailableModel(withoutDefaultLite, "gemini-3.8-flash"),
    "gemini-3.8-flash"
  );
}

function testPickFallsBackToFirstWhenPriorityMissing() {
  const models = G.usableModels({
    models: [listed("gemini-custom-flash"), listed("gemini-custom-pro")]
  });
  assert.equal(G.recommendedModelName(models), "gemini-custom-flash");
  assert.equal(G.pickAvailableModel(models, "missing-model"), "gemini-custom-flash");
  assert.equal(G.pickAvailableModel([], "missing-model"), G.DEFAULT_MODEL);
}

function testStaticFallbacksMatchDocs() {
  const html = source("options.html");
  assert.match(html, /<option value="gemini-3.5-flash-lite">Gemini 3.5 Flash-Lite｜建議<\/option>/);
  assert.match(html, /<option value="gemini-3.8-flash">Gemini 3.8 Flash<\/option>/);
  assert.match(html, /<option value="gemini-3.7-flash">Gemini 3.7 Flash<\/option>/);
  assert.doesNotMatch(html, /gemini-2\.0-flash/);

  const settings = source("background/settings.js");
  const vertexFn = settings.slice(
    settings.indexOf("function recommendedVertexModels()"),
    settings.indexOf("async function testVertexModel")
  );
  assert.match(vertexFn, /name: "gemini-3.5-flash-lite"/);
  assert.match(vertexFn, /name: "gemini-3.8-flash"/);
  assert.match(vertexFn, /name: "gemini-3.7-flash"/);
  assert.doesNotMatch(vertexFn, /gemini-2\.0-flash/);
  const liteIndex = vertexFn.indexOf("gemini-3.5-flash-lite");
  const flash38Index = vertexFn.indexOf("gemini-3.8-flash");
  assert.ok(liteIndex < flash38Index, "Vertex curated list should recommend Flash-Lite before 3.8 Flash");

  const options = source("options.js");
  assert.match(options, /model\.name === recommendedName \? "｜建議"/);
  assert.doesNotMatch(options, /model\.name === "gemini-3\.5-flash-lite" \? "｜建議"/);
}

testDefaultStaysDocumentedLite();
testUsableModelsPriorityAndExclusions();
testRecommendedFollowsLiveList();
testPickFallsBackToFirstWhenPriorityMissing();
testStaticFallbacksMatchDocs();
console.log("gemini model tests passed");
