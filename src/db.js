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
    `ALTER TABLE users
     ADD COLUMN IF NOT EXISTS avatar_url VARCHAR(500) NULL
     AFTER display_name`
  );
  await query(
    `CREATE TABLE IF NOT EXISTS venues (
       id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
       name VARCHAR(120) NOT NULL,
       court_count TINYINT UNSIGNED NOT NULL DEFAULT 1,
       starts_at DATETIME NOT NULL,
       ends_at DATETIME NOT NULL,
       location_url VARCHAR(500) NULL,
       status ENUM('active','inactive') NOT NULL DEFAULT 'active',
       created_by BIGINT UNSIGNED NOT NULL,
       created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
       updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
       INDEX idx_venues_status_time (status, starts_at, ends_at)
     ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`
  );
  await query(
    `CREATE TABLE IF NOT EXISTS active_sessions (
       session_id_hash CHAR(64) NOT NULL PRIMARY KEY,
       user_id BIGINT UNSIGNED NOT NULL,
       user_role ENUM('user','admin') NOT NULL DEFAULT 'user',
       created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
       last_seen_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
       CONSTRAINT fk_active_sessions_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
       INDEX idx_active_sessions_seen (last_seen_at),
       INDEX idx_active_sessions_user_role (user_role, user_id)
     ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`
  );
  await query(
    `CREATE TABLE IF NOT EXISTS announcements (
       id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
       title VARCHAR(120) NOT NULL,
       body TEXT NOT NULL,
       is_active TINYINT(1) NOT NULL DEFAULT 1,
       created_by BIGINT UNSIGNED NOT NULL,
       updated_by BIGINT UNSIGNED NOT NULL,
       created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
       updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
       CONSTRAINT fk_announcements_creator FOREIGN KEY (created_by) REFERENCES users(id),
       CONSTRAINT fk_announcements_updater FOREIGN KEY (updated_by) REFERENCES users(id),
       INDEX idx_announcements_active_updated (is_active, updated_at)
     ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`
  );
  await query(
    `ALTER TABLE rooms
     ADD COLUMN IF NOT EXISTS venue_id BIGINT UNSIGNED NULL
     AFTER sport_key`
  );
  await query('CREATE INDEX IF NOT EXISTS idx_rooms_venue_status ON rooms (venue_id, status)');
  await query(
    `ALTER TABLE room_members
     ADD COLUMN IF NOT EXISTS match_preferences VARCHAR(64) NOT NULL DEFAULT 'any'
     AFTER match_preference`
  );
  await query(
    `ALTER TABLE room_members
     ADD COLUMN IF NOT EXISTS match_pool_joined_at DATETIME NULL
     AFTER match_preferences`
  );
  await query(
    `UPDATE room_members
     SET match_preferences = match_preference
     WHERE match_preferences IN ('', 'any')
       AND match_preference <> 'any'`
  );
  await query('CREATE INDEX IF NOT EXISTS idx_rooms_status_owner ON rooms (status, owner_user_id)');
  await query('CREATE INDEX IF NOT EXISTS idx_room_members_pool ON room_members (room_id, play_status, match_pool_joined_at)');
  await query('CREATE INDEX IF NOT EXISTS idx_matches_room_started_status ON matches (room_id, started_at, status)');
  await query('CREATE INDEX IF NOT EXISTS idx_matches_status_ended ON matches (status, ended_at)');
  await query('CREATE INDEX IF NOT EXISTS idx_match_players_user_match ON match_players (user_id, match_id)');
  await query(
    `ALTER TABLE users
     ADD COLUMN IF NOT EXISTS account_type ENUM('normal','temporary') NOT NULL DEFAULT 'normal'
     AFTER role`
  );
  await query(
    `ALTER TABLE users
     ADD COLUMN IF NOT EXISTS temporary_expires_at DATETIME NULL
     AFTER account_type`
  );
  await query(
    `ALTER TABLE users
     ADD COLUMN IF NOT EXISTS password_changed_at DATETIME NULL
     AFTER temporary_expires_at`
  );
  await query(
    `ALTER TABLE users
     ADD COLUMN IF NOT EXISTS profile_updated_on DATE NULL
     AFTER password_changed_at`
  );
  await query(
    `ALTER TABLE match_results
     ADD COLUMN IF NOT EXISTS verdict ENUM('red','blue','draw','terminated') NULL
     AFTER outcome`
  );
  await query(
    `CREATE TABLE IF NOT EXISTS free_match_proposals (
       id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
       room_id BIGINT UNSIGNED NOT NULL,
       match_type ENUM('md','wd','xd','ms','ws','xs') NOT NULL,
       court_no TINYINT UNSIGNED NULL,
       round_no INT UNSIGNED NOT NULL DEFAULT 1,
       status ENUM('pending','accepted','expired','cancelled') NOT NULL DEFAULT 'pending',
       created_by BIGINT UNSIGNED NOT NULL,
       accepted_match_id BIGINT UNSIGNED NULL,
       created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
       expires_at DATETIME NOT NULL,
       CONSTRAINT fk_free_match_proposals_room FOREIGN KEY (room_id) REFERENCES rooms(id) ON DELETE CASCADE,
       CONSTRAINT fk_free_match_proposals_creator FOREIGN KEY (created_by) REFERENCES users(id),
       CONSTRAINT fk_free_match_proposals_match FOREIGN KEY (accepted_match_id) REFERENCES matches(id) ON DELETE SET NULL,
       INDEX idx_free_match_proposals_room_status (room_id, status, expires_at),
       INDEX idx_free_match_proposals_match (accepted_match_id)
     ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`
  );
  await query(
    `CREATE TABLE IF NOT EXISTS free_match_proposal_players (
       id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
       proposal_id BIGINT UNSIGNED NOT NULL,
       user_id BIGINT UNSIGNED NOT NULL,
       team ENUM('red','blue') NOT NULL,
       accepted_at DATETIME NULL,
       UNIQUE KEY uq_free_match_proposal_user (proposal_id, user_id),
       CONSTRAINT fk_free_match_proposal_players_proposal FOREIGN KEY (proposal_id) REFERENCES free_match_proposals(id) ON DELETE CASCADE,
       CONSTRAINT fk_free_match_proposal_players_user FOREIGN KEY (user_id) REFERENCES users(id),
       INDEX idx_free_match_proposal_players_user (user_id)
     ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`
  );
  await query(
    `UPDATE users
     SET password_changed_at = COALESCE(password_changed_at, updated_at)
     WHERE account_type = 'normal'
       AND password_changed_at IS NULL`
  );
  await query('CREATE INDEX IF NOT EXISTS idx_users_account_type_expires ON users (account_type, temporary_expires_at)');
}

