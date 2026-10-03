import {
  artistCreditCompatible,
  crossScriptIdentityCompatible,
  trackTitleIdentityCompatible,
} from './text.js';

const API_BASE = 'https://rj-deskcloud.com/api2/mp3';
const API_HEADERS = {
  accept: 'application/json, text/plain, */*',
  'accept-language': 'en-US',
  'x-rj-user-agent': 'Radio Javan/5.0.0 (Desktop) com.radioJavan.rj.desktop',
  'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) RadioJavan/5.2.0 Chrome/130.0.6723.118 Electron/33.2.0 Safari/537.36',
};

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function clean(value = '') {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function normalizePayload(payload) {
  if (Array.isArray(payload)) return payload.find(Boolean) || null;
  if (!payload || typeof payload !== 'object') return null;
  for (const key of ['mp3', 'data', 'result', 'track']) {
    const value = payload[key];
    if (Array.isArray(value)) return value.find(Boolean) || null;
    if (value && typeof value === 'object') return value;
  }
  return payload;
}

function inferQuality(url = '', fallback = null) {
  const value = String(url || '').toLowerCase();
  const match = value.match(/(?:aac|mp3)[-_](\d{2,3})/);
  if (match) return Number(match[1]);
  return Number(fallback || 0) || null;
}

function candidateFromUrl(url, quality = null, label = 'api') {
  try {
    const parsed = new URL(String(url || ''));
    if (parsed.protocol !== 'https:') return null;
    return {
      url: parsed.toString(),
      host: parsed.hostname,
      quality: inferQuality(parsed.pathname, quality),
      source: label,
    };
  } catch {
    return null;
  }
}

function dedupeCandidates(items = []) {
  const seen = new Set();
  const out = [];
  for (const item of items) {
    if (!item?.url || seen.has(item.url)) continue;
    seen.add(item.url);
    out.push(item);
  }
  return out;
}

export function evaluateRjApiRecovery(row = {}, rawPayload = {}) {
  const payload = normalizePayload(rawPayload);
  if (!payload) return { ok: false, reason: 'empty Radio Javan API payload' };

  const apiId = clean(payload.id);
  const rowId = clean(row.source_id);
  if (apiId && rowId && apiId !== rowId) {
    return {
      ok: false,
      reason: `Radio Javan API id mismatch: expected=${rowId} actual=${apiId}`,
    };
  }

  const apiArtist = clean(payload.artist);
  const apiTitle = clean(payload.song || payload.name || '');
  const artistOk = Boolean(
    apiArtist
    && (
      artistCreditCompatible(row.artist, apiArtist)
      || crossScriptIdentityCompatible(row.artist, apiArtist)
    )
  );
  const titleOk = Boolean(
    apiTitle
    && trackTitleIdentityCompatible(row.title, apiTitle)
  );

  if (!artistOk || !titleOk) {
    return {
      ok: false,
      reason: !artistOk && !titleOk
        ? 'fresh Radio Javan artist and title both mismatch archive identity'
        : (!artistOk
            ? 'fresh Radio Javan artist mismatches archive identity'
            : 'fresh Radio Javan title mismatches archive identity'),
      apiArtist,
      apiTitle,
      artistOk,
      titleOk,
    };
  }

  const duration = Number(payload.duration || 0) || null;
  const candidates = dedupeCandidates([
    candidateFromUrl(payload.hq_link, 256, 'rj_api_hq'),
    candidateFromUrl(payload.link, null, 'rj_api_primary'),
    candidateFromUrl(payload.lq_link, 128, 'rj_api_lq'),
  ].filter(Boolean));

  if (!candidates.length) {
    return {
      ok: false,
      reason: 'fresh Radio Javan API returned no usable direct audio link',
      apiArtist,
      apiTitle,
      artistOk,
      titleOk,
      duration,
    };
  }

  return {
    ok: true,
    apiId: apiId || rowId || null,
    apiArtist,
    apiTitle,
    artistOk,
    titleOk,
    duration,
    candidates,
  };
}

export async function fetchFreshRjTrack(sourceId, { retries = 2 } = {}) {
  const id = clean(sourceId);
  if (!/^\d+$/.test(id)) throw new Error('invalid Radio Javan source_id');

  const url = new URL(API_BASE);
  url.searchParams.set('id', id);

  let lastError = null;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      const response = await fetch(url, {
        headers: API_HEADERS,
        signal: AbortSignal.timeout(20_000),
      });
      const raw = await response.text();
      if (!response.ok) {
        throw new Error(`Radio Javan API HTTP ${response.status}`);
      }
      let payload;
      try {
        payload = JSON.parse(raw);
      } catch {
        throw new Error('Radio Javan API returned invalid JSON');
      }
      if (payload?.success === false) {
        throw new Error(`Radio Javan API rejected id ${id}: ${clean(payload.msg || 'unknown error')}`);
      }
      return payload;
    } catch (err) {
      lastError = err;
      if (attempt >= retries) break;
      await sleep(350 * (attempt + 1));
    }
  }
  throw lastError || new Error('Radio Javan API request failed');
}

