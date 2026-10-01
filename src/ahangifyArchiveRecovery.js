export const AHANGIFY_ARCHIVE_STALE_RUNNING_MS = 5 * 60 * 1000;

export async function recoverStaleAhangifyArchiveJobs(
  db,
  { staleAfterMs = AHANGIFY_ARCHIVE_STALE_RUNNING_MS } = {}
) {
  if (!db?.query) throw new Error('Ahangify archive recovery requires a database client');

  const safeStaleAfterMs = Math.max(
    60_000,
    Number(staleAfterMs || AHANGIFY_ARCHIVE_STALE_RUNNING_MS)
  );

  const result = await db.query(`
    UPDATE ahangify_archive_media
       SET status='retry',
           attempts=GREATEST(attempts - 1, 0),
           next_attempt_at=NOW(),
           completed_at=NULL,
           last_error='recovered stale running archive job',
           updated_at=NOW()
     WHERE status='running'
       AND updated_at < NOW() - ($1::bigint * INTERVAL '1 millisecond')
  `, [Math.round(safeStaleAfterMs)]);

  return Number(result?.rowCount || 0);
}
