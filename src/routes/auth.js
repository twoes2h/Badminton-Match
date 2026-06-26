const express = require('express');
const bcrypt = require('bcryptjs');
const { query, transaction } = require('../db');
const { asyncRoute, requireAuth } = require('../middleware');
const { markMatchAwaitingResult } = require('../services/results');

const router = express.Router();

function sessionUser(user) {
  return {
    id: Number(user.id),
    username: user.username,
    displayName: user.display_name,
    role: user.role
  };
}

router.post('/register', asyncRoute(async (req, res) => {
  const username = String(req.body.username || '').trim();
  const password = String(req.body.password || '');
  const displayName = String(req.body.displayName || username).trim();
  const gender = req.body.gender || 'other';
  const birthYear = req.body.birthYear ? Number(req.body.birthYear) : null;
  const skillLevel = Number(req.body.skillLevel || 5);

  if (!/^[a-zA-Z0-9_\u4e00-\u9fa5-]{3,32}$/.test(username)) {
    return res.status(400).json({ error: '用户名需为 3-32 位，可包含中文、字母、数字、下划线或短横线' });
  }
  if (password.length < 6) {
    return res.status(400).json({ error: '密码至少 6 位' });
  }
  if (!['male', 'female', 'other'].includes(gender)) {
    return res.status(400).json({ error: '性别参数不正确' });
  }
  if (skillLevel < 1 || skillLevel > 10) {
    return res.status(400).json({ error: '技术等级需在 1-10 之间' });
  }

  const passwordHash = await bcrypt.hash(password, 12);
  const created = await transaction(async (conn) => {
    const userCount = await conn.query('SELECT COUNT(*) AS count_value FROM users');
    const role = Number(userCount[0].count_value) === 0 ? 'admin' : 'user';
    const result = await conn.query(
      `INSERT INTO users
        (username, password_hash, display_name, gender, birth_year, skill_level, role)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [username, passwordHash, displayName, gender, birthYear, skillLevel, role]
    );
    const rows = await conn.query('SELECT * FROM users WHERE id = ? LIMIT 1', [result.insertId]);
    return rows[0];
  });

  req.session.user = sessionUser(created);
  res.status(201).json({ user: req.session.user });
}));

router.post('/login', asyncRoute(async (req, res) => {
  const username = String(req.body.username || '').trim();
  const password = String(req.body.password || '');
  const rows = await query('SELECT * FROM users WHERE username = ? LIMIT 1', [username]);
  const user = rows[0];
  if (!user || !(await bcrypt.compare(password, user.password_hash))) {
    return res.status(401).json({ error: '用户名或密码错误' });
  }
  if (user.is_blacklisted) {
    return res.status(403).json({ error: '账号已被管理员限制登录' });
  }

  await query('UPDATE users SET last_seen_at = NOW() WHERE id = ?', [user.id]);
  req.session.user = sessionUser(user);
  res.json({ user: req.session.user });
}));

router.post('/logout', requireAuth, asyncRoute(async (req, res) => {
  const userId = req.session.user.id;
  await transaction(async (conn) => {
    const activeRows = await conn.query(
      `SELECT DISTINCT current_match_id
       FROM room_members
       WHERE user_id = ?
         AND current_match_id IS NOT NULL`,
      [userId]
    );
    for (const row of activeRows) {
      await markMatchAwaitingResult(conn, row.current_match_id);
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
  });

  req.session.destroy(() => {
    res.json({ ok: true });
  });
}));

router.get('/me', requireAuth, asyncRoute(async (req, res) => {
  const rows = await query(
    `SELECT id, username, display_name, gender, birth_year, rating, skill_level, role, matches_played
     FROM users
     WHERE id = ?
     LIMIT 1`,
    [req.session.user.id]
  );
  res.json({ user: rows[0] });
}));

module.exports = router;
