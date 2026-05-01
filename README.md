# memTube

This project scans one or more folders of images and movies, reads metadata from all supported media files, groups everything by capture day, infers a daily place title from GPS data, and exports one merged movie per day into an `export_to_youtube` folder.

## Installation

### Prerequisites

- Node.js and npm installed
- Internet access for reverse geocoding and YouTube API usage
- A Google Cloud OAuth client JSON file if you want to upload to YouTube

This project was tested with:

- `node v25.8.0`
- `npm 11.11.0`

### Setup

Clone or download this project, then install dependencies:

```bash
cd /path/to/memtube
npm install
```

The project uses bundled `ffmpeg-static` and `ffprobe-static` binaries, so you do not need to install FFmpeg separately.

## Before Publishing

If you publish this project to GitHub, do not commit local OAuth files or generated media exports.

These files are already ignored by `.gitignore`:

- `secrets/`
- `client_secret.json`
- `.youtube-upload-token.json`
- `node_modules/`
- `tmp/`
- `export_to_youtube/`
- `input_folder_test/`

If your Google OAuth client secret was ever exposed, rotate it in Google Cloud before using it again.

## YouTube Setup

If you want to upload videos to YouTube, you must create an OAuth client in Google Cloud and place the credentials JSON in this project.

High-level steps:

1. Create or select a Google Cloud project.
2. Enable the YouTube Data API v3.
3. Configure the OAuth consent screen.
4. Create an OAuth client for a desktop application.
5. Download the OAuth credentials JSON file.
6. Save it locally as `secrets/client_secret.json`, or pass a custom path with `--youtube-credentials=/path/to/client_secret.json`.

On the first upload run, the app opens the Google authorization page in your browser and stores the resulting OAuth token locally in `secrets/.youtube-upload-token.json`.

## What it does

1. Recursively reads all supported images and movies from every input folder and subfolder.
2. Reads metadata for every file with `exiftool`.
3. Groups media by creation date using `YYYY-MM-DD`.
4. Reverse geocodes GPS coordinates into city, state, and country.
5. Builds a day title such as `2026-07-12 - Madrid, Spain` or `2025-07-21 - Milan to Locarno`.
6. Selects only movie files longer than 2 seconds.
7. Normalizes each selected clip, bakes in a bottom-left PT-BR timestamp/location caption, and stitches the clips into a single `.mov` file per day.

## Usage

```bash
cd /path/to/memtube
npm start -- "/path/to/folder-one" "/path/to/folder-two"
```

You can also run the CLI directly:

```bash
node src/index.js "/path/to/folder-one" "/path/to/folder-two"
```

If the input folders contain date-like subfolders such as `2025-07-12`, the CLI prompts you to choose an inclusive processing range:

```text
I found a time span from 2025-07-12 to 2025-07-28. Which timeframe you want to process? Please inform Startdate; End-date:
```

Example answer:

```text
2025-07-12; 2025-07-14
```

You can also pass it directly:

```bash
node src/index.js "/path/to/folder" --timeframe="2025-07-12; 2025-07-14"
```

To upload generated exports to YouTube as part of the same run:

```bash
node src/index.js "/path/to/folder" \
  --youtube-upload \
  --youtube-credentials=./secrets/client_secret.json \
  --youtube-privacy=private \
  --youtube-playlist-id=PLxxxxxxxxxxxxxxxx
```

To create a new YouTube playlist on demand and upload into it in the same run:

```bash
node src/index.js "/path/to/folder" \
  --youtube-upload \
  --youtube-create-playlist \
  --youtube-new-playlist-title="Summer Trip 2025" \
  --youtube-new-playlist-description="Daily merged exports from the trip" \
  --youtube-new-playlist-privacy=private \
  --youtube-credentials=./secrets/client_secret.json
```

Useful YouTube flags:

- `--youtube-upload`
- `--youtube-delete-after-upload`
- `--youtube-create-playlist`
- `--youtube-new-playlist-title=Your playlist title`
- `--youtube-new-playlist-description=Optional description`
- `--youtube-new-playlist-privacy=public|private|unlisted`
- `--youtube-rebuild-descriptions`
- `--youtube-credentials=/path/to/client_secret.json`
- `--youtube-token=/path/to/.youtube-upload-token.json`
- `--youtube-privacy=public|private|unlisted`
- `--youtube-playlist-id=PLxxxxxxxxxxxxxxxx`
- `--youtube-category=22`
- `--youtube-tags=travel,brazil,family`
- `--youtube-description-prefix=Your text`
- `--youtube-language=pt-BR`
- `--youtube-notify-subscribers`
- `--youtube-made-for-kids` or `--youtube-not-made-for-kids`
- `--youtube-no-browser`
- `--no-youtube-upload`

To rebuild YouTube descriptions and chapters for already uploaded videos without re-uploading them:

```bash
node src/index.js "/path/to/folder" \
  --timeframe="2025-07-19; 2025-08-04" \
  --youtube-rebuild-descriptions \
  --youtube-credentials=./secrets/client_secret.json
```

## Output

The app creates:

- `export_to_youtube/<date - place>.mov`
- `export_to_youtube/export-report.json`
- `.geocode-cache.json` in the common parent folder of the provided inputs to avoid repeated reverse-geocoding calls

## Notes

- Reverse geocoding uses OpenStreetMap Nominatim and falls back to the nearest mapped city/town when the direct lookup has no city, then caches the result locally.
- Files without GPS data are still grouped by day, but their titles may fall back to `Unknown location`.
- Video clips are normalized to a common 1920x1080 / 30fps H.264 format before concatenation so mixed camera formats can be merged reliably.
- The baked caption format is `12 de abril de 2024, 12:49:23, Cidade, Estado, Pais`, rendered in white at the lower-left corner.
- YouTube uploads use the official YouTube Data API OAuth flow and store the OAuth token locally so you do not need to re-authorize every run.
- Uploaded videos default to `private`, and if you provide `--youtube-playlist-id`, each uploaded export is added to that playlist.
- Uploaded videos default to `No, it's not made for kids` unless you explicitly pass `--youtube-made-for-kids`.
- After scanning all media, the app processes each day sequentially: export one day, optionally upload that day, clean temporary files for that day, then continue to the next day. This reduces peak temporary disk usage.
- If you pass `--youtube-delete-after-upload`, the local exported movie is deleted right after a successful YouTube upload, which helps keep disk usage low on large runs.
- Description rebuild mode updates the description of already uploaded videos in place using the saved YouTube video IDs from `export-report.json`, so chapters can be added later without re-uploading. It first tries to reuse the `export-report.json` file inside each source folder's `export_to_youtube` directory before falling back to a fresh media scan.
