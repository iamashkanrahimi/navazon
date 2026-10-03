import { db } from './db.js';
import { applyPolicyDefaults } from './policy.js';
import {
  artistCreditMatchesContext,
  artistCreditCompatible,
  trackBelongsToArtistContext,
  trackMediaIdentityMatches,
  trackTitleIdentityCompatible,
  hasMediaIdentityEvidence,
  cleanText,
  normalizeText,
} from './text.js';

function clean(value = '') {
  return cleanText(value);
}

export const MEDIA_IDENTITY_SOURCE_PREFIX = 'identity-v2:';

const TRUSTED_RJ_DEEP_MEDIA_CLAUSE = `
(
  m.source <> 'identity-v2:radiojavan'
  OR EXISTS (
    SELECT 1
    FROM track_cache tc
    WHERE tc.active = TRUE
      AND LEFT(tc.track_key, LENGTH(m.track_key) + 1) = m.track_key || '|'
      AND COALESCE(tc.track->>'source','') = 'radiojavan'
      AND COALESCE(tc.media->>'verifiedDirect','false') = 'true'
      AND COALESCE(tc.media->>'identityVerified','false') = 'true'
      AND NULLIF(BTRIM(COALESCE(tc.media->>'fileId','')), '') = m.file_id
  )
)
`;

function trustedMediaSource(source = '') {
  return MEDIA_IDENTITY_SOURCE_PREFIX + clean(source || 'melobot');
}

function publicMediaSource(source = '') {
  const value = clean(source);
  return value.startsWith(MEDIA_IDENTITY_SOURCE_PREFIX)
    ? value.slice(MEDIA_IDENTITY_SOURCE_PREFIX.length)
    : value;
}

export function deepNormalize(value = '') {
  return normalizeText(value);
}

export function hasDurableTrackIdentity(track = {}) {
  return Boolean(
    !track?.artistInferred
    && deepNormalize(track?.artist || '')
    && deepNormalize(track?.title || '')
  );
}

export function deepTrackKey(track = {}) {
  if (!hasDurableTrackIdentity(track)) return '';
  return `${deepNormalize(track.artist)}|${deepNormalize(track.title)}`;
}

export function deepAlbumKey(artist = '', title = '') {
  return `${deepNormalize(artist)}|${deepNormalize(title)}`;
}

export const SUSPENDED_BACKGROUND_MEDIA_TASK_KINDS = Object.freeze([
  'artist_bulk_media',
  'album_bulk_media',
  'track_enrich',
  'track_hq',
  'track_normal',
  'track_metadata',
  'track_cover',
  'track_lyrics',
]);

export function isSuspendedBackgroundMediaTaskKind(kind = '') {
  return SUSPENDED_BACKGROUND_MEDIA_TASK_KINDS.includes(String(kind || ''));
}

function inferredArtistFromFeaturedTitle(artist = '', title = '') {
  const artistKey = deepNormalize(artist);
  const titleKey = deepNormalize(title);
  return Boolean(
    artistKey
    && (
      titleKey.includes(`feat ${artistKey}`)
      || titleKey.includes(`ft ${artistKey}`)
      || titleKey.includes(`featuring ${artistKey}`)
    )
  );
}

function safeJson(value) {
  return JSON.stringify(value ?? {});
}

function aliasTargetCompatible(aliasTrack = {}, canonicalTrack = {}, evidence = 'unknown') {
  const sameIdentity = artistCreditCompatible(
    aliasTrack?.artist || '',
    canonicalTrack?.artist || ''
  ) && trackTitleIdentityCompatible(
    aliasTrack?.title || '',
    canonicalTrack?.title || ''
  );
  if (sameIdentity) return true;
  if (evidence !== 'telegram_audio_metadata') return false;
  return trackMediaIdentityMatches(aliasTrack, {
    performer: canonicalTrack?.artist || '',
    title: canonicalTrack?.title || '',
  });
}

export class DeepCatalog {
  async setTrackAlias(aliasTrack = {}, canonicalTrack = {}, {
    source = null,
    evidence = 'unknown',
  } = {}) {
    const aliasKey = deepTrackKey(aliasTrack);
    const canonicalKey = deepTrackKey(canonicalTrack);
    if (!aliasKey || aliasKey === '|' || !canonicalKey || canonicalKey === '|') return canonicalTrack;
    if (aliasKey === canonicalKey) return canonicalTrack;
    if (aliasTrack?.artistInferred || canonicalTrack?.artistInferred) return canonicalTrack;
    if (!aliasTargetCompatible(aliasTrack, canonicalTrack, evidence)) {
      const err = new Error('Track alias identity mismatch');
      err.code = 'TRACK_ALIAS_IDENTITY_MISMATCH';
      throw err;
    }

    const existingCanonical = await db.query(
      'SELECT 1 FROM deep_tracks WHERE track_key = $1 LIMIT 1',
      [canonicalKey]
    );
    if (!existingCanonical.rowCount) {
      await this.upsertTrack(canonicalTrack, {
        discoveredFrom: 'canonical-alias',
      });
    }

    await db.query(`
      INSERT INTO track_aliases (
        alias_key, alias_artist, alias_title, canonical_track_key, source, evidence, updated_at
      ) VALUES ($1,$2,$3,$4,$5,$6,NOW())
      ON CONFLICT (alias_key) DO UPDATE SET
        alias_artist = EXCLUDED.alias_artist,
        alias_title = EXCLUDED.alias_title,
        canonical_track_key = EXCLUDED.canonical_track_key,
        source = COALESCE(EXCLUDED.source, track_aliases.source),
        evidence = EXCLUDED.evidence,
        updated_at = NOW()
    `, [
      aliasKey,
      clean(aliasTrack.artist),
      clean(aliasTrack.title),
      canonicalKey,
      source || aliasTrack.source || null,
      evidence,
    ]);

    return canonicalTrack;
  }

