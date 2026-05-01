"use strict";

const path = require("node:path");

const { GEOCODE_CACHE_FILE, NOMINATIM_URL, OVERPASS_URL, USER_AGENT } = require("./config");
const { composePlace, normalizePlaceName, readJsonIfExists, writeJson } = require("./utils");

function buildCacheKey(latitude, longitude) {
  return `${latitude.toFixed(4)},${longitude.toFixed(4)}`;
}

async function loadGeocodeCache(baseDir) {
  const filePath = path.join(baseDir, GEOCODE_CACHE_FILE);
  const cache = await readJsonIfExists(filePath, {});
  return { cache, filePath };
}

async function reverseGeocode(latitude, longitude, geocodeState) {
  const key = buildCacheKey(latitude, longitude);
  if (geocodeState.cache[key]) {
    return geocodeState.cache[key];
  }

  const url = new URL(NOMINATIM_URL);
  url.searchParams.set("format", "jsonv2");
  url.searchParams.set("lat", String(latitude));
  url.searchParams.set("lon", String(longitude));
  url.searchParams.set("zoom", "14");
  url.searchParams.set("addressdetails", "1");

  const response = await fetch(url, {
    headers: {
      "User-Agent": USER_AGENT,
      Accept: "application/json",
    },
  });

  if (!response.ok) {
    throw new Error(`Reverse geocoding failed (${response.status} ${response.statusText})`);
  }

  const payload = await response.json();
  let normalized = normalizePlaceName(payload.address || null);

  if (!normalized?.city) {
    const nearbyCity = await findNearbyMajorCity(latitude, longitude);
    if (nearbyCity) {
      normalized = composePlace(
        nearbyCity.city,
        normalized?.state || nearbyCity.state,
        normalized?.country || nearbyCity.country
      );
    }
  }

  geocodeState.cache[key] = normalized;
  await writeJson(geocodeState.filePath, geocodeState.cache);

  await new Promise((resolve) => setTimeout(resolve, 1100));

  return normalized;
}

async function findNearbyMajorCity(latitude, longitude) {
  const query = `
[out:json][timeout:25];
(
  node(around:30000,${latitude},${longitude})["place"~"city|town"];
  way(around:30000,${latitude},${longitude})["place"~"city|town"];
  relation(around:30000,${latitude},${longitude})["place"~"city|town"];
);
out center tags;
`;

  const response = await fetch(OVERPASS_URL, {
    method: "POST",
    headers: {
      "User-Agent": USER_AGENT,
      Accept: "application/json",
      "Content-Type": "text/plain;charset=UTF-8",
    },
    body: query,
  });

  if (!response.ok) {
    return null;
  }

  const payload = await response.json();
  if (!Array.isArray(payload.elements) || payload.elements.length === 0) {
    return null;
  }

  const ranked = payload.elements
    .map((element) => normalizeNearbyPlace(element, latitude, longitude))
    .filter(Boolean)
    .sort(compareNearbyPlaces);

  return ranked[0] || null;
}

function normalizeNearbyPlace(element, latitude, longitude) {
  const candidateLatitude = element.lat ?? element.center?.lat;
  const candidateLongitude = element.lon ?? element.center?.lon;
  const name = element.tags?.name;
  const placeType = element.tags?.place || "town";

  if (!name || candidateLatitude == null || candidateLongitude == null) {
    return null;
  }

  return {
    city: name,
    state: element.tags["addr:state"] || element.tags.state || null,
    country: element.tags["addr:country"] || element.tags.country || null,
    placeType,
    population: parsePopulation(element.tags.population),
    distanceKm: haversineKm(latitude, longitude, candidateLatitude, candidateLongitude),
  };
}

function compareNearbyPlaces(left, right) {
  const placeRank = rankPlaceType(left.placeType) - rankPlaceType(right.placeType);
  if (placeRank !== 0) {
    return placeRank;
  }

  const populationRank = (right.population || 0) - (left.population || 0);
  if (populationRank !== 0) {
    return populationRank;
  }

  return left.distanceKm - right.distanceKm;
}

function rankPlaceType(placeType) {
  if (placeType === "city") {
    return 0;
  }
  if (placeType === "town") {
    return 1;
  }
  return 2;
}

function parsePopulation(value) {
  if (value == null) {
    return null;
  }
  const parsed = Number.parseInt(String(value).replace(/[^\d]/g, ""), 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function haversineKm(lat1, lon1, lat2, lon2) {
  const earthRadiusKm = 6371;
  const toRadians = (value) => (value * Math.PI) / 180;
  const dLat = toRadians(lat2 - lat1);
  const dLon = toRadians(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRadians(lat1)) * Math.cos(toRadians(lat2)) * Math.sin(dLon / 2) ** 2;

  return 2 * earthRadiusKm * Math.asin(Math.sqrt(a));
}

module.exports = {
  loadGeocodeCache,
  reverseGeocode,
};
