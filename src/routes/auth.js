const express = require('express');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const fs = require('fs/promises');
const path = require('path');
const { query, transaction } = require('../db');
const { asyncRoute, requireAuth } = require('../middleware');
const { markMatchAwaitingResult } = require('../services/results');
const { logEvent, requestFields } = require('../logger');

const router = express.Router();
const USERNAME_PATTERN = /^[a-zA-Z0-9_\u4e00-\u9fa5-]{3,32}$/;
const AVATAR_UPLOAD_DIR = path.join(process.cwd(), 'public', 'uploads', 'avatars');
const AVATAR_PUBLIC_PREFIX = '/uploads/avatars';
const AVATAR_MAX_BYTES = 2 * 1024 * 1024;
const AVATAR_TYPES = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp'
};

function sessionUser(user) {
  return {
    id: Number(user.id),
    username: user.username,
    displayName: user.display_name,
    avatarUrl: user.avatar_url || null,
    role: user.role,
    accountType: user.account_type || 'normal'
  };
}

function profileInput(body) {
  const displayName = String(body.displayName || '').trim();
  const gender = body.gender || 'other';
  const birthYear = body.birthYear ? Number(body.birthYear) : null;
  const skillLevel = Number(body.skillLevel || 5);

  if (!displayName || displayName.length > 80) {
    throw new Error('昵称不能为空且不能超过 80 个字符');
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

  return { displayName, gender, birthYear, skillLevel };
}

function parseAvatarImage(imageData) {
  const raw = String(imageData || '');
  const match = raw.match(/^data:(image\/(?:jpeg|png|webp));base64,([a-zA-Z0-9+/=\s]+)$/);
  if (!match) throw new Error('头像文件格式不正确');

  const mimeType = match[1];
  const extension = AVATAR_TYPES[mimeType];
  const buffer = Buffer.from(match[2].replace(/\s/g, ''), 'base64');
  if (buffer.length === 0 || buffer.length > AVATAR_MAX_BYTES) {
    throw new Error('头像文件需小于 2MB');
  }

  const valid = (mimeType === 'image/jpeg' && buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff)
    || (mimeType === 'image/png' && buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])))
    || (mimeType === 'image/webp' && buffer.length >= 12 && buffer.subarray(0, 4).toString('ascii') === 'RIFF' && buffer.subarray(8, 12).toString('ascii') === 'WEBP');
  if (!valid) throw new Error('头像文件内容不正确');

  return { buffer, extension, mimeType };
}

