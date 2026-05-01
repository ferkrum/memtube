"use strict";

const http = require("node:http");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const readline = require("node:readline");
const { spawn } = require("node:child_process");

const { google } = require("googleapis");

const YOUTUBE_SCOPE = "https://www.googleapis.com/auth/youtube";

async function uploadExportsToYouTube(groups, options) {
  const uploads = [];

  for (const group of groups) {
    uploads.push(await uploadGroupToYouTube(group, options));
  }

  return uploads;
}

async function createYouTubeClient(options) {
  const auth = await authorizeYouTube(options);
  return google.youtube({ version: "v3", auth });
}

async function createPlaylistOnYouTube(options, youtubeClient = null) {
  const youtube = youtubeClient || (await createYouTubeClient(options));
  const response = await youtube.playlists.insert({
    part: ["snippet", "status"],
    requestBody: {
      snippet: {
        title: options.youtubeNewPlaylistTitle,
        description: options.youtubeNewPlaylistDescription || undefined,
        defaultLanguage: options.youtubeDefaultLanguage,
      },
      status: {
        privacyStatus: options.youtubeNewPlaylistPrivacy || options.youtubePrivacy,
      },
    },
  });

  const playlistId = response.data.id || null;
  return {
    playlistId,
    title: response.data.snippet?.title || options.youtubeNewPlaylistTitle,
    privacyStatus:
      response.data.status?.privacyStatus ||
      options.youtubeNewPlaylistPrivacy ||
      options.youtubePrivacy,
    url: playlistId ? `https://www.youtube.com/playlist?list=${playlistId}` : null,
  };
}

async function rebuildGroupDescriptionOnYouTube(group, options, youtubeClient = null) {
  const videoId = group.youtubeUpload?.videoId;
  if (!videoId) {
    return {
      date: group.date,
      skipped: true,
      reason: "No YouTube video ID was found in the report for this group.",
    };
  }

  const youtube = youtubeClient || (await createYouTubeClient(options));
  const existing = await youtube.videos.list({
    part: ["snippet"],
    id: [videoId],
  });

  const video = existing.data.items?.[0];
  if (!video?.snippet) {
    return {
      date: group.date,
      skipped: true,
      reason: `Video ${videoId} was not found on YouTube.`,
    };
  }

  const nextDescription = truncate(buildDescription(group, options), 5000);
  await youtube.videos.update({
    part: ["snippet"],
    requestBody: {
      id: videoId,
      snippet: {
        title: video.snippet.title,
        description: nextDescription,
        categoryId: video.snippet.categoryId,
        tags: video.snippet.tags,
        defaultLanguage: video.snippet.defaultLanguage || options.youtubeDefaultLanguage,
      },
    },
  });

  return {
    date: group.date,
    skipped: false,
    videoId,
    url: group.youtubeUpload?.url || `https://www.youtube.com/watch?v=${videoId}`,
    descriptionUpdated: true,
  };
}

async function uploadGroupToYouTube(group, options, youtubeClient = null) {
  if (!group.exportCreated || !group.exportPath) {
    return {
      date: group.date,
      skipped: true,
      reason: "No export file was created for this group.",
    };
  }

  const youtube = youtubeClient || (await createYouTubeClient(options));
  const snippet = buildSnippet(group, options);
  const status = buildStatus(options);
  const response = await youtube.videos.insert({
    part: ["snippet", "status"],
    notifySubscribers: options.youtubeNotifySubscribers,
    requestBody: {
      snippet,
      status,
    },
    media: {
      mimeType: inferMimeType(group.exportPath),
      body: fs.createReadStream(group.exportPath),
    },
  });

  const upload = {
    date: group.date,
    skipped: false,
    videoId: response.data.id || null,
    privacyStatus: response.data.status?.privacyStatus || options.youtubePrivacy,
    title: response.data.snippet?.title || snippet.title,
    url: response.data.id ? `https://www.youtube.com/watch?v=${response.data.id}` : null,
  };

  if (options.youtubePlaylistId && response.data.id) {
    await youtube.playlistItems.insert({
      part: ["snippet"],
      requestBody: {
        snippet: {
          playlistId: options.youtubePlaylistId,
          resourceId: {
            kind: "youtube#video",
            videoId: response.data.id,
          },
        },
      },
    });

    upload.playlistId = options.youtubePlaylistId;
    upload.addedToPlaylist = true;
  } else {
    upload.playlistId = options.youtubePlaylistId || null;
    upload.addedToPlaylist = false;
  }

  return upload;
}

