const express = require('express');
const { query, transaction } = require('../db');
const { asyncRoute, requireAuth, requireAdmin } = require('../middleware');
const { emitRoomChanged } = require('../realtime');
const { markMatchAwaitingResult } = require('../services/results');
const { removeUserActiveSessions } = require('../services/online');
const { destroyUserSessions } = require('../services/sessions');
const {
  latestAnnouncement,
  normalizeAnnouncementInput,
  saveAnnouncement
} = require('../services/announcements');

const router = express.Router();
const ADMIN_MEMBER_STATUSES = new Set(['idle', 'waiting', 'resting', 'busy', 'locked']);

router.use(requireAuth, requireAdmin);

function normalizeDateTime(value, fieldName) {
  const raw = String(value || '').trim();
  const match = raw.match(/^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2})(?::(\d{2}))?$/);
  if (!match) throw new Error(`${fieldName}格式不正确`);
  return `${match[1]} ${match[2]}:${match[3] || '00'}`;
}

function dateTimeMs(value) {
  if (value instanceof Date) return value.getTime();
  return new Date(String(value).replace(' ', 'T')).getTime();
}

function normalizeVenueInput(body, partial = false) {
  const fields = {};
  if (!partial || body.name !== undefined) {
    const name = String(body.name || '').trim();
    if (!name || name.length > 120) throw new Error('场地名称不能为空且不能超过 120 个字符');
    fields.name = name;
  }
  if (!partial || body.courtCount !== undefined) {
    fields.court_count = Math.max(1, Math.min(20, Number(body.courtCount || 1)));
  }
  if (!partial || body.startsAt !== undefined) {
    fields.starts_at = normalizeDateTime(body.startsAt, '开始时间');
  }
  if (!partial || body.endsAt !== undefined) {
    fields.ends_at = normalizeDateTime(body.endsAt, '结束时间');
  }
  if (!partial || body.locationUrl !== undefined) {
    const locationUrl = String(body.locationUrl || '').trim();
    if (locationUrl.length > 500) throw new Error('位置链接不能超过 500 个字符');
    if (locationUrl) {
      let parsed;
      try {
        parsed = new URL(locationUrl);
      } catch {
        throw new Error('位置链接格式不正确');
      }
      if (!['http:', 'https:'].includes(parsed.protocol)) {
        throw new Error('位置链接必须是 http 或 https 地址');
      }
    }
    fields.location_url = locationUrl || null;
  }
  if (body.status !== undefined) {
    if (!['active', 'inactive'].includes(body.status)) throw new Error('场地状态不正确');
    fields.status = body.status;
  }
  if (fields.starts_at && fields.ends_at && dateTimeMs(fields.starts_at) >= dateTimeMs(fields.ends_at)) {
    throw new Error('结束时间必须晚于开始时间');
  }
  return fields;
}

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

async function forceUserOffline(conn, userId) {
  const memberRows = await conn.query(
    `SELECT DISTINCT room_id, current_match_id
     FROM room_members
     WHERE user_id = ?`,
    [userId]
  );
  const roomIds = [...new Set(memberRows.map((row) => Number(row.room_id)).filter(Boolean))];
  const matchIds = [...new Set(memberRows.map((row) => Number(row.current_match_id)).filter(Boolean))];

  for (const matchId of matchIds) {
    await markMatchAwaitingResult(conn, matchId);
  }

  await conn.query(
    `UPDATE room_members
     SET presence_status = 'offline',
         play_status = CASE
           WHEN current_match_id IS NULL THEN 'idle'
           ELSE 'awaiting_result'
         END
     WHERE user_id = ?`,
    [userId]
  );

  return roomIds;
}