async function removeLocalAvatar(avatarUrl) {
  if (!avatarUrl || !String(avatarUrl).startsWith(`${AVATAR_PUBLIC_PREFIX}/`)) return;
  const relative = String(avatarUrl).slice(1).replace(/\//g, path.sep);
  const filePath = path.resolve(process.cwd(), 'public', relative);
  const uploadRoot = path.resolve(AVATAR_UPLOAD_DIR);
  if (!filePath.startsWith(uploadRoot + path.sep)) return;
  await fs.unlink(filePath).catch((error) => {
    if (error.code !== 'ENOENT') throw error;
  });
}

router.post('/register', asyncRoute(async (req, res) => {
  const username = String(req.body.username || '').trim();
  const password = String(req.body.password || '');
  const displayName = String(req.body.displayName || username).trim();
  const gender = req.body.gender || 'other';
  const birthYear = req.body.birthYear ? Number(req.body.birthYear) : null;
  const skillLevel = Number(req.body.skillLevel || 5);

  if (!USERNAME_PATTERN.test(username)) {
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
    const existingRows = await conn.query('SELECT account_type FROM users WHERE username = ? LIMIT 1', [username]);
    if (existingRows[0]) {
      if (existingRows[0].account_type === 'temporary') {
        throw new Error('这个用户名是临时成员账号，请用默认密码 000000 登录后在我的资料里修改密码');
      }
      throw new Error('用户名已存在');
    }
    const userCount = await conn.query('SELECT COUNT(*) AS count_value FROM users');
    const role = Number(userCount[0].count_value) === 0 ? 'admin' : 'user';
    const result = await conn.query(
      `INSERT INTO users
        (username, password_hash, display_name, gender, birth_year, skill_level, role, account_type, password_changed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'normal', NOW())`,
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
    logEvent('warn', 'auth.login_failed', {
      ...requestFields(req),
      username,
      reason: 'invalid_credentials'
    });
    return res.status(401).json({ error: '用户名或密码错误' });
  }
  if (user.is_blacklisted) {
    logEvent('warn', 'auth.login_failed', {
      ...requestFields(req),
      username,
      userId: Number(user.id),
      reason: 'blacklisted'
    });
    return res.status(403).json({ error: '账号已被管理员限制登录' });
  }

  await query('UPDATE users SET last_seen_at = NOW() WHERE id = ?', [user.id]);
  req.session.user = sessionUser(user);
  logEvent('info', 'auth.login_success', {
    ...requestFields(req),
    username,
    userId: Number(user.id),
    role: user.role,
    accountType: user.account_type || 'normal'
  });
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
    `SELECT
       id, username, display_name, gender, birth_year, rating, skill_level,
       avatar_url,
       role, account_type, temporary_expires_at, password_changed_at,
       profile_updated_on, matches_played,
       1 AS can_update_profile
     FROM users
     WHERE id = ?
     LIMIT 1`,
    [req.session.user.id]
  );
  if (!rows[0]) {
    logEvent('warn', 'auth.me_missing_user', {
      ...requestFields(req),
      sessionUserId: req.session.user.id
    });
    req.session.destroy(() => {});
    return res.status(401).json({ error: '登录状态已失效，请重新登录' });
  }
  res.json({ user: rows[0] });
}));

router.post('/avatar', requireAuth, asyncRoute(async (req, res) => {
  const image = parseAvatarImage(req.body.imageData);
  await fs.mkdir(AVATAR_UPLOAD_DIR, { recursive: true });

  const fileName = `user-${req.session.user.id}-${Date.now()}-${crypto.randomBytes(4).toString('hex')}.${image.extension}`;
  const filePath = path.join(AVATAR_UPLOAD_DIR, fileName);
  const avatarUrl = `${AVATAR_PUBLIC_PREFIX}/${fileName}`;

  const rows = await query('SELECT avatar_url FROM users WHERE id = ? LIMIT 1', [req.session.user.id]);
  if (!rows[0]) throw new Error('用户不存在');

  try {
    await fs.writeFile(filePath, image.buffer, { flag: 'wx' });
    await query('UPDATE users SET avatar_url = ? WHERE id = ?', [avatarUrl, req.session.user.id]);
  } catch (error) {
    await fs.unlink(filePath).catch(() => {});
    throw error;
  }

  await removeLocalAvatar(rows[0].avatar_url);
  const updatedRows = await query('SELECT * FROM users WHERE id = ? LIMIT 1', [req.session.user.id]);
  req.session.user = sessionUser(updatedRows[0]);
  logEvent('info', 'profile.avatar_uploaded', {
    ...requestFields(req),
    userId: req.session.user.id,
    avatarUrl,
    mimeType: image.mimeType,
    size: image.buffer.length
  });
  res.json({ avatarUrl, user: req.session.user });
}));

router.patch('/profile', requireAuth, asyncRoute(async (req, res) => {
  const profile = profileInput(req.body);

  const user = await transaction(async (conn) => {
    const rows = await conn.query(
      `SELECT id, profile_updated_on
       FROM users
       WHERE id = ?
       LIMIT 1`,
      [req.session.user.id]
    );
    if (!rows[0]) throw new Error('用户不存在');

    await conn.query(
      `UPDATE users
       SET display_name = ?,
           gender = ?,
           birth_year = ?,
           skill_level = ?,
           profile_updated_on = CURDATE()
       WHERE id = ?`,
      [
        profile.displayName,
        profile.gender,
        profile.birthYear,
        profile.skillLevel,
        req.session.user.id
      ]
    );
    const updated = await conn.query('SELECT * FROM users WHERE id = ? LIMIT 1', [req.session.user.id]);
    return updated[0];
  });

  req.session.user = sessionUser(user);
  res.json({ user: req.session.user });
}));

router.post('/password', requireAuth, asyncRoute(async (req, res) => {
  const currentPassword = String(req.body.currentPassword || '');
  const newPassword = String(req.body.newPassword || '');
  const confirmPassword = String(req.body.confirmPassword || '');

  if (newPassword.length < 6) {
    return res.status(400).json({ error: '新密码至少 6 位' });
  }
  if (newPassword !== confirmPassword) {
    return res.status(400).json({ error: '两次输入的新密码不一致' });
  }

  const user = await transaction(async (conn) => {
    const rows = await conn.query('SELECT * FROM users WHERE id = ? LIMIT 1', [req.session.user.id]);
    const found = rows[0];
    if (!found) throw new Error('用户不存在');
    if (!(await bcrypt.compare(currentPassword, found.password_hash))) {
      throw new Error('当前密码不正确');
    }

    const passwordHash = await bcrypt.hash(newPassword, 12);
    await conn.query(
      `UPDATE users
       SET password_hash = ?,
           account_type = 'normal',
           temporary_expires_at = NULL,
           password_changed_at = NOW()
       WHERE id = ?`,
      [passwordHash, req.session.user.id]
    );
    const updated = await conn.query('SELECT * FROM users WHERE id = ? LIMIT 1', [req.session.user.id]);
    return updated[0];
  });

  req.session.user = sessionUser(user);
  res.json({ ok: true, user: req.session.user });
}));

module.exports = router;
