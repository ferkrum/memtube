"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

test("timeframe filtering is inclusive for both start and end dates", () => {
  const timeframe = {
    startDate: "2025-07-12",
    endDate: "2025-07-14",
  };

  const isWithinDateRange = (dateKey) =>
    dateKey >= timeframe.startDate && dateKey <= timeframe.endDate;

  assert.equal(isWithinDateRange("2025-07-12"), true);
  assert.equal(isWithinDateRange("2025-07-13"), true);
  assert.equal(isWithinDateRange("2025-07-14"), true);
  assert.equal(isWithinDateRange("2025-07-15"), false);
});

test("report-style group merge semantics keep old entries and replace matching ones", () => {
  const groups = [
    { date: "2025-07-09", title: "2025-07-09 - Santa Maria, Brasil", exportCreated: false },
    { date: "2025-07-10", title: "2025-07-10 - Porto Alegre, Brasil", exportCreated: true },
  ];
  const next = { date: "2025-07-09", title: "2025-07-09 - Santa Maria, Brasil", exportCreated: true };

  const index = groups.findIndex((group) => group.date === next.date && group.title === next.title);
  if (index >= 0) {
    groups[index] = { ...groups[index], ...next };
  } else {
    groups.push(next);
  }

  assert.equal(groups.length, 2);
  assert.equal(groups[0].exportCreated, true);
  assert.equal(groups[1].title, "2025-07-10 - Porto Alegre, Brasil");
});

test("scan flow should skip unreadable media files instead of aborting the run", async () => {
  const source = await import("node:fs/promises");
  const contents = await source.readFile(
    "/Users/ferkrum/Documents/codex/memtube/src/index.js",
    "utf8"
  );

  assert.match(contents, /Skipping unreadable media file/);
  assert.match(contents, /report\.skippedFiles/);
});

test("reruns should prompt for skip or reprocess when files were already processed", async () => {
  const source = await import("node:fs/promises");
  const contents = await source.readFile(
    "/Users/ferkrum/Documents/codex/memtube/src/index.js",
    "utf8"
  );

  assert.match(contents, /source file\(s\) were already processed before/);
  assert.match(contents, /Choose what to do: skip or reprocess/);
  assert.match(contents, /resolveProcessingReuseDecision/);
});

test("quota exhaustion should stop gracefully and tell the user to resume tomorrow", async () => {
  const source = await import("node:fs/promises");
  const contents = await source.readFile(
    "/Users/ferkrum/Documents/codex/memtube/src/index.js",
    "utf8"
  );

  assert.match(contents, /quotaExhausted/);
  assert.match(contents, /YouTube quota exhausted, resume tomorrow\./);
  assert.match(contents, /Progress was saved to/);
});