async function cleanupExpiredTemporaryUsers() {
  await transaction(async (conn) => {
    await conn.query(
      `DELETE rm
       FROM room_members rm
       JOIN users u ON u.id = rm.user_id
       WHERE u.account_type = 'temporary'
         AND u.temporary_expires_at IS NOT NULL
         AND u.temporary_expires_at < NOW()
         AND rm.current_match_id IS NULL`
    );
    await conn.query(
      `DELETE u
       FROM users u
       LEFT JOIN match_players mp ON mp.user_id = u.id
       LEFT JOIN match_results mr ON mr.user_id = u.id
       LEFT JOIN rating_events re ON re.user_id = u.id
       LEFT JOIN rooms r ON r.owner_user_id = u.id
       LEFT JOIN room_members rm ON rm.user_id = u.id
       WHERE u.account_type = 'temporary'
         AND u.temporary_expires_at IS NOT NULL
         AND u.temporary_expires_at < NOW()
         AND mp.id IS NULL
         AND mr.id IS NULL
         AND re.id IS NULL
         AND r.id IS NULL
         AND rm.id IS NULL`
    );
  });
}

function placeholders(values) {
  return values.map(() => '?').join(',');
}

async function cleanupExpiredVenueRooms() {
  return transaction(async (conn) => {
    const expired = await conn.query(
      `SELECT
         v.id AS venue_id,
         r.id AS room_id
       FROM venues v
       LEFT JOIN rooms r
         ON r.venue_id = v.id
        AND r.status = 'active'
       WHERE v.ends_at <= NOW()
       FOR UPDATE`
    );
    const venueIds = [...new Set(expired.map((row) => Number(row.venue_id)).filter(Boolean))];
    const roomIds = [...new Set(expired.map((row) => Number(row.room_id)).filter(Boolean))];

    if (roomIds.length) {
      await conn.query(
        `UPDATE matches
         SET status = 'cancelled',
             ended_at = COALESCE(ended_at, NOW())
         WHERE room_id IN (${placeholders(roomIds)})
           AND status IN ('active','awaiting_result')`,
        roomIds
      );
      await conn.query(
        `UPDATE room_members
         SET presence_status = 'offline',
             play_status = 'idle',
             current_match_id = NULL
         WHERE room_id IN (${placeholders(roomIds)})`,
        roomIds
      );
      await conn.query(
        `UPDATE rooms
         SET status = 'dissolved',
             venue_id = NULL
         WHERE id IN (${placeholders(roomIds)})`,
        roomIds
      );
    }

    if (venueIds.length) {
      await conn.query(
        `UPDATE rooms
         SET venue_id = NULL
         WHERE venue_id IN (${placeholders(venueIds)})`,
        venueIds
      );
      await conn.query(
        `DELETE FROM venues
         WHERE id IN (${placeholders(venueIds)})`,
        venueIds
      );
    }

    return { venueIds, roomIds };
  });
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
      (username, password_hash, display_name, role, account_type, gender, skill_level, rating, password_changed_at)
     VALUES (?, ?, ?, 'admin', 'normal', 'other', 5, 1000, NOW())`,
    [config.admin.username, passwordHash, '管理员']
  );
}

module.exports = {
  pool,
  query,
  transaction,
  initSchema,
  runMigrations,
  cleanupExpiredTemporaryUsers,
  cleanupExpiredVenueRooms,
  seedAdmin
};
