"use strict";

const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const testsDir = path.join(root, "tests");
const files = fs.readdirSync(testsDir)
  .filter(name => name.endsWith(".test.js"))
  .sort();

if (!files.length) {
  console.error("No tests/*.test.js files found");
  process.exit(1);
}

let failed = 0;
for (const file of files) {
  const relativePath = path.join("tests", file);
  console.log(`\n> node ${relativePath}`);
  const result = spawnSync(process.execPath, [path.join(testsDir, file)], {
    cwd: root,
    stdio: "inherit"
  });
  if (result.status !== 0) {
    failed += 1;
    if (result.error) console.error(result.error);
  }
}

if (failed) {
  console.error(`\n${failed} test file(s) failed`);
  process.exit(1);
}

console.log(`\n${files.length} test file(s) passed`);
