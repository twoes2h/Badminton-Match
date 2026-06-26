const express = require('express');
const { query, transaction } = require('../db');
const { asyncRoute, requireAuth, requireAdmin } = require('../middleware');
const { emitRoomChanged } = require('../realtime');

const router = express.Router();
const ADMIN_MEMBER_STATUSES = new Set(['idle', 'waiting', 'resting', 'busy', 'locked']);

router.use(requireAuth, requireAdmin);

async function dissolveRoom(conn, roomId) {
  await conn.query("UPDATE rooms SET status = 'dissolved' WHERE id = ?", [roomId]);
  await conn.query(
    `UPDATE matches
     SET status = 'cancelled',
         ended_at = COALESCE(ended_at, NOW())
     WHERE room_id = ?
       AND status IN ('active','awaiting_result')`,
    [roomId]
  );
  await conn.query(
    `UPDATE room_members
     SET presence_status = 'offline',
         play_status = 'idle',
         current_match_id = NULL
     WHERE room_id = ?`,
    [roomId]
  );
}

router.get('/users', asyncRoute(async (req, res) => {
  const users = await query(
    `SELECT
       id, username, display_name, gender, birth_year, rating, skill_level,
       role, is_blacklisted, matches_played, last_seen_at, created_at
     FROM users
     ORDER BY created_at DESC
     LIMIT 200`
  );
  res.json({ users });
}));

router.patch('/users/:userId', asyncRoute(async (req, res) => {
  const userId = Number(req.params.userId);
  const fields = {};

  if (req.body.displayName !== undefined) fields.display_name = String(req.body.displayName).trim();
  if (req.body.gender !== undefined && ['male', 'female', 'other'].includes(req.body.gender)) fields.gender = req.body.gender;
  if (req.body.birthYear !== undefined) fields.birth_year = req.body.birthYear ? Number(req.body.birthYear) : null;
  if (req.body.skillLevel !== undefined) fields.skill_level = Math.max(1, Math.min(10, Number(req.body.skillLevel)));
  if (req.body.rating !== undefined) fields.rating = Math.max(0, Math.round(Number(req.body.rating)));
  if (req.body.role !== undefined && ['user', 'admin'].includes(req.body.role)) fields.role = req.body.role;
  if (req.body.isBlacklisted !== undefined) fields.is_blacklisted = req.body.isBlacklisted ? 1 : 0;

  if (Object.keys(fields).length === 0) {
    return res.status(400).json({ error: '没有可更新字段' });
  }

  await transaction(async (conn) => {
    const assignments = Object.keys(fields).map((field) => `${field} = ?`).join(', ');
    await conn.query(
      `UPDATE users SET ${assignments} WHERE id = ?`,
      [...Object.values(fields), userId]
    );

    if (fields.is_blacklisted === 1) {
      await conn.query(
        `UPDATE room_members
         SET presence_status = 'offline',
             play_status = 'locked',
             current_match_id = NULL
         WHERE user_id = ?`,
        [userId]
      );
    }
  });

  res.json({ ok: true });
}));

router.get('/rooms', asyncRoute(async (req, res) => {
  const status = ['active', 'dissolved'].includes(req.query.status) ? req.query.status : 'active';
  const rooms = await query(
    `SELECT
       r.*,
       COUNT(CASE WHEN rm.presence_status = 'online' THEN 1 END) AS online_count,
       COUNT(rm.id) AS member_count
     FROM rooms r
     LEFT JOIN room_members rm ON rm.room_id = r.id
     WHERE r.status = ?
     GROUP BY r.id
     ORDER BY r.created_at DESC
     LIMIT 200`,
    [status]
  );
  res.json({ rooms, status });
}));

router.patch('/rooms/:roomId', asyncRoute(async (req, res) => {
  const roomId = Number(req.params.roomId);
  const fields = {};
  if (req.body.name !== undefined) fields.name = String(req.body.name).trim();
  if (req.body.courtCount !== undefined) fields.court_count = Math.max(1, Math.min(20, Number(req.body.courtCount)));
  if (req.body.maxPeople !== undefined) fields.max_people = Math.max(2, Math.min(200, Number(req.body.maxPeople)));
  if (req.body.mode !== undefined) {
    return res.status(400).json({ error: '房间模式只能在创建时选择，不能修改' });
  }
  if (req.body.status !== undefined) {
    if (req.body.status !== 'dissolved') {
      return res.status(400).json({ error: '已解散房间不能恢复为当前房间' });
    }
    fields.status = 'dissolved';
  }

  if (Object.keys(fields).length === 0) {
    return res.status(400).json({ error: '没有可更新字段' });
  }

  const assignments = Object.keys(fields).map((field) => `${field} = ?`).join(', ');
  await transaction(async (conn) => {
    await conn.query(`UPDATE rooms SET ${assignments} WHERE id = ?`, [...Object.values(fields), roomId]);
    if (fields.status === 'dissolved') {
      await dissolveRoom(conn, roomId);
    }
  });
  await emitRoomChanged(req.app.get('io'), roomId);
  res.json({ ok: true });
}));

router.delete('/rooms/:roomId', asyncRoute(async (req, res) => {
  const roomId = Number(req.params.roomId);
  await transaction(async (conn) => {
    await dissolveRoom(conn, roomId);
  });
  await emitRoomChanged(req.app.get('io'), roomId);
  res.json({ ok: true });
}));

router.patch('/rooms/:roomId/members/:userId', asyncRoute(async (req, res) => {
  const roomId = Number(req.params.roomId);
  const userId = Number(req.params.userId);
  const playStatus = req.body.playStatus;
  if (!ADMIN_MEMBER_STATUSES.has(playStatus)) {
    return res.status(400).json({ error: '不支持的状态' });
  }

  await query(
    `UPDATE room_members
     SET play_status = ?,
         current_match_id = CASE WHEN ? IN ('idle','waiting','resting','busy','locked') THEN NULL ELSE current_match_id END
     WHERE room_id = ?
       AND user_id = ?`,
    [playStatus, playStatus, roomId, userId]
  );
  await emitRoomChanged(req.app.get('io'), roomId);
  res.json({ ok: true });
}));

module.exports = router;
