/**
 * data.js — Fetches site + artist data from the RomitesDB Google Sheet.
 *
 * Main spreadsheet (RomitesDB):
 *   Main (gid 1081541338) — site-wide copy (title, headings, footer)
 *   Artists (gid 1911627660) — flat list of URLs to individual artist spreadsheets
 *
 * Each artist has their own spreadsheet with:
 *   - "Artist Main" (gid 0) — one row of artist info
 *   - "Project 1", "Project 2", … — one tab per project, each with one row
 *     Each project row has: Name, Description, IG Link, Website Link,
 *     then up to 10 content blocks of [Title, Description, Content Type, Data]
 *
 * The Google Visualization API returns JSONP-style text:
 *   google.visualization.Query.setResponse({…});
 * We strip the wrapper and JSON.parse the inner object.
 */

const SHEET_ID = '1ypLnmAvfGj3HZj4Vdz_CLmnOkjQqQchJXlUGZKuWdio';
const MAIN_GID = '1081541338';
const ARTISTS_GID = '1911627660';

/** URL for a sheet in the main RomitesDB spreadsheet */
function sheetURL(gid) {
  return `https://docs.google.com/spreadsheets/d/${SHEET_ID}/gviz/tq?tqx=out:json&gid=${gid}`;
}

/** URL for a sheet in any spreadsheet (by id and gid) */
function sheetURLForSpreadsheet(spreadsheetId, gid) {
  return `https://docs.google.com/spreadsheets/d/${spreadsheetId}/gviz/tq?tqx=out:json&gid=${gid}`;
}

/** Extract spreadsheet ID from a Google Sheets URL */
function extractSpreadsheetId(url) {
  if (!url || typeof url !== 'string') return null;
  const m = url.match(/\/spreadsheets\/d\/([a-zA-Z0-9_-]+)/);
  return m ? m[1] : null;
}

/** Strip the google.visualization.Query.setResponse(...) wrapper */
function parseGvizJSON(text) {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  return JSON.parse(text.substring(start, end + 1));
}

/** Convert a gviz table into an array of plain objects keyed by the first row. */
function tableToObjects(table) {
  if (!table?.rows?.length) return [];
  const cols = table.rows[0].c.map(cell => (cell != null && cell.v != null ? String(cell.v).trim() : ''));
  return table.rows.slice(1).map(row => {
    const obj = {};
    cols.forEach((key, i) => {
      const cell = row.c && row.c[i];
      const val = cell != null && cell.v != null ? cell.v : '';
      obj[key] = typeof val === 'string' ? val.trim() : val;
    });
    return obj;
  });
}

/**
 * Convert a Google Drive share link to an embeddable image URL.
 * Input:  https://drive.google.com/file/d/FILE_ID/view?usp=drive_link
 * Output: https://drive.google.com/thumbnail?id=FILE_ID&sz=w800
 */
function driveToDirectURL(url) {
  if (!url) return '';
  const m = url.match(/\/d\/([^/]+)/);
  if (m) {
    const directUrl = `https://drive.google.com/thumbnail?id=${m[1]}&sz=w800`;
    return `/img-proxy?url=${encodeURIComponent(directUrl)}`;
  }
  return url;
}

/** Fetch + parse one sheet from the main spreadsheet */
async function fetchSheet(gid) {
  const res = await fetch(sheetURL(gid));
  const text = await res.text();
  const json = parseGvizJSON(text);
  return tableToObjects(json.table);
}

/** Fetch + parse one sheet from any spreadsheet by id and gid */
async function fetchSheetFromSpreadsheet(spreadsheetId, gid) {
  const res = await fetch(sheetURLForSpreadsheet(spreadsheetId, gid));
  const text = await res.text();
  const json = parseGvizJSON(text);
  return tableToObjects(json.table || { rows: [] });
}

/**
 * Discover all sheet tabs (name + gid) in a spreadsheet by scraping
 * the htmlview page. Returns [{ name, gid }].
 */
async function discoverSheetTabs(spreadsheetId) {
  const url = `https://docs.google.com/spreadsheets/d/${spreadsheetId}/htmlview`;
  try {
    const res = await fetch(url);
    const html = await res.text();
    const tabs = [];
    // Match tab links like: #gid=1234567">Tab Name</a>
    const re = /gid=(\d+)[^>]*>([^<]+)</g;
    let m;
    while ((m = re.exec(html)) !== null) {
      tabs.push({ gid: m[1], name: m[2].trim() });
    }
    return tabs;
  } catch (e) {
    console.warn('Could not discover tabs for', spreadsheetId, e);
    return [];
  }
}

