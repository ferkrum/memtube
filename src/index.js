#!/usr/bin/env node
"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");
const readline = require("node:readline");

const { EXPORT_FOLDER_NAME, REPORT_FILE_NAME } = require("./config");
const { collectDateFolders, collectMediaFiles } = require("./discover");
const { loadGeocodeCache, reverseGeocode } = require("./geocode");
const { buildExportFileName, groupByDay, inferDayTitle, inferNarrative } = require("./grouping");
const { exportMergedVideo, inspectExportedVideo, readMediaMetadata, selectExportClips, shutdownExiftool } = require("./media");
const { buildClipCaption, createProgressTracker, ensureDir, formatBytesToGb, formatBytesToMb, formatDateKey, formatSecondsAsClock, readJsonIfExists, relativeTo, writeJson } = require("./utils");
const { createYouTubeClient, rebuildGroupDescriptionOnYouTube, uploadGroupToYouTube } = require("./youtube");

async function main() {
  const cli = parseCli(process.argv.slice(2));
  const inputFolders = cli.inputFolders;
  if (inputFolders.length === 0) {
    throw new Error("Pass one or more folders: youtube-uploader <folder> <folder> ...");
  }

  const resolvedFolders = inputFolders.map((folder) => path.resolve(folder));
  const outputBaseDir = findCommonAncestor(resolvedFolders);
  const exportDir = path.join(outputBaseDir, EXPORT_FOLDER_NAME);
  const geocodeState = await loadGeocodeCache(outputBaseDir);

  await ensureDir(exportDir);

  const discoveredDates = await collectDateFolders(resolvedFolders);
  const timeframe = await resolveTimeframeSelection(cli.options, discoveredDates);
  const reportPath = path.join(exportDir, REPORT_FILE_NAME);
  const report = await loadExistingReport(reportPath, resolvedFolders, cli.options, timeframe);

  let youtubeClient = null;
  if (cli.options.youtubeUpload || cli.options.youtubeRebuildDescriptions) {
    await resolveInteractiveYouTubeOptions(cli.options, {
      requirePlaylistId: cli.options.youtubeUpload,
    });
    youtubeClient = await createYouTubeClient(cli.options);
  }

  if (cli.options.youtubeRebuildDescriptions) {
    const cachedGroups = await loadGroupsFromFolderReports(resolvedFolders, timeframe);
    const rebuildGroups = cachedGroups.length > 0
      ? cachedGroups
      : await scanAndBuildGroups({
          resolvedFolders,
          timeframe,
          discoveredDates,
          geocodeState,
        });
    const dayProgress = createProgressTracker({
      label: "days",
      total: rebuildGroups.length,
    });
    await rebuildDescriptionsForGroups({
      groups: rebuildGroups,
      report,
      reportPath,
      youtubeClient,
      options: cli.options,
      outputBaseDir,
      dayProgress,
      resolvedFolders,
      timeframe,
    });

    if (cli.options.youtubePlaylistId) {
      console.log(`YouTube playlist: ${buildPlaylistUrl(cli.options.youtubePlaylistId)}`);
    }
    console.log(`Done. Updated YouTube descriptions and report at ${reportPath}`);
    playCompletionSound();
    return;
  }

  const groups = await scanAndBuildGroups({
    resolvedFolders,
    timeframe,
    discoveredDates,
    geocodeState,
  });
  if (groups.length === 0) {
    return;
  }
  const dayProgress = createProgressTracker({
    label: "days",
    total: groups.length,
  });

  for (let groupIndex = 0; groupIndex < groups.length; groupIndex += 1) {
    const group = groups[groupIndex];
    const title = inferDayTitle(group);
    const exportFileName = buildExportFileName(title);
    const outputPath = path.join(exportDir, exportFileName);
    const clips = selectExportClips(group.items);
    dayProgress.update(groupIndex, `Starting ${title}`);

    const reportGroup = {
      date: group.dateKey,
      title,
      narrative: inferNarrative(group),
      exportCreated: false,
      exportPath: null,
      clipCount: clips.length,
      fileCount: group.items.length,
      chapters: buildChaptersFromClips(clips),
      files: group.items.map((item) => ({
        path: item.path,
        relativePath: relativeTo(outputBaseDir, item.path),
        type: item.type,
        createdAt: item.createdAt.toISOString(),
        durationSeconds: item.durationSeconds,
        gps: item.gps,
        place: item.place,
      })),
    };

    const conflictDecision = await resolveExistingProcessingConflict({
      report,
      reportGroup,
      outputPath,
    });

    if (conflictDecision === "cancel") {
      console.log(`Cancelling processing at ${title} by user request.`);
      break;
    }

    if (conflictDecision === "skip") {
      console.log(`Skipping ${title} because it was already processed before.`);
      dayProgress.update(groupIndex + 1, `Skipped ${title}`);
      continue;
    }

    await cleanupPreviousExportIfNeeded(report, reportGroup, outputPath);

    if (clips.length > 0) {
      console.log(`Exporting ${clips.length} clips for ${title}`);
      const tempDir = path.join(exportDir, `.tmp-${group.dateKey}`);
      const clipProgress = createProgressTracker({
        label: `clips ${group.dateKey}`,
        total: clips.length,
      });
      await exportMergedVideo({
        clips,
        outputPath,
        tempDir,
        onClipNormalized(current, total, clip) {
          clipProgress.update(current, path.basename(clip.path));
        },
      });
      reportGroup.exportCreated = true;
      reportGroup.exportPath = outputPath;
      reportGroup.exportInfo = await inspectExportedVideo(outputPath);
      console.log(`Finished export for ${title}`);
      console.log(
        `Exported file stats: size ${formatBytesToMb(reportGroup.exportInfo.fileSizeBytes)}, duration ${formatSecondsAsClock(reportGroup.exportInfo.durationSeconds)}, free space ${formatBytesToGb(reportGroup.exportInfo.freeBytes)}`
      );

      if (youtubeClient) {
        console.log(`Uploading ${title} to YouTube`);
        console.log(`[upload ${group.dateKey}] [------------------------] 0/1 (0.0%) elapsed 00:00:00 ETA 00:00:00 Starting upload`);
        reportGroup.youtubeUpload = await uploadGroupToYouTube(reportGroup, cli.options, youtubeClient);
        console.log(`[upload ${group.dateKey}] [########################] 1/1 (100.0%) elapsed 00:00:00 ETA 00:00:00 Upload complete`);
        if (reportGroup.youtubeUpload?.url) {
          console.log(`YouTube video URL: ${reportGroup.youtubeUpload.url}`);
        }
        if (cli.options.youtubeDeleteAfterUpload) {
          await deleteLocalExportAfterUpload(reportGroup);
        }
        console.log(`Finished YouTube upload for ${title}`);
      }
    } else {
      console.log(`Skipping ${title}: no video clips longer than 2 seconds.`);
    }

    upsertReportGroup(report, reportGroup);
    report.generatedAt = new Date().toISOString();
    report.lastRun = {
      sourceFolders: resolvedFolders,
      youtubeUploadRequested: cli.options.youtubeUpload,
      timeframe,
    };
    await writeJson(reportPath, report);
    dayProgress.update(groupIndex + 1, `Finished ${title}`);
  }

  await writeJson(reportPath, report);
  if (cli.options.youtubePlaylistId) {
    console.log(`YouTube playlist: ${buildPlaylistUrl(cli.options.youtubePlaylistId)}`);
  }
  console.log(`Done. Wrote exports and report to ${exportDir}`);
  playCompletionSound();
}

