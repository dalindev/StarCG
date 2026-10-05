#!/usr/bin/env node
/*
 * sync-gather-data.mjs - generate starcg_gather_data.js from the official guide.
 *
 * Source page : https://guide.starcg.net/production/best-spots
 *               (the pre-rendered HTML carries the 採集最佳點 tables)
 * Output      : ../starcg_gather_data.js  (window.STARCG_GATHER_DATA, Node-safe)
 *
 * Node >= 18, ESM, zero dependencies, built-in fetch only. No network is used
 * when --input / --from-file is given.
 *
 *   node scripts/sync-gather-data.mjs                         fetch the live page, write the data file
 *   node scripts/sync-gather-data.mjs --input page.html       parse a saved copy (fetchedAt = file mtime)
 *   node scripts/sync-gather-data.mjs --check                 parse + validate + print a summary, write nothing
 *   node scripts/sync-gather-data.mjs --out some/other.js     write somewhere else
 *   node scripts/sync-gather-data.mjs --last-modified "Thu, 01 Oct 2026 13:28:05 GMT"
 *   node scripts/sync-gather-data.mjs --fetched-at 1790000000000
 *
 * Aliases: --from-file is accepted as a synonym of --input.
 *
 * Fail gates (exit 1, existing output file untouched): fewer than 4 no-zebra
 * tables (unknown guide URLs answer HTTP 200 with a soft-404 page), fewer than
 * 60 items, an item without fee or with a level outside 1-10, a duplicate item
 * key, an item without spots, a key that violates the key regexes, minutes
 * outside 1..6000, a table whose preceding <h3> is not one of 狩獵 / 挖掘 /
 * 木材 / 花草, or a category that is missing or appears twice.
 * Differences from the expected 32/17/12/12 items are warnings only.
 *
 * The output is deterministic: fixed key order, one item per line, page order.
 * The only volatile fields are fetchedAt and lastModified (both can be pinned
 * with --fetched-at / --last-modified).
 */

import { readFileSync, writeFileSync, renameSync, statSync, unlinkSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const SOURCE_URL = 'https://guide.starcg.net/production/best-spots';
export const FETCH_TIMEOUT_MS = 20000;
export const BENCHMARK = { items: 4000, slotSize: 800, slots: 5 };

/* Hand-maintained: oldItemKey -> newItemKey, for when the guide renames an item
 * and saved user data still points at the old key. Every target must exist. */
export const ALIASES = {};

const CATEGORIES = [
  { key: 'hunt', label: '狩獵' },
  { key: 'mine', label: '挖掘' },
  { key: 'wood', label: '木材' },
  { key: 'herb', label: '花草' },
];
const EXPECTED_COUNTS = { hunt: 32, mine: 17, wood: 12, herb: 12 };
const ITEM_KEY_RE = /^[a-z]+\/\S{1,40}$/;
const SPOT_KEY_RE = /^(shed|p:\S{1,80})$/;
const MIN_ITEMS = 60;
const MIN_TABLES = 4;
const MAX_MINUTES = 6000;

/* ------------------------------------------------------------------ text */

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00a0' };

export function decodeEntities(s) {
  return s.replace(/&(#x[0-9a-fA-F]+|#\d+|[a-zA-Z]+);/g, (m, body) => {
    if (body[0] === '#') {
      const cp = body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      return Number.isFinite(cp) && cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : m;
    }
    return Object.prototype.hasOwnProperty.call(ENTITIES, body) ? ENTITIES[body] : m;
  });
}

/* Order: <br> -> space, strip tags, markdown [t](/p) -> t, decode entities, collapse whitespace. */
export function cleanText(html, { spaceLinks = false } = {}) {
  let s = html.replace(/<br\s*\/?>/gi, ' ').replace(/<[^>]*>/g, '');
  s = s.replace(/\[([^\]]*)\]\([^)]*\)/g, spaceLinks ? ' $1 ' : '$1');
  s = decodeEntities(s);
  return s.replace(/[\s\u00a0]+/g, ' ').trim();
}