  async resolveTrackAlias(track = {}, { learnFromCache = true } = {}) {
    const aliasKey = deepTrackKey(track);
    if (!aliasKey || aliasKey === '|' || track?.artistInferred) return track;

    const aliasResult = await db.query(`
      SELECT
        a.canonical_track_key,
        a.source AS alias_source,
        a.evidence AS alias_evidence,
        t.artist,
        t.title,
        t.source_data,
        t.duration_seconds,
        t.popularity_count,
        t.popularity_text
      FROM track_aliases a
      JOIN deep_tracks t ON t.track_key = a.canonical_track_key
      WHERE a.alias_key = $1
      LIMIT 1
    `, [aliasKey]);

    const known = aliasResult.rows[0];
    if (known) {
      const sourceData = known.source_data || {};
      const compatible = aliasTargetCompatible(
        track,
        { artist: known.artist, title: known.title },
        known.alias_evidence || 'unknown'
      );

      if (!compatible) {
        console.warn(
          '[track alias rejected]',
          track?.artist,
          track?.title,
          '=>',
          known.artist,
          known.title,
          known.alias_evidence || 'unknown'
        );
      } else {
        return applyPolicyDefaults({
        ...track,
        artist: known.artist,
        title: known.title,
        durationSeconds: known.duration_seconds || track.durationSeconds,
        sourcePopularityCount: known.popularity_count
          ? Number(known.popularity_count)
          : track.sourcePopularityCount,
        sourcePopularityText: known.popularity_text || track.sourcePopularityText,
        ...sourceData,
        source: sourceData.source || track.source,
        // Never replace a live MeloBot search-row button with a rawText value
        // loaded from durable catalog storage. rawText is reply-keyboard state,
        // not Track identity; an old value can point at the wrong source page.
        rawText: track?.source === 'melobot' && track?.rawText
          ? track.rawText
          : (sourceData.rawText || track.rawText),
        cmd: sourceData.cmd || track.cmd,
          artistInferred: false,
        });
      }
    }

    if (!learnFromCache) return track;

    const cacheResult = await db.query(`
      SELECT track, media
      FROM track_cache
      WHERE track_key LIKE $1
      ORDER BY updated_at DESC
      LIMIT 3
    `, [`${aliasKey}|%`]);

    for (const row of cacheResult.rows) {
      const performer = clean(row.media?.performer || '');
      const mediaTitle = clean(row.media?.title || '');
      if (!performer || !mediaTitle) continue;

      const expectedTitle = normalizeText(track?.title || '');
      const actualTitle = normalizeText(mediaTitle);
      const titleCompatible = Boolean(
        expectedTitle
        && actualTitle
        && (
          expectedTitle === actualTitle
          || expectedTitle.includes(actualTitle)
          || actualTitle.includes(expectedTitle)
        )
      );
      const trustedAhangifyMetadataAlias = Boolean(
        track?.source === 'ahangify'
        && row.track?.source === 'ahangify'
      );
      if (
        !trustedAhangifyMetadataAlias
        && (
          !titleCompatible
          || (
            track?.artist
            && !artistCreditCompatible(track.artist, performer)
          )
        )
      ) {
        console.warn(
          '[track alias cache mismatch]',
          track?.artist,
          track?.title,
          '!=',
          performer,
          mediaTitle
        );
        continue;
      }

      const candidate = applyPolicyDefaults({
        ...track,
        artist: performer,
        title: mediaTitle,
        artistInferred: false,
      });
      const candidateKey = deepTrackKey(candidate);
      if (!candidateKey || candidateKey === '|' || candidateKey === aliasKey) continue;

      const canonicalResult = await db.query(`
        SELECT artist, title, source_data, duration_seconds, popularity_count, popularity_text
        FROM deep_tracks
        WHERE track_key = $1
        LIMIT 1
      `, [candidateKey]);

      const canonical = canonicalResult.rows[0];
      const resolved = canonical
        ? applyPolicyDefaults({
            ...track,
            artist: canonical.artist,
            title: canonical.title,
            durationSeconds: canonical.duration_seconds || track.durationSeconds,
            sourcePopularityCount: canonical.popularity_count
              ? Number(canonical.popularity_count)
              : track.sourcePopularityCount,
            sourcePopularityText: canonical.popularity_text || track.sourcePopularityText,
            ...(canonical.source_data || {}),
            source: canonical.source_data?.source || track.source,
            rawText: track?.source === 'melobot' && track?.rawText
              ? track.rawText
              : (canonical.source_data?.rawText || track.rawText),
            cmd: canonical.source_data?.cmd || track.cmd,
            artistInferred: false,
          })
        : candidate;

      try {
        await this.setTrackAlias(track, resolved, {
          source: row.track?.source || track.source || null,
          evidence: 'telegram_audio_metadata',
        });
      } catch (err) {
        if (err?.code === 'TRACK_ALIAS_IDENTITY_MISMATCH') {
          console.warn('[track alias learn rejected]', track?.artist, track?.title);
          continue;
        }
        throw err;
      }
      return resolved;
    }

    return track;
  }

  async canonicalizeKnownTracks(tracks = []) {
    const out = [];
    const seen = new Set();
    for (const track of tracks || []) {
      if (!hasDurableTrackIdentity(track)) {
        const transientKey = [
          'transient',
          deepNormalize(track?.artist || ''),
          deepNormalize(track?.title || ''),
          deepNormalize(track?.rawText || track?.cmd || ''),
        ].join('|');
        if (!deepNormalize(track?.title || '') || seen.has(transientKey)) continue;
        seen.add(transientKey);
        out.push(track);
        continue;
      }

      let resolved = track;
      try {
        resolved = await this.resolveTrackAlias(track);
      } catch (err) {
        console.warn('[track alias resolve]', track?.artist, track?.title, err.message);
      }
      const key = deepTrackKey(resolved);
      if (!key || key === '|' || seen.has(key)) continue;
      seen.add(key);
      out.push(resolved);
    }
    return out;
  }

  async clearCapability(track = {}, capability = '') {
    const trackKey = deepTrackKey(track);
    const allowed = new Set([
      'hasHq', 'hasNormal', 'hasLyrics', 'hasCover', 'hasMetadata', 'hasArtistPage',
    ]);
    if (!trackKey || trackKey === '|' || !allowed.has(capability)) return;

    await db.query(`
      UPDATE deep_tracks
      SET metadata = CASE
        WHEN metadata ? 'capabilities' THEN
          jsonb_set(
            metadata,
            '{capabilities}',
            COALESCE(metadata->'capabilities', '{}'::jsonb) - $2,
            TRUE
          )
        ELSE metadata
      END,
      updated_at = NOW()
      WHERE track_key = $1
    `, [trackKey, capability]);
  }

  async markCapabilityFailure(track = {}, capability = '', reason = '') {
    const trackKey = deepTrackKey(track);
    const allowed = new Set([
      'hasHq', 'hasNormal', 'hasLyrics', 'hasCover', 'hasMetadata', 'hasArtistPage',
    ]);
    if (!trackKey || trackKey === '|' || !allowed.has(capability)) return;

    const exists = await db.query(
      'SELECT 1 FROM deep_tracks WHERE track_key = $1 LIMIT 1',
      [trackKey]
    );
    if (!exists.rowCount) return;

    await db.query(`
      INSERT INTO track_capability_failures (track_key, capability, reason, failed_at)
      VALUES ($1,$2,$3,NOW())
      ON CONFLICT (track_key, capability) DO UPDATE SET
        reason = EXCLUDED.reason,
        failed_at = NOW()
    `, [trackKey, capability, clean(reason).slice(0, 500) || null]);
  }

