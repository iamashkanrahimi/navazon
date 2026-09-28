import { config } from './config.js';

const ORIGINS = new Set(['iranian', 'foreign', 'unknown']);
const POLICIES = new Set(['global', 'iran_only', 'unknown']);
const REASONS = new Set(['copyright', 'regional', 'source_policy', 'unknown', 'none']);

function enumValue(value, allowed, fallback) {
  const v = String(value || '').trim().toLowerCase();
  return allowed.has(v) ? v : fallback;
}

export function applyPolicyDefaults(track = {}) {
  const contentOrigin = enumValue(track.contentOrigin, ORIGINS, 'unknown');

  let availabilityPolicy = enumValue(track.availabilityPolicy, POLICIES, 'unknown');
  if (availabilityPolicy === 'unknown') {
    if (contentOrigin === 'foreign') {
      availabilityPolicy = config.foreignDefaultPolicy === 'global' ? 'global' : 'iran_only';
    } else if (contentOrigin === 'iranian') {
      availabilityPolicy = 'global';
    }
  }

  return {
    ...track,
    contentOrigin,
    availabilityPolicy,
    restrictionSource: track.restrictionSource || 'none',
    restrictionReason: enumValue(track.restrictionReason, REASONS, 'none'),
    availabilityUpdatedAt: track.availabilityUpdatedAt || null,
  };
}

export function mergeAvailability(track = {}, patch = {}) {
  return applyPolicyDefaults({
    ...track,
    ...patch,
    availabilityUpdatedAt: patch.availabilityUpdatedAt || new Date().toISOString(),
  });
}

export function canDeliverTrack(track = {}, userRegion = 'unknown') {
  const item = applyPolicyDefaults(track);

  if (!config.regionEnforcementEnabled) {
    return { allowed: true, reason: 'enforcement_disabled', track: item };
  }

  if (item.availabilityPolicy !== 'iran_only') {
    return { allowed: true, reason: 'not_region_restricted', track: item };
  }

  if (String(userRegion || '').toUpperCase() === 'IR') {
    return { allowed: true, reason: 'iran_verified', track: item };
  }

  return { allowed: false, reason: 'iran_only', track: item };
}