/* NFKC, every kind of whitespace removed: used for item and spot keys. */
function keyText(s) {
  return s.normalize('NFKC').replace(/[\s\u00a0\u200b-\u200d\ufeff]+/g, '');
}

function stripOuterParens(s) {
  let t = s.trim();
  while (t.length >= 2 && /^[(（]/.test(t) && /[)）]$/.test(t)) {
    let depth = 0;
    let wraps = true;
    for (let i = 0; i < t.length; i++) {
      const c = t[i];
      if (c === '(' || c === '（') depth++;
      else if (c === ')' || c === '）') depth--;
      if (depth === 0 && i < t.length - 1) {
        wraps = false;
        break;
      }
    }
    if (!wraps) break;
    t = t.slice(1, -1).trim();
  }
  return t;
}

/* ----------------------------------------------------------------- parse */

class GateError extends Error {
  constructor(messages) {
    super(messages.join('\n'));
    this.name = 'GateError';
    this.messages = messages;
  }
}

function cellsOf(rowHtml) {
  return [...rowHtml.matchAll(/<td([^>]*)>([\s\S]*?)<\/td>/g)].map((m) => ({ attrs: m[1], html: m[2] }));
}

function parseMinutes(text) {
  const m = /用時\s*(\d+)\s*分鐘/.exec(text);
  return m ? parseInt(m[1], 10) : null;
}

/* A location cell -> {place, coords, nav, note}. */
function parseSpotCell(rawHtml, warnings, ctx) {
  const nav = rawHtml.includes('採集手冊導航');
  const brAt = rawHtml.search(/<br\s*\/?>/i);
  const headRaw = brAt === -1 ? rawHtml : rawHtml.slice(0, brAt);
  const tailRaw = brAt === -1 ? '' : rawHtml.slice(brAt).replace(/^<br\s*\/?>/i, '');

  let head = cleanText(headRaw).replace(/[(（]\s*採集手冊導航\s*[)）]/g, '').trim();
  let coords;
  const cm = /[(（]\s*(\d+)\s*[,，]\s*(\d+)\s*[)）]\s*$/.exec(head);
  if (cm) {
    coords = [parseInt(cm[1], 10), parseInt(cm[2], 10)];
    head = head.slice(0, cm.index).trim();
  } else if (/[(（]\s*\d+\s*[,，]\s*\d+\s*[)）]/.test(head)) {
    warnings.push(`${ctx}: coordinates not at the end of the place, left inside the text: ${head}`);
  }

  let note = cleanText(tailRaw, { spaceLinks: true })
    .replace(/[(（]\s*採集手冊導航\s*[)）]/g, '')
    .replace(/[(（]\s+/g, '(')
    .replace(/\s+[)）]/g, ')')
    .replace(/[(（]\s*[)）]/g, '')
    .trim();
  note = stripOuterParens(note).replace(/\s+/g, ' ').trim();

  return { place: head, coords, nav, note: note || null };
}

/* A time cell -> {kind, minutes, note}. */
function parseTimeCell(html, warnings, ctx) {
  const text = cleanText(html);
  const minutes = parseMinutes(text);
  if (minutes !== null) return { kind: 'spot', minutes, note: null };
  if (text.includes('混點')) return { kind: 'mixed', minutes: null, note: null };
  if (text.includes('唯一點')) {
    const rest = stripOuterParens(text.replace('唯一點', '').trim());
    return { kind: 'unique', minutes: null, note: rest || null };
  }
  warnings.push(`${ctx}: unrecognised time cell "${text}" -> treated as unique with no minutes`);
  return { kind: 'unique', minutes: null, note: text || null };
}

function makeSpot({ key, place, kind, minutes, coords, nav, note }) {
  const spot = { key, place, kind, minutes };
  if (coords) spot.coords = coords;
  if (nav) spot.nav = true;
  if (note) spot.note = note;
  return spot;
}

