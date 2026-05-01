"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { composePlace } = require("../src/utils");

test("composePlace keeps city, state and country ready for captions and titles", () => {
  const place = composePlace("Santa Maria", "Rio Grande do Sul", "Brasil");

  assert.deepEqual(place, {
    city: "Santa Maria",
    state: "Rio Grande do Sul",
    country: "Brasil",
    displayName: "Santa Maria, Rio Grande do Sul, Brasil",
    compactName: "Santa Maria, Brasil",
  });
});
