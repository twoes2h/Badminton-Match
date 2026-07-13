const express = require('express');
const bcrypt = require('bcryptjs');
const { query, transaction } = require('../db');
const { asyncRoute, requireAuth } = require('../middleware');
const { MATCH_TYPES, createFreeMatch, createRoundMatches } = require('../services/matching');
const { markMatchAwaitingResult, submitMatchResult } = require('../services/results');
const { emitRoomChanged } = require('../realtime');

const router = express.Router();
const MEMBER_STATUSES = new Set(['idle', 'waiting', 'resting', 'busy']);
const MATCH_PREFS = new Set(['md', 'wd', 'xd', 'ms', 'ws', 'xs', 'any']);
const MATCH_TYPE_ORDER = ['md', 'wd', 'xd', 'ms', 'ws', 'xs'];
const TEMP_MEMBER_DEFAULT_PASSWORD = '000000';
const USERNAME_PATTERN = /^[a-zA-Z0-9_\u4e00-\u9fa5-]{3,32}$/;

function sqlPlaceholders(values) {
  return values.map(() => '?').join(',');
}

function normalizeUserIds(value) {
  const values = Array.isArray(value)
    ? value
    : typeof value === 'string'
      ? value.split(',')
      : [];
  return [...new Set(values.map((item) => Number(item)).filter((item) => Number.isInteger(item) && item > 0))];
}

function normalizeMatchPreferences(value) {
  const values = Array.isArray(value)
    ? value
    : typeof value === 'string'
      ? value.split(',')
      : [];
  const cleaned = [...new Set(values.map((item) => String(item).trim()).filter(Boolean))]
    .filter((item) => MATCH_PREFS.has(item));

  if (cleaned.length === 0 || cleaned.includes('any')) {
    return ['any'];
  }

  return cleaned.filter((item) => item !== 'any');
}

function preferencesToDb(value) {
  return normalizeMatchPreferences(value).join(',');
}

function legacyPreference(value) {
  return normalizeMatchPreferences(value)[0] || 'any';
}

function normalizeMatchTypes(value) {
  const values = Array.isArray(value)
    ? value
    : typeof value === 'string'
      ? value.split(',')
      : [];
  const cleaned = [...new Set(values.map((item) => String(item).trim()).filter(Boolean))]
    .filter((item) => item === 'any' || MATCH_TYPES[item]);

  if (cleaned.includes('any')) {
    return MATCH_TYPE_ORDER;
  }

  return cleaned.filter((item) => MATCH_TYPES[item]);
}

function normalizeMatchDate(value) {
  const text = String(value || '').trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : null;
}

function makeRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 6; i += 1) {
    code += chars[Math.floor(Math.random() * chars.length)];
  }
  return code;
}

function makeTemporaryUsername(roomId) {
  const suffix = Math.random().toString(36).slice(2, 8);
  return `tmp${roomId}_${suffix}`;
}

function normalizeTemporaryMemberInput(body) {
  const displayName = String(body.displayName || '').trim();
  const username = String(body.username || '').trim();
  const gender = body.gender || 'other';
  const birthYear = body.birthYear ? Number(body.birthYear) : null;
  const skillLevel = Number(body.skillLevel || 5);
  const rating = body.rating === undefined || body.rating === ''
    ? 1000
    : Math.max(0, Math.min(3000, Math.round(Number(body.rating))));

  if (!displayName || displayName.length > 80) {
    throw new Error('成员昵称不能为空且不能超过 80 个字符');
  }
  if (username && !USERNAME_PATTERN.test(username)) {
    throw new Error('用户名需为 3-32 位，可包含中文、字母、数字、下划线或短横线');
  }
  if (!['male', 'female', 'other'].includes(gender)) {
    throw new Error('性别参数不正确');
  }
  if (birthYear !== null) {
    const currentYear = new Date().getFullYear();
    if (birthYear < 1930 || birthYear > currentYear) {
      throw new Error('出生年份不正确');
    }
  }
  if (skillLevel < 1 || skillLevel > 10) {
    throw new Error('技术等级需在 1-10 之间');
  }

  return { displayName, username, gender, birthYear, skillLevel, rating };
}

