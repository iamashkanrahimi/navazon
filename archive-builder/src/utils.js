import crypto from 'node:crypto';

const ARABIC_TO_PERSIAN = new Map([
  ['ي', 'ی'], ['ى', 'ی'], ['ك', 'ک'], ['ة', 'ه'], ['ۀ', 'ه'],
]);

export const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

export function cleanText(value = '') {
  return String(value ?? '')
    .normalize('NFKC')
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function normalizeText(value = '') {
  let s = cleanText(value).toLowerCase();
  s = [...s].map(ch => ARABIC_TO_PERSIAN.get(ch) || ch).join('');
  return s
    .replace(/[ًٌٍَُِّْـ]/g, '')
    .replace(/\b(feat\.?|ft\.?|featuring)\b/gi, ' ')
    .replace(/&amp;/g, '&')
    .replace(/[’'`´]/g, '')
    .replace(/[^\p{L}\p{N}&]+/gu, ' ')
    .replace(/\s*&\s*/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

export function splitArtistNames(display = '', tags = []) {
  const fromTags = Array.isArray(tags) ? tags.map(cleanText).filter(Boolean) : [];
  const values = fromTags.length
    ? fromTags
    : cleanText(display).split(/\s*(?:&|,|\band\b|\+|؛|،)\s*/i).map(cleanText).filter(Boolean);
  const seen = new Set();
  const out = [];
  for (const name of values) {
    const key = normalizeText(name);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(name);
  }
  return out;
}

export function artistSetKey(display = '', tags = []) {
  const parts = splitArtistNames(display, tags).map(normalizeText).filter(Boolean).sort();
  return parts.join('&') || normalizeText(display);
}

export function canonicalMatchKey({ artist = '', artistTags = [], title = '' } = {}) {
  return `${artistSetKey(artist, artistTags)}|${normalizeText(title)}`;
}

export function slugFromUrl(value) {
  const url = new URL(value);
  return decodeURIComponent(url.pathname.split('/').filter(Boolean).at(-1) || '').trim();
}

export function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

export function stableJsonHash(rawText, parsed) {
  if (typeof rawText === 'string' && rawText.length) return sha256(rawText);
  return sha256(JSON.stringify(parsed ?? null));
}

export function parseArgs(argv = process.argv.slice(2)) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith('--')) continue;
    const key = token.slice(2);
    const next = argv[i + 1];
    if (next != null && !next.startsWith('--')) {
      out[key] = next;
      i += 1;
    } else out[key] = true;
  }
  return out;
}

export function intValue(value, fallback) {
  const n = Number(value ?? fallback);
  if (!Number.isFinite(n)) throw new Error(`Expected integer, received ${value}`);
  return Math.trunc(n);
}

export function isoDate(value) {
  const raw = cleanText(value);
  if (!raw) return null;
  const ms = Date.parse(raw);
  if (!Number.isFinite(ms)) return null;
  return new Date(ms).toISOString().slice(0, 10);
}

export function selectReleaseDate(raw = {}) {
  const candidates = [
    ['release_date', raw.release_date],
    ['date', raw.date],
    ['created_at_fallback', raw.created_at],
  ];
  for (const [source, value] of candidates) {
    const date = isoDate(value);
    if (date) return { release_date: date, release_date_raw: cleanText(value), release_date_source: source };
  }
  return { release_date: null, release_date_raw: null, release_date_source: 'unknown' };
}

export function truthyBool(value) {
  if (typeof value === 'boolean') return value;
  if (value == null || value === '') return null;
  if (typeof value === 'number') return value !== 0;
  if (/^(1|true|yes|explicit)$/i.test(String(value))) return true;
  if (/^(0|false|no)$/i.test(String(value))) return false;
  return null;
}