  async clearCapabilityFailure(track = {}, capability = '') {
    const trackKey = deepTrackKey(track);
    if (!trackKey || trackKey === '|' || !capability) return;
    await db.query(
      'DELETE FROM track_capability_failures WHERE track_key = $1 AND capability = $2',
      [trackKey, capability]
    );
  }

  async getRecentCapabilityFailures(track = {}, maxAgeMs = 15 * 60 * 1000) {
    const trackKey = deepTrackKey(track);
    if (!trackKey || trackKey === '|') return {};

    const result = await db.query(`
      SELECT capability, reason, failed_at
      FROM track_capability_failures
      WHERE track_key = $1
        AND failed_at >= NOW() - ($2::bigint * INTERVAL '1 millisecond')
    `, [trackKey, Math.max(0, Number(maxAgeMs || 0))]);

    const out = {};
    for (const row of result.rows) {
      out[row.capability] = {
        failedAt: row.failed_at,
        reason: row.reason || undefined,
      };
    }
    return out;
  }

  async upsertTrack(track = {}, extra = {}) {
    const policy = applyPolicyDefaults({ ...track, ...extra });
    const trackKey = deepTrackKey(policy);
    if (!trackKey || trackKey === '|') return null;

    const sourceData = {
      rawText: policy.rawText || undefined,
      cmd: policy.cmd || undefined,
      source: policy.source || undefined,
      artistInferred: Boolean(policy.artistInferred) || undefined,
      sourcePopularityText: policy.sourcePopularityText || undefined,
      sourcePopularityCount: Number.isFinite(policy.sourcePopularityCount)
        ? policy.sourcePopularityCount
        : undefined,
      discoveredFrom: extra.discoveredFrom || undefined,
      feed: extra.feed || undefined,
    };

    await db.query(`
      INSERT INTO deep_tracks (
        track_key, artist, title, album, duration_seconds,
        popularity_count, popularity_text,
        content_origin, availability_policy,
        copyright_status, copyright_source, copyright_checked_at,
        source_data, metadata, discovered_at, updated_at
      ) VALUES (
        $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb,$14::jsonb,NOW(),NOW()
      )
      ON CONFLICT (track_key) DO UPDATE SET
        artist = EXCLUDED.artist,
        title = EXCLUDED.title,
        album = COALESCE(EXCLUDED.album, deep_tracks.album),
        duration_seconds = COALESCE(EXCLUDED.duration_seconds, deep_tracks.duration_seconds),
        popularity_count = COALESCE(EXCLUDED.popularity_count, deep_tracks.popularity_count),
        popularity_text = COALESCE(EXCLUDED.popularity_text, deep_tracks.popularity_text),
        content_origin = CASE
          WHEN EXCLUDED.content_origin <> 'unknown' THEN EXCLUDED.content_origin
          ELSE deep_tracks.content_origin
        END,
        availability_policy = CASE
          WHEN EXCLUDED.availability_policy <> 'unknown' THEN EXCLUDED.availability_policy
          ELSE deep_tracks.availability_policy
        END,
        copyright_status = CASE
          WHEN EXCLUDED.copyright_status <> 'unknown' THEN EXCLUDED.copyright_status
          ELSE deep_tracks.copyright_status
        END,
        copyright_source = COALESCE(EXCLUDED.copyright_source, deep_tracks.copyright_source),
        copyright_checked_at = COALESCE(EXCLUDED.copyright_checked_at, deep_tracks.copyright_checked_at),
        source_data = CASE
          WHEN COALESCE(deep_tracks.source_data->>'source','') = 'melobot'
            AND COALESCE(EXCLUDED.source_data->>'source','') <> 'melobot'
          THEN deep_tracks.source_data
            || (EXCLUDED.source_data - 'source' - 'rawText')
          ELSE deep_tracks.source_data || EXCLUDED.source_data
        END,
        metadata = deep_tracks.metadata || EXCLUDED.metadata,
        updated_at = NOW()
    `, [
      trackKey,
      clean(policy.artist),
      clean(policy.title),
      clean(extra.album || policy.album || '') || null,
      Number(policy.durationSeconds || policy.duration || 0) || null,
      Number.isFinite(policy.sourcePopularityCount) ? policy.sourcePopularityCount : null,
      policy.sourcePopularityText || null,
      policy.contentOrigin || 'unknown',
      policy.availabilityPolicy || 'unknown',
      clean(extra.copyrightStatus || policy.copyrightStatus || 'unknown') || 'unknown',
      clean(extra.copyrightSource || policy.copyrightSource || '') || null,
      extra.copyrightCheckedAt || policy.copyrightCheckedAt || null,
      safeJson(sourceData),
      safeJson(extra.metadata || {}),
    ]);

    return trackKey;
  }

  async setArtistList(artist, listType, tracks = []) {
    const artistKey = deepNormalize(artist);
    if (!artistKey) return;
    const durableTracks = (tracks || []).filter(track =>
      !track?.artistInferred
      && artistCreditMatchesContext(track?.artist || '', artist)
    );
    if (!durableTracks.length) return;

    await db.query('DELETE FROM deep_artist_tracks WHERE artist_key = $1 AND list_type = $2', [artistKey, listType]);

    const rows = await Promise.all(durableTracks.map(async (track, index) => {
      const trackKey = await this.upsertTrack(track, { discoveredFrom: `artist:${listType}` });
      return trackKey ? { trackKey, rank: index + 1 } : null;
    }));

    await Promise.all(rows.filter(Boolean).map(row => db.query(`
      INSERT INTO deep_artist_tracks (
        artist_key, artist_name, list_type, track_key, rank, observed_at, list_version
      )
      VALUES ($1,$2,$3,$4,$5,NOW(),1)
      ON CONFLICT (artist_key, list_type, track_key) DO UPDATE SET
        rank = EXCLUDED.rank,
        observed_at = NOW(),
        list_version = 1
    `, [artistKey, clean(artist), listType, row.trackKey, row.rank])));
  }

