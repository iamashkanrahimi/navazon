import 'dotenv/config';

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

function boolEnv(name, fallback = false) {
  const raw = process.env[name];
  if (raw == null || raw === '') return fallback;
  return /^(1|true|yes|on)$/i.test(raw);
}

export const config = {
  port: Number(process.env.PORT || 10000),
  publicBaseUrl: (process.env.RENDER_EXTERNAL_URL || process.env.PUBLIC_BASE_URL || '').replace(/\/$/, ''),

  botToken: required('BOT_TOKEN'),
  botUsername: required('BOT_USERNAME').replace(/^@/, ''),
  apiId: Number(required('TG_API_ID')),
  apiHash: required('TG_API_HASH'),
  stringSession: required('TG_STRING_SESSION'),
  proxyUserId: Number(required('PROXY_USER_ID')),

  databaseUrl: required('DATABASE_URL'),
  webhookSecret: required('WEBHOOK_SECRET'),
  crawlerToken: required('CRAWLER_TOKEN'),
  adminToken: required('ADMIN_TOKEN'),

  archiveDatabaseUrl: (process.env.ARCHIVE_DATABASE_URL || '').trim(),
  archiveImportBaseUrl: (process.env.ARCHIVE_IMPORT_BASE_URL || '').replace(/\/$/, ''),
  archiveImportOnce: boolEnv('ARCHIVE_IMPORT_ONCE', false),

  mediaCacheEnabled: boolEnv('MEDIA_CACHE_ENABLED', false),
  mediaCacheRecoveryEnabled: boolEnv('MEDIA_CACHE_RECOVERY_ENABLED', false),
  mediaCacheChatId: (process.env.MEDIA_CACHE_CHAT_ID || '').trim(),
  mediaCacheDelayMs: Math.max(2000, Number(process.env.MEDIA_CACHE_DELAY_MS || 2000)),

  rjAudioCacheEnabled: boolEnv('RJ_AUDIO_CACHE_ENABLED', false),
  rjMtprotoPilotEnabled: boolEnv('RJ_MTPROTO_PILOT_ENABLED', false),
  rjMtprotoChannelPilotEnabled: boolEnv('RJ_MTPROTO_CHANNEL_PILOT_ENABLED', false),
  rjMtprotoChannelWorkerEnabled: boolEnv('RJ_MTPROTO_CHANNEL_WORKER_ENABLED', false),
  rjMtprotoChannelStartGapMs: Math.max(
    1100,
    Number(process.env.RJ_MTPROTO_CHANNEL_START_GAP_MS || 1500)
  ),
  rjMtprotoChannelMinGapMs: Math.max(
    1100,
    Number(process.env.RJ_MTPROTO_CHANNEL_MIN_GAP_MS || 1100)
  ),
  rjMtprotoChannelMaxGapMs: Math.max(
    1500,
    Number(process.env.RJ_MTPROTO_CHANNEL_MAX_GAP_MS || 5000)
  ),
  rjMtprotoChannelConcurrency: Math.max(
    1,
    Math.min(3, Number(process.env.RJ_MTPROTO_CHANNEL_CONCURRENCY || 2))
  ),
  rjAudioCacheDelayMs: Math.max(900, Number(process.env.RJ_AUDIO_CACHE_DELAY_MS || 1100)),
  rjAudioCacheConcurrency: Math.max(
    1,
    Math.min(12, Number(process.env.RJ_AUDIO_CACHE_CONCURRENCY || 8))
  ),
  rjAudioCacheSendIntervalMs: Math.max(
    1000,
    Number(process.env.RJ_AUDIO_CACHE_SEND_INTERVAL_MS || 1100)
  ),
  rjAudioCacheMaxAttempts: Math.max(
    1,
    Math.min(3, Number(process.env.RJ_AUDIO_CACHE_MAX_ATTEMPTS || 2))
  ),

  melobotUsername: (process.env.MELOBOT_USERNAME || 'melobot').replace(/^@/, ''),
  melobotArchivePilotEnabled: boolEnv('MELOBOT_ARCHIVE_PILOT_ENABLED', false),
  melobotArchivePilotCount: Math.max(1, Math.min(12500, Number(process.env.MELOBOT_ARCHIVE_PILOT_COUNT || 50))),
  ahangifyUsername: (process.env.AHANGIFY_USERNAME || 'ahangifybot').replace(/^@/, ''),
  ahangifyBestPilotEnabled: boolEnv('AHANGIFY_BEST_PILOT_ENABLED', false),
  ahangifyBestPilotCount: Math.max(1, Math.min(50, Number(process.env.AHANGIFY_BEST_PILOT_COUNT || 50))),
  ahangifyArchiveEnabled: boolEnv('AHANGIFY_ARCHIVE_ENABLED', false),
  ahangifyArchiveBatchSize: Math.max(
    1,
    Math.min(100, Number(process.env.AHANGIFY_ARCHIVE_BATCH_SIZE || 24))
  ),
  ahangifyArchiveMaxAttempts: Math.max(
    1,
    Math.min(5, Number(process.env.AHANGIFY_ARCHIVE_MAX_ATTEMPTS || 2))
  ),
  ahangifyArchivePumpMs: Math.max(
    5000,
    Number(process.env.AHANGIFY_ARCHIVE_PUMP_SECONDS || 15) * 1000
  ),
  brandCaption: process.env.BRAND_CAPTION || `@${required('BOT_USERNAME').replace(/^@/, '')}`,

  catalogSearchTtlMs: Number(process.env.CATALOG_SEARCH_TTL_MINUTES || 15) * 60 * 1000,
  catalogArtistTtlMs: Number(process.env.CATALOG_ARTIST_TTL_HOURS || 72) * 60 * 60 * 1000,
  catalogAlbumsTtlMs: Number(process.env.CATALOG_ALBUMS_TTL_HOURS || 168) * 60 * 60 * 1000,
  catalogEmptyAlbumsTtlMs: Number(process.env.CATALOG_EMPTY_ALBUMS_TTL_HOURS || 72) * 60 * 60 * 1000,
  catalogAlbumTracksTtlMs: Number(process.env.CATALOG_ALBUM_TRACKS_TTL_HOURS || 720) * 60 * 60 * 1000,

  foreignDefaultPolicy: (process.env.FOREIGN_DEFAULT_POLICY || 'iran_only').trim(),
  regionEnforcementEnabled: boolEnv('REGION_ENFORCEMENT_ENABLED', false),
  searchTimeoutMs: Number(process.env.SEARCH_TIMEOUT_MS || 18000),
  downloadTimeoutMs: Number(process.env.DOWNLOAD_TIMEOUT_MS || 90000),

  discoveryEnabled: boolEnv('DISCOVERY_ENABLED', true),
  discoverySchedulerMs: Math.max(
    30_000,
    Number(process.env.DISCOVERY_SCHEDULER_SECONDS || 120) * 1000
  ),
  discoveryIdleMs: Number(process.env.DISCOVERY_IDLE_MINUTES || 8) * 60 * 1000,
  discoveryHeavyIdleMs: Number(process.env.DISCOVERY_HEAVY_IDLE_MINUTES || 25) * 60 * 1000,
  discoveryArtistMinAgeMs: Number(process.env.DISCOVERY_ARTIST_MIN_AGE_HOURS || 168) * 60 * 60 * 1000,
  discoveryAlbumsPerRun: Math.max(0, Number(process.env.DISCOVERY_ALBUMS_PER_RUN || 1)),
  discoveryContinueDelayMs: Number(process.env.DISCOVERY_CONTINUE_MINUTES || 2) * 60 * 1000,
  discoveryRetryDelayMs: Number(process.env.DISCOVERY_RETRY_HOURS || 6) * 60 * 60 * 1000,
  discoveryUseAhangify: boolEnv('DISCOVERY_USE_AHANGIFY', true),
  discoveryWarmTopTracks: Math.max(0, Number(process.env.DISCOVERY_WARM_TOP_TRACKS || 0)),
};

if (!Number.isFinite(config.apiId)) throw new Error('TG_API_ID must be a number');
if (!Number.isFinite(config.proxyUserId)) throw new Error('PROXY_USER_ID must be a number');
if (!Number.isFinite(config.port)) throw new Error('PORT must be a number');