async function scanAndBuildGroups({ resolvedFolders, timeframe, discoveredDates, geocodeState }) {
  let mediaFiles = await collectMediaFiles(resolvedFolders);
  if (timeframe && discoveredDates.length > 0) {
    mediaFiles = mediaFiles.filter((filePath) => fileMatchesDateRange(filePath, timeframe));
  }

  if (mediaFiles.length === 0) {
    console.log("No supported media files were found.");
    return [];
  }

  console.log(`Discovered ${mediaFiles.length} supported media files.`);
  const metadataProgress = createProgressTracker({
    label: "metadata",
    total: mediaFiles.length,
  });

  const metadataItems = [];
  for (let index = 0; index < mediaFiles.length; index += 1) {
    const filePath = mediaFiles[index];
    const item = await readMediaMetadata(filePath);
    if (item.gps) {
      try {
        item.place = await reverseGeocode(item.gps.latitude, item.gps.longitude, geocodeState);
      } catch (error) {
        item.place = null;
        console.warn(`Geocoding failed for ${filePath}: ${error.message}`);
      }
    } else {
      item.place = null;
    }
    metadataItems.push(item);
    metadataProgress.update(index + 1, path.basename(filePath));
  }

  const filteredMetadataItems = timeframe
    ? metadataItems.filter((item) => isWithinDateRange(formatDateKey(item.createdAt), timeframe))
    : metadataItems;

  if (filteredMetadataItems.length === 0) {
    console.log("No media files matched the selected timeframe.");
    return [];
  }

  return groupByDay(filteredMetadataItems);
}