  async upsertAlbum(artist, album = {}) {
    const albumKey = deepAlbumKey(artist, album.title);
    if (!albumKey || albumKey === '|') return null;
    await db.query(`
      INSERT INTO deep_albums (album_key, artist, title, track_count, metadata, updated_at)
      VALUES ($1,$2,$3,$4,$5::jsonb,NOW())
      ON CONFLICT (album_key) DO UPDATE SET
        track_count = COALESCE(EXCLUDED.track_count, deep_albums.track_count),
        metadata = deep_albums.metadata || EXCLUDED.metadata,
        updated_at = NOW()
    `, [
      albumKey,
      clean(artist),
      clean(album.title),
      Number(album.trackCount || 0) || null,
      safeJson({
        rawText: album.rawText || undefined,
        verifiedAlbum: Boolean(album.verifiedAlbum) || undefined,
        albumTrustVersion: Number(album.albumTrustVersion || 0) || undefined,
      }),
    ]);
    return albumKey;
  }

  async deleteAlbum(artist, albumTitle) {
    const albumKey = deepAlbumKey(artist, albumTitle);
    if (!albumKey || albumKey === '|') return false;
    const result = await db.query(
      'DELETE FROM deep_albums WHERE album_key = $1',
      [albumKey]
    );
    return result.rowCount > 0;
  }

  async setAlbumTracks(artist, album, tracks = []) {
    const albumKey = await this.upsertAlbum(artist, album);
    if (!albumKey) return;

    const sourceTracks = tracks || [];
    const durableTracks = sourceTracks.filter(track =>
      !track?.artistInferred
      && trackBelongsToArtistContext(track, artist)
    );

    await db.query('DELETE FROM deep_album_tracks WHERE album_key = $1', [albumKey]);
    await db.query(`
      UPDATE deep_albums
      SET metadata = metadata - 'trackListVersion',
          updated_at = NOW()
      WHERE album_key = $1
    `, [albumKey]);

    // A title-only album row can inherit the page artist even when the real
    // primary artist is a collaborator. Keep that live list in the session/
    // legacy JSON cache, but do not certify a partial or misattributed deep
    // relation. It will be rebuilt once all identities are canonical.
    if (
      !sourceTracks.length
      || durableTracks.length !== sourceTracks.length
    ) {
      return;
    }

    const rows = await Promise.all(durableTracks.map(async (track, index) => {
      const trackKey = await this.upsertTrack(track, {
        album: album.title,
        discoveredFrom: 'album',
      });
      return trackKey ? { trackKey, position: index + 1 } : null;
    }));

    const validRows = rows.filter(Boolean);
    if (validRows.length !== durableTracks.length) return;

    await Promise.all(validRows.map(row => db.query(`
      INSERT INTO deep_album_tracks (album_key, track_key, position)
      VALUES ($1,$2,$3)
      ON CONFLICT (album_key, track_key) DO UPDATE SET position = EXCLUDED.position
    `, [albumKey, row.trackKey, row.position])));

    // Only mark the relation trusted after the full canonical replacement.
    await db.query(`
      UPDATE deep_albums
      SET metadata = metadata || '{"trackListVersion":1}'::jsonb,
          updated_at = NOW()
      WHERE album_key = $1
    `, [albumKey]);
  }

  async setMedia(track, quality, media = {}, extra = {}) {
    // Durable media must never be keyed by an inferred Artist identity.
    // Resolve/canonicalize first; otherwise common titles can poison file_id
    // cache entries for a different performer.
    if (track?.artistInferred) return;
    if (
      !hasMediaIdentityEvidence(media)
      || !trackMediaIdentityMatches(track, media || {})
    ) {
      console.warn('[deep media write rejected]', track?.artist, track?.title);
      return;
    }
    const mediaSource = clean(extra.source || track.source || 'melobot');
    if (
      mediaSource === 'radiojavan'
      && (media?.verifiedDirect !== true || media?.identityVerified !== true)
    ) {
      console.warn('[deep media radiojavan write rejected]', track?.artist, track?.title);
      return;
    }

    const trackKey = await this.upsertTrack(track);
    if (!trackKey || !media.fileId) return;
    await db.query(`
      INSERT INTO deep_track_media (
        track_key, quality, file_id, file_unique_id, kind,
        bitrate, file_size, duration_seconds, source, verified_quality, updated_at
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,TRUE,NOW())
      ON CONFLICT (track_key, quality) DO UPDATE SET
        file_id = EXCLUDED.file_id,
        file_unique_id = COALESCE(EXCLUDED.file_unique_id, deep_track_media.file_unique_id),
        kind = EXCLUDED.kind,
        bitrate = COALESCE(EXCLUDED.bitrate, deep_track_media.bitrate),
        file_size = COALESCE(EXCLUDED.file_size, deep_track_media.file_size),
        duration_seconds = COALESCE(EXCLUDED.duration_seconds, deep_track_media.duration_seconds),
        source = EXCLUDED.source,
        verified_quality = TRUE,
        updated_at = NOW()
      WHERE
        COALESCE(deep_track_media.source,'') <> 'identity-v2:radiojavan'
        OR EXCLUDED.source = 'identity-v2:radiojavan'
    `, [
      trackKey,
      quality,
      media.fileId,
      media.fileUniqueId || null,
      media.kind || 'audio',
      Number(extra.bitrate || 0) || null,
      Number(extra.fileSize || media.fileSize || 0) || null,
      Number(media.duration || extra.duration || 0) || null,
      trustedMediaSource(mediaSource),
    ]);
    await this.completeTaskByKey(`track_${quality}:${trackKey}`, {
      satisfiedBy: extra.satisfiedBy || 'media_cache',
      quality,
    });
  }

  async getMediaMap(tracks = [], quality = 'hq') {
    const keys = [...new Set((tracks || [])
      .filter(track => !track?.artistInferred)
      .map(track => deepTrackKey(track))
      .filter(key => key && key !== '|'))];

    const out = new Map();
    if (!keys.length) return out;

    const result = await db.query(`
      SELECT m.track_key, m.quality, m.file_id, m.file_unique_id, m.kind,
             m.bitrate, m.file_size, m.duration_seconds, m.source
      FROM deep_track_media m
      WHERE m.quality = $1
        AND m.verified_quality = TRUE
        AND m.source LIKE $3
        AND m.track_key = ANY($2::text[])
        AND ${TRUSTED_RJ_DEEP_MEDIA_CLAUSE}
    `, [quality, keys, MEDIA_IDENTITY_SOURCE_PREFIX + '%']);

    for (const item of result.rows) {
      out.set(item.track_key, {
        fileId: item.file_id,
        fileUniqueId: item.file_unique_id,
        kind: item.kind,
        bitrate: item.bitrate,
        fileSize: item.file_size ? Number(item.file_size) : undefined,
        duration: item.duration_seconds || undefined,
        source: publicMediaSource(item.source) || undefined,
        quality: item.quality,
      });
    }

    return out;
  }