async function authorizeYouTube(options) {
  const credentials = JSON.parse(await fsp.readFile(options.youtubeCredentialsPath, "utf8"));
  const shape = credentials.installed || credentials.web;
  if (!shape) {
    throw new Error("The YouTube credentials file must contain an 'installed' or 'web' OAuth client.");
  }

  const oauth2Client = new google.auth.OAuth2(
    shape.client_id,
    shape.client_secret,
    shape.redirect_uris?.[0]
  );

  try {
    const tokenContents = await fsp.readFile(options.youtubeTokenPath, "utf8");
    oauth2Client.setCredentials(JSON.parse(tokenContents));
    try {
      await oauth2Client.getAccessToken();
      return oauth2Client;
    } catch (error) {
      if (!isInvalidGrantError(error)) {
        throw error;
      }

      console.log("Stored YouTube token is no longer valid. Reauthorizing...");
      await fsp.rm(options.youtubeTokenPath, { force: true });
    }
  } catch (error) {
    if (error && error.code !== "ENOENT") {
      throw error;
    }
  }

  const token = await getNewToken(shape, options);
  await fsp.writeFile(options.youtubeTokenPath, `${JSON.stringify(token, null, 2)}\n`, "utf8");
  oauth2Client.setCredentials(token);
  return oauth2Client;
}

function isInvalidGrantError(error) {
  const message = String(error?.message || "");
  const code = String(error?.code || "");
  const responseData = JSON.stringify(error?.response?.data || {});
  return (
    message.includes("invalid_grant") ||
    code === "invalid_grant" ||
    responseData.includes("invalid_grant")
  );
}

async function getNewToken(clientShape, options) {
  const callback = await createLoopbackCallbackServer();
  const interactiveClient = new google.auth.OAuth2(
    clientShape.client_id,
    clientShape.client_secret,
    callback.redirectUri
  );

  const authUrl = interactiveClient.generateAuthUrl({
    access_type: "offline",
    prompt: "consent",
    scope: [YOUTUBE_SCOPE],
  });

  try {
    console.log("Authorize this app by visiting this URL:");
    console.log(authUrl);
    await tryOpenBrowser(authUrl, options.youtubeOpenBrowser);

    let code;
    try {
      code = await callback.waitForCode();
      console.log("Authorization code received automatically.");
    } catch (error) {
      console.log("Automatic callback capture failed. Falling back to manual code entry.");
      code = await askQuestion("Paste the authorization code here: ");
    }

    const response = await interactiveClient.getToken(code.trim());
    return response.tokens;
  } finally {
    await callback.close();
  }
}

function buildSnippet(group, options) {
  const tags = dedupeTags([
    ...options.youtubeTags,
    ...extractTagsFromGroup(group),
  ]).slice(0, 500);

  return {
    title: truncate(group.title, 100),
    description: truncate(buildDescription(group, options), 5000),
    categoryId: String(options.youtubeCategoryId),
    tags: tags.length > 0 ? tags : undefined,
    defaultLanguage: options.youtubeDefaultLanguage,
  };
}

function buildStatus(options) {
  const status = {
    privacyStatus: options.youtubePrivacy,
  };

  if (typeof options.youtubeMadeForKids === "boolean") {
    status.selfDeclaredMadeForKids = options.youtubeMadeForKids;
  }

  return status;
}

function buildDescription(group, options) {
  const parts = [];
  if (options.youtubeDescriptionPrefix) {
    parts.push(options.youtubeDescriptionPrefix);
  }
  parts.push(group.title);
  parts.push(group.narrative);
  parts.push(`Data do grupo: ${group.date}`);
  parts.push(`Arquivos processados: ${group.fileCount}`);
  parts.push(`Clipes exportados: ${group.clipCount}`);
  if (Array.isArray(group.chapters) && group.chapters.length > 0) {
    parts.push(["Capitulos:", ...group.chapters.map((chapter) => `${chapter.timestamp} ${chapter.label}`)].join("\n"));
  }
  return parts.filter(Boolean).join("\n\n");
}