function parseCli(argv) {
  const options = {
    youtubeUpload: false,
    youtubeDeleteAfterUpload: false,
    youtubeOpenBrowser: true,
    youtubePrivacy: "private",
    youtubePlaylistId: "",
    youtubeCategoryId: "22",
    youtubeTags: [],
    youtubeDefaultLanguage: "pt-BR",
    youtubeDescriptionPrefix: "",
    youtubeNotifySubscribers: false,
    youtubeMadeForKids: false,
    youtubeCredentialsPath: path.resolve(process.cwd(), "client_secret.json"),
    youtubeTokenPath: path.resolve(process.cwd(), ".youtube-upload-token.json"),
    timeframe: null,
    youtubeRebuildDescriptions: false,
  };
  const inputFolders = [];

  for (const argument of argv) {
    if (!argument.startsWith("--")) {
      inputFolders.push(argument);
      continue;
    }

    if (argument === "--youtube-upload") {
      options.youtubeUpload = true;
      continue;
    }
    if (argument === "--youtube-delete-after-upload") {
      options.youtubeDeleteAfterUpload = true;
      continue;
    }
    if (argument === "--youtube-rebuild-descriptions") {
      options.youtubeRebuildDescriptions = true;
      continue;
    }
    if (argument === "--no-youtube-upload") {
      options.youtubeUpload = false;
      continue;
    }
    if (argument === "--youtube-no-browser") {
      options.youtubeOpenBrowser = false;
      continue;
    }
    if (argument === "--youtube-notify-subscribers") {
      options.youtubeNotifySubscribers = true;
      continue;
    }
    if (argument === "--youtube-made-for-kids") {
      options.youtubeMadeForKids = true;
      continue;
    }
    if (argument === "--youtube-not-made-for-kids") {
      options.youtubeMadeForKids = false;
      continue;
    }

    const [flag, ...rest] = argument.split("=");
    const value = rest.join("=");

    switch (flag) {
      case "--youtube-privacy":
        assertPrivacy(value);
        options.youtubePrivacy = value;
        break;
      case "--youtube-category":
        options.youtubeCategoryId = value || options.youtubeCategoryId;
        break;
      case "--youtube-playlist-id":
        options.youtubePlaylistId = value || "";
        break;
      case "--youtube-tags":
        options.youtubeTags = value
          .split(",")
          .map((item) => item.trim())
          .filter(Boolean);
        break;
      case "--youtube-description-prefix":
        options.youtubeDescriptionPrefix = value;
        break;
      case "--youtube-language":
        options.youtubeDefaultLanguage = value || options.youtubeDefaultLanguage;
        break;
      case "--youtube-credentials":
        options.youtubeCredentialsPath = path.resolve(process.cwd(), value);
        break;
      case "--youtube-token":
        options.youtubeTokenPath = path.resolve(process.cwd(), value);
        break;
      case "--timeframe":
        options.timeframe = parseTimeframeInput(value);
        break;
      default:
        throw new Error(`Unknown option: ${argument}`);
    }
  }

  return { inputFolders, options };
}

