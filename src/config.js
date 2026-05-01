"use strict";

const path = require("node:path");

const IMAGE_EXTENSIONS = new Set([
  ".jpg",
  ".jpeg",
  ".png",
  ".heic",
  ".heif",
  ".gif",
  ".webp",
  ".tif",
  ".tiff",
  ".arw",
  ".cr2",
  ".cr3",
  ".nef",
  ".dng",
]);

const VIDEO_EXTENSIONS = new Set([
  ".mp4",
  ".mov",
  ".m4v",
  ".avi",
  ".mts",
  ".m2ts",
  ".3gp",
  ".mkv",
  ".wmv",
  ".mpg",
  ".mpeg",
]);

const EXPORT_FOLDER_NAME = "export_to_youtube";
const GEOCODE_CACHE_FILE = ".geocode-cache.json";
const REPORT_FILE_NAME = "export-report.json";
const MIN_VIDEO_DURATION_SECONDS = 2;
const NOMINATIM_URL = "https://nominatim.openstreetmap.org/reverse";
const OVERPASS_URL = "https://overpass-api.de/api/interpreter";
const USER_AGENT = "memtube/1.0 (+https://openai.com)";

function isSupportedMedia(filePath) {
  const extension = path.extname(filePath).toLowerCase();
  return IMAGE_EXTENSIONS.has(extension) || VIDEO_EXTENSIONS.has(extension);
}

function isVideoFile(filePath) {
  return VIDEO_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}

module.exports = {
  EXPORT_FOLDER_NAME,
  GEOCODE_CACHE_FILE,
  IMAGE_EXTENSIONS,
  isSupportedMedia,
  isVideoFile,
  MIN_VIDEO_DURATION_SECONDS,
  NOMINATIM_URL,
  OVERPASS_URL,
  REPORT_FILE_NAME,
  USER_AGENT,
  VIDEO_EXTENSIONS,
};
