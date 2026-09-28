import { db } from './db.js';

function clean(value = '') {
  return String(value).replace(/\s+/g, ' ').trim();
}

function normalize(value = '') {
  return clean(value)
    .toLocaleLowerCase('en-US')
    .replace(/[\u200e\u200f\u202a-\u202e]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export class FollowStore {
  async load() {}

  async isFollowing(userId, artist) {
    const key = normalize(artist);
    if (!key) return false;
    const result = await db.query(
      'SELECT 1 FROM follows WHERE user_id = $1 AND artist_key = $2 LIMIT 1',
      [String(userId), key]
    );
    return Boolean(result.rowCount);
  }

  async toggle(userId, artist) {
    const key = normalize(artist);
    if (!key) return false;

    const result = await db.query(`
      WITH deleted AS (
        DELETE FROM follows
        WHERE user_id = $1 AND artist_key = $2
        RETURNING 1
      ),
      inserted AS (
        INSERT INTO follows (user_id, artist_key, artist_name)
        SELECT $1, $2, $3
        WHERE NOT EXISTS (SELECT 1 FROM deleted)
        ON CONFLICT (user_id, artist_key) DO NOTHING
        RETURNING 1
      )
      SELECT EXISTS(SELECT 1 FROM inserted) AS following
    `, [String(userId), key, clean(artist)]);

    return Boolean(result.rows[0]?.following);
  }

  async listForUser(userId, limit = 20) {
    const result = await db.query(
      `SELECT artist_key, artist_name, followed_at
       FROM follows
       WHERE user_id = $1
       ORDER BY followed_at DESC
       LIMIT $2`,
      [String(userId), Math.max(1, Number(limit || 20))]
    );
    return result.rows;
  }

  async followersOf(artist) {
    const key = normalize(artist);
    if (!key) return [];
    const result = await db.query('SELECT user_id FROM follows WHERE artist_key = $1', [key]);
    return result.rows.map(row => Number(row.user_id)).filter(Number.isFinite);
  }
}
