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

  melobotUsername: (process.env.MELOBOT_USERNAME || 'melobot').replace(/^@/, ''),
  ahangifyUsername: (process.env.AHANGIFY_USERNAME || 'ahangifybot').replace(/^@/, ''),
  brandCaption: process.env.BRAND_CAPTION || `@${required('BOT_USERNAME').replace(/^@/, '')}`,

  catalogSearchTtlMs: Number(process.env.CATALOG_SEARCH_TTL_MINUTES || 15) * 60 * 1000,
  catalogArtistTtlMs: Number(process.env.CATALOG_ARTIST_TTL_HOURS || 72) * 60 * 60 * 1000,
  catalogAlbumsTtlMs: Number(process.env.CATALOG_ALBUMS_TTL_HOURS || 168) * 60 * 60 * 1000,
  catalogAlbumTracksTtlMs: Number(process.env.CATALOG_ALBUM_TRACKS_TTL_HOURS || 720) * 60 * 60 * 1000,

  foreignDefaultPolicy: (process.env.FOREIGN_DEFAULT_POLICY || 'iran_only').trim(),
  regionEnforcementEnabled: boolEnv('REGION_ENFORCEMENT_ENABLED', false),
  searchTimeoutMs: Number(process.env.SEARCH_TIMEOUT_MS || 18000),
  downloadTimeoutMs: Number(process.env.DOWNLOAD_TIMEOUT_MS || 90000),

  discoveryEnabled: boolEnv('DISCOVERY_ENABLED', true),
  discoveryIdleMs: Number(process.env.DISCOVERY_IDLE_MINUTES || 2) * 60 * 1000,
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
