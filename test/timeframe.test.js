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
