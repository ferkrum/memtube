"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { buildSnippetForTest } = require("../src/youtube");

test("builds a valid YouTube snippet with title, tags and description", () => {
  const snippet = buildSnippetForTest(
    {
      date: "2025-07-09",
      title: "2025-07-09 - Santa Maria, Brasil",
      narrative: "Mostly captured around Santa Maria, Brasil.",
      fileCount: 17,
      clipCount: 4,
      files: [
        {
          place: {
            city: "Santa Maria",
            state: "Rio Grande do Sul",
            country: "Brasil",
          },
        },
      ],
    },
    {
      youtubeTags: ["viagem"],
      youtubeCategoryId: "22",
      youtubeDefaultLanguage: "pt-BR",
      youtubeDescriptionPrefix: "Resumo automatico",
    }
  );

  assert.equal(snippet.title, "2025-07-09 - Santa Maria, Brasil");
  assert.equal(snippet.categoryId, "22");
  assert.equal(snippet.defaultLanguage, "pt-BR");
  assert.match(snippet.description, /Resumo automatico/);
  assert.ok(snippet.tags.includes("viagem"));
  assert.ok(snippet.tags.includes("Santa Maria"));
});

test("private should remain the default upload visibility", async () => {
  const source = await import("node:fs/promises");
  const contents = await source.readFile(
    "/Users/ferkrum/Documents/codex/youtube-uploader/src/index.js",
    "utf8"
  );

  assert.match(contents, /youtubePrivacy:\s*"private"/);
});

test("videos should default to not made for kids", async () => {
  const source = await import("node:fs/promises");
  const contents = await source.readFile(
    "/Users/ferkrum/Documents/codex/youtube-uploader/src/index.js",
    "utf8"
  );

  assert.match(contents, /youtubeMadeForKids:\s*false/);
});

test("description rebuild flag should be available in the CLI", async () => {
  const source = await import("node:fs/promises");
  const contents = await source.readFile(
    "/Users/ferkrum/Documents/codex/youtube-uploader/src/index.js",
    "utf8"
  );

  assert.match(contents, /--youtube-rebuild-descriptions/);
});

test("delete-after-upload flag should be available in the CLI", async () => {
  const source = await import("node:fs/promises");
  const contents = await source.readFile(
    "/Users/ferkrum/Documents/codex/youtube-uploader/src/index.js",
    "utf8"
  );

  assert.match(contents, /--youtube-delete-after-upload/);
  assert.match(contents, /youtubeDeleteAfterUpload:\s*false/);
});