  async setCover(track, media = {}) {
    const trackKey = await this.upsertTrack(track);
    if (!trackKey || !media.fileId) return;
    await db.query(`
      UPDATE deep_tracks
      SET cover_file_id = $2,
          cover_unique_id = $3,
          cover_meta = cover_meta || $4::jsonb,
          updated_at = NOW()
      WHERE track_key = $1
    `, [
      trackKey,
      media.fileId,
      media.fileUniqueId || null,
      safeJson({
        width: media.width || undefined,
        height: media.height || undefined,
        fileSize: media.fileSize || undefined,
      }),
    ]);
    await this.completeTaskByKey(`track_cover:${trackKey}`, { satisfiedBy: 'track_enrich' });
  }

  async setLyrics(track, lyricsText, source = 'melobot') {
    const trackKey = await this.upsertTrack(track);
    if (!trackKey) return;
    await db.query(`
      UPDATE deep_tracks
      SET lyrics_text = $2,
          lyrics_source = $3,
          lyrics_updated_at = NOW(),
          metadata = metadata || '{"hasLyrics":true}'::jsonb,
          updated_at = NOW()
      WHERE track_key = $1
    `, [trackKey, String(lyricsText || '').trim(), source]);
    await this.completeTaskByKey(`track_lyrics:${trackKey}`, { satisfiedBy: 'track_enrich' });
  }

  async markNoLyrics(track, source = 'melobot') {
    const trackKey = await this.upsertTrack(track);
    if (!trackKey) return;
    await db.query(`
      UPDATE deep_tracks
      SET lyrics_source = $2,
          lyrics_updated_at = NOW(),
          metadata = metadata || '{"hasLyrics":false}'::jsonb,
          updated_at = NOW()
      WHERE track_key = $1
    `, [trackKey, source]);
    await this.completeTaskByKey(`track_lyrics:${trackKey}`, { satisfiedBy: 'track_enrich', available: false });
  }

  async setMetadata(track, patch = {}) {
    const trackKey = await this.upsertTrack(track);
    if (!trackKey) return;
    const releaseDate = patch.releaseDate || null;
    const releaseDateRaw = patch.releaseDateRaw || null;
    const popularityCount = Number.isFinite(patch.popularityCount) ? patch.popularityCount : null;
    await db.query(`
      UPDATE deep_tracks
      SET release_date = COALESCE($2::date, release_date),
          release_date_raw = COALESCE($3, release_date_raw),
          popularity_count = COALESCE($4, popularity_count),
          popularity_text = COALESCE($5, popularity_text),
          metadata = metadata || $6::jsonb,
          updated_at = NOW()
      WHERE track_key = $1
    `, [
      trackKey,
      releaseDate,
      releaseDateRaw,
      popularityCount,
      patch.popularityText || null,
      safeJson({
        ...(patch.raw && typeof patch.raw === 'object' ? patch.raw : patch),
        ...(typeof patch.raw === 'string' && patch.raw ? { raw: patch.raw } : {}),
        metadataCheckedAt: new Date().toISOString(),
      }),
    ]);
    await this.completeTaskByKey(`track_metadata:${trackKey}`, { satisfiedBy: 'track_enrich' });
  }

  async setCapabilities(track, capabilities = {}) {
    const trackKey = await this.upsertTrack(track);
    if (!trackKey) return;

    // Capability discovery is best-effort. Persist positive evidence only;
    // a timeout/empty source surface means "unknown", not "unavailable".
    const positive = Object.fromEntries(
      Object.entries({
        hasHq: capabilities.hasHq,
        hasNormal: capabilities.hasNormal,
        hasLyrics: capabilities.hasLyrics,
        hasCover: capabilities.hasCover,
        hasMetadata: capabilities.hasMetadata,
        hasArtistPage: capabilities.hasArtistPage,
      }).filter(([, value]) => value === true)
    );

    if (!Object.keys(positive).length) return;

    await db.query(`
      UPDATE deep_tracks
      SET metadata = metadata
          || jsonb_build_object(
            'capabilities',
            COALESCE(metadata->'capabilities', '{}'::jsonb) || $2::jsonb,
            'capabilitiesCheckedAt',
            to_jsonb(NOW()::text)
          ),
          updated_at = NOW()
      WHERE track_key = $1
    `, [
      trackKey,
      safeJson(positive),
    ]);
  }

  async getTrackDetails(track = {}) {
    const trackKey = deepTrackKey(track);
    if (!trackKey || trackKey === '|') return null;

    const [trackResult, mediaResult, albumResult] = await Promise.all([
      db.query(`
        SELECT track_key, artist, title, album, duration_seconds,
          release_date, release_date_raw, popularity_count, popularity_text,
          content_origin, availability_policy, metadata,
          lyrics_text, lyrics_source,
          cover_file_id, cover_unique_id, cover_meta
        FROM deep_tracks
        WHERE track_key = $1
      `, [trackKey]),
      db.query(`
        SELECT m.quality, m.file_id, m.file_unique_id, m.kind, m.bitrate, m.file_size, m.duration_seconds, m.source
        FROM deep_track_media m
        WHERE m.track_key = $1
          AND m.verified_quality = TRUE
          AND m.source LIKE $2
          AND ${TRUSTED_RJ_DEEP_MEDIA_CLAUSE}
      `, [trackKey, MEDIA_IDENTITY_SOURCE_PREFIX + '%']),
      db.query(`
        SELECT a.album_key, a.artist, a.title, a.track_count
        FROM deep_album_tracks dat
        JOIN deep_albums a ON a.album_key = dat.album_key
        WHERE dat.track_key = $1
          AND a.metadata @> '{"verifiedAlbum":true,"albumTrustVersion":2,"trackListVersion":1}'::jsonb
        ORDER BY a.updated_at DESC
        LIMIT 1
      `, [trackKey]),
    ]);

    const row = trackResult.rows[0] || null;
    const media = {};
    for (const item of mediaResult.rows) {
      media[item.quality] = {
        fileId: item.file_id,
        fileUniqueId: item.file_unique_id,
        kind: item.kind,
        bitrate: item.bitrate,
        fileSize: item.file_size ? Number(item.file_size) : undefined,
        duration: item.duration_seconds || undefined,
        source: publicMediaSource(item.source) || undefined,
      };
    }

    return {
      ...(row || {
        track_key: trackKey,
        artist: clean(track.artist),
        title: clean(track.title),
      }),
      media,
      albumInfo: albumResult.rows[0] || null,
    };
  }

