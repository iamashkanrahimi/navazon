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
    const existing = await this.isFollowing(userId, artist);
    if (existing) {
      await db.query('DELETE FROM follows WHERE user_id = $1 AND artist_key = $2', [String(userId), key]);
      return false;
    }
    await db.query(`
      INSERT INTO follows (user_id, artist_key, artist_name)
      VALUES ($1, $2, $3)
      ON CONFLICT (user_id, artist_key) DO NOTHING
    `, [String(userId), key, clean(artist)]);
    return true;
  }

  async followersOf(artist) {
    const key = normalize(artist);
    if (!key) return [];
    const result = await db.query('SELECT user_id FROM follows WHERE artist_key = $1', [key]);
    return result.rows.map(row => Number(row.user_id)).filter(Number.isFinite);
  }
}
