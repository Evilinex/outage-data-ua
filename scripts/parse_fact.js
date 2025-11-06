#!/usr/bin/env node
/**
 * Extracts `DisconSchedule.fact = { ... }` from an HTML file, normalizes it,
 * and writes JSON to data/<region>.json according to data/_template.json shape.
 *
 * Usage:
 *   node scripts/parse_fact.js --region <id> --in outputs/<region>.html --out data/<region>.json --upstream <url>
 *
 * Notes:
 * - The script is defensive: it never overwrites the output with invalid/empty data.
 * - It attempts JSON.parse first; if that fails (JS literal), it falls back to a safe eval via Function().
 * - Normalization: if the extracted object has a `data` field, it is used directly as `data`.
 *   Otherwise, the whole object is stored under `data` and flagged in meta.dataEmptyReason.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function parseArgs(argv) {
  const args = {};
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--region') args.region = argv[++i];
    else if (a === '--in') args.input = argv[++i];
    else if (a === '--out') args.output = argv[++i];
    else if (a === '--upstream') args.upstream = argv[++i];
    else if (a === '--pretty') args.pretty = true;
  }
  return args;
}

function readFile(file) {
  return fs.readFileSync(file, 'utf8');
}

function writeFileAtomic(file, content) {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, content);
  fs.renameSync(tmp, file);
}

function isoNow() {
  return new Date().toISOString();
}

function sha256(data) {
  return crypto.createHash('sha256').update(data).digest('hex');
}

function extractFact(html) {
  const marker = 'DisconSchedule.fact =';
  const idx = html.indexOf(marker);
  if (idx === -1) {
    return { error: 'Marker `DisconSchedule.fact =` not found' };
  }
  let i = idx + marker.length;
  // Skip whitespace
  while (i < html.length && /\s/.test(html[i])) i++;
  if (html[i] !== '{') {
    return { error: 'Expected `{` after `DisconSchedule.fact =`' };
  }
  // Extract balanced braces
  let depth = 0;
  let start = i;
  for (; i < html.length; i++) {
    const ch = html[i];
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) {
        // Include this closing brace
        const jsonLike = html.slice(start, i + 1);
        return { jsonLike, startIndex: start, endIndex: i + 1 };
      }
    }
  }
  return { error: 'Unbalanced braces while extracting fact object' };
}

function tryParseObject(text) {
  // First, try strict JSON
  try {
    return { value: JSON.parse(text), method: 'json' };
  } catch (_) {}
  // Fallback: attempt to evaluate as JS object literal safely.
  try {
    // Wrap in parentheses to form an expression
    const val = Function('"use strict"; return (' + text + ');')();
    return { value: val, method: 'eval' };
  } catch (e) {
    return { error: 'Failed to parse object: ' + e.message };
  }
}

function loadExisting(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (_) {
    return null;
  }
}

function loadTemplateBase(regionId, upstream) {
  const now = isoNow();
  let template = null;
  try {
    const tplPath = path.join(__dirname, '..', 'data', '_template.json');
    template = JSON.parse(fs.readFileSync(tplPath, 'utf8'));
  } catch (_) {
    // Fallback minimal template if _template.json is unavailable
    template = {
      regionId: regionId || null,
      regionName: null,
      regionType: null,
      lastUpdated: null,
      data: [],
      lastUpdateStatus: { status: 'idle', ok: true, code: null, message: null, at: null, attempt: 0 },
      meta: {
        schemaVersion: '1.0.0',
        fileCreated: now,
        timezone: 'Europe/Kyiv',
        source: { type: 'proxy', upstream: upstream || null, notes: 'Initialized by parser' },
        ttlSeconds: 300,
        nextScheduledFetch: null,
        etag: null,
        contentHash: null,
        dataEmpty: true,
        dataEmptyReason: 'initialized'
      }
    };
  }
  // Apply regionId and upstream if provided
  template.regionId = regionId || template.regionId || null;
  if (template.meta && template.meta.source) {
    template.meta.source.upstream = upstream || template.meta.source.upstream || null;
  }
  if (template.meta && !template.meta.fileCreated) template.meta.fileCreated = now;
  return template;
}

function updateStatusOnError(existingObj, regionId, upstream, code, message) {
  const now = isoNow();
  const base = existingObj || loadTemplateBase(regionId, upstream);
  // preserve data and lastUpdated as-is; only update status/meta fields
  const prevAttempt = (base.lastUpdateStatus && typeof base.lastUpdateStatus.attempt === 'number') ? base.lastUpdateStatus.attempt : 0;
  base.lastUpdateStatus = {
    status: 'error',
    ok: false,
    code: code,
    message: message,
    at: now,
    attempt: prevAttempt + 1,
  };
  if (base.meta) {
    if (!base.meta.fileCreated) base.meta.fileCreated = now;
    if (upstream) {
      base.meta.source = base.meta.source || { type: 'proxy' };
      base.meta.source.upstream = upstream;
    }
    // keep existing contentHash/dataEmpty untouched on errors
  }
  return base;
}

function isObject(x) { return x && typeof x === 'object' && !Array.isArray(x); }

function pad2(n) { return String(n).padStart(2, '0'); }

function tzOffsetMinutes(utcTs, timeZone) {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit'
  });
  const parts = dtf.formatToParts(new Date(utcTs));
  const map = Object.fromEntries(parts.map(p => [p.type, p.value]));
  const asUTC = Date.UTC(parseInt(map.year), parseInt(map.month) - 1, parseInt(map.day), parseInt(map.hour), parseInt(map.minute), parseInt(map.second));
  // Difference between local wall clock expressed as UTC and the actual UTC instant gives offset
  return (asUTC - utcTs) / 60000;
}

function zonedTimeToUtc(dateStr, timeStr, timeZone) {
  const [Y, M, D] = dateStr.split('-').map(Number);
  const [h, m] = timeStr.split(':').map(Number);
  // Initial guess: UTC timestamp with same components
  let ts = Date.UTC(Y, (M || 1) - 1, D || 1, h || 0, m || 0, 0);
  // Compute offset for this instant, then adjust to get the UTC instant corresponding to the given local wall time
  const off = tzOffsetMinutes(ts, timeZone);
  ts = ts - off * 60000;
  return new Date(ts);
}

function formatOffset(totalMinutes) {
  const sign = totalMinutes >= 0 ? '+' : '-';
  const a = Math.abs(totalMinutes);
  const hh = pad2(Math.floor(a / 60));
  const mm = pad2(a % 60);
  return `${sign}${hh}:${mm}`;
}

function toKyivIso(dateStr, timeStr) {
  const tz = 'Europe/Kyiv';
  const utcDate = zonedTimeToUtc(dateStr, timeStr, tz);
  const off = tzOffsetMinutes(utcDate.getTime(), tz);
  const [Y, M, D] = [utcDate.getUTCFullYear(), pad2(utcDate.getUTCMonth() + 1), pad2(utcDate.getUTCDate())];
  const [h, m, s] = [pad2(utcDate.getUTCHours()), pad2(utcDate.getUTCMinutes()), pad2(utcDate.getUTCSeconds())];
  const offsetStr = formatOffset(off);
  return `${Y}-${M}-${D}T${h}:${m}:${s}${offsetStr}`;
}

function extractGroupsWithIso(data) {
  // Keep only keys that look like group identifiers (e.g., GPV1.1, GPV4.1)
  const out = {};
  if (!isObject(data)) return null;
  const keys = Object.keys(data);
  const groupKeyRe = /^[A-ZА-Я]{2,}\d+\.\d+$/i; // broad match
  for (const k of keys) {
    const v = data[k];
    if (!groupKeyRe.test(k)) continue;
    if (!Array.isArray(v)) { out[k] = v; continue; }
    // Try to map entries with date/start/end into ISO tuples
    const items = [];
    for (const entry of v) {
      if (isObject(entry)) {
        const date = entry.date || entry.day || entry.d || null;
        let start = entry.start || entry.from || entry.begin || entry.s || null;
        let end = entry.end || entry.to || entry.finish || entry.e || null;
        const timeRe = /^\d{1,2}:\d{2}$/;
        if (date && start && end && timeRe.test(start) && timeRe.test(end)) {
          // Normalize HH:mm
          if (start.length === 4) start = '0' + start;
          if (end.length === 4) end = '0' + end;
          try {
            const startISO = toKyivIso(String(date), String(start));
            const endISO = toKyivIso(String(date), String(end));
            items.push({ date: String(date), startLocal: startISO, endLocal: endISO });
            continue;
          } catch (_) {}
        }
      }
      // Fallback: keep raw entry if we couldn't normalize
      items.push(entry);
    }
    out[k] = items;
  }
  return Object.keys(out).length ? out : null;
}

function normalize(regionId, upstream, rawObj) {
  const now = isoNow();
  const dataField = Object.prototype.hasOwnProperty.call(rawObj, 'data') ? rawObj.data : undefined;
  let dataOut = null;
  let dataEmpty = false;
  let dataEmptyReason = null;

  if (dataField !== undefined && dataField !== null) {
    // Try to return only per-group data with ISO timestamps for Europe/Kyiv
    const groups = extractGroupsWithIso(dataField);
    if (groups) {
      dataOut = groups;
    } else {
      dataOut = dataField; // fallback: store as-is
      dataEmptyReason = 'stored-as-is-unrecognized-structure';
    }
  } else {
    dataOut = rawObj; // fallback: store full object
    dataEmpty = false; // still has content
    dataEmptyReason = 'no-data-field-present';
  }

  return {
    regionId,
    regionName: null,
    regionType: null,
    lastUpdated: now,
    data: dataOut,
    lastUpdateStatus: {
      status: 'parsed',
      ok: true,
      code: 200,
      message: null,
      at: now,
      attempt: 1,
    },
    meta: {
      schemaVersion: '1.0.0',
      fileCreated: now,
      timezone: 'Europe/Kyiv',
      source: {
        type: 'proxy',
        upstream: upstream || null,
        notes: 'Extracted from DisconSchedule.fact in upstream HTML',
      },
      ttlSeconds: 300,
      nextScheduledFetch: null,
      etag: null,
      contentHash: null,
      dataEmpty,
      dataEmptyReason,
      rawFactIncluded: dataField === undefined, // true if full raw fact used
    },
  };
}

function updateMetaFromExisting(existing, now) {
  if (!existing) return;
  // Preserve fileCreated if present
  if (existing.meta && existing.meta.fileCreated) return existing.meta.fileCreated;
  return now;
}

function main() {
  const args = parseArgs(process.argv);
  if (!args.region || !args.input || !args.output) {
    console.error('[ERROR] Usage: --region <id> --in <input.html> --out <output.json> [--upstream <url>] [--pretty]');
    process.exit(2);
  }

  const regionId = args.region;
  const upstream = args.upstream || null;

  if (!fs.existsSync(args.input)) {
    console.error(`[WARN] Input not found: ${args.input}`);
    const existing = loadExisting(args.output);
    const errObj = updateStatusOnError(existing, regionId, upstream, 404, `Input not found: ${args.input}`);
    const jsonText = args.pretty ? JSON.stringify(errObj, null, 2) : JSON.stringify(errObj);
    writeFileAtomic(args.output, jsonText);
    process.exit(0); // skip gracefully
  }

  const html = readFile(args.input);
  const ext = extractFact(html);
  if (ext.error) {
    console.error('[WARN] ' + ext.error + ` in ${args.input}`);
    const existing = loadExisting(args.output);
    const errObj = updateStatusOnError(existing, regionId, upstream, 422, ext.error + ` in ${args.input}`);
    const jsonText = args.pretty ? JSON.stringify(errObj, null, 2) : JSON.stringify(errObj);
    writeFileAtomic(args.output, jsonText);
    process.exit(0);
  }

  const parsed = tryParseObject(ext.jsonLike);
  if (parsed.error) {
    console.error('[WARN] ' + parsed.error + ` in ${args.input}`);
    const existing = loadExisting(args.output);
    const errObj = updateStatusOnError(existing, regionId, upstream, 422, parsed.error + ` in ${args.input}`);
    const jsonText = args.pretty ? JSON.stringify(errObj, null, 2) : JSON.stringify(errObj);
    writeFileAtomic(args.output, jsonText);
    process.exit(0);
  }

  const now = isoNow();

  let outObj = normalize(regionId, upstream, parsed.value);

  // Merge with existing to preserve fileCreated and increment attempts
  const existing = loadExisting(args.output);
  if (existing && existing.meta) {
    outObj.meta.fileCreated = existing.meta.fileCreated || outObj.meta.fileCreated;
  }
  const prevAttempt = (existing && existing.lastUpdateStatus && typeof existing.lastUpdateStatus.attempt === 'number') ? existing.lastUpdateStatus.attempt : 0;
  outObj.lastUpdateStatus = {
    status: 'parsed',
    ok: true,
    code: 200,
    message: null,
    at: now,
    attempt: prevAttempt + 1,
  };

  // Compute content hash based on the extracted JSON text
  const hash = sha256(ext.jsonLike);
  outObj.meta.contentHash = hash;
  outObj.meta.dataEmpty = !outObj.data || (Array.isArray(outObj.data) ? outObj.data.length === 0 : Object.keys(outObj.data).length === 0);
  if (outObj.meta.dataEmpty && !outObj.meta.dataEmptyReason) {
    outObj.meta.dataEmptyReason = 'empty-data-after-parse';
  }

  const jsonText = args.pretty ? JSON.stringify(outObj, null, 2) : JSON.stringify(outObj);
  writeFileAtomic(args.output, jsonText);
  console.log(`[OK] Parsed ${args.region} → ${args.output} (method=${parsed.method}, bytes=${jsonText.length})`);
}

if (require.main === module) {
  try {
    main();
  } catch (e) {
    console.error('[WARN] parse_fact crashed: ' + e.message);
    // On crash, also update status in output file if possible
    try {
      const args = parseArgs(process.argv);
      const regionId = args.region;
      const upstream = args.upstream || null;
      const existing = args.output ? loadExisting(args.output) : null;
      const errObj = updateStatusOnError(existing, regionId, upstream, 500, 'parse_fact crashed: ' + e.message);
      if (args.output) {
        const jsonText = args.pretty ? JSON.stringify(errObj, null, 2) : JSON.stringify(errObj);
        writeFileAtomic(args.output, jsonText);
      }
    } catch (_) {}
    process.exit(0);
  }
}