function parseTable(tableInner, catKey, warnings, errors) {
  const bodyMatch = /<tbody\b[^>]*>([\s\S]*?)<\/tbody>/i.exec(tableInner);
  const body = bodyMatch ? bodyMatch[1] : tableInner;
  const rows = [...body.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/g)].map((m) => m[1]);
  const items = [];
  let cur = null;

  const closeGroup = () => {
    cur = null;
  };

  rows.forEach((rowHtml, rowIdx) => {
    const tds = cellsOf(rowHtml);
    const where = `${catKey} row ${rowIdx + 1}`;
    if (tds.length === 0) {
      closeGroup(); // <tr><th colspan="5"></th></tr> separator
      return;
    }
    if (tds.length === 5) {
      // New item: name | fee | level | 素材屋 | time. rowspan is deliberately ignored.
      const nameHtml = /<strong\b[^>]*>([\s\S]*?)<\/strong>/i.exec(tds[0].html);
      const name = nameHtml ? cleanText(nameHtml[1]) : cleanText(tds[0].html);
      const feeText = cleanText(tds[1].html);
      const levelText = cleanText(tds[2].html);
      const feeM = /^([\d,]+)\s*G$/i.exec(feeText);
      const fee4000 = feeM ? parseInt(feeM[1].replace(/,/g, ''), 10) : NaN;
      const level = /^\d+$/.test(levelText) ? parseInt(levelText, 10) : NaN;
      if (!name) errors.push(`${where}: item without a name`);
      if (!Number.isFinite(fee4000) || fee4000 <= 0) errors.push(`${where} (${name}): missing or unreadable fee "${feeText}"`);
      if (!Number.isFinite(level) || level < 1 || level > 10) errors.push(`${where} (${name}): level "${levelText}" is outside 1-10`);

      cur = {
        key: `${catKey}/${keyText(name)}`,
        name,
        level,
        fee4000,
        hint: null,
        spots: [],
        _usedKeys: new Set(),
      };
      items.push(cur);

      const locText = cleanText(tds[3].html);
      const timeText = cleanText(tds[4].html);
      if (locText.includes('素材屋')) {
        const minutes = parseMinutes(timeText);
        if (minutes !== null) {
          cur.spots.push(makeSpot({ key: 'shed', place: '素材屋', kind: 'shed', minutes }));
          cur._usedKeys.add('shed');
        } else if (timeText !== '-' && timeText !== '' && timeText !== '－') {
          warnings.push(`${where} (${name}): unrecognised 素材屋 time "${timeText}", shed omitted`);
        }
      } else {
        warnings.push(`${where} (${name}): first row location is "${locText}", not 素材屋; treated as a normal spot`);
        addSpot(cur, tds[3].html, tds[4].html, warnings, where);
      }
      return;
    }
    if (tds.length === 2) {
      if (!cur) {
        errors.push(`${where}: spot row before any item`);
        return;
      }
      addSpot(cur, tds[0].html, tds[1].html, warnings, `${where} (${cur.name})`);
      return;
    }
    if (tds.length === 1) {
      if (!cur) {
        errors.push(`${where}: hint row before any item`);
        return;
      }
      const hint = cleanText(tds[0].html);
      if (hint) cur.hint = cur.hint ? `${cur.hint} ${hint}` : hint;
      return;
    }
    errors.push(`${where}: unexpected row with ${tds.length} cells`);
  });

  for (const it of items) delete it._usedKeys;
  return items;
}

function addSpot(item, locHtml, timeHtml, warnings, ctx) {
  const loc = parseSpotCell(locHtml, warnings, ctx);
  const time = parseTimeCell(timeHtml, warnings, ctx);
  const baseKey = `p:${keyText(loc.place)}`;
  let key = baseKey;
  for (let n = 2; item._usedKeys.has(key); n++) key = `${baseKey}#${n}`;
  item._usedKeys.add(key);
  const notes = [loc.note, time.note].filter(Boolean);
  item.spots.push(
    makeSpot({
      key,
      place: loc.place,
      kind: time.kind,
      minutes: time.minutes,
      coords: loc.coords,
      nav: loc.nav,
      note: notes.length ? notes.join('；') : null,
    })
  );
}

