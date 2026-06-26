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

function makeRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 6; i += 1) {
    code += chars[Math.floor(Math.random() * chars.length)];
  }
  return code;
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
         OR r.owner_user_id = ?
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

async function getRoomPayload(roomId, userId) {
  const roomRows = await query('SELECT * FROM rooms WHERE id = ? LIMIT 1', [roomId]);
  const room = roomRows[0];
  if (!room || room.status !== 'active') throw new Error('房间不存在或已解散');

  const members = await query(
    `SELECT
       rm.*,
       u.username,
       u.display_name,
       u.gender,
       u.birth_year,
       u.rating,
       u.skill_level,
       u.role,
       u.is_blacklisted
     FROM room_members rm
     JOIN users u ON u.id = rm.user_id
     WHERE rm.room_id = ?
     ORDER BY rm.presence_status DESC, rm.play_status, u.rating DESC`,
    [roomId]
  );
  const matches = await query(
    `SELECT *
     FROM matches
     WHERE room_id = ?
       AND (status IN ('active','awaiting_result') OR started_at >= DATE_SUB(NOW(), INTERVAL 30 DAY))
     ORDER BY started_at DESC
     LIMIT 100`,
    [roomId]
  );
  const matchIds = matches.map((match) => Number(match.id));
  const players = matchIds.length
    ? await query(
      `SELECT
         mp.*,
         u.display_name,
         u.gender,
         u.rating,
         mr.outcome,
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
    room,
    member: members.find((member) => Number(member.user_id) === Number(userId)) || null,
    members,
    matches: matches.map((match) => ({
      ...match,
      label: MATCH_TYPES[match.match_type] && MATCH_TYPES[match.match_type].label,
      players: playersByMatch.get(Number(match.id)) || []
    })),
    matchTypes: MATCH_TYPES
  };
}

router.get('/', requireAuth, asyncRoute(async (req, res) => {
  const term = String(req.query.q || '').trim();
  const params = [];
  let where = "WHERE r.status = 'active'";
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
       r.mode,
       r.court_count,
       r.max_people,
       r.created_at,
       COUNT(CASE WHEN rm.presence_status = 'online' THEN 1 END) AS online_count
     FROM rooms r
     LEFT JOIN room_members rm ON rm.room_id = r.id
     ${where}
     GROUP BY r.id
     ORDER BY r.created_at DESC
     LIMIT 50`,
    params
  );
  res.json({ rooms });
}));

router.post('/', requireAuth, asyncRoute(async (req, res) => {
  const courtCount = Math.max(1, Math.min(20, Number(req.body.courtCount || 1)));
  const maxPeople = Math.max(2, Math.min(200, Number(req.body.maxPeople || 30)));
  const mode = req.body.mode === 'round' ? 'round' : 'free';
  const sportKey = String(req.body.sportKey || 'badminton').trim() || 'badminton';
  const password = String(req.body.password || '');
  const passwordHash = password ? await bcrypt.hash(password, 12) : null;

  const room = await transaction(async (conn) => {
    const activeRoom = await findActiveRoomForUser(conn, req.session.user.id);
    if (activeRoom) {
      throw new Error(`你已经在房间 ${activeRoom.name} 中，请先离开或解散该房间`);
    }

    let code;
    let result;
    for (let attempt = 0; attempt < 5; attempt += 1) {
      code = makeRoomCode();
      try {
        result = await conn.query(
          `INSERT INTO rooms
            (code, name, sport_key, mode, password_hash, court_count, max_people, owner_user_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            code,
            String(req.body.name || `羽球房-${code}`).trim(),
            sportKey,
            mode,
            passwordHash,
            courtCount,
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

    await conn.query(
      `INSERT INTO room_members
        (room_id, user_id, presence_status, play_status, last_seen_at)
       VALUES (?, ?, 'online', 'idle', NOW())`,
      [result.insertId, req.session.user.id]
    );
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

router.get('/:roomId', requireAuth, asyncRoute(async (req, res) => {
  const payload = await getRoomPayload(Number(req.params.roomId), req.session.user.id);
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
  const matchType = req.body.matchType;
  if (!MATCH_TYPES[matchType]) {
    return res.status(400).json({ error: '不支持的匹配方式' });
  }
  await transaction(async (conn) => {
    const room = await assertActiveRoom(conn, roomId);
    if (room.mode !== 'free') {
      throw new Error('这个房间是固定场次模式，不能发起自由匹配');
    }
    await assertMember(conn, roomId, req.session.user.id);
  });
  const match = await createFreeMatch({ roomId, matchType, createdBy: req.session.user.id });
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
    await assertMember(conn, roomId, req.session.user.id);
  });
  const result = await createRoundMatches({ roomId, courtModes, createdBy: req.session.user.id });
  await emitRoomChanged(req.app.get('io'), roomId);
  res.status(201).json(result);
}));

router.post('/matches/:matchId/finish', requireAuth, asyncRoute(async (req, res) => {
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
    scoreRed: req.body.scoreRed,
    scoreBlue: req.body.scoreBlue,
    note: req.body.note
  });
  const matchRows = await query('SELECT room_id FROM matches WHERE id = ? LIMIT 1', [matchId]);
  if (matchRows[0]) await emitRoomChanged(req.app.get('io'), matchRows[0].room_id);
  res.json(result);
}));

module.exports = router;
