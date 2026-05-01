"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");

const { EXPORT_FOLDER_NAME, isSupportedMedia } = require("./config");

async function collectMediaFiles(inputFolders) {
  const uniqueFolders = [...new Set(inputFolders.map((folder) => path.resolve(folder)))];
  const results = [];

  for (const folder of uniqueFolders) {
    await walk(folder, results);
  }

  return results.sort((a, b) => a.localeCompare(b));
}

async function collectDateFolders(inputFolders) {
  const uniqueFolders = [...new Set(inputFolders.map((folder) => path.resolve(folder)))];
  const results = new Set();

  for (const folder of uniqueFolders) {
    await walkForDateFolders(folder, results);
  }

  return [...results].sort((a, b) => a.localeCompare(b));
}

async function walk(currentPath, results) {
  const stats = await fs.stat(currentPath);
  if (!stats.isDirectory()) {
    if (stats.isFile() && isSupportedMedia(currentPath)) {
      results.push(currentPath);
    }
    return;
  }

  if (path.basename(currentPath) === EXPORT_FOLDER_NAME) {
    return;
  }

  const entries = await fs.readdir(currentPath, { withFileTypes: true });
  for (const entry of entries) {
    const nextPath = path.join(currentPath, entry.name);
    if (entry.isDirectory()) {
      await walk(nextPath, results);
      continue;
    }
    if (entry.isFile() && isSupportedMedia(nextPath)) {
      results.push(nextPath);
    }
  }
}

async function walkForDateFolders(currentPath, results) {
  const stats = await fs.stat(currentPath);
  if (!stats.isDirectory()) {
    return;
  }

  const baseName = path.basename(currentPath);
  if (baseName === EXPORT_FOLDER_NAME) {
    return;
  }

  if (isDateFolderName(baseName)) {
    results.add(baseName);
  }

  const entries = await fs.readdir(currentPath, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    await walkForDateFolders(path.join(currentPath, entry.name), results);
  }
}

function isDateFolderName(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(value);
}

module.exports = {
  collectDateFolders,
  collectMediaFiles,
};