function extractTagsFromGroup(group) {
  const tags = [];
  if (group.date) {
    tags.push(group.date);
  }

  for (const value of group.title.split(/[-,]/).map((item) => item.trim())) {
    if (value) {
      tags.push(value);
    }
  }

  for (const file of group.files || []) {
    if (file.place?.city) {
      tags.push(file.place.city);
    }
    if (file.place?.state) {
      tags.push(file.place.state);
    }
    if (file.place?.country) {
      tags.push(file.place.country);
    }
  }

  return tags;
}

function dedupeTags(tags) {
  const seen = new Set();
  const output = [];
  for (const tag of tags) {
    const normalized = String(tag || "").trim();
    if (!normalized) {
      continue;
    }
    const key = normalized.toLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    output.push(normalized);
  }
  return output;
}

function truncate(value, limit) {
  if (value.length <= limit) {
    return value;
  }
  return value.slice(0, Math.max(0, limit - 1)).trimEnd();
}

function inferMimeType(filePath) {
  const extension = path.extname(filePath).toLowerCase();
  if (extension === ".mov") {
    return "video/quicktime";
  }
  if (extension === ".mp4") {
    return "video/mp4";
  }
  return "application/octet-stream";
}

function askQuestion(prompt) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    rl.question(prompt, (answer) => {
      rl.close();
      resolve(answer);
    });
  });
}

async function tryOpenBrowser(url, enabled) {
  if (!enabled) {
    return;
  }

  const command =
    process.platform === "darwin"
      ? "open"
      : process.platform === "win32"
        ? "start"
        : "xdg-open";

  try {
    await new Promise((resolve, reject) => {
      const child = spawn(command, [url], {
        shell: process.platform === "win32",
        stdio: "ignore",
      });
      child.on("error", reject);
      child.on("close", (code) => {
        if (code === 0) {
          resolve();
          return;
        }
        reject(new Error(`Browser opener exited with code ${code}`));
      });
    });
  } catch {
    console.log("Could not open the browser automatically. Open the URL manually.");
  }
}

async function createLoopbackCallbackServer() {
  let resolveCode;
  let rejectCode;

  const codePromise = new Promise((resolve, reject) => {
    resolveCode = resolve;
    rejectCode = reject;
  });

  const server = http.createServer((request, response) => {
    const url = new URL(request.url, "http://127.0.0.1");
    const code = url.searchParams.get("code");
    const error = url.searchParams.get("error");

    response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });

    if (code) {
      response.end(
        "<html><body><h1>Autorizacao concluida</h1><p>Voce pode fechar esta aba e voltar ao aplicativo.</p></body></html>"
      );
      resolveCode(code);
      return;
    }

    if (error) {
      response.end(
        "<html><body><h1>Autorizacao falhou</h1><p>Volte ao aplicativo e tente novamente.</p></body></html>"
      );
      rejectCode(new Error(`Authorization failed: ${error}`));
      return;
    }

    response.end(
      "<html><body><h1>Resposta incompleta</h1><p>Nenhum codigo foi recebido.</p></body></html>"
    );
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });

  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Could not determine the local OAuth callback address.");
  }

  const redirectUri = `http://127.0.0.1:${address.port}`;

  return {
    redirectUri,
    waitForCode() {
      return Promise.race([
        codePromise,
        new Promise((_, reject) => {
          setTimeout(() => reject(new Error("Timed out waiting for OAuth callback.")), 5 * 60 * 1000);
        }),
      ]);
    },
    close() {
      return new Promise((resolve) => {
        server.close(() => resolve());
      });
    },
  };
}

module.exports = {
  buildSnippetForTest: buildSnippet,
  createPlaylistOnYouTube,
  createYouTubeClient,
  rebuildGroupDescriptionOnYouTube,
  uploadGroupToYouTube,
  uploadExportsToYouTube,
};