router.get('/users', asyncRoute(async (req, res) => {
  const users = await query(
    `SELECT
       id, username, display_name, avatar_url, gender, birth_year, rating, skill_level,
       role, account_type, is_blacklisted, matches_played, last_seen_at, created_at
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
  if (Number(userId) === Number(req.session.user.id)) {
    if (fields.role && fields.role !== 'admin') {
      return res.status(400).json({ error: '不能取消自己的管理员权限' });
    }
    if (fields.is_blacklisted === 1) {
      return res.status(400).json({ error: '不能拉黑自己' });
    }
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

router.post('/users/:userId/force-logout', asyncRoute(async (req, res) => {
  const userId = Number(req.params.userId);
  if (!Number.isFinite(userId) || userId <= 0) {
    return res.status(400).json({ error: '用户不存在' });
  }
  if (Number(userId) === Number(req.session.user.id)) {
    return res.status(400).json({ error: '不能强制下线自己' });
  }

  const roomIds = await transaction(async (conn) => {
    const rows = await conn.query('SELECT id FROM users WHERE id = ? LIMIT 1', [userId]);
    if (!rows[0]) throw new Error('用户不存在');
    return forceUserOffline(conn, userId);
  });

  const destroyedSessions = await destroyUserSessions(req.app.get('sessionStore'), userId);
  const removedActiveSessions = await removeUserActiveSessions(userId);
  for (const roomId of roomIds) {
    await emitRoomChanged(req.app.get('io'), roomId);
  }

  res.json({
    ok: true,
    destroyedSessions,
    removedActiveSessions,
    roomIds
  });
}));

router.get('/announcement', asyncRoute(async (req, res) => {
  res.json({ announcement: await latestAnnouncement() });
}));

router.put('/announcement', asyncRoute(async (req, res) => {
  const announcement = await saveAnnouncement(req.body, req.session.user.id);
  res.json({ announcement });
}));

router.get('/venues', asyncRoute(async (req, res) => {
  const status = ['active', 'inactive'].includes(req.query.status) ? req.query.status : 'active';
  const venues = await query(
    `SELECT
       v.*,
       r.id AS active_room_id,
       r.name AS active_room_name,
       r.code AS active_room_code
     FROM venues v
     LEFT JOIN rooms r
       ON r.venue_id = v.id
      AND r.status = 'active'
     WHERE v.status = ?
     ORDER BY v.starts_at DESC, v.created_at DESC
     LIMIT 200`,
    [status]
  );
  res.json({ venues, status });
}));

router.post('/venues', asyncRoute(async (req, res) => {
  const fields = normalizeVenueInput(req.body);
  const result = await query(
    `INSERT INTO venues
      (name, court_count, starts_at, ends_at, location_url, status, created_by)
     VALUES (?, ?, ?, ?, ?, 'active', ?)`,
    [
      fields.name,
      fields.court_count,
      fields.starts_at,
      fields.ends_at,
      fields.location_url,
      req.session.user.id
    ]
  );
  const rows = await query('SELECT * FROM venues WHERE id = ? LIMIT 1', [result.insertId]);
  res.status(201).json({ venue: rows[0] });
}));

router.patch('/venues/:venueId', asyncRoute(async (req, res) => {
  const venueId = Number(req.params.venueId);
  const fields = normalizeVenueInput(req.body, true);

  if ((fields.starts_at && !fields.ends_at) || (!fields.starts_at && fields.ends_at)) {
    const rows = await query('SELECT starts_at, ends_at FROM venues WHERE id = ? LIMIT 1', [venueId]);
    if (!rows[0]) throw new Error('场地不存在');
    const startsAt = fields.starts_at || rows[0].starts_at;
    const endsAt = fields.ends_at || rows[0].ends_at;
    if (dateTimeMs(startsAt) >= dateTimeMs(endsAt)) throw new Error('结束时间必须晚于开始时间');
  }

  if (Object.keys(fields).length === 0) {
    return res.status(400).json({ error: '没有可更新字段' });
  }

  await transaction(async (conn) => {
    if (fields.status === 'inactive') {
      const roomRows = await conn.query(
        `SELECT id
         FROM rooms
         WHERE venue_id = ?
           AND status = 'active'
         LIMIT 1`,
        [venueId]
      );
      if (roomRows[0]) throw new Error('这个场地还有当前房间，不能停用');
    }
    const assignments = Object.keys(fields).map((field) => `${field} = ?`).join(', ');
    await conn.query(
      `UPDATE venues SET ${assignments} WHERE id = ?`,
      [...Object.values(fields), venueId]
    );
  });

  res.json({ ok: true });
}));

router.delete('/venues/:venueId', asyncRoute(async (req, res) => {
  const venueId = Number(req.params.venueId);
  await transaction(async (conn) => {
    const roomRows = await conn.query(
      `SELECT id
       FROM rooms
       WHERE venue_id = ?
         AND status = 'active'
       LIMIT 1`,
      [venueId]
    );
    if (roomRows[0]) throw new Error('这个场地还有当前房间，不能停用');
    await conn.query("UPDATE venues SET status = 'inactive' WHERE id = ?", [venueId]);
  });
  res.json({ ok: true });
}));

router.get('/rooms', asyncRoute(async (req, res) => {
  const status = ['active', 'dissolved'].includes(req.query.status) ? req.query.status : 'active';
  const orderBy = status === 'dissolved'
    ? 'r.updated_at DESC, r.created_at DESC'
    : 'r.created_at DESC';
  const rooms = await query(
    `SELECT
       r.*,
       v.name AS venue_name,
       v.starts_at AS venue_starts_at,
       v.ends_at AS venue_ends_at,
       v.location_url AS venue_location_url,
       COUNT(CASE WHEN rm.presence_status = 'online' THEN 1 END) AS online_count,
       COUNT(rm.id) AS member_count
     FROM rooms r
     LEFT JOIN venues v ON v.id = r.venue_id
     LEFT JOIN room_members rm ON rm.room_id = r.id
     WHERE r.status = ?
     GROUP BY r.id
     ORDER BY ${orderBy}
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
         match_pool_joined_at = CASE
           WHEN ? = 'waiting' THEN COALESCE(match_pool_joined_at, NOW())
           ELSE NULL
         END,
         current_match_id = CASE WHEN ? IN ('idle','waiting','resting','busy','locked') THEN NULL ELSE current_match_id END
     WHERE room_id = ?
       AND user_id = ?`,
    [playStatus, playStatus, playStatus, roomId, userId]
  );
  await emitRoomChanged(req.app.get('io'), roomId);
  res.json({ ok: true });
}));

router._test = {
  normalizeDateTime,
  normalizeVenueInput,
  normalizeAnnouncementInput,
  forceUserOffline
};

module.exports = router;
