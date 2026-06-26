const fs = require('fs');
const path = require('path');
const mariadb = require('mariadb');
const bcrypt = require('bcryptjs');
const config = require('./config');

const pool = mariadb.createPool({
  ...config.db,
  acquireTimeout: 10000,
  bigIntAsNumber: true
});

async function query(sql, params = []) {
  let conn;
  try {
    conn = await pool.getConnection();
    return await conn.query(sql, params);
  } finally {
    if (conn) conn.release();
  }
}

async function transaction(work) {
  let conn;
  try {
    conn = await pool.getConnection();
    await conn.beginTransaction();
    const result = await work(conn);
    await conn.commit();
    return result;
  } catch (error) {
    if (conn) await conn.rollback();
    throw error;
  } finally {
    if (conn) conn.release();
  }
}

function splitSqlStatements(sql) {
  return sql
    .split(/;\s*(?:\r?\n|$)/)
    .map((statement) => statement.trim())
    .filter(Boolean);
}

async function initSchema() {
  const schemaPath = path.join(process.cwd(), 'schema.sql');
  const schema = fs.readFileSync(schemaPath, 'utf8');
  for (const statement of splitSqlStatements(schema)) {
    await query(statement);
  }
  await runMigrations();
}

async function runMigrations() {
  await query(
    `ALTER TABLE room_members
     ADD COLUMN IF NOT EXISTS match_preferences VARCHAR(64) NOT NULL DEFAULT 'any'
     AFTER match_preference`
  );
  await query(
    `UPDATE room_members
     SET match_preferences = match_preference
     WHERE match_preferences IN ('', 'any')
       AND match_preference <> 'any'`
  );
  await query('CREATE INDEX IF NOT EXISTS idx_rooms_status_owner ON rooms (status, owner_user_id)');
  await query('CREATE INDEX IF NOT EXISTS idx_matches_room_started_status ON matches (room_id, started_at, status)');
  await query('CREATE INDEX IF NOT EXISTS idx_match_players_user_match ON match_players (user_id, match_id)');
}

async function seedAdmin() {
  if (!config.admin.username || !config.admin.password) return;

  const existing = await query('SELECT id FROM users WHERE username = ? LIMIT 1', [
    config.admin.username
  ]);
  if (existing.length > 0) return;

  const passwordHash = await bcrypt.hash(config.admin.password, 12);
  await query(
    `INSERT INTO users
      (username, password_hash, display_name, role, gender, skill_level, rating)
     VALUES (?, ?, ?, 'admin', 'other', 5, 1000)`,
    [config.admin.username, passwordHash, '管理员']
  );
}

module.exports = {
  pool,
  query,
  transaction,
  initSchema,
  runMigrations,
  seedAdmin
};
