"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { buildClipCaption } = require("../src/utils");

test("formats clip captions in pt-BR with time and place", () => {
  const caption = buildClipCaption({
    createdAt: new Date(2024, 3, 12, 12, 49, 23),
    place: {
      city: "Santa Maria",
      state: "Rio Grande do Sul",
      country: "Brasil",
    },
  });

  assert.equal(
    caption,
    "12 de abril de 2024, 12:49:23, Santa Maria, Rio Grande do Sul, Brasil"
  );
});