function assertPrivacy(value) {
  const allowed = new Set(["public", "private", "unlisted"]);
  if (!allowed.has(value)) {
    throw new Error("--youtube-privacy must be one of: public, private, unlisted");
  }
}

async function resolveInteractiveYouTubeOptions(options, settings = {}) {
  const requirePlaylistId = settings.requirePlaylistId ?? true;

  if (!(await fileExists(options.youtubeCredentialsPath))) {
    const answer = await askQuestion(
      `Path to your YouTube OAuth credentials JSON [${options.youtubeCredentialsPath}]: `
    );
    if (answer.trim()) {
      options.youtubeCredentialsPath = path.resolve(process.cwd(), answer.trim());
    }
  }

  if (!(await fileExists(options.youtubeCredentialsPath))) {
    throw new Error(`YouTube credentials file not found: ${options.youtubeCredentialsPath}`);
  }

  if (requirePlaylistId && !options.youtubePlaylistId) {
    const answer = await askQuestion("YouTube playlist ID to add uploaded videos to: ");
    options.youtubePlaylistId = answer.trim();
  }

  if (requirePlaylistId && !options.youtubePlaylistId) {
    throw new Error("A YouTube playlist ID is required for upload in interactive mode.");
  }
}

async function resolveTimeframeSelection(options, discoveredDates) {
  if (options.timeframe) {
    return options.timeframe;
  }

  if (!process.stdin.isTTY || discoveredDates.length === 0) {
    return null;
  }

  const start = discoveredDates[0];
  const end = discoveredDates[discoveredDates.length - 1];
  const answer = await askQuestion(
    `I found a time span from ${start} to ${end}. Which timeframe you want to process? Please inform Startdate; End-date: `
  );

  return parseTimeframeInput(answer);
}

async function fileExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
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

function parseTimeframeInput(value) {
  const [startDateRaw, endDateRaw] = String(value || "")
    .split(";")
    .map((item) => item.trim());

  if (!isIsoDate(startDateRaw) || !isIsoDate(endDateRaw)) {
    throw new Error("Timeframe must use the format YYYY-MM-DD; YYYY-MM-DD");
  }

  if (startDateRaw > endDateRaw) {
    throw new Error("The timeframe start date must be before or equal to the end date.");
  }

  return {
    startDate: startDateRaw,
    endDate: endDateRaw,
  };
}

function isIsoDate(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(value || "");
}

function fileMatchesDateRange(filePath, timeframe) {
  const matches = filePath.match(/\d{4}-\d{2}-\d{2}/g) || [];
  return matches.some((match) => isWithinDateRange(match, timeframe));
}

function isWithinDateRange(dateKey, timeframe) {
  return dateKey >= timeframe.startDate && dateKey <= timeframe.endDate;
}

async function loadExistingReport(reportPath, sourceFolders, options, timeframe) {
  const existing = await readJsonIfExists(reportPath, null);
  const baseReport = {
    generatedAt: new Date().toISOString(),
    sourceFolders,
    youtubeUploadRequested: options.youtubeUpload,
    timeframe,
    groups: [],
  };

  if (!existing || typeof existing !== "object") {
    return baseReport;
  }

  return {
    ...existing,
    generatedAt: new Date().toISOString(),
    sourceFolders: uniqueStrings([...(existing.sourceFolders || []), ...sourceFolders]),
    youtubeUploadRequested: options.youtubeUpload,
    timeframe,
    groups: Array.isArray(existing.groups) ? existing.groups : [],
  };
}

async function loadGroupsFromFolderReports(resolvedFolders, timeframe) {
  const loaded = [];

  for (const folder of resolvedFolders) {
    const candidatePath = path.join(folder, EXPORT_FOLDER_NAME, REPORT_FILE_NAME);
    const report = await readJsonIfExists(candidatePath, null);
    if (!report || !Array.isArray(report.groups)) {
      continue;
    }

    for (const storedGroup of report.groups) {
      if (timeframe && !isWithinDateRange(storedGroup.date, timeframe)) {
        continue;
      }

      const normalized = normalizeStoredGroup(storedGroup);
      if (normalized) {
        loaded.push(normalized);
      }
    }
  }

  loaded.sort((left, right) => left.dateKey.localeCompare(right.dateKey));
  return loaded;
}