  async getArtistList(artist, listType = 'top', limit = 10) {
    const artistKey = deepNormalize(artist);
    if (!artistKey) return [];
    const result = await db.query(`
      SELECT
        t.track_key,
        t.artist,
        t.title,
        t.album,
        t.duration_seconds,
        t.popularity_count,
        t.popularity_text,
        t.content_origin,
        t.availability_policy,
        t.source_data,
        at.rank
      FROM deep_artist_tracks at
      JOIN deep_tracks t ON t.track_key = at.track_key
      WHERE at.artist_key = $1
        AND at.list_type = $2
        AND at.list_version >= 1
      ORDER BY at.rank ASC NULLS LAST, at.observed_at DESC
      LIMIT $3
    `, [
      artistKey,
      listType,
      Math.min(60, Math.max(1, Number(limit || 10)) * 3),
    ]);

    return result.rows
      .map(row => ({
        artist: row.artist,
        title: row.title,
        album: row.album || undefined,
        durationSeconds: row.duration_seconds || undefined,
        sourcePopularityCount: row.popularity_count ? Number(row.popularity_count) : undefined,
        sourcePopularityText: row.popularity_text || undefined,
        contentOrigin: row.content_origin || 'unknown',
        availabilityPolicy: row.availability_policy || 'unknown',
        ...(row.source_data || {}),
        source: row.source_data?.source || 'melobot',
        rawText: row.source_data?.rawText || undefined,
        artistInferred: Boolean(row.source_data?.artistInferred)
          || inferredArtistFromFeaturedTitle(row.artist, row.title),
      }))
      .filter(track =>
        !track.artistInferred
        && artistCreditMatchesContext(track.artist || '', artist)
      )
      .slice(0, Math.max(1, Number(limit || 10)));
  }

  async deriveArtistList(artist, listType = 'top', limit = 10) {
    const artistName = clean(artist);
    if (!artistName) return [];

    const recentMode = listType === 'recent';
    const evidenceClause = recentMode
      ? 't.release_date IS NOT NULL'
      : 't.popularity_count IS NOT NULL';
    const order = recentMode
      ? 't.release_date DESC, t.updated_at DESC'
      : 't.popularity_count DESC, t.updated_at DESC';

    const result = await db.query(`
      SELECT
        t.track_key,
        t.artist,
        t.title,
        t.album,
        t.duration_seconds,
        t.release_date,
        t.popularity_count,
        t.popularity_text,
        t.content_origin,
        t.availability_policy,
        t.source_data
      FROM deep_tracks t
      WHERE LOWER(t.artist) = LOWER($1)
        AND ${evidenceClause}
      ORDER BY ${order}
      LIMIT $2
    `, [artistName, Math.max(1, Number(limit || 10))]);

    return result.rows
      .map(row => ({
        artist: row.artist,
        title: row.title,
        album: row.album || undefined,
        durationSeconds: row.duration_seconds || undefined,
        releaseDate: row.release_date || undefined,
        sourcePopularityCount: row.popularity_count ? Number(row.popularity_count) : undefined,
        sourcePopularityText: row.popularity_text || undefined,
        contentOrigin: row.content_origin || 'unknown',
        availabilityPolicy: row.availability_policy || 'unknown',
        ...(row.source_data || {}),
        source: row.source_data?.source || 'melobot',
        rawText: row.source_data?.rawText || undefined,
        artistInferred: Boolean(row.source_data?.artistInferred)
          || inferredArtistFromFeaturedTitle(row.artist, row.title),
      }))
      .filter(track => !track.artistInferred);
  }

  async searchAlbums(query, limit = 4) {
    const allTokens = deepNormalize(query).split(' ').filter(Boolean);
    const albumWords = new Set([
      'album', 'albums',
      'آلبوم', 'آلبومها', 'آلبومهای',
      'البوم', 'البومها', 'البومهای',
    ]);
    const hasAlbumIntent = allTokens.some(token => albumWords.has(token));
    const tokens = allTokens.filter(token =>
      token.length >= 2
      && !albumWords.has(token)
      && !(hasAlbumIntent && ['ها','های'].includes(token))
    );
    if (!tokens.length) return [];

    const clauses = tokens.map((_, index) =>
      "LOWER(artist || ' ' || title) LIKE $" + (index + 1)
    );
    const params = tokens.map(token => `%${token}%`);
    params.push(Math.max(1, Number(limit || 4)));
    const limitParam = '$' + params.length;

    const result = await db.query(`
      SELECT album_key, artist, title, track_count, metadata, updated_at
      FROM deep_albums
      WHERE ${clauses.join(' AND ')}
      ORDER BY updated_at DESC
      LIMIT ${limitParam}
    `, params);

    return result.rows
      .filter(row =>
        row.metadata?.verifiedAlbum === true
        && Number(row.metadata?.albumTrustVersion || 0) >= 2
      )
      .map(row => ({
        albumKey: row.album_key,
        artist: row.artist,
        title: row.title,
        trackCount: row.track_count || undefined,
        rawText: row.metadata?.rawText || undefined,
        verifiedAlbum: Boolean(row.metadata?.verifiedAlbum),
        albumTrustVersion: Number(row.metadata?.albumTrustVersion || 0) || undefined,
        source: 'catalog',
      }));
  }

  async getAlbumTracksByKey(albumKey) {
    if (!albumKey) return [];
    const result = await db.query(`
      SELECT t.*, dat.position, da.artist AS album_artist
      FROM deep_album_tracks dat
      JOIN deep_tracks t ON t.track_key = dat.track_key
      JOIN deep_albums da ON da.album_key = dat.album_key
      WHERE dat.album_key = $1
        AND da.metadata @> '{"trackListVersion":1}'::jsonb
      ORDER BY dat.position ASC NULLS LAST
    `, [albumKey]);
    const tracks = result.rows.map(row => ({
      artist: row.artist,
      title: row.title,
      album: row.album || undefined,
      durationSeconds: row.duration_seconds || undefined,
      sourcePopularityCount: row.popularity_count ? Number(row.popularity_count) : undefined,
      sourcePopularityText: row.popularity_text || undefined,
      contentOrigin: row.content_origin || 'unknown',
      availabilityPolicy: row.availability_policy || 'unknown',
      ...(row.source_data || {}),
      source: row.source_data?.source || 'melobot',
      rawText: row.source_data?.rawText || undefined,
      _albumArtist: row.album_artist,
    }));

    if (
      tracks.some(track =>
        !trackBelongsToArtistContext(track, track._albumArtist || '')
      )
    ) {
      return [];
    }

    return tracks.map(({ _albumArtist, ...track }) => track);
  }

  async completeTaskByKey(taskKey, summary = {}) {
    if (!taskKey) return;
    await db.query(`
      UPDATE crawl_tasks
      SET status = 'done',
          completed_at = COALESCE(completed_at, NOW()),
          updated_at = NOW(),
          last_error = NULL,
          result = result || $2::jsonb
      WHERE task_key = $1 AND status <> 'running'
    `, [taskKey, safeJson(summary)]);
  }

