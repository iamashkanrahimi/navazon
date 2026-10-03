export const BULK_INDIVIDUAL_RECOVERY_LIMIT = 3;

export function planBulkIndividualRecovery(tracks = [], limit = BULK_INDIVIDUAL_RECOVERY_LIMIT) {
  const source = Array.isArray(tracks) ? tracks : [];
  const cap = Math.max(0, Math.floor(Number(limit || 0)));
  const attempt = source.slice(0, cap);
  return {
    attempt,
    skipped: Math.max(0, source.length - attempt.length),
  };
}
