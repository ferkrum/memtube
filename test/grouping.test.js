"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { inferDayTitle } = require("../src/grouping");

test("uses dominant place when all media stays in one city", () => {
  const title = inferDayTitle({
    dateKey: "2025-06-25",
    items: [
      { place: { city: "Santa Maria", country: "Brazil", compactName: "Santa Maria, Brazil" } },
      { place: { city: "Santa Maria", country: "Brazil", compactName: "Santa Maria, Brazil" } },
      { place: { city: "Santa Maria", country: "Brazil", compactName: "Santa Maria, Brazil" } },
    ],
  });

  assert.equal(title, "2025-06-25 - Santa Maria, Brazil");
});

test("detects travel when the city changes during the day", () => {
  const title = inferDayTitle({
    dateKey: "2025-07-21",
    items: [
      { place: { city: "Milan", country: "Italy", compactName: "Milan, Italy" } },
      { place: { city: "Milan", country: "Italy", compactName: "Milan, Italy" } },
      { place: { city: "Locarno", country: "Switzerland", compactName: "Locarno, Switzerland" } },
    ],
  });

  assert.equal(title, "2025-07-21 - Milan to Locarno");
});
