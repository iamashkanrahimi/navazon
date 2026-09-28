import { db } from './db.js';

export class SessionStore {
  constructor() {
    this.memory = new Map();
    this.lastDbCleanupAt = 0;
    this.dbCleanupIntervalMs = 300000;
  }

  async get(id) {
    const local = this.memory.get(id);
    if (local && local.expiresAt > Date.now()) return local;
    const result = await db.query(
      'SELECT data, expires_at FROM sessions WHERE session_id = $1 AND expires_at > NOW()',
      [id]
    );
    if (!result.rowCount) {
      this.memory.delete(id);
      return null;
    }
    const session = result.rows[0].data;
    session.expiresAt = new Date(result.rows[0].expires_at).getTime();
    this.memory.set(id, session);
    return session;
  }

  async set(id, session) {
    if (!session) return;
    this.memory.set(id, session);
    await db.query(`
      INSERT INTO sessions (session_id, user_id, chat_id, data, expires_at)
      VALUES ($1, $2, $3, $4::jsonb, TO_TIMESTAMP($5 / 1000.0))
      ON CONFLICT (session_id) DO UPDATE SET
        user_id = EXCLUDED.user_id,
        chat_id = EXCLUDED.chat_id,
        data = EXCLUDED.data,
        expires_at = EXCLUDED.expires_at,
        updated_at = NOW()
    `, [id, String(session.userId), String(session.chatId), JSON.stringify(session), session.expiresAt]);
  }

  async delete(id) {
    this.memory.delete(id);
    await db.query('DELETE FROM sessions WHERE session_id = $1', [id]);
  }

  async cleanup() {
    const now = Date.now();
    for (const [id, session] of this.memory) {
      if (!session || session.expiresAt <= now) this.memory.delete(id);
    }
    if (now - this.lastDbCleanupAt < this.dbCleanupIntervalMs) return;
    this.lastDbCleanupAt = now;
    await db.query('DELETE FROM sessions WHERE expires_at <= NOW()');
  }
}