async function findActiveRoomForUser(conn, userId) {
  const rows = await conn.query(
    `SELECT r.id, r.name, r.code, r.owner_user_id, rm.presence_status, rm.play_status
     FROM room_members rm
     JOIN rooms r ON r.id = rm.room_id
     WHERE rm.user_id = ?
       AND r.status = 'active'
       AND (
         rm.presence_status = 'online'
         OR rm.play_status IN ('in_match','awaiting_result','locked')
         OR (r.owner_user_id = ? AND r.venue_id IS NULL)
       )
     ORDER BY r.created_at DESC
     LIMIT 1`,
    [userId, userId]
  );
  return rows[0] || null;
}

async function assertMember(conn, roomId, userId) {
  const rows = await conn.query(
    'SELECT * FROM room_members WHERE room_id = ? AND user_id = ? LIMIT 1',
    [roomId, userId]
  );
  if (!rows[0]) throw new Error('你还没有加入该房间');
  return rows[0];
}

async function assertActiveRoom(conn, roomId) {
  const rows = await conn.query('SELECT * FROM rooms WHERE id = ? LIMIT 1', [roomId]);
  const room = rows[0];
  if (!room || room.status !== 'active') throw new Error('房间不存在或已解散');
  return room;
}

async function assertVenueUserAvailability(conn, { userIds, venue, excludeRoomId = 0 }) {
  if (!venue || userIds.length === 0) return;
  const rows = await conn.query(
    `SELECT
       rm.user_id,
       u.display_name,
       r.name AS room_name
     FROM room_members rm
     JOIN rooms r ON r.id = rm.room_id
     JOIN venues v ON v.id = r.venue_id
     JOIN users u ON u.id = rm.user_id
     WHERE r.status = 'active'
       AND r.venue_id IS NOT NULL
       AND r.id <> ?
       AND rm.user_id IN (${sqlPlaceholders(userIds)})
       AND v.starts_at < ?
       AND v.ends_at > ?
     LIMIT 6`,
    [excludeRoomId, ...userIds, venue.ends_at, venue.starts_at]
  );
  if (rows.length) {
    const names = rows.map((row) => row.display_name || row.user_id).join('、');
    throw new Error(`这些成员在同一时间段已报名其他场地：${names}`);
  }
}

async function registerVenueMembers(conn, roomId, userIds) {
  if (userIds.length === 0) return;
  for (const userId of userIds) {
    await conn.query(
      `INSERT INTO room_members
        (room_id, user_id, presence_status, play_status, last_seen_at)
       VALUES (?, ?, 'offline', 'idle', NULL)
       ON DUPLICATE KEY UPDATE
         play_status = CASE
           WHEN play_status IN ('in_match','awaiting_result','locked') THEN play_status
           ELSE play_status
         END`,
      [roomId, userId]
    );
  }
}

async function assertVenueMatchStarted(conn, room) {
  if (!room.venue_id) return;
  const rows = await conn.query(
    `SELECT
       starts_at,
       CASE WHEN starts_at <= NOW() THEN 1 ELSE 0 END AS started
     FROM venues
     WHERE id = ?
     LIMIT 1`,
    [room.venue_id]
  );
  const venue = rows[0];
  if (!venue || Number(venue.started) !== 1) {
    throw new Error('场地时间开始后才能发起匹配');
  }
}