/** Get value from object using substring-matching keys (case-insensitive) */
function getVal(obj, ...possibleKeys) {
  if (!obj || typeof obj !== 'object') return '';
  const entries = Object.entries(obj).map(([k, v]) => [k.toLowerCase().trim(), v]);
  for (const key of possibleKeys) {
    const needle = key.toLowerCase().trim();
    // Exact match first
    for (const [k, v] of entries) {
      if (k === needle && v !== undefined && v !== null) {
        return typeof v === 'string' ? v.trim() : v;
      }
    }
    // Then substring/contains match
    for (const [k, v] of entries) {
      if (k.includes(needle) && v !== undefined && v !== null) {
        return typeof v === 'string' ? v.trim() : v;
      }
    }
  }
  return '';
}

const SPREADSHEET_URL_PATTERN = /https?:\/\/docs\.google\.com\/spreadsheets\/d\/[a-zA-Z0-9_-]+/;

/** Public API ------------------------------------------------------------ */

export async function fetchSiteData() {
  const rows = await fetchSheet(MAIN_GID);
  return rows[0] || {};
}

export async function fetchArtists() {
  // Fetch the Artists tab — a flat list of spreadsheet URLs (no headers).
  // We parse the raw gviz table directly instead of using tableToObjects,
  // because that function treats row 0 as headers and would skip the first URL.
  let rawTable;
  try {
    const res = await fetch(sheetURL(ARTISTS_GID));
    const text = await res.text();
    const json = parseGvizJSON(text);
    rawTable = json.table;
  } catch (e) {
    console.warn('Failed to fetch Artists tab:', e);
    return [];
  }
  if (!rawTable?.rows?.length) return [];

  // Extract spreadsheet URLs from every cell in every row
  const artistUrls = [];
  for (const row of rawTable.rows) {
    for (const cell of (row.c || [])) {
      const val = cell && cell.v;
      if (val && typeof val === 'string' && SPREADSHEET_URL_PATTERN.test(val)) {
        artistUrls.push(val.trim());
        break;
      }
    }
  }

  // Fetch each artist spreadsheet in parallel
  const artists = await Promise.all(artistUrls.map(url => fetchSingleArtist(url)));
  return artists.filter(Boolean);
}

/**
 * Fetch a single artist from their own spreadsheet.
 * Reads the "Artist Main" tab (gid 0) for info,
 * then discovers "Project N" tabs and fetches each one.
 */
async function fetchSingleArtist(sheetUrl) {
  const spreadsheetId = extractSpreadsheetId(sheetUrl);
  if (!spreadsheetId) return null;

  try {
    // Fetch artist info (gid 0) and discover tabs in parallel
    const [infoRows, tabs] = await Promise.all([
      fetchSheetFromSpreadsheet(spreadsheetId, '0').catch(() => []),
      discoverSheetTabs(spreadsheetId),
    ]);

    const artistRow = infoRows[0] || {};

    // Find project tabs (any tab whose name starts with "Project")
    const projectTabs = tabs.filter(t => /^project\b/i.test(t.name));

    // Fetch all project tabs in parallel
    const projectRows = await Promise.all(
      projectTabs.map(t =>
        fetchSheetFromSpreadsheet(spreadsheetId, t.gid)
          .then(rows => rows[0] || null)
          .catch(() => null)
      )
    );

    const projects = projectRows
      .filter(Boolean)
      .map(buildProjectFromRow)
      .filter(Boolean);

    return rowToArtist(artistRow, projects);
  } catch (e) {
    console.warn('Failed to fetch artist from', sheetUrl, e);
    return null;
  }
}