function categoryOfHeading(text) {
  const hits = CATEGORIES.filter((c) => text.includes(c.label));
  return hits.length === 1 ? hits[0] : null;
}

/**
 * Parse the guide page. Returns {categories, warnings}; throws GateError listing
 * every violated fail gate.
 */
export function parseGuideHtml(rawHtml) {
  const html = String(rawHtml).replace(/ data-v-[\w-]+(?:="[^"]*")?/g, '');
  const warnings = [];
  const errors = [];

  const h3s = [...html.matchAll(/<h3\b[^>]*>([\s\S]*?)<\/h3>/g)].map((m) => ({ at: m.index, text: cleanText(m[1]) }));
  const tables = [];
  for (const m of html.matchAll(/<table\b([^>]*)>([\s\S]*?)<\/table>/g)) {
    const cls = /class\s*=\s*"([^"]*)"/.exec(m[1]);
    const tokens = cls ? cls[1].split(/\s+/) : [];
    if (tokens.includes('no-zebra')) tables.push({ at: m.index, inner: m[2] });
  }
  if (tables.length < MIN_TABLES) {
    throw new GateError([
      `only ${tables.length} no-zebra table(s) found, need at least ${MIN_TABLES} (soft-404 page, empty file or the guide layout changed)`,
    ]);
  }

  const byCat = new Map();
  for (const t of tables) {
    if (/<table\b/i.test(t.inner)) errors.push('nested <table> inside a no-zebra table is not supported');
    const before = h3s.filter((h) => h.at < t.at);
    const heading = before.length ? before[before.length - 1].text : '';
    const cat = categoryOfHeading(heading);
    if (!cat) {
      errors.push(`category guard: the <h3> before a no-zebra table is "${heading}", expected one of 狩獵 / 挖掘 / 木材 / 花草`);
      continue;
    }
    if (byCat.has(cat.key)) {
      errors.push(`category guard: two no-zebra tables claim category ${cat.key} (heading "${heading}")`);
      continue;
    }
    byCat.set(cat.key, parseTable(t.inner, cat.key, warnings, errors));
  }
  for (const c of CATEGORIES) {
    if (!byCat.has(c.key)) errors.push(`category guard: no table found for ${c.key} (${c.label})`);
  }

  const categories = CATEGORIES.map((c) => ({ key: c.key, label: c.label, items: byCat.get(c.key) || [] }));

  // ---- validation gates
  const seen = new Set();
  let total = 0;
  for (const c of categories) {
    total += c.items.length;
    for (const it of c.items) {
      if (seen.has(it.key)) errors.push(`duplicate item key ${it.key}`);
      seen.add(it.key);
      if (!ITEM_KEY_RE.test(it.key)) errors.push(`item key violates /^[a-z]+\\/\\S{1,40}$/: ${JSON.stringify(it.key)}`);
      if (it.spots.length === 0) errors.push(`item ${it.key} has no spots`);
      const spotKeys = new Set();
      for (const s of it.spots) {
        if (!SPOT_KEY_RE.test(s.key)) errors.push(`spot key violates /^(shed|p:\\S{1,80})$/: ${JSON.stringify(s.key)} (${it.key})`);
        if (spotKeys.has(s.key)) errors.push(`duplicate spot key ${s.key} in ${it.key}`);
        spotKeys.add(s.key);
        if (s.minutes !== null && (!Number.isInteger(s.minutes) || s.minutes < 1 || s.minutes > MAX_MINUTES)) {
          errors.push(`minutes ${s.minutes} out of range 1..${MAX_MINUTES} (${it.key} / ${s.key})`);
        }
        if (s.kind === 'shed' && s.minutes === null) errors.push(`shed spot without minutes (${it.key})`);
        if ((s.kind === 'unique' || s.kind === 'mixed') && s.minutes !== null) errors.push(`${s.kind} spot with minutes (${it.key})`);
      }
    }
  }
  if (total < MIN_ITEMS) errors.push(`only ${total} items parsed, need at least ${MIN_ITEMS}`);
  for (const [alias, target] of Object.entries(ALIASES)) {
    if (!seen.has(target)) errors.push(`alias ${alias} -> ${target}: target item does not exist`);
  }
  if (errors.length) throw new GateError([...new Set(errors)]);

  for (const c of categories) {
    if (c.items.length !== EXPECTED_COUNTS[c.key]) {
      warnings.push(`category ${c.key}: ${c.items.length} items, expected ${EXPECTED_COUNTS[c.key]} (guide changed?)`);
    }
  }
  const feeByLevel = new Map();
  for (const c of categories) {
    for (const it of c.items) {
      const prev = feeByLevel.get(it.level);
      if (prev === undefined) feeByLevel.set(it.level, it.fee4000);
      else if (prev !== it.fee4000) warnings.push(`level ${it.level}: fee ${it.fee4000} differs from ${prev} (${it.key})`);
    }
  }
  if (!/4[,，]?000\s*個/.test(cleanText(html))) warnings.push('benchmark text (採集 4,000 個) not found; the minutes may use a different bag size');

  return { categories, warnings };
}

