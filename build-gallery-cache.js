#!/usr/bin/env node
/**
 * build-gallery-cache.js
 *
 * Reads the Artists tab (list of spreadsheet URLs), then fetches each
 * artist's own spreadsheet to find their Image Gallery folder URL.
 * For each folder, fetches the Drive embeddedfolderview page and
 * extracts all image file IDs and names.
 *
 * Writes the result to js/gallery-cache.json which the frontend reads
 * at runtime (no CORS issues since it's a local file).
 *
 * Usage:  node build-gallery-cache.js
 * Run this whenever the spreadsheet or Drive folders change.
 */

const SHEET_ID = '1ypLnmAvfGj3HZj4Vdz_CLmnOkjQqQchJXlUGZKuWdio';
const ARTISTS_GID = '1911627660';
const fs = require('fs');
const path = require('path');

const SPREADSHEET_URL_RE = /https?:\/\/docs\.google\.com\/spreadsheets\/d\/([a-zA-Z0-9_-]+)/;

function parseGviz(text) {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  return JSON.parse(text.substring(start, end + 1));
}

function tableToObjects(table) {
  if (!table?.rows?.length) return [];
  const cols = table.rows[0].c.map(c => (c && c.v != null ? String(c.v).trim() : ''));
  return table.rows.slice(1).map(row => {
    const obj = {};
    cols.forEach((key, i) => {
      const cell = row.c && row.c[i];
      obj[key] = cell && cell.v != null ? (typeof cell.v === 'string' ? cell.v.trim() : cell.v) : '';
    });
    return obj;
  });
}

async function fetchGviz(spreadsheetId, gid) {
  const url = `https://docs.google.com/spreadsheets/d/${spreadsheetId}/gviz/tq?tqx=out:json&gid=${gid}`;
  const res = await fetch(url);
  const text = await res.text();
  return tableToObjects(parseGviz(text).table);
}

async function main() {
  console.log('Fetching artist list from main sheet...');

  // 1. Get artist spreadsheet URLs from the Artists tab
  const artistListUrl = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/gviz/tq?tqx=out:json&gid=${ARTISTS_GID}`;
  const res = await fetch(artistListUrl);
  const text = await res.text();
  const json = parseGviz(text);

  // Extract all spreadsheet URLs from the rows (flat list, column A)
  const artistSpreadsheetIds = [];
  for (const row of (json.table.rows || [])) {
    for (const cell of (row.c || [])) {
      const val = cell && cell.v;
      if (val && typeof val === 'string') {
        const m = val.match(SPREADSHEET_URL_RE);
        if (m) {
          artistSpreadsheetIds.push(m[1]);
          break;
        }
      }
    }
  }

  console.log(`Found ${artistSpreadsheetIds.length} artist spreadsheet(s).`);

  // 2. For each artist spreadsheet, fetch their info (gid 0) and find gallery URL
  const cache = {};

  for (const ssId of artistSpreadsheetIds) {
    let rows;
    try {
      rows = await fetchGviz(ssId, '0');
    } catch (e) {
      console.warn(`  Failed to fetch artist sheet ${ssId}: ${e.message}`);
      continue;
    }

    const artistRow = rows[0] || {};
    // Find the gallery column — case-insensitive substring match
    let name = '';
    let galleryURL = '';
    for (const [key, val] of Object.entries(artistRow)) {
      const k = key.toLowerCase();
      if (k.includes('artist name') || k === 'name') name = val;
      if (k.includes('image gallery') || k.includes('gallery')) galleryURL = val;
    }

    if (!galleryURL) {
      console.log(`  ${name || ssId}: no gallery URL, skipping.`);
      continue;
    }

    const m = galleryURL.match(/folders\/([^?/]+)/);
    if (!m) {
      console.log(`  ${name || ssId}: gallery URL doesn't contain a folder ID, skipping.`);
      continue;
    }
    const folderId = m[1];

    if (cache[folderId]) {
      console.log(`  ${name}: folder already cached, skipping.`);
      continue;
    }

    console.log(`  Fetching gallery for ${name || ssId} (folder: ${folderId})...`);

    try {
      const folderRes = await fetch(
        `https://drive.google.com/embeddedfolderview?id=${folderId}`
      );
      const html = await folderRes.text();

      // Extract paired (id, name) from flip-entry elements
      const entries = [];

      const entryIdPattern = /flip-entry" id="entry-([a-zA-Z0-9_-]{20,})"/g;
      const entryIds = [];
      let match;
      while ((match = entryIdPattern.exec(html)) !== null) {
        entryIds.push(match[1]);
      }

      const titlePattern = /class="flip-entry-title">([^<]+)</g;
      const entryNames = [];
      while ((match = titlePattern.exec(html)) !== null) {
        entryNames.push(match[1]);
      }

      for (let i = 0; i < entryIds.length; i++) {
        const fileName = entryNames[i] || '';
        if (/\.(jpe?g|png|gif|webp|svg|bmp|tiff?)$/i.test(fileName) || !fileName) {
          entries.push({
            id: entryIds[i],
            name: fileName.replace(/\.[^.]+$/, ''),
          });
        }
      }

      cache[folderId] = entries;
      console.log(`    Found ${entries.length} images.`);
    } catch (e) {
      console.warn(`    Failed to fetch folder: ${e.message}`);
      cache[folderId] = [];
    }
  }

  // 3. Write cache
  const outPath = path.join(__dirname, 'js', 'gallery-cache.json');
  fs.writeFileSync(outPath, JSON.stringify(cache, null, 2));
  console.log(`\nWrote gallery cache to ${outPath}`);
  console.log('Done!');
}

main().catch(e => { console.error(e); process.exit(1); });
