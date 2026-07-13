const { query, transaction } = require('../db');

function normalizeAnnouncementInput(body) {
  const title = String(body.title || '').trim();
  const bodyText = String(body.body || '').trim();
  const isActive = body.isActive === true
    || body.isActive === 'true'
    || body.isActive === '1'
    || body.isActive === 1;

  if (title.length > 120) throw new Error('公告标题不能超过 120 个字');
  if (bodyText.length > 2000) throw new Error('公告内容不能超过 2000 个字');
  if (isActive && !title && !bodyText) throw new Error('公告内容不能为空');

  return {
    title: title || '公告',
    body: bodyText,
    isActive
  };
}

async function currentAnnouncement() {
  const rows = await query(
    `SELECT id, title, body, updated_at
     FROM announcements
     WHERE is_active = 1
       AND body <> ''
     ORDER BY updated_at DESC, id DESC
     LIMIT 1`
  );
  return rows[0] || null;
}

async function latestAnnouncement() {
  const rows = await query(
    `SELECT id, title, body, is_active, created_at, updated_at
     FROM announcements
     ORDER BY updated_at DESC, id DESC
     LIMIT 1`
  );
  return rows[0] || null;
}

async function saveAnnouncement(input, adminUserId) {
  const fields = normalizeAnnouncementInput(input);
  return transaction(async (conn) => {
    const existing = await conn.query(
      `SELECT id
       FROM announcements
       ORDER BY updated_at DESC, id DESC
       LIMIT 1
       FOR UPDATE`
    );

    if (existing[0]) {
      await conn.query(
        `UPDATE announcements
         SET title = ?,
             body = ?,
             is_active = ?,
             updated_by = ?,
             updated_at = NOW()
         WHERE id = ?`,
        [
          fields.title,
          fields.body,
          fields.isActive ? 1 : 0,
          adminUserId,
          existing[0].id
        ]
      );
      const rows = await conn.query('SELECT * FROM announcements WHERE id = ? LIMIT 1', [existing[0].id]);
      return rows[0];
    }

    const result = await conn.query(
      `INSERT INTO announcements
        (title, body, is_active, created_by, updated_by)
       VALUES (?, ?, ?, ?, ?)`,
      [
        fields.title,
        fields.body,
        fields.isActive ? 1 : 0,
        adminUserId,
        adminUserId
      ]
    );
    const rows = await conn.query('SELECT * FROM announcements WHERE id = ? LIMIT 1', [result.insertId]);
    return rows[0];
  });
}

module.exports = {
  currentAnnouncement,
  latestAnnouncement,
  normalizeAnnouncementInput,
  saveAnnouncement
};