function rowToArtist(a, projects = []) {
  const name = getVal(a, 'artist name', 'name');
  const description = getVal(a, 'description');
  const profilePic = getVal(a, 'profile pic', 'profile picture');
  const avatarLink = getVal(a, 'avatar link', 'avatar');
  const hex = getVal(a, 'hex color', 'hex') || '#ffffff';
  const ig = getVal(a, 'ig link', 'instagram');
  const website = getVal(a, 'website link', 'website');
  const portfolioPDF = getVal(a, 'portfolio pdf', 'portfolio');
  const imageGallery = getVal(a, 'image gallery', 'gallery');
  const youtubeEmbed = getVal(a, 'youtube embed', 'youtube');
  return {
    name: name || 'Unknown Artist',
    description: description || '',
    avatarLink: driveToDirectURL(avatarLink),
    profilePic: driveToDirectURL(profilePic),
    hex: hex || '#ffffff',
    ig: ig || '',
    website: website || '',
    portfolioPDF: portfolioPDF || '',
    imageGallery: imageGallery || '',
    youtubeEmbed: youtubeEmbed || '',
    projects,
  };
}

/**
 * Build a project from a single row (one tab = one project).
 * Row has: Name, Description, IG Link, Website Link,
 * then up to 10 content blocks of [Title, Description, Content Type, Data].
 */
function buildProjectFromRow(row) {
  if (!row) return null;
  const name = getVal(row, 'name');
  if (!name) return null;

  const project = {
    name,
    description: getVal(row, 'description') || '',
    ig: getVal(row, 'ig link', 'instagram') || '',
    website: getVal(row, 'website link', 'website') || '',
    content: [],  // Array of content blocks
  };

  // Extract content blocks — look for columns with "Content Type" and "Data"
  // The columns repeat in blocks: Title, Description, Content Type, Data
  const keys = Object.keys(row);
  const contentTypeKeys = keys.filter(k => k.toLowerCase().includes('content type'));

  for (const ctKey of contentTypeKeys) {
    const contentType = row[ctKey];
    if (!contentType) continue;

    // Find the corresponding Data column (immediately after Content Type)
    const ctIndex = keys.indexOf(ctKey);
    // The Data column is the next one after Content Type
    const dataKey = keys[ctIndex + 1];
    const data = dataKey ? row[dataKey] : '';

    // Look back for Title and Description of this block
    const titleKey = ctIndex >= 2 ? keys[ctIndex - 2] : null;
    const descKey = ctIndex >= 1 ? keys[ctIndex - 1] : null;

    project.content.push({
      title: titleKey ? (row[titleKey] || '') : '',
      description: descKey ? (row[descKey] || '') : '',
      type: String(contentType).trim(),
      data: data ? String(data).trim() : '',
    });
  }

  return project;
}

/**
 * Convert a Google Drive file link to a PDF embed URL.
 * Input:  https://drive.google.com/file/d/FILE_ID/view?usp=drive_link
 * Output: https://drive.google.com/file/d/FILE_ID/preview
 */
export function driveToPDFEmbed(url) {
  if (!url) return '';
  const m = url.match(/\/d\/([^/]+)/);
  if (m) return `https://drive.google.com/file/d/${m[1]}/preview`;
  return url;
}

/**
 * Extract a Google Drive folder ID from a folder URL.
 */
export function getDriveFolderId(folderURL) {
  if (!folderURL) return null;
  const m = folderURL.match(/folders\/([^?/]+)/);
  return m ? m[1] : null;
}

/**
 * Fetch image URLs for a Google Drive folder.
 * Uses a pre-built gallery-cache.json file (generated by
 * `node build-gallery-cache.js`). Run it whenever images change.
 */
let _galleryCache = null;

async function loadGalleryCache() {
  if (_galleryCache) return _galleryCache;
  try {
    const res = await fetch('./js/gallery-cache.json');
    _galleryCache = await res.json();
  } catch (e) {
    console.warn('Could not load gallery cache:', e);
    _galleryCache = {};
  }
  return _galleryCache;
}

/**
 * Returns an array of { url, name } objects for images in the folder.
 */
export async function fetchDriveFolderImages(folderURL) {
  if (!folderURL) return [];
  const folderId = getDriveFolderId(folderURL);
  if (!folderId) return [];

  const cache = await loadGalleryCache();
  const entries = cache[folderId];
  if (entries && entries.length > 0) {
    return entries.map(e => ({
      url: `/img-proxy?url=${encodeURIComponent(`https://drive.google.com/thumbnail?id=${e.id}&sz=w600`)}`,
      name: e.name || '',
    }));
  }

  return [];
}

/** Convenience: slug from artist name for routing */
export function toSlug(name) {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
}