function normalizeStoredGroup(storedGroup) {
  if (!storedGroup?.date || !Array.isArray(storedGroup.files)) {
    return null;
  }

  return {
    dateKey: storedGroup.date,
    storedReportGroup: storedGroup,
    items: storedGroup.files
      .map((file) => ({
        path: file.path,
        name: path.basename(file.path),
        createdAt: new Date(file.createdAt),
        durationSeconds: file.durationSeconds,
        type: file.type,
        gps: file.gps,
        place: file.place,
      }))
      .filter((item) => item.createdAt instanceof Date && !Number.isNaN(item.createdAt.getTime()))
      .sort((left, right) => left.createdAt - right.createdAt),
  };
}

function upsertReportGroup(report, reportGroup) {
  const index = report.groups.findIndex(
    (group) => group.date === reportGroup.date && group.title === reportGroup.title
  );

  if (index >= 0) {
    report.groups[index] = {
      ...report.groups[index],
      ...reportGroup,
    };
    return;
  }

  report.groups.push(reportGroup);
  report.groups.sort((left, right) => {
    if (left.date !== right.date) {
      return left.date.localeCompare(right.date);
    }
    return left.title.localeCompare(right.title);
  });
}

function uniqueStrings(values) {
  return [...new Set(values.filter(Boolean))];
}

function buildPlaylistUrl(playlistId) {
  return `https://www.youtube.com/playlist?list=${playlistId}`;
}

async function rebuildDescriptionsForGroups({
  groups,
  report,
  reportPath,
  youtubeClient,
  options,
  outputBaseDir,
  dayProgress,
  resolvedFolders,
  timeframe,
}) {
  for (let groupIndex = 0; groupIndex < groups.length; groupIndex += 1) {
    const group = groups[groupIndex];
    const title = group.storedReportGroup?.title || inferDayTitle(group);
    const clips = selectExportClips(group.items);
    const reportGroup = {
      date: group.dateKey,
      title,
      narrative: group.storedReportGroup?.narrative || inferNarrative(group),
      exportCreated: group.storedReportGroup?.exportCreated || false,
      exportPath: group.storedReportGroup?.exportPath || null,
      clipCount: clips.length,
      fileCount: group.items.length,
      chapters: buildChaptersFromClips(clips),
      files: group.items.map((item) => ({
        path: item.path,
        relativePath: relativeTo(outputBaseDir, item.path),
        type: item.type,
        createdAt: item.createdAt.toISOString(),
        durationSeconds: item.durationSeconds,
        gps: item.gps,
        place: item.place,
      })),
    };

    const previousGroup =
      group.storedReportGroup?.youtubeUpload?.videoId
        ? group.storedReportGroup
        : report.groups.find(
            (existingGroup) => existingGroup.date === reportGroup.date && existingGroup.youtubeUpload?.videoId
          );

    if (!previousGroup?.youtubeUpload?.videoId) {
      console.log(`Skipping ${title}: no previously uploaded YouTube video was found in export-report.json.`);
      dayProgress.update(groupIndex + 1, `Skipped ${title}`);
      continue;
    }

    reportGroup.exportCreated = previousGroup.exportCreated;
    reportGroup.exportPath = previousGroup.exportPath;
    reportGroup.youtubeUpload = previousGroup.youtubeUpload;
    reportGroup.exportInfo = previousGroup.exportInfo;

    dayProgress.update(groupIndex, `Rebuilding description for ${title}`);
    console.log(`Rebuilding YouTube description for ${title}`);
    const updateResult = await rebuildGroupDescriptionOnYouTube(reportGroup, options, youtubeClient);
    reportGroup.youtubeDescriptionRebuilt = updateResult;
    if (updateResult.url) {
      console.log(`YouTube video URL: ${updateResult.url}`);
    }

    upsertReportGroup(report, reportGroup);
    report.generatedAt = new Date().toISOString();
    report.lastRun = {
      sourceFolders: resolvedFolders,
      youtubeUploadRequested: options.youtubeUpload,
      youtubeRebuildDescriptions: true,
      timeframe,
    };
    await writeJson(reportPath, report);
    dayProgress.update(groupIndex + 1, `Updated ${title}`);
  }
}