async function prepareOne(db, row) {
  const attemptedAt = new Date().toISOString();
  try {
    const payload = await fetchFreshRjTrack(row.source_id);
    const evaluated = evaluateRjApiRecovery(row, payload);

    if (!evaluated.ok) {
      await db.query(`
        UPDATE rj_audio_cache
        SET verification = COALESCE(verification,'{}'::jsonb) || $2::jsonb,
            last_error = LEFT(COALESCE(last_error,'') || ' | API recovery: ' || $3, 1800),
            updated_at = NOW()
        WHERE source_url=$1
      `, [
        row.source_url,
        JSON.stringify({
          apiRecovery: {
            attemptedAt,
            prepared: false,
            reason: evaluated.reason,
            apiArtist: evaluated.apiArtist || null,
            apiTitle: evaluated.apiTitle || null,
          },
        }),
        evaluated.reason,
      ]);
      return { prepared: false, reason: evaluated.reason };
    }

    const primary = evaluated.candidates[0];
    const expectedDuration = evaluated.duration
      ? Math.round(evaluated.duration)
      : row.expected_duration_seconds;

    await db.query(`
      UPDATE rj_audio_cache
      SET status='pending',
          attempts=0,
          expected_duration_seconds=$2,
          direct_url=$3,
          direct_quality=$4,
          direct_host=$5,
          last_error=NULL,
          next_attempt_at=NULL,
          started_at=NULL,
          verification = COALESCE(verification,'{}'::jsonb) || $6::jsonb,
          updated_at=NOW()
      WHERE source_url=$1
    `, [
      row.source_url,
      expectedDuration,
      primary.url,
      primary.quality,
      primary.host,
      JSON.stringify({
        apiRecovery: {
          attemptedAt,
          prepared: true,
          apiId: evaluated.apiId,
          apiArtist: evaluated.apiArtist,
          apiTitle: evaluated.apiTitle,
          previousExpectedDuration: row.expected_duration_seconds || null,
          refreshedDuration: expectedDuration || null,
          candidates: evaluated.candidates,
        },
      }),
    ]);

    return { prepared: true, candidates: evaluated.candidates.length };
  } catch (err) {
    const message = clean(err?.message || err).slice(0, 800);
    await db.query(`
      UPDATE rj_audio_cache
      SET verification = COALESCE(verification,'{}'::jsonb) || $2::jsonb,
          last_error = LEFT(COALESCE(last_error,'') || ' | API recovery: ' || $3, 1800),
          updated_at=NOW()
      WHERE source_url=$1
    `, [
      row.source_url,
      JSON.stringify({
        apiRecovery: {
          attemptedAt,
          prepared: false,
          reason: message,
        },
      }),
      message,
    ]);
    return { prepared: false, reason: message };
  }
}

export async function prepareFailedRjAudioRecovery(db, { concurrency = 4 } = {}) {
  const { rows } = await db.query(`
    SELECT *
    FROM rj_audio_cache
    WHERE status='failed'
      AND NULLIF(BTRIM(COALESCE(source_id,'')), '') IS NOT NULL
      AND NOT (COALESCE(verification,'{}'::jsonb) ? 'apiRecovery')
    ORDER BY md5(source_url || ':rj-api-recovery-v1')
  `);

  if (!rows.length) {
    return { scanned: 0, prepared: 0, rejected: 0 };
  }

  let cursor = 0;
  let prepared = 0;
  let rejected = 0;
  const reasons = new Map();

  async function worker() {
    while (true) {
      const index = cursor;
      cursor += 1;
      if (index >= rows.length) return;
      const row = rows[index];
      const result = await prepareOne(db, row);
      if (result.prepared) {
        prepared += 1;
      } else {
        rejected += 1;
        const reason = result.reason || 'unknown';
        reasons.set(reason, (reasons.get(reason) || 0) + 1);
      }
    }
  }

  await Promise.all(
    Array.from(
      { length: Math.max(1, Math.min(8, Number(concurrency) || 4)) },
      () => worker()
    )
  );

  const summary = {
    scanned: rows.length,
    prepared,
    rejected,
    topRejectReasons: [...reasons.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([reason, count]) => ({ reason, count })),
  };
  console.log('[rj api recovery] prepared', JSON.stringify(summary));
  return summary;
}
