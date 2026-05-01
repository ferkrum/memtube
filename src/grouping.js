"use strict";

const { formatDateKey, locationKey, sanitizeFileName } = require("./utils");

function groupByDay(items) {
  const groups = new Map();

  for (const item of items) {
    const key = formatDateKey(item.createdAt);
    if (!groups.has(key)) {
      groups.set(key, []);
    }
    groups.get(key).push(item);
  }

  return [...groups.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([dateKey, entries]) => ({
      dateKey,
      items: entries.sort((a, b) => a.createdAt - b.createdAt),
    }));
}

function inferDayTitle(group) {
  const datedPlaces = group.items
    .filter((item) => item.place?.city || item.place?.country)
    .map((item) => item.place);

  const uniquePlaces = [];
  const seen = new Set();
  for (const place of datedPlaces) {
    const key = locationKey(place);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    uniquePlaces.push(place);
  }

  if (uniquePlaces.length === 0) {
    return `${group.dateKey} - Unknown location`;
  }

  if (uniquePlaces.length === 1) {
    const place = uniquePlaces[0];
    return `${group.dateKey} - ${place.compactName || place.displayName}`;
  }

  const startPlace = uniquePlaces[0];
  const endPlace = uniquePlaces[uniquePlaces.length - 1];
  if (locationKey(startPlace) !== locationKey(endPlace)) {
    return `${group.dateKey} - ${startPlace.city || startPlace.country} to ${endPlace.city || endPlace.country}`;
  }

  const counts = new Map();
  for (const place of datedPlaces) {
    const key = locationKey(place);
    counts.set(key, (counts.get(key) || 0) + 1);
  }

  let winner = uniquePlaces[0];
  let winnerCount = counts.get(locationKey(winner)) || 0;
  for (const place of uniquePlaces.slice(1)) {
    const count = counts.get(locationKey(place)) || 0;
    if (count > winnerCount) {
      winner = place;
      winnerCount = count;
    }
  }

  return `${group.dateKey} - ${winner.compactName || winner.displayName}`;
}

function inferNarrative(group) {
  const places = group.items
    .filter((item) => item.place?.city || item.place?.country)
    .map((item) => item.place.compactName || item.place.displayName);

  if (places.length === 0) {
    return "Media collected on this day with no GPS-derived location information.";
  }

  const first = places[0];
  const last = places[places.length - 1];
  if (first !== last) {
    return `Travel day inferred from GPS drift, starting around ${first} and ending around ${last}.`;
  }

  return `Mostly captured around ${first}.`;
}

function buildExportFileName(title) {
  return `${sanitizeFileName(title)}.mov`;
}

module.exports = {
  buildExportFileName,
  groupByDay,
  inferDayTitle,
  inferNarrative,
};
