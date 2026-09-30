import pg from 'pg';
import { config } from './config.js';

const { Pool } = pg;
let archiveDb = null;

export function getArchiveDb() {
  if (!config.archiveDatabaseUrl) return null;
  if (!archiveDb) {
    archiveDb = new Pool({
      connectionString: config.archiveDatabaseUrl,
      max: 2,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 15_000,
      keepAlive: true,
    });
    archiveDb.on('error', err => console.error('[archive postgres pool]', err.message));
  }
  return archiveDb;
}

export async function closeArchiveDb() {
  if (!archiveDb) return;
  const pool = archiveDb;
  archiveDb = null;
  await pool.end();
}
