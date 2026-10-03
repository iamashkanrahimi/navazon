import {
  artistCreditCompatible,
  crossScriptIdentityCompatible,
  trackTitleIdentityCompatible,
} from './text.js';

function clean(value = '') {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

export function verifyRjTelegramAudio(row = {}, message = {}) {
  const audio = message?.audio || null;
  if (!audio?.file_id) {
    return {
      ok: false,
      reason: 'Telegram sendAudio returned no audio.file_id',
      audio: null,
    };
  }

  const expectedDuration = Number(row.expected_duration_seconds || 0) || null;
  const actualDuration = Number(audio.duration || 0) || null;
  const durationDelta = expectedDuration && actualDuration
    ? Math.abs(expectedDuration - actualDuration)
    : null;
  const durationOk = durationDelta == null || durationDelta <= 12;

  const title = clean(audio.title);
  const performer = clean(audio.performer);
  const titleOk = title
    ? trackTitleIdentityCompatible(row.title, title)
    : null;
  const artistOk = performer
    ? (
        artistCreditCompatible(row.artist, performer)
        || crossScriptIdentityCompatible(row.artist, performer)
      )
    : null;

  const textContradictions = [titleOk, artistOk].filter(value => value === false);
  const hasTextEvidence = titleOk === true || artistOk === true;
  const hasTightDurationEvidence = Boolean(
    expectedDuration
    && actualDuration
    && durationDelta != null
    && durationDelta <= 3
  );
  const hasIdentityEvidence = hasTextEvidence || hasTightDurationEvidence;
  const ok = durationOk
    && textContradictions.length === 0
    && hasIdentityEvidence;

  let reason = null;
  if (!durationOk) {
    reason = `duration mismatch: expected=${expectedDuration} actual=${actualDuration}`;
  } else if (titleOk === false && artistOk === false) {
    reason = 'embedded title and performer contradict Radio Javan identity';
  } else if (titleOk === false) {
    reason = 'embedded title contradicts Radio Javan identity';
  } else if (artistOk === false) {
    reason = 'embedded performer contradicts Radio Javan identity';
  } else if (!hasIdentityEvidence) {
    reason = 'insufficient Radio Javan identity evidence';
  }

  return {
    ok,
    reason,
    audio,
    expectedDuration,
    actualDuration,
    durationDelta,
    titleOk,
    artistOk,
  };
}
