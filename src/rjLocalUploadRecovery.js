import { createHash, randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { stat, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { extname, join } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const MAX_DOWNLOAD_BYTES = 512 * 1024 * 1024;
const ALLOWED_HOST_SUFFIXES = [
  '.rjmedia-content.app',
  '.mediacon-rj.app',
];

function clean(value = '') {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function safeHost(host = '') {
  const value = clean(host).toLowerCase();
  return ALLOWED_HOST_SUFFIXES.some(suffix =>
    value === suffix.slice(1) || value.endsWith(suffix)
  );
}

export function selectRjApiUploadCandidate(row = {}) {
  const candidates = Array.isArray(row?.verification?.apiRecovery?.candidates)
    ? row.verification.apiRecovery.candidates
    : [];

  for (const raw of candidates) {
    try {
      const parsed = new URL(clean(raw?.url));
      if (parsed.protocol !== 'https:' || !safeHost(parsed.hostname)) continue;
      const source = clean(raw?.source);
      if (!source.startsWith('rj_api')) continue;
      return {
        url: parsed.toString(),
        host: parsed.hostname,
        quality: Number(raw?.quality || 0) || null,
        source,
      };
    } catch {}
  }
  return null;
}

export function validateRjAudioResponseMeta({
  status = 0,
  contentType = '',
  contentLength = null,
} = {}) {
  const numericStatus = Number(status || 0);
  if (numericStatus < 200 || numericStatus >= 300) {
    return { ok:false, reason:`HTTP ${numericStatus || 'unknown'}` };
  }

  const type = clean(contentType).toLowerCase().split(';')[0];
  const size = Number(contentLength || 0) || null;
  if (size != null && size > MAX_DOWNLOAD_BYTES) {
    return { ok:false, reason:`file too large: ${size}` };
  }

  // Some live RJ CDN responses label valid m4a files as text/plain. Do not
  // trust Content-Type for identity. The downloaded bytes are always sniffed
  // before Telegram upload.
  return {
    ok:true,
    contentType:type || null,
    contentLength:size,
    suspiciousContentType:Boolean(
      type
      && (
        type.startsWith('text/')
        || type.includes('json')
        || type.includes('html')
        || type.startsWith('image/')
      )
    ),
  };
}

export function looksLikeAudioHeader(value) {
  const buffer = Buffer.isBuffer(value) ? value : Buffer.from(value || []);
  if (buffer.length < 2) return false;

  if (buffer.length >= 3 && buffer.subarray(0, 3).toString('ascii') === 'ID3') {
    return true;
  }
  if (
    buffer[0] === 0xff
    && (
      (buffer[1] & 0xe0) === 0xe0 // MPEG audio frame
      || (buffer[1] & 0xf6) === 0xf0 // AAC ADTS
    )
  ) {
    return true;
  }
  if (buffer.length >= 4) {
    const first4 = buffer.subarray(0, 4).toString('ascii');
    if (['OggS','fLaC','ADIF'].includes(first4)) return true;
    if (
      first4 === 'RIFF'
      && buffer.length >= 12
      && buffer.subarray(8, 12).toString('ascii') === 'WAVE'
    ) return true;
  }

  // ISO Base Media / M4A typically starts with a 32-bit box size followed by
  // "ftyp". Search only the tiny header window rather than arbitrary content.
  const ftyp = buffer.subarray(0, Math.min(buffer.length, 32)).indexOf(Buffer.from('ftyp'));
  return ftyp >= 4 && ftyp <= 16;
}

function extensionFor(candidate, contentType = '') {
  try {
    const ext = extname(new URL(candidate.url).pathname).toLowerCase();
    if (['.m4a','.mp3','.aac','.mp4','.ogg','.opus','.flac'].includes(ext)) return ext;
  } catch {}
  const type = clean(contentType).toLowerCase();
  if (type.includes('mpeg')) return '.mp3';
  if (type.includes('aac')) return '.aac';
  return '.m4a';
}

export async function downloadRjAudioToTemp(candidate, sourceId, {
  timeoutMs = 180_000,
} = {}) {
  if (!candidate?.url) throw new Error('RJ local upload candidate missing URL');

  const parsed = new URL(candidate.url);
  if (parsed.protocol !== 'https:' || !safeHost(parsed.hostname)) {
    throw new Error('RJ local upload candidate host is not allowed');
  }

  const response = await fetch(parsed, {
    headers: {
      accept: 'audio/*,application/octet-stream;q=0.9,*/*;q=0.1',
      'user-agent': 'Mozilla/5.0 Navazon/1.0',
    },
    redirect: 'follow',
    signal: AbortSignal.timeout(timeoutMs),
  });

  try {
    const finalUrl = new URL(response.url || parsed.toString());
    if (finalUrl.protocol !== 'https:' || !safeHost(finalUrl.hostname)) {
      throw new Error('RJ local download redirected to a non-RJ host');
    }
  } catch (err) {
    throw new Error(`RJ local download redirect rejected: ${err?.message || err}`);
  }

  const meta = validateRjAudioResponseMeta({
    status: response.status,
    contentType: response.headers.get('content-type') || '',
    contentLength: response.headers.get('content-length'),
  });
  if (!meta.ok) throw new Error(`RJ local download rejected: ${meta.reason}`);
  if (!response.body) throw new Error('RJ local download returned an empty body');

  const ext = extensionFor(candidate, meta.contentType || '');
  const path = join(
    tmpdir(),
    `navazon-rj-${clean(sourceId).replace(/[^a-zA-Z0-9_-]/g,'_')}-${randomUUID()}${ext}`
  );

  const hash = createHash('sha256');
  let bytes = 0;
  let header = Buffer.alloc(0);
  const meter = new Transform({
    transform(chunk, _encoding, callback) {
      bytes += chunk.length;
      if (header.length < 64) {
        const needed = 64 - header.length;
        header = Buffer.concat([header, chunk.subarray(0, needed)]);
      }
      if (bytes > MAX_DOWNLOAD_BYTES) {
        callback(new Error(`RJ local download exceeded ${MAX_DOWNLOAD_BYTES} bytes`));
        return;
      }
      hash.update(chunk);
      callback(null, chunk);
    },
  });

  try {
    await pipeline(
      Readable.fromWeb(response.body),
      meter,
      createWriteStream(path)
    );
    const info = await stat(path);
    if (!info.size || info.size < 1024) {
      throw new Error(`RJ local download too small: ${info.size || 0} bytes`);
    }
    if (!looksLikeAudioHeader(header)) {
      throw new Error(
        `RJ local download magic bytes are not recognized as audio${meta.contentType ? ` (content-type ${meta.contentType})` : ''}`
      );
    }
    return {
      path,
      bytes: info.size,
      sha256: hash.digest('hex'),
      contentType: meta.contentType,
      candidate,
    };
  } catch (err) {
    try { await unlink(path); } catch {}
    throw err;
  }
}

export async function cleanupRjTempFile(path) {
  if (!path) return;
  try { await unlink(path); } catch {}
}