  async missingMediaTracks(tracks = [], quality = 'hq') {
    const keyed = (tracks || [])
      .map(track => ({ track, key: deepTrackKey(track) }))
      .filter(item => item.key && item.key !== '|');
    if (!keyed.length) return [];

    const keys = keyed.map(item => item.key);
    const result = await db.query(`
      SELECT m.track_key
      FROM deep_track_media m
      WHERE m.quality = $1
        AND m.verified_quality = TRUE
        AND m.source LIKE $3
        AND m.track_key = ANY($2::text[])
        AND ${TRUSTED_RJ_DEEP_MEDIA_CLAUSE}
    `, [quality, keys, MEDIA_IDENTITY_SOURCE_PREFIX + '%']);
    const present = new Set(result.rows.map(row => row.track_key));
    return keyed.filter(item => !present.has(item.key)).map(item => item.track);
  }

  async compactQueue() {
    // MeloBot is a single stateful source lane. Background media warming used
    // to occupy that lane for 4-25 seconds and could make a real user wait.
    // Retire old queued/running warmers on startup; user-triggered actions still
    // fetch and cache the same media on demand.
    await db.query(`
      UPDATE crawl_tasks
      SET status = 'done',
          completed_at = COALESCE(completed_at, NOW()),
          started_at = NULL,
          updated_at = NOW(),
          last_error = NULL,
          result = result || '{"suspendedBy":"interactive-lane-policy-v164"}'::jsonb
      WHERE status IN ('queued','running')
        AND kind = ANY($1::text[])
    `, [SUSPENDED_BACKGROUND_MEDIA_TASK_KINDS]);

    await db.query(`
      UPDATE crawl_tasks legacy
      SET status = 'done',
          completed_at = COALESCE(completed_at, NOW()),
          updated_at = NOW(),
          result = legacy.result || '{"supersededBy":"track_enrich"}'::jsonb
      WHERE legacy.status = 'queued'
        AND legacy.kind IN ('track_metadata','track_cover','track_lyrics')
        AND EXISTS (
          SELECT 1
          FROM crawl_tasks bundle
          WHERE bundle.task_key =
            'track_enrich:' || substring(legacy.task_key from position(':' in legacy.task_key) + 1)
            AND bundle.status IN ('queued','running','done')
        )
    `);

    // Recurring bucketed tasks have new keys on future runs, so old completed
    // rows can be removed without losing one-time completion memory.
    await db.query(`
      DELETE FROM crawl_tasks
      WHERE status = 'done'
        AND kind IN ('feed','home_discovery','playlist_discovery','artist_profile','artist_bulk_media')
        AND completed_at < NOW() - INTERVAL '21 days'
    `);
  }

  async enqueueTask(kind, payload = {}, {
    priority = 50,
    delayMs = 0,
    taskKey = null,
    reviveDone = false,
  } = {}) {
    const key = taskKey || `${kind}:${payload.trackKey || payload.artist || payload.feed || JSON.stringify(payload)}`;
    const availableAt = new Date(Date.now() + Math.max(0, delayMs));
    await db.query(`
      INSERT INTO crawl_tasks (task_key, kind, payload, priority, status, available_at)
      VALUES ($1,$2,$3::jsonb,$4,'queued',$5)
      ON CONFLICT (task_key) DO UPDATE SET
        payload = EXCLUDED.payload,
        priority = GREATEST(crawl_tasks.priority, EXCLUDED.priority),
        available_at = LEAST(crawl_tasks.available_at, EXCLUDED.available_at),
        status = CASE
          WHEN crawl_tasks.status IN ('failed','queued') THEN 'queued'
          WHEN $6::boolean AND crawl_tasks.status = 'done' THEN 'queued'
          ELSE crawl_tasks.status
        END,
        attempts = CASE
          WHEN crawl_tasks.status = 'failed' THEN 0
          WHEN $6::boolean AND crawl_tasks.status = 'done' THEN 0
          ELSE crawl_tasks.attempts
        END,
        started_at = CASE
          WHEN crawl_tasks.status = 'failed' OR ($6::boolean AND crawl_tasks.status = 'done') THEN NULL
          ELSE crawl_tasks.started_at
        END,
        completed_at = CASE
          WHEN crawl_tasks.status = 'failed' OR ($6::boolean AND crawl_tasks.status = 'done') THEN NULL
          ELSE crawl_tasks.completed_at
        END,
        last_error = CASE
          WHEN crawl_tasks.status = 'failed' OR ($6::boolean AND crawl_tasks.status = 'done') THEN NULL
          ELSE crawl_tasks.last_error
        END,
        updated_at = NOW()
      WHERE crawl_tasks.status <> 'done' OR $6::boolean
    `, [key, kind, safeJson(payload), priority, availableAt, reviveDone]);
    return key;
  }

  async seedTrackTasks(track, {
    priority = 70,
    preferBulk = false,
    includeMedia = true,
    includeEnrichment = true,
  } = {}) {
    const trackKey = await this.upsertTrack(track);
    if (!trackKey) return;

    // Deep source tasks require a live MeloBot button reference. Ahangify
    // tracks are enriched/downloaded on demand through their own command.
    const canUseMeloBot = Boolean(track?.rawText) && track?.source !== 'ahangify';
    if (!canUseMeloBot) return;

    const payload = { track: { ...track, trackKey, source: track.source || 'melobot' }, trackKey };

    // Background discovery can explicitly opt out of source-backed enrichment.
    // Interactive actions remain the authoritative path for warming media and
    // track capabilities so crawler work never monopolizes MeloBot.
    if (includeEnrichment) {
      await this.enqueueTask('track_enrich', payload, {
        priority: priority + 5,
        taskKey: `track_enrich:${trackKey}`,
      });
    }

    if (includeMedia && !preferBulk) {
      // For user-selected/standalone tracks, warm files individually.
      // Feed/artist/album tracks wait for native bulk first; sparse misses are
      // enqueued later only when bulk cannot efficiently fill them.
      await this.enqueueTask('track_hq', payload, {
        priority: priority + 20,
        taskKey: `track_hq:${trackKey}`,
      });
      // Normal-quality media is intentionally no longer warmed in the
      // background. Existing normal file_ids/media rows are preserved and the
      // legacy task kind remains understood for compatibility with old rows.
    }
  }