/* ----------------------------------------------------------- build / emit */

export function buildDataset(categories, { fetchedAt, lastModified }) {
  return {
    version: 1,
    fetchedAt,
    lastModified: lastModified ?? null,
    source: SOURCE_URL,
    benchmark: { ...BENCHMARK },
    aliases: { ...ALIASES },
    categories,
  };
}

function js(value) {
  return JSON.stringify(value).replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
}

export function summarize(data) {
  const lines = [];
  const kinds = { shed: 0, spot: 0, unique: 0, mixed: 0 };
  let items = 0;
  let spots = 0;
  let hints = 0;
  const noMinutes = [];
  let minM = Infinity;
  let maxM = -Infinity;
  let minItem = '';
  let maxItem = '';
  const fees = new Map();
  for (const c of data.categories) {
    let cMin = Infinity;
    let cMax = -Infinity;
    let cSpots = 0;
    for (const it of c.items) {
      items++;
      if (it.hint) hints++;
      fees.set(it.level, it.fee4000);
      let numeric = false;
      for (const s of it.spots) {
        spots++;
        cSpots++;
        kinds[s.kind]++;
        if (s.minutes !== null) {
          numeric = true;
          if (s.minutes < cMin) cMin = s.minutes;
          if (s.minutes > cMax) cMax = s.minutes;
          if (s.minutes < minM) {
            minM = s.minutes;
            minItem = it.name;
          }
          if (s.minutes > maxM) {
            maxM = s.minutes;
            maxItem = it.name;
          }
        }
      }
      if (!numeric) noMinutes.push(it.name);
    }
    lines.push(`  ${c.key.padEnd(4)} ${c.label}  items ${String(c.items.length).padStart(2)}  spots ${String(cSpots).padStart(3)}  minutes ${cMin}..${cMax}`);
  }
  const feeLine = [...fees.keys()].sort((a, b) => a - b).map((l) => fees.get(l)).join(', ');
  return [
    `items ${items}  (${data.categories.map((c) => c.items.length).join('/')} = ${data.categories.map((c) => c.key).join('/')})`,
    ...lines,
    `spots ${spots}  = shed ${kinds.shed} + spot ${kinds.spot} + unique ${kinds.unique} + mixed ${kinds.mixed}`,
    `items with no numeric minutes (${noMinutes.length}): ${noMinutes.join(', ') || '-'}`,
    `hints ${hints}`,
    `numeric minutes ${minM}..${maxM}  (min ${minItem}, max ${maxItem})`,
    `fee by level 1..10: ${feeLine}`,
  ];
}

