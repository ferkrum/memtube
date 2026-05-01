"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");
const ptBrMonths = [
  "janeiro",
  "fevereiro",
  "marco",
  "abril",
  "maio",
  "junho",
  "julho",
  "agosto",
  "setembro",
  "outubro",
  "novembro",
  "dezembro",
];

function pad(value) {
  return String(value).padStart(2, "0");
}

function formatDateKey(date) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function sanitizeFileName(name) {
  return name.replace(/[<>:"/\\|?*\u0000-\u001f]/g, " ").replace(/\s+/g, " ").trim();
}

function extractCoordinate(raw) {
  if (raw == null) {
    return null;
  }
  if (typeof raw === "number") {
    return Number.isFinite(raw) ? raw : null;
  }
  if (typeof raw === "string") {
    const parsed = Number.parseFloat(raw);
    return Number.isFinite(parsed) ? parsed : null;
  }
  if (typeof raw === "object") {
    if ("value" in raw) {
      return extractCoordinate(raw.value);
    }
    if ("decimal" in raw) {
      return extractCoordinate(raw.decimal);
    }
    if ("num" in raw) {
      return extractCoordinate(raw.num);
    }
  }
  return null;
}

function preferredDate(metadata, fallbackStat) {
  const candidates = [
    metadata.DateTimeOriginal,
    metadata.CreateDate,
    metadata.MediaCreateDate,
    metadata.TrackCreateDate,
    metadata.FileModifyDate,
  ];

  for (const candidate of candidates) {
    const date = toDate(candidate);
    if (date) {
      return date;
    }
  }

  if (fallbackStat?.birthtime instanceof Date && !Number.isNaN(fallbackStat.birthtime.getTime())) {
    return fallbackStat.birthtime;
  }

  if (fallbackStat?.mtime instanceof Date && !Number.isNaN(fallbackStat.mtime.getTime())) {
    return fallbackStat.mtime;
  }

  return null;
}

function toDate(value) {
  if (!value) {
    return null;
  }
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return value;
  }
  if (typeof value === "string") {
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime())) {
      return parsed;
    }
  }
  if (typeof value === "object") {
    if (value.toDate instanceof Function) {
      const converted = value.toDate();
      if (converted instanceof Date && !Number.isNaN(converted.getTime())) {
        return converted;
      }
    }
    if ("rawValue" in value) {
      return toDate(value.rawValue);
    }
    if ("value" in value) {
      return toDate(value.value);
    }
  }
  return null;
}

async function ensureDir(directoryPath) {
  await fs.mkdir(directoryPath, { recursive: true });
}

async function readJsonIfExists(filePath, fallback) {
  try {
    const contents = await fs.readFile(filePath, "utf8");
    return JSON.parse(contents);
  } catch (error) {
    if (error && error.code === "ENOENT") {
      return fallback;
    }
    throw error;
  }
}

async function writeJson(filePath, value) {
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function normalizePlaceName(place) {
  if (!place) {
    return null;
  }
  const city = place.city || place.town || place.village || place.hamlet || place.county || null;
  const state = place.state || null;
  const country = place.country || null;
  return {
    city,
    state,
    country,
    displayName: [city, state, country].filter(Boolean).join(", "),
    compactName: [city, country].filter(Boolean).join(", "),
  };
}

function composePlace(city, state, country) {
  return {
    city: city || null,
    state: state || null,
    country: country || null,
    displayName: [city, state, country].filter(Boolean).join(", "),
    compactName: [city, country].filter(Boolean).join(", "),
  };
}

function locationKey(place) {
  if (!place) {
    return "unknown";
  }
  return [place.city, place.state, place.country].filter(Boolean).join("|").toLowerCase();
}

function relativeTo(baseDir, targetPath) {
  return path.relative(baseDir, targetPath) || ".";
}

function formatCaptionTimestamp(date) {
  const day = pad(date.getDate());
  const month = ptBrMonths[date.getMonth()];
  const year = date.getFullYear();
  const hours = pad(date.getHours());
  const minutes = pad(date.getMinutes());
  const seconds = pad(date.getSeconds());
  return `${day} de ${month} de ${year}, ${hours}:${minutes}:${seconds}`;
}

function formatCaptionLocation(place) {
  const city = place?.city || "Cidade desconhecida";
  const state = place?.state || "Estado desconhecido";
  const country = place?.country || "Pais desconhecido";
  return `${city}, ${state}, ${country}`;
}

function buildClipCaption(item) {
  return `${formatCaptionTimestamp(item.createdAt)}, ${formatCaptionLocation(item.place)}`;
}

function formatDurationMs(durationMs) {
  const totalSeconds = Math.max(0, Math.round(durationMs / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return `${pad(hours)}:${pad(minutes)}:${pad(seconds)}`;
}

function createProgressTracker({ label, total }) {
  const startedAt = Date.now();
  let lastLoggedAt = 0;
  let lastLoggedValue = -1;

  return {
    update(current, details = "") {
      const safeCurrent = Math.min(Math.max(current, 0), Math.max(total, 1));
      const percentage = total > 0 ? (safeCurrent / total) * 100 : 100;
      const roundedPercentage = Number.parseFloat(percentage.toFixed(1));
      const now = Date.now();
      const elapsedMs = now - startedAt;
      const shouldLog =
        safeCurrent === total ||
        safeCurrent === 1 ||
        roundedPercentage >= lastLoggedValue + 1 ||
        now - lastLoggedAt >= 5000;

      if (!shouldLog) {
        return;
      }

      const etaMs =
        safeCurrent > 0 && safeCurrent < total
          ? (elapsedMs / safeCurrent) * (total - safeCurrent)
          : 0;
      const progressBar = renderProgressBar(percentage);

      const suffix = details ? ` ${details}` : "";
      console.log(
        `[${label}] ${progressBar} ${safeCurrent}/${total} (${roundedPercentage.toFixed(1)}%) elapsed ${formatDurationMs(elapsedMs)} ETA ${formatDurationMs(etaMs)}${suffix}`
      );

      lastLoggedAt = now;
      lastLoggedValue = roundedPercentage;
    },
  };
}

function renderProgressBar(percentage, width = 24) {
  const clamped = Math.max(0, Math.min(100, percentage));
  const filled = Math.round((clamped / 100) * width);
  return `[${"#".repeat(filled)}${"-".repeat(width - filled)}]`;
}

function formatBytesToMb(bytes) {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatBytesToGb(bytes) {
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function formatSecondsAsClock(durationSeconds) {
  return formatDurationMs((durationSeconds || 0) * 1000);
}

module.exports = {
  buildClipCaption,
  composePlace,
  createProgressTracker,
  ensureDir,
  extractCoordinate,
  formatBytesToGb,
  formatBytesToMb,
  formatCaptionLocation,
  formatCaptionTimestamp,
  formatDurationMs,
  formatDateKey,
  formatSecondsAsClock,
  locationKey,
  normalizePlaceName,
  preferredDate,
  readJsonIfExists,
  relativeTo,
  sanitizeFileName,
  toDate,
  writeJson,
};