  async claimNextTask() {
    const client = await db.connect();
    try {
      await client.query('BEGIN');
      await client.query(`
        UPDATE crawl_tasks
        SET status = 'queued',
            available_at = NOW(),
            last_error = COALESCE(last_error, 'recovered stale running task'),
            updated_at = NOW()
        WHERE status = 'running' AND started_at < NOW() - INTERVAL '15 minutes'
      `);
      const result = await client.query(`
        SELECT id, task_key, kind, payload, priority, attempts
        FROM crawl_tasks
        WHERE status = 'queued' AND available_at <= NOW()
        ORDER BY
          (
            priority +
            LEAST(
              60,
              FLOOR(EXTRACT(EPOCH FROM (NOW() - available_at)) / 600)::int
            )
          ) DESC,
          available_at ASC,
          id ASC
        FOR UPDATE SKIP LOCKED
        LIMIT 1
      `);
      if (!result.rowCount) {
        await client.query('COMMIT');
        return null;
      }
      const task = result.rows[0];
      await client.query(`
        UPDATE crawl_tasks
        SET status = 'running', attempts = attempts + 1, started_at = NOW(), updated_at = NOW()
        WHERE id = $1
      `, [task.id]);
      await client.query('COMMIT');
      return task;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  async finishTask(id, summary = {}) {
    await db.query(`
      UPDATE crawl_tasks
      SET status = 'done', completed_at = NOW(), updated_at = NOW(),
          last_error = NULL, result = $2::jsonb
      WHERE id = $1
    `, [id, safeJson(summary)]);
  }

  async deferTask(id, delayMs = 5 * 60 * 1000, reason = 'deferred') {
    await db.query(`
      UPDATE crawl_tasks
      SET status = 'queued',
          available_at = NOW() + ($2 * INTERVAL '1 millisecond'),
          started_at = NULL,
          attempts = GREATEST(0, attempts - 1),
          last_error = $3,
          updated_at = NOW()
      WHERE id = $1
    `, [
      id,
      Math.max(0, Number(delayMs || 0)),
      String(reason || 'deferred').slice(0, 1000),
    ]);
  }

  async failTask(id, error, { retryDelayMs = 6 * 60 * 60 * 1000, maxAttempts = 4 } = {}) {
    const result = await db.query('SELECT attempts FROM crawl_tasks WHERE id = $1', [id]);
    const attempts = Number(result.rows[0]?.attempts || 0);
    const terminal = attempts >= maxAttempts;
    await db.query(`
      UPDATE crawl_tasks
      SET status = $2,
          available_at = CASE WHEN $2 = 'queued' THEN NOW() + ($3 * INTERVAL '1 millisecond') ELSE available_at END,
          last_error = $4,
          updated_at = NOW()
      WHERE id = $1
    `, [
      id,
      terminal ? 'failed' : 'queued',
      Math.max(0, retryDelayMs),
      String(error || 'unknown error').slice(0, 1000),
    ]);
  }

  async enqueueFeedSweep() {
    const feeds = [
      { feed: '/new', priority: 130, everyMs: 20 * 60 * 1000, origin: 'unknown' },
      { feed: '/topday', priority: 126, everyMs: 45 * 60 * 1000, origin: 'unknown' },
      { feed: '/foreign', priority: 116, everyMs: 2 * 60 * 60 * 1000, origin: 'foreign' },
      { feed: '/topweek', priority: 108, everyMs: 6 * 60 * 60 * 1000, origin: 'unknown' },
      { feed: '/turkish', priority: 102, everyMs: 8 * 60 * 60 * 1000, origin: 'foreign' },
      { feed: '/arabic', priority: 102, everyMs: 8 * 60 * 60 * 1000, origin: 'foreign' },
    ];
    const now = Date.now();
    await Promise.all(feeds.map(item => {
      const bucket = Math.floor(now / item.everyMs);
      return this.enqueueTask('feed', item, {
        priority: item.priority,
        taskKey: `feed:${item.feed}:${bucket}`,
      });
    }));

    const homeEveryMs = 12 * 60 * 60 * 1000;
    const homeBucket = Math.floor(now / homeEveryMs);
    await this.enqueueTask('home_discovery', { maxSections: 8 }, {
      priority: 94,
      taskKey: `home_discovery:${homeBucket}`,
    });

    const playlistEveryMs = 24 * 60 * 60 * 1000;
    const playlistBucket = Math.floor(now / playlistEveryMs);
    await this.enqueueTask('playlist_discovery', { maxPlaylists: 6 }, {
      priority: 92,
      taskKey: `playlist_discovery:${playlistBucket}`,
    });
  }

  async stats() {
    const [tracks, media, tasks, albums, lists] = await Promise.all([
      db.query(`
        SELECT COUNT(*)::bigint AS tracks,
          COUNT(*) FILTER (WHERE lyrics_text IS NOT NULL AND lyrics_text <> '')::bigint AS lyrics,
          COUNT(*) FILTER (WHERE cover_file_id IS NOT NULL)::bigint AS covers,
          COUNT(*) FILTER (WHERE release_date IS NOT NULL OR release_date_raw IS NOT NULL)::bigint AS release_dates
        FROM deep_tracks
      `),
      db.query(`
        SELECT
          COUNT(*) FILTER (WHERE verified_quality = TRUE)::bigint AS media,
          COUNT(*) FILTER (WHERE quality = 'hq' AND verified_quality = TRUE)::bigint AS hq,
          COUNT(*) FILTER (WHERE quality = 'normal' AND verified_quality = TRUE)::bigint AS normal,
          COUNT(*) FILTER (WHERE verified_quality = FALSE)::bigint AS unverified
        FROM deep_track_media
      `),
      db.query(`
        SELECT
          COUNT(*) FILTER (WHERE status = 'queued')::bigint AS queued,
          COUNT(*) FILTER (WHERE status = 'running')::bigint AS running,
          COUNT(*) FILTER (WHERE status = 'done')::bigint AS done,
          COUNT(*) FILTER (WHERE status = 'failed')::bigint AS failed
        FROM crawl_tasks
      `),
      db.query('SELECT COUNT(*)::bigint AS albums FROM deep_albums'),
      db.query(`
        SELECT
          COUNT(*) FILTER (WHERE list_type = 'recent' AND list_version >= 1)::bigint AS recent_rows,
          COUNT(*) FILTER (WHERE list_type = 'top' AND list_version >= 1)::bigint AS top_rows,
          COUNT(*) FILTER (WHERE list_version = 0)::bigint AS legacy_rows
        FROM deep_artist_tracks
      `),
    ]);
    const num = row => Object.fromEntries(Object.entries(row).map(([k,v]) => [k, /^\d+$/.test(String(v)) ? Number(v) : v]));
    return {
      tracks: num(tracks.rows[0]),
      media: num(media.rows[0]),
      tasks: num(tasks.rows[0]),
      albums: num(albums.rows[0]),
      artistLists: num(lists.rows[0]),
    };
  }
}