async function assertMatchRequester(conn, room, user) {
  if (Number(room.owner_user_id) === Number(user.id) || user.role === 'admin') return;
  await assertMember(conn, room.id, user.id);
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

async function getRoomPayload(roomId, userId, options = {}) {
  const matchDate = normalizeMatchDate(options.matchDate);
  const roomRows = await query('SELECT * FROM rooms WHERE id = ? LIMIT 1', [roomId]);
  const room = roomRows[0];
  if (!room || room.status !== 'active') throw new Error('房间不存在或已解散');
  const venueRows = room.venue_id
    ? await query(
      `SELECT id, name, court_count, starts_at, ends_at, location_url, status
       FROM venues
       WHERE id = ?
       LIMIT 1`,
      [room.venue_id]
    )
    : [];
  const venue = venueRows[0] || null;

  const members = await query(
    `SELECT
       rm.*,
       u.username,
       u.display_name,
       u.avatar_url,
       u.gender,
       u.birth_year,
       u.rating,
       u.skill_level,
       u.role,
       u.account_type,
       u.temporary_expires_at,
       u.is_blacklisted
     FROM room_members rm
     JOIN users u ON u.id = rm.user_id
     WHERE rm.room_id = ?
     ORDER BY rm.presence_status DESC, rm.play_status, u.rating DESC`,
    [roomId]
  );
  const currentMember = members.find((member) => Number(member.user_id) === Number(userId)) || null;
  if (room.venue_id && !currentMember && Number(room.owner_user_id) !== Number(userId)) {
    const requesterRows = await query('SELECT role FROM users WHERE id = ? LIMIT 1', [userId]);
    if (!requesterRows[0] || requesterRows[0].role !== 'admin') {
      throw new Error('你不在这个场地房间的报名名单中');
    }
  }
  const matchParams = [roomId];
  let matchWhere = 'room_id = ?';
  let matchLimit = 100;
  if (matchDate) {
    matchWhere += ' AND started_at >= ? AND started_at < DATE_ADD(?, INTERVAL 1 DAY)';
    matchParams.push(matchDate, matchDate);
    matchLimit = 200;
  } else {
    matchWhere += " AND (status IN ('active','awaiting_result') OR started_at >= DATE_SUB(NOW(), INTERVAL 30 DAY))";
  }
  const matches = await query(
    `SELECT *
     FROM matches
     WHERE ${matchWhere}
     ORDER BY started_at DESC
     LIMIT ${matchLimit}`,
    matchParams
  );
  const matchIds = matches.map((match) => Number(match.id));
  const players = matchIds.length
    ? await query(
      `SELECT
         mp.*,
         u.display_name,
         u.avatar_url,
         u.gender,
         u.rating,
         u.account_type,
         mr.outcome,
         mr.verdict,
         mr.score_red,
         mr.score_blue
       FROM match_players mp
       JOIN users u ON u.id = mp.user_id
       LEFT JOIN match_results mr
         ON mr.match_id = mp.match_id
        AND mr.user_id = mp.user_id
       WHERE mp.match_id IN (${matchIds.map(() => '?').join(',')})
       ORDER BY mp.match_id DESC, mp.team, mp.id`,
      matchIds
    )
    : [];

  const playersByMatch = new Map();
  for (const player of players) {
    const list = playersByMatch.get(Number(player.match_id)) || [];
    list.push(player);
    playersByMatch.set(Number(player.match_id), list);
  }

  return {
    room: { ...room, venue },
    venue,
    member: currentMember,
    members,
    matches: matches.map((match) => ({
      ...match,
      label: MATCH_TYPES[match.match_type] && MATCH_TYPES[match.match_type].label,
      players: playersByMatch.get(Number(match.id)) || []
    })),
    matchDate,
    matchTypes: MATCH_TYPES
  };
}

router.get('/', requireAuth, asyncRoute(async (req, res) => {
  const term = String(req.query.q || '').trim();
  const params = [];
  let where = "WHERE r.status = 'active'";
  if (req.session.user.role !== 'admin') {
    where += ` AND (
      r.venue_id IS NULL
      OR EXISTS (
        SELECT 1
        FROM room_members visible_rm
        WHERE visible_rm.room_id = r.id
          AND visible_rm.user_id = ?
      )
    )`;
    params.push(req.session.user.id);
  }
  if (term) {
    where += ' AND (r.code LIKE ? OR r.name LIKE ?)';
    params.push(`%${term}%`, `%${term}%`);
  }
  const rooms = await query(
    `SELECT
       r.id,
       r.code,
       r.name,
       r.sport_key,
       r.venue_id,
       r.mode,
       r.court_count,
       r.max_people,
       r.created_at,
       v.name AS venue_name,
       v.starts_at AS venue_starts_at,
       v.ends_at AS venue_ends_at,
       v.location_url AS venue_location_url,
       COUNT(CASE WHEN rm.presence_status = 'online' THEN 1 END) AS online_count
     FROM rooms r
     LEFT JOIN venues v ON v.id = r.venue_id
     LEFT JOIN room_members rm ON rm.room_id = r.id
     ${where}
     GROUP BY r.id
     ORDER BY r.created_at DESC
     LIMIT 50`,
    params
  );
  res.json({ rooms });
}));

router.get('/create-options', requireAuth, asyncRoute(async (req, res) => {
  if (req.session.user.role !== 'admin') {
    return res.json({ venues: [], users: [] });
  }

  const [venues, users] = await Promise.all([
    query(
      `SELECT
         v.id,
         v.name,
         v.court_count,
         v.starts_at,
         v.ends_at,
         v.location_url
       FROM venues v
       WHERE v.status = 'active'
         AND NOT EXISTS (
           SELECT 1
           FROM rooms r
           WHERE r.venue_id = v.id
         )
       ORDER BY v.starts_at ASC
       LIMIT 100`
    ),
    query(
      `SELECT
         id, username, display_name, avatar_url, gender, rating, skill_level, account_type
       FROM users
       WHERE is_blacklisted = 0
       ORDER BY display_name ASC, username ASC
       LIMIT 500`
    )
  ]);

  res.json({ venues, users });
}));

router.post('/', requireAuth, asyncRoute(async (req, res) => {
  const courtCount = Math.max(1, Math.min(20, Number(req.body.courtCount || 1)));
  const maxPeople = Math.max(2, Math.min(200, Number(req.body.maxPeople || 30)));
  const mode = req.body.mode === 'round' ? 'round' : 'free';
  const sportKey = String(req.body.sportKey || 'badminton').trim() || 'badminton';
  const venueId = Number(req.body.venueId || 0);
  const registeredUserIds = normalizeUserIds(req.body.registeredUserIds);
  const password = String(req.body.password || '');
  const passwordHash = password ? await bcrypt.hash(password, 12) : null;

  const room = await transaction(async (conn) => {
    let venue = null;
    if (venueId) {
      if (req.session.user.role !== 'admin') {
        throw new Error('只有管理员可以创建场地房间');
      }
      const venueRows = await conn.query(
        `SELECT *
         FROM venues
         WHERE id = ?
           AND status = 'active'
         LIMIT 1
         FOR UPDATE`,
        [venueId]
      );
      venue = venueRows[0];
      if (!venue) throw new Error('场地不存在或已停用');
      const usedRows = await conn.query(
        `SELECT id
         FROM rooms
         WHERE venue_id = ?
         LIMIT 1`,
        [venueId]
      );
      if (usedRows[0]) throw new Error('这个场地已经创建了房间');
      await assertVenueUserAvailability(conn, { userIds: registeredUserIds, venue });
    } else {
      const activeRoom = await findActiveRoomForUser(conn, req.session.user.id);
      if (activeRoom) {
        throw new Error(`你已经在房间 ${activeRoom.name} 中，请先离开或解散该房间`);
      }
    }

    let code;
    let result;
    for (let attempt = 0; attempt < 5; attempt += 1) {
      code = makeRoomCode();
      try {
        result = await conn.query(
          `INSERT INTO rooms
            (code, name, sport_key, venue_id, mode, password_hash, court_count, max_people, owner_user_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            code,
            String(req.body.name || (venue ? `${venue.name}-${code}` : `羽球房-${code}`)).trim(),
            sportKey,
            venue ? venue.id : null,
            mode,
            passwordHash,
            venue ? venue.court_count : courtCount,
            maxPeople,
            req.session.user.id
          ]
        );
        break;
      } catch (error) {
        if (!String(error.message).includes('Duplicate')) throw error;
      }
    }
    if (!result) throw new Error('房间号生成失败，请重试');

    if (venue) {
      await registerVenueMembers(conn, result.insertId, registeredUserIds);
    } else {
      await conn.query(
        `INSERT INTO room_members
          (room_id, user_id, presence_status, play_status, last_seen_at)
         VALUES (?, ?, 'online', 'idle', NOW())`,
        [result.insertId, req.session.user.id]
      );
    }
    const rows = await conn.query('SELECT * FROM rooms WHERE id = ? LIMIT 1', [result.insertId]);
    return rows[0];
  });

  res.status(201).json({ room });
}));

router.post('/:roomId/join', requireAuth, asyncRoute(async (req, res) => {
  const roomId = Number(req.params.roomId);
  const password = String(req.body.password || '');

  const room = await transaction(async (conn) => {
    const found = await assertActiveRoom(conn, roomId);
    if (found.password_hash && !(await bcrypt.compare(password, found.password_hash))) {
      throw new Error('房间密码错误');
    }

    const activeRoom = await findActiveRoomForUser(conn, req.session.user.id);
    if (activeRoom && Number(activeRoom.id) !== roomId) {
      throw new Error(`你已经在房间 ${activeRoom.name} 中，一个人只能同时进入一个房间`);
    }

    const existingRows = await conn.query(
      'SELECT * FROM room_members WHERE room_id = ? AND user_id = ? LIMIT 1',
      [roomId, req.session.user.id]
    );
    if (found.venue_id && !existingRows[0]) {
      throw new Error('你不在这个场地房间的报名名单中');
    }
    const onlineRows = await conn.query(
      `SELECT COUNT(*) AS count_value
       FROM room_members
       WHERE room_id = ?
         AND presence_status = 'online'`,
      [roomId]
    );
    const alreadyOnline = existingRows[0] && existingRows[0].presence_status === 'online';
    if (!alreadyOnline && Number(onlineRows[0].count_value) >= Number(found.max_people)) {
      throw new Error('房间在线人数已满');
    }

    await conn.query(
      `INSERT INTO room_members
        (room_id, user_id, presence_status, play_status, last_seen_at)
       VALUES (?, ?, 'online', 'idle', NOW())
       ON DUPLICATE KEY UPDATE
         presence_status = 'online',
         last_seen_at = NOW(),
         play_status = CASE
           WHEN play_status IN ('in_match','awaiting_result','locked') THEN play_status
           ELSE 'idle'
         END`,
      [roomId, req.session.user.id]
    );
    return found;
  });

  await emitRoomChanged(req.app.get('io'), roomId);
  res.json({ room });
}));

router.post('/:roomId/temporary-members', requireAuth, asyncRoute(async (req, res) => {
  const roomId = Number(req.params.roomId);
  const input = normalizeTemporaryMemberInput(req.body);
  const passwordHash = await bcrypt.hash(TEMP_MEMBER_DEFAULT_PASSWORD, 12);

  const created = await transaction(async (conn) => {
    const room = await assertActiveRoom(conn, roomId);
    if (Number(room.owner_user_id) !== Number(req.session.user.id) && req.session.user.role !== 'admin') {
      throw new Error('只有房主或管理员可以添加临时成员');
    }

    const onlineRows = await conn.query(
      `SELECT COUNT(*) AS count_value
       FROM room_members
       WHERE room_id = ?
         AND presence_status = 'online'`,
      [roomId]
    );
    if (Number(onlineRows[0].count_value) >= Number(room.max_people)) {
      throw new Error('房间在线人数已满，不能继续添加成员');
    }

    let username = input.username;
    if (username) {
      const existing = await conn.query('SELECT id FROM users WHERE username = ? LIMIT 1', [username]);
      if (existing[0]) throw new Error('用户名已存在');
    } else {
      for (let attempt = 0; attempt < 8; attempt += 1) {
        const candidate = makeTemporaryUsername(roomId);
        const existing = await conn.query('SELECT id FROM users WHERE username = ? LIMIT 1', [candidate]);
        if (!existing[0]) {
          username = candidate;
          break;
        }
      }
      if (!username) throw new Error('临时用户名生成失败，请重试');
    }

    const result = await conn.query(
      `INSERT INTO users
        (username, password_hash, display_name, gender, birth_year, rating, skill_level,
         role, account_type, temporary_expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'user', 'temporary', DATE_ADD(NOW(), INTERVAL 1 MONTH))`,
      [
        username,
        passwordHash,
        input.displayName,
        input.gender,
        input.birthYear,
        input.rating,
        input.skillLevel
      ]
    );

    await conn.query(
      `INSERT INTO room_members
        (room_id, user_id, presence_status, play_status, last_seen_at)
       VALUES (?, ?, 'online', 'idle', NOW())`,
      [roomId, result.insertId]
    );
    const rows = await conn.query(
      `SELECT id, username, display_name, gender, birth_year, rating, skill_level,
              account_type, temporary_expires_at
       FROM users
       WHERE id = ?
       LIMIT 1`,
      [result.insertId]
    );
    return rows[0];
  });

  await emitRoomChanged(req.app.get('io'), roomId);
  res.status(201).json({ user: created, defaultPassword: TEMP_MEMBER_DEFAULT_PASSWORD });
}));

router.post('/:roomId/registrations', requireAuth, asyncRoute(async (req, res) => {
  const roomId = Number(req.params.roomId);
  const userIds = normalizeUserIds(req.body.userIds);
  if (!userIds.length) {
    return res.status(400).json({ error: '请选择报名成员' });
  }

  await transaction(async (conn) => {
    const room = await assertActiveRoom(conn, roomId);
    if (!room.venue_id) throw new Error('只有场地房间需要报名名单');
    if (Number(room.owner_user_id) !== Number(req.session.user.id) && req.session.user.role !== 'admin') {
      throw new Error('只有房主或管理员可以管理报名名单');
    }

    const venueRows = await conn.query('SELECT * FROM venues WHERE id = ? LIMIT 1', [room.venue_id]);
    const venue = venueRows[0];
    if (!venue) throw new Error('场地不存在');
    await assertVenueUserAvailability(conn, { userIds, venue, excludeRoomId: roomId });
    await registerVenueMembers(conn, roomId, userIds);
  });

  await emitRoomChanged(req.app.get('io'), roomId);
  res.status(201).json({ ok: true });
}));

router.delete('/:roomId/registrations/:userId', requireAuth, asyncRoute(async (req, res) => {
  const roomId = Number(req.params.roomId);
  const userId = Number(req.params.userId);

  await transaction(async (conn) => {
    const room = await assertActiveRoom(conn, roomId);
    if (!room.venue_id) throw new Error('只有场地房间需要报名名单');
    if (Number(room.owner_user_id) !== Number(req.session.user.id) && req.session.user.role !== 'admin') {
      throw new Error('只有房主或管理员可以管理报名名单');
    }
    const rows = await conn.query(
      `SELECT play_status, current_match_id
       FROM room_members
       WHERE room_id = ?
         AND user_id = ?
       LIMIT 1`,
      [roomId, userId]
    );
    if (!rows[0]) return;
    if (rows[0].current_match_id || ['in_match', 'awaiting_result', 'locked'].includes(rows[0].play_status)) {
      throw new Error('成员正在比赛或等待结果，不能移出报名名单');
    }
    await conn.query(
      `DELETE FROM room_members
       WHERE room_id = ?
         AND user_id = ?`,
      [roomId, userId]
    );
  });

  await emitRoomChanged(req.app.get('io'), roomId);
  res.json({ ok: true });
}));

router.get('/:roomId', requireAuth, asyncRoute(async (req, res) => {
  const payload = await getRoomPayload(Number(req.params.roomId), req.session.user.id, {
    matchDate: req.query.matchDate
  });
  res.json(payload);
}));

router.post('/:roomId/leave', requireAuth, asyncRoute(async (req, res) => {
  const roomId = Number(req.params.roomId);
  await transaction(async (conn) => {
    const room = await assertActiveRoom(conn, roomId);
    if (Number(room.owner_user_id) === Number(req.session.user.id)) {
      throw new Error('房间创建者不能离开自己的房间，请直接解散房间');
    }
    const member = await assertMember(conn, roomId, req.session.user.id);
    if (member.current_match_id) {
      await markMatchAwaitingResult(conn, member.current_match_id);
      await conn.query(
        `UPDATE room_members
         SET presence_status = 'offline',
             play_status = 'awaiting_result'
         WHERE room_id = ?
           AND user_id = ?`,
        [roomId, req.session.user.id]
      );
    } else {
      await conn.query(
        `UPDATE room_members
         SET presence_status = 'offline',
             play_status = 'idle',
             current_match_id = NULL
         WHERE room_id = ?
           AND user_id = ?`,
        [roomId, req.session.user.id]
      );
    }
  });

  await emitRoomChanged(req.app.get('io'), roomId);
  res.json({ ok: true });
}));

router.delete('/:roomId', requireAuth, asyncRoute(async (req, res) => {
  const roomId = Number(req.params.roomId);
  await transaction(async (conn) => {
    const room = await assertActiveRoom(conn, roomId);
    if (Number(room.owner_user_id) !== Number(req.session.user.id) && req.session.user.role !== 'admin') {
      throw new Error('只有房间创建者或管理员可以解散房间');
    }
    await dissolveRoom(conn, roomId);
  });

  await emitRoomChanged(req.app.get('io'), roomId);
  res.json({ ok: true });
}));

router.patch('/:roomId/my-state', requireAuth, asyncRoute(async (req, res) => {
  const roomId = Number(req.params.roomId);
  const playStatus = req.body.playStatus;
  const hasPreferenceInput = Object.prototype.hasOwnProperty.call(req.body, 'matchPreferences')
    || Object.prototype.hasOwnProperty.call(req.body, 'matchPreference');
  const rawPreferences = hasPreferenceInput ? (req.body.matchPreferences ?? req.body.matchPreference) : null;
  const rawPreferenceValues = Array.isArray(rawPreferences)
    ? rawPreferences
    : typeof rawPreferences === 'string'
      ? rawPreferences.split(',')
      : [];
  const matchPreferences = hasPreferenceInput ? preferencesToDb(rawPreferences) : null;
  const matchPreference = hasPreferenceInput ? legacyPreference(rawPreferences) : null;

  if (playStatus && !MEMBER_STATUSES.has(playStatus)) {
    return res.status(400).json({ error: '不支持的状态' });
  }
  if (hasPreferenceInput && rawPreferenceValues.some((item) => {
    const value = String(item).trim();
    return value && !MATCH_PREFS.has(value);
  })) {
    return res.status(400).json({ error: '不支持的匹配偏好' });
  }

  await transaction(async (conn) => {
    await assertActiveRoom(conn, roomId);
    const member = await assertMember(conn, roomId, req.session.user.id);
    if (['in_match', 'awaiting_result', 'locked'].includes(member.play_status)) {
      throw new Error('当前状态不能自行切换，请先完成比赛结果或联系管理员');
    }

    await conn.query(
      `UPDATE room_members
       SET play_status = COALESCE(?, play_status),
           match_preference = COALESCE(?, match_preference),
           match_preferences = COALESCE(?, match_preferences),
           last_seen_at = NOW()
       WHERE room_id = ?
         AND user_id = ?`,
      [playStatus || null, matchPreference, matchPreferences, roomId, req.session.user.id]
    );
  });

  await emitRoomChanged(req.app.get('io'), roomId);
  res.json({ ok: true });
}));

router.post('/:roomId/match/free', requireAuth, asyncRoute(async (req, res) => {
  const roomId = Number(req.params.roomId);
  const matchTypes = normalizeMatchTypes(req.body.matchTypes ?? req.body.matchType);
  if (matchTypes.length === 0) {
    return res.status(400).json({ error: '不支持的匹配方式' });
  }
  await transaction(async (conn) => {
    const room = await assertActiveRoom(conn, roomId);
    if (room.mode !== 'free') {
      throw new Error('这个房间是固定场次模式，不能发起自由匹配');
    }
    await assertVenueMatchStarted(conn, room);
    await assertMatchRequester(conn, room, req.session.user);
  });
  const match = await createFreeMatch({ roomId, matchType: matchTypes, createdBy: req.session.user.id });
  await emitRoomChanged(req.app.get('io'), roomId);
  res.status(201).json({ match });
}));

router.post('/:roomId/match/round', requireAuth, asyncRoute(async (req, res) => {
  const roomId = Number(req.params.roomId);
  const courtModes = Array.isArray(req.body.courtModes) ? req.body.courtModes : [];
  await transaction(async (conn) => {
    const room = await assertActiveRoom(conn, roomId);
    if (room.mode !== 'round') {
      throw new Error('这个房间是自由匹配模式，不能发起固定场次匹配');
    }
    await assertVenueMatchStarted(conn, room);
    await assertMatchRequester(conn, room, req.session.user);
  });
  const result = await createRoundMatches({ roomId, courtModes, createdBy: req.session.user.id });
  await emitRoomChanged(req.app.get('io'), roomId);
  res.status(201).json(result);
}));

router.post('/matches/:matchId/finish', requireAuth, asyncRoute(async (req, res) => {
  const matchId = Number(req.params.matchId);
  const roomId = await transaction(async (conn) => {
    const rows = await conn.query(
      `SELECT
         m.room_id,
         r.owner_user_id,
         u.role AS requester_role,
         mp.user_id AS player_user_id,
         (
           SELECT COUNT(*)
           FROM match_players mp2
           JOIN users player_user ON player_user.id = mp2.user_id
           WHERE mp2.match_id = m.id
             AND player_user.account_type <> 'temporary'
         ) AS real_player_count
       FROM matches m
       JOIN rooms r ON r.id = m.room_id
       JOIN users u ON u.id = ?
       LEFT JOIN match_players mp
         ON mp.match_id = m.id
        AND mp.user_id = ?
       WHERE m.id = ?
       LIMIT 1`,
      [req.session.user.id, req.session.user.id, matchId]
    );
    const row = rows[0];
    if (!row) throw new Error('比赛不存在');
    const isAuthority = Number(row.owner_user_id) === Number(req.session.user.id) || row.requester_role === 'admin';
    if (!row.player_user_id && (!isAuthority || Number(row.real_player_count) > 0)) {
      throw new Error('你不属于这场比赛');
    }
    await markMatchAwaitingResult(conn, matchId);
    return Number(row.room_id);
  });
  await emitRoomChanged(req.app.get('io'), roomId);
  res.json({ ok: true });
}));

router.post('/matches/:matchId/leave', requireAuth, asyncRoute(async (req, res) => {
  const matchId = Number(req.params.matchId);
  const roomId = await transaction(async (conn) => {
    const rows = await conn.query(
      `SELECT m.room_id
       FROM matches m
       JOIN match_players mp ON mp.match_id = m.id
       WHERE m.id = ?
         AND mp.user_id = ?
       LIMIT 1`,
      [matchId, req.session.user.id]
    );
    if (!rows[0]) throw new Error('你不属于这场比赛');
    await markMatchAwaitingResult(conn, matchId);
    return Number(rows[0].room_id);
  });
  await emitRoomChanged(req.app.get('io'), roomId);
  res.json({ ok: true });
}));

router.post('/matches/:matchId/results', requireAuth, asyncRoute(async (req, res) => {
  const matchId = Number(req.params.matchId);
  const result = await submitMatchResult({
    matchId,
    userId: req.session.user.id,
    outcome: req.body.outcome,
    verdict: req.body.verdict,
    winner: req.body.winner,
    scoreRed: req.body.scoreRed,
    scoreBlue: req.body.scoreBlue,
    note: req.body.note
  });
  const matchRows = await query('SELECT room_id FROM matches WHERE id = ? LIMIT 1', [matchId]);
  if (matchRows[0]) await emitRoomChanged(req.app.get('io'), matchRows[0].room_id);
  res.json(result);
}));

module.exports = router;