export function serialize(data) {
  const fetched = new Date(data.fetchedAt).toISOString().replace(/\.\d{3}Z$/, 'Z');
  const counts = data.categories.reduce((n, c) => n + c.items.length, 0);
  const spotCount = data.categories.reduce((n, c) => n + c.items.reduce((m, it) => m + it.spots.length, 0), 0);
  const out = [];
  out.push('/*');
  out.push(' * StarCG gather best-spot data (採集最佳點).');
  out.push(` * Source:        ${data.source}`);
  out.push(` * Fetched:       ${fetched}`);
  out.push(` * Last-Modified: ${data.lastModified ?? 'unknown'}`);
  out.push(` * Content:       ${counts} items, ${spotCount} spots; minutes = average time to gather ${data.benchmark.items} items (5-10 min error)`);
  out.push(' *');
  out.push(' * GENERATED by scripts/sync-gather-data.mjs, DO NOT EDIT BY HAND.');
  out.push(' * Regenerate with: node scripts/sync-gather-data.mjs');
  out.push(' */');
  out.push('(function (root) {');
  out.push('  var data = {');
  out.push(`    "version": ${js(data.version)},`);
  out.push(`    "fetchedAt": ${js(data.fetchedAt)},`);
  out.push(`    "lastModified": ${js(data.lastModified)},`);
  out.push(`    "source": ${js(data.source)},`);
  out.push(`    "benchmark": ${js(data.benchmark)},`);
  out.push(`    "aliases": ${js(data.aliases)},`);
  out.push('    "categories": [');
  data.categories.forEach((c, ci) => {
    out.push(`      {"key": ${js(c.key)}, "label": ${js(c.label)}, "items": [`);
    c.items.forEach((it, ii) => {
      out.push(`        ${js(it)}${ii < c.items.length - 1 ? ',' : ''}`);
    });
    out.push(`      ]}${ci < data.categories.length - 1 ? ',' : ''}`);
  });
  out.push('    ]');
  out.push('  };');
  out.push('  root.STARCG_GATHER_DATA = data;');
  out.push("  if (typeof module !== 'undefined' && module.exports) module.exports = data;");
  out.push("})(typeof window !== 'undefined' ? window : globalThis);");
  return out.join('\n') + '\n';
}

/* ------------------------------------------------------------------- cli */

function usage() {
  return [
    'Usage: node scripts/sync-gather-data.mjs [options]',
    '  --input <html>          parse a saved copy of the guide page (alias: --from-file); no network',
    '  --out <path>            output file (default: ../starcg_gather_data.js next to this script)',
    '  --check                 parse + validate + print a summary, write nothing',
    '  --last-modified <date>  HTTP date to record as lastModified (default: the Last-Modified header, or null for --input)',
    '  --fetched-at <ms>       epoch ms to record as fetchedAt (default: now, or the file mtime for --input)',
    '  --help',
  ].join('\n');
}

function parseArgs(argv) {
  const opts = { input: null, out: null, check: false, lastModified: null, fetchedAt: null, help: false };
  const valueFlags = {
    '--input': 'input',
    '--from-file': 'input',
    '--out': 'out',
    '--last-modified': 'lastModified',
    '--fetched-at': 'fetchedAt',
  };
  for (let i = 0; i < argv.length; i++) {
    let arg = argv[i];
    let inline = null;
    const eq = arg.indexOf('=');
    if (arg.startsWith('--') && eq > 0) {
      inline = arg.slice(eq + 1);
      arg = arg.slice(0, eq);
    }
    if (arg === '--check') opts.check = true;
    else if (arg === '--help' || arg === '-h') opts.help = true;
    else if (Object.prototype.hasOwnProperty.call(valueFlags, arg)) {
      const v = inline !== null ? inline : argv[++i];
      if (v === undefined || (inline === null && v.startsWith('--'))) throw new Error(`${arg} needs a value`);
      opts[valueFlags[arg]] = v;
    } else throw new Error(`unknown option ${arg}`);
  }
  return opts;
}

