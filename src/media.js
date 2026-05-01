"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");
const { spawn } = require("node:child_process");

const ffmpegPath = require("ffmpeg-static");
const ffprobePath = require("ffprobe-static").path;
const { exiftool } = require("exiftool-vendored");

const { isVideoFile, MIN_VIDEO_DURATION_SECONDS } = require("./config");
const { buildClipCaption, extractCoordinate, preferredDate } = require("./utils");

async function readMediaMetadata(filePath) {
  const [stats, metadata] = await Promise.all([
    fs.stat(filePath),
    exiftool.read(filePath),
  ]);

  const createdAt = preferredDate(metadata, stats);
  if (!createdAt) {
    throw new Error(`Unable to determine creation date for ${filePath}`);
  }

  const latitude = extractCoordinate(
    metadata.GPSLatitude ?? metadata.CompositeGPSLatitude ?? metadata.GPSPosition?.latitude
  );
  const longitude = extractCoordinate(
    metadata.GPSLongitude ?? metadata.CompositeGPSLongitude ?? metadata.GPSPosition?.longitude
  );
  const durationSeconds = await getDurationSeconds(filePath, metadata);

  return {
    path: filePath,
    name: path.basename(filePath),
    createdAt,
    metadata,
    gps: latitude != null && longitude != null ? { latitude, longitude } : null,
    durationSeconds,
    type: isVideoFile(filePath) ? "video" : "image",
  };
}

async function getDurationSeconds(filePath, metadata) {
  const exifDuration = metadata.Duration ?? metadata.MediaDuration ?? metadata.TrackDuration;
  if (typeof exifDuration === "number" && Number.isFinite(exifDuration)) {
    return exifDuration;
  }

  if (!isVideoFile(filePath)) {
    return null;
  }

  const args = [
    "-v",
    "error",
    "-show_entries",
    "format=duration",
    "-of",
    "default=noprint_wrappers=1:nokey=1",
    filePath,
  ];

  const output = await runProcess(ffprobePath, args);
  const duration = Number.parseFloat(output.trim());
  return Number.isFinite(duration) ? duration : null;
}

async function inspectExportedVideo(filePath) {
  const [stats, durationSeconds] = await Promise.all([
    fs.stat(filePath),
    getDurationSeconds(filePath, {}),
  ]);

  const statfs = await fs.statfs(path.dirname(filePath));
  const freeBytes = Number(statfs.bavail) * Number(statfs.bsize);

  return {
    fileSizeBytes: stats.size,
    durationSeconds,
    freeBytes,
  };
}

function selectExportClips(items) {
  return items
    .filter((item) => item.type === "video")
    .filter((item) => (item.durationSeconds ?? 0) > MIN_VIDEO_DURATION_SECONDS)
    .sort((a, b) => a.createdAt - b.createdAt);
}

async function exportMergedVideo({ clips, outputPath, tempDir, onClipNormalized }) {
  if (clips.length === 0) {
    return null;
  }

  await fs.mkdir(tempDir, { recursive: true });
  const fontFile = await resolveFontFile();
  const normalizedPaths = [];

  for (let index = 0; index < clips.length; index += 1) {
    const clip = clips[index];
    const normalizedPath = path.join(tempDir, `segment-${String(index).padStart(4, "0")}.mp4`);
    const captionPath = path.join(tempDir, `caption-${String(index).padStart(4, "0")}.txt`);
    await fs.writeFile(captionPath, `${buildClipCaption(clip)}\n`, "utf8");
    await normalizeClip({
      inputPath: clip.path,
      outputPath: normalizedPath,
      captionPath,
      fontFile,
    });
    normalizedPaths.push(normalizedPath);
    if (onClipNormalized) {
      onClipNormalized(index + 1, clips.length, clip);
    }
  }

  const listFilePath = path.join(tempDir, "concat-list.txt");
  const concatFileContents = normalizedPaths
    .map((clipPath) => `file '${escapeConcatPath(clipPath)}'`)
    .join("\n");
  await fs.writeFile(listFilePath, `${concatFileContents}\n`, "utf8");

  const args = [
    "-y",
    "-f",
    "concat",
    "-safe",
    "0",
    "-i",
    listFilePath,
    "-c",
    "copy",
    outputPath,
  ];

  try {
    await runProcess(ffmpegPath, args);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }

  return outputPath;
}

async function normalizeClip({ inputPath, outputPath, captionPath, fontFile }) {
  const drawTextFilter = [
    "drawtext=",
    `fontfile=${escapeFilterValue(fontFile)}`,
    `textfile=${escapeFilterValue(captionPath)}`,
    "reload=0",
    "fontcolor=white@0.6",
    "fontsize=26",
    "x=40",
    "y=h-th-40",
    "enable='between(t,0,2)'",
  ].join(":");

  const args = [
    "-y",
    "-i",
    inputPath,
    "-map",
    "0:v:0",
    "-map",
    "0:a:0?",
    "-dn",
    "-sn",
    "-vf",
    `scale=w=1920:h=1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2:black,fps=30,${drawTextFilter}`,
    "-c:v",
    "libx264",
    "-preset",
    "medium",
    "-crf",
    "20",
    "-pix_fmt",
    "yuv420p",
    "-c:a",
    "aac",
    "-b:a",
    "192k",
    "-ac",
    "2",
    "-ar",
    "48000",
    "-af",
    "aresample=async=1:first_pts=0",
    "-movflags",
    "+faststart",
    outputPath,
  ];

  await runProcess(ffmpegPath, args);
}

async function resolveFontFile() {
  const candidates = [
    "/Library/Fonts/Verdana.ttf",
    "/System/Library/Fonts/Supplemental/Verdana.ttf",
    "/System/Library/Fonts/Verdana.ttf",
    "/System/Library/Fonts/Supplemental/Arial Unicode.ttf",
    "/System/Library/Fonts/Supplemental/Arial.ttf",
    "/System/Library/Fonts/Supplemental/Helvetica.ttc",
    "/Library/Fonts/Arial Unicode.ttf",
    "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
    "/usr/share/fonts/dejavu/DejaVuSans.ttf",
  ];

  for (const candidate of candidates) {
    try {
      await fs.access(candidate);
      return candidate;
    } catch {
      // Try the next font candidate.
    }
  }

  throw new Error("No usable font file was found for FFmpeg drawtext.");
}

function escapeConcatPath(filePath) {
  return filePath.replace(/'/g, "'\\''");
}

function escapeFilterValue(value) {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/ /g, "\\ ")
    .replace(/:/g, "\\:")
    .replace(/,/g, "\\,")
    .replace(/'/g, "\\'");
}

function runProcess(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });

    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve(stdout);
        return;
      }
      reject(new Error(`Command failed (${command} ${args.join(" ")}): ${stderr || stdout}`));
    });
  });
}

async function shutdownExiftool() {
  await exiftool.end();
}

module.exports = {
  exportMergedVideo,
  inspectExportedVideo,
  readMediaMetadata,
  selectExportClips,
  shutdownExiftool,
};
