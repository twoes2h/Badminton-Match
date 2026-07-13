const crypto = require('crypto');
const config = require('../config');
const { query, transaction } = require('../db');

function sessionHash(sessionId) {
  return crypto.createHash('sha256').update(String(sessionId || '')).digest('hex');
}

function onlineLimit() {
  return Math.max(1, Number(config.maxOnlineUsers || 100));
}

function staleMinutes() {
  return Math.max(1, Math.min(240, Number(config.onlineSessionTtlMinutes || 15)));
}

function canLoginByCapacity({ role, activeUsers, userAlreadyActive, limit }) {
  if (role === 'admin') return true;
  if (userAlreadyActive) return true;
  return Number(activeUsers || 0) < Math.max(1, Number(limit || 1));
}

async function cleanupStaleSessions(conn) {
  await conn.query(
    `DELETE FROM active_sessions
     WHERE last_seen_at < DATE_SUB(NOW(), INTERVAL ${staleMinutes()} MINUTE)`
  );
}

async function loginCapacity(user) {
  return transaction(async (conn) => {
    await cleanupStaleSessions(conn);
    const activeRows = await conn.query(
      `SELECT COUNT(DISTINCT user_id) AS count_value
       FROM active_sessions
       WHERE user_role <> 'admin'`
    );
    const existingRows = await conn.query(
      `SELECT 1
       FROM active_sessions
       WHERE user_id = ?
       LIMIT 1`,
      [user.id]
    );
    const activeUsers = Number(activeRows[0].count_value || 0);
    const limit = onlineLimit();
    const userAlreadyActive = Boolean(existingRows[0]);
    return {
      ok: canLoginByCapacity({
        role: user.role,
        activeUsers,
        userAlreadyActive,
        limit
      }),
      activeUsers,
      limit,
      userAlreadyActive
    };
  });
}

async function touchActiveSession(sessionId, user) {
  if (!sessionId || !user || !user.id) return;
  await query(
    `INSERT INTO active_sessions
       (session_id_hash, user_id, user_role, created_at, last_seen_at)
     VALUES (?, ?, ?, NOW(), NOW())
     ON DUPLICATE KEY UPDATE
       user_id = VALUES(user_id),
       user_role = VALUES(user_role),
       last_seen_at = NOW()`,
    [
      sessionHash(sessionId),
      user.id,
      user.role === 'admin' ? 'admin' : 'user'
    ]
  );
}

async function removeActiveSession(sessionId) {
  if (!sessionId) return;
  await query(
    'DELETE FROM active_sessions WHERE session_id_hash = ?',
    [sessionHash(sessionId)]
  );
}

async function removeUserActiveSessions(userId) {
  if (!userId) return 0;
  const result = await query(
    'DELETE FROM active_sessions WHERE user_id = ?',
    [userId]
  );
  return Number(result.affectedRows || 0);
}

async function onlineSnapshot() {
  return transaction(async (conn) => {
    await cleanupStaleSessions(conn);
    const rows = await conn.query(
      `SELECT
         COUNT(*) AS session_count,
         COUNT(DISTINCT user_id) AS active_users,
         COUNT(DISTINCT CASE WHEN user_role <> 'admin' THEN user_id END) AS limited_active_users
       FROM active_sessions`
    );
    const row = rows[0] || {};
    return {
      sessionCount: Number(row.session_count || 0),
      activeUsers: Number(row.active_users || 0),
      limitedActiveUsers: Number(row.limited_active_users || 0),
      limit: onlineLimit(),
      ttlMinutes: staleMinutes()
    };
  });
}

module.exports = {
  canLoginByCapacity,
  cleanupStaleSessions,
  loginCapacity,
  onlineSnapshot,
  removeActiveSession,
  removeUserActiveSessions,
  sessionHash,
  touchActiveSession
};