function buildChaptersFromClips(clips) {
  let offsetSeconds = 0;
  return clips.map((clip) => {
    const chapter = {
      timestamp: formatSecondsAsClock(offsetSeconds),
      label: buildClipCaption(clip),
    };
    offsetSeconds += Math.max(0, Math.round(clip.durationSeconds || 0));
    return chapter;
  });
}

async function resolveExistingProcessingConflict({ report, reportGroup, outputPath }) {
  const existingGroup = report.groups.find((group) => group.date === reportGroup.date);
  const existingPaths = [existingGroup?.exportPath, outputPath].filter(Boolean);
  const hasExistingFile = await anyFileExists(existingPaths);

  if (!existingGroup || !hasExistingFile) {
    return "overwrite";
  }

  const existingTitle = existingGroup.title || reportGroup.title;
  const existingPath = existingGroup.exportPath || outputPath;
  const message = [
    `I found that ${existingTitle} was already processed before.`,
    `Existing export file: ${existingPath}`,
    "Choose what to do: skip, overwrite, or cancel",
  ].join("\n");

  if (!process.stdin.isTTY) {
    throw new Error(
      `${message}\nInteractive input is not available, so the app cannot decide automatically.`
    );
  }

  while (true) {
    const answer = (await askQuestion(`${message}\nYour choice: `)).trim().toLowerCase();
    if (["skip", "overwrite", "cancel"].includes(answer)) {
      return answer;
    }
    console.log("Please answer with one of: skip, overwrite, cancel");
  }
}

async function anyFileExists(filePaths) {
  for (const filePath of filePaths) {
    if (await fileExists(filePath)) {
      return true;
    }
  }
  return false;
}

async function cleanupPreviousExportIfNeeded(report, reportGroup, outputPath) {
  const existingGroup = report.groups.find((group) => group.date === reportGroup.date);
  const previousExportPath = existingGroup?.exportPath;
  if (!previousExportPath || previousExportPath === outputPath) {
    return;
  }

  if (await fileExists(previousExportPath)) {
    await fs.rm(previousExportPath, { force: true });
  }
}

async function deleteLocalExportAfterUpload(reportGroup) {
  if (!reportGroup.exportPath) {
    return;
  }

  if (await fileExists(reportGroup.exportPath)) {
    await fs.rm(reportGroup.exportPath, { force: true });
  }

  reportGroup.localExportDeletedAfterUpload = true;
  reportGroup.localExportDeletedAt = new Date().toISOString();
  console.log(`Deleted local export after upload: ${reportGroup.exportPath}`);
}

function playCompletionSound() {
  if (!process.stdout.isTTY) {
    return;
  }

  process.stdout.write("\u0007");
  setTimeout(() => {
    process.stdout.write("\u0007");
  }, 150);
}

function findCommonAncestor(paths) {
  const [firstPath, ...rest] = paths;
  const firstSegments = firstPath.split(path.sep).filter(Boolean);
  let sharedSegments = firstSegments;

  for (const currentPath of rest) {
    const currentSegments = currentPath.split(path.sep).filter(Boolean);
    const nextShared = [];
    const length = Math.min(sharedSegments.length, currentSegments.length);

    for (let index = 0; index < length; index += 1) {
      if (sharedSegments[index] !== currentSegments[index]) {
        break;
      }
      nextShared.push(sharedSegments[index]);
    }

    sharedSegments = nextShared;
  }

  return path.join(path.sep, ...sharedSegments);
}

main()
  .catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    await shutdownExiftool();
  });