function httpDateToIso(text) {
  const t = Date.parse(text);
  if (!Number.isFinite(t)) return null;
  return new Date(t).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

async function fetchGuide() {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(SOURCE_URL, {
      signal: ac.signal,
      redirect: 'follow',
      headers: { accept: 'text/html', 'user-agent': 'starcg-gather-sync/1 (+local script)' },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} from ${SOURCE_URL}`);
    const html = await res.text();
    return { html, lastModified: res.headers.get('last-modified') };
  } catch (err) {
    if (err && err.name === 'AbortError') throw new Error(`timed out after ${FETCH_TIMEOUT_MS / 1000}s fetching ${SOURCE_URL}`);
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

async function main(argv) {
  let opts;
  try {
    opts = parseArgs(argv);
  } catch (err) {
    console.error(`error: ${err.message}\n\n${usage()}`);
    return 2;
  }
  if (opts.help) {
    console.log(usage());
    return 0;
  }

  const scriptDir = path.dirname(fileURLToPath(import.meta.url));
  const outPath = path.resolve(opts.out || path.join(scriptDir, '..', 'starcg_gather_data.js'));

  let fetchedAt = null;
  if (opts.fetchedAt !== null) {
    if (!/^\d{10,15}$/.test(opts.fetchedAt)) {
      console.error('error: --fetched-at must be epoch milliseconds (integer)');
      return 2;
    }
    fetchedAt = parseInt(opts.fetchedAt, 10);
  }
  let lastModified = null;
  if (opts.lastModified !== null) {
    lastModified = httpDateToIso(opts.lastModified);
    if (!lastModified) {
      console.error(`error: cannot parse --last-modified "${opts.lastModified}" as an HTTP date`);
      return 2;
    }
  }

  let html;
  let origin;
  try {
    if (opts.input) {
      const file = path.resolve(opts.input);
      html = readFileSync(file, 'utf8');
      if (fetchedAt === null) fetchedAt = Math.floor(statSync(file).mtimeMs);
      origin = `file ${file}`;
    } else {
      const res = await fetchGuide();
      html = res.html;
      if (fetchedAt === null) fetchedAt = Date.now();
      if (lastModified === null && res.lastModified) lastModified = httpDateToIso(res.lastModified);
      origin = `live ${SOURCE_URL}`;
    }
  } catch (err) {
    console.error(`error: ${err.message}`);
    return 1;
  }

  let parsed;
  try {
    parsed = parseGuideHtml(html);
  } catch (err) {
    if (err instanceof GateError) {
      console.error(`FAILED (${origin}): the page did not pass the validation gates, nothing was written.`);
      for (const m of err.messages) console.error(`  - ${m}`);
      return 1;
    }
    throw err;
  }

  const data = buildDataset(parsed.categories, { fetchedAt, lastModified });
  console.log(`source: ${origin}`);
  console.log(`lastModified: ${data.lastModified ?? 'null'}  fetchedAt: ${data.fetchedAt} (${new Date(data.fetchedAt).toISOString()})`);
  for (const line of summarize(data)) console.log(line);
  for (const w of parsed.warnings) console.warn(`warning: ${w}`);

  if (opts.check) {
    console.log('CHECK OK: nothing written.');
    return 0;
  }

  const text = serialize(data);
  const tmp = `${outPath}.tmp-${process.pid}`;
  try {
    writeFileSync(tmp, text, 'utf8');
    renameSync(tmp, outPath);
  } catch (err) {
    try {
      unlinkSync(tmp);
    } catch {
      /* ignore */
    }
    console.error(`error: could not write ${outPath}: ${err.message}`);
    return 1;
  }
  console.log(`wrote ${outPath} (${Buffer.byteLength(text, 'utf8')} bytes)`);
  return 0;
}

function isMain() {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isMain()) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (err) => {
      console.error(err && err.stack ? err.stack : String(err));
      process.exitCode = 1;
    }
  );
}
