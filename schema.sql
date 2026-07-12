CREATE TABLE IF NOT EXISTS users (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  username VARCHAR(64) NOT NULL UNIQUE,
  password_hash VARCHAR(255) NOT NULL,
  display_name VARCHAR(80) NOT NULL,
  avatar_url VARCHAR(500) NULL,
  gender ENUM('male','female','other') NOT NULL DEFAULT 'other',
  birth_year SMALLINT UNSIGNED NULL,
  rating INT NOT NULL DEFAULT 1000,
  skill_level TINYINT UNSIGNED NOT NULL DEFAULT 5,
  role ENUM('user','admin') NOT NULL DEFAULT 'user',
  account_type ENUM('normal','temporary') NOT NULL DEFAULT 'normal',
  temporary_expires_at DATETIME NULL,
  password_changed_at DATETIME NULL,
  profile_updated_on DATE NULL,
  is_blacklisted TINYINT(1) NOT NULL DEFAULT 0,
  matches_played INT UNSIGNED NOT NULL DEFAULT 0,
  last_seen_at DATETIME NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_users_role (role),
  INDEX idx_users_blacklist (is_blacklisted),
  INDEX idx_users_account_type_expires (account_type, temporary_expires_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS venues (
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
  CONSTRAINT fk_venues_creator FOREIGN KEY (created_by) REFERENCES users(id),
  INDEX idx_venues_status_time (status, starts_at, ends_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS rooms (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  code VARCHAR(12) NOT NULL UNIQUE,
  name VARCHAR(120) NOT NULL,
  sport_key VARCHAR(40) NOT NULL DEFAULT 'badminton',
  venue_id BIGINT UNSIGNED NULL,
  mode ENUM('free','round') NOT NULL DEFAULT 'free',
  password_hash VARCHAR(255) NULL,
  court_count TINYINT UNSIGNED NOT NULL DEFAULT 1,
  max_people SMALLINT UNSIGNED NOT NULL DEFAULT 30,
  status ENUM('active','dissolved') NOT NULL DEFAULT 'active',
  owner_user_id BIGINT UNSIGNED NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_rooms_owner FOREIGN KEY (owner_user_id) REFERENCES users(id),
  CONSTRAINT fk_rooms_venue FOREIGN KEY (venue_id) REFERENCES venues(id),
  INDEX idx_rooms_status (status),
  INDEX idx_rooms_code (code),
  INDEX idx_rooms_venue_status (venue_id, status),
  INDEX idx_rooms_status_owner (status, owner_user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS room_members (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  room_id BIGINT UNSIGNED NOT NULL,
  user_id BIGINT UNSIGNED NOT NULL,
  presence_status ENUM('online','offline') NOT NULL DEFAULT 'online',
  play_status ENUM('idle','waiting','resting','busy','in_match','awaiting_result','locked') NOT NULL DEFAULT 'idle',
  match_preference ENUM('md','wd','xd','ms','ws','xs','any') NOT NULL DEFAULT 'any',
  match_preferences VARCHAR(64) NOT NULL DEFAULT 'any',
  current_match_id BIGINT UNSIGNED NULL,
  consecutive_play_count SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  rest_streak SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  joined_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_seen_at DATETIME NULL,
  UNIQUE KEY uq_room_user (room_id, user_id),
  CONSTRAINT fk_room_members_room FOREIGN KEY (room_id) REFERENCES rooms(id) ON DELETE CASCADE,
  CONSTRAINT fk_room_members_user FOREIGN KEY (user_id) REFERENCES users(id),
  INDEX idx_room_members_status (room_id, presence_status, play_status),
  INDEX idx_room_members_match (current_match_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS matches (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  room_id BIGINT UNSIGNED NOT NULL,
  sport_key VARCHAR(40) NOT NULL DEFAULT 'badminton',
  match_type ENUM('md','wd','xd','ms','ws','xs') NOT NULL,
  court_no TINYINT UNSIGNED NULL,
  round_no INT UNSIGNED NOT NULL DEFAULT 1,
  status ENUM('active','awaiting_result','completed','invalid','cancelled') NOT NULL DEFAULT 'active',
  result_winner ENUM('red','blue','draw','terminated','invalid') NULL,
  score_red SMALLINT UNSIGNED NULL,
  score_blue SMALLINT UNSIGNED NULL,
  rating_delta_json JSON NULL,
  invalid_reason VARCHAR(255) NULL,
  created_by BIGINT UNSIGNED NOT NULL,
  started_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ended_at DATETIME NULL,
  finalized_at DATETIME NULL,
  CONSTRAINT fk_matches_room FOREIGN KEY (room_id) REFERENCES rooms(id) ON DELETE CASCADE,
  CONSTRAINT fk_matches_creator FOREIGN KEY (created_by) REFERENCES users(id),
  INDEX idx_matches_room_status (room_id, status),
  INDEX idx_matches_started (started_at),
  INDEX idx_matches_room_started_status (room_id, started_at, status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS match_players (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  match_id BIGINT UNSIGNED NOT NULL,
  user_id BIGINT UNSIGNED NOT NULL,
  team ENUM('red','blue') NOT NULL,
  rating_before INT NOT NULL,
  rating_after INT NULL,
  result_submitted TINYINT(1) NOT NULL DEFAULT 0,
  UNIQUE KEY uq_match_user (match_id, user_id),
  CONSTRAINT fk_match_players_match FOREIGN KEY (match_id) REFERENCES matches(id) ON DELETE CASCADE,
  CONSTRAINT fk_match_players_user FOREIGN KEY (user_id) REFERENCES users(id),
  INDEX idx_match_players_user (user_id),
  INDEX idx_match_players_user_match (user_id, match_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS match_results (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  match_id BIGINT UNSIGNED NOT NULL,
  user_id BIGINT UNSIGNED NOT NULL,
  outcome ENUM('win','lose','draw','terminated') NULL,
  verdict ENUM('red','blue','draw','terminated') NULL,
  score_red SMALLINT UNSIGNED NULL,
  score_blue SMALLINT UNSIGNED NULL,
  note VARCHAR(255) NULL,
  submitted_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_match_result_user (match_id, user_id),
  CONSTRAINT fk_match_results_match FOREIGN KEY (match_id) REFERENCES matches(id) ON DELETE CASCADE,
  CONSTRAINT fk_match_results_user FOREIGN KEY (user_id) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS rating_events (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  match_id BIGINT UNSIGNED NOT NULL,
  user_id BIGINT UNSIGNED NOT NULL,
  rating_before INT NOT NULL,
  rating_after INT NOT NULL,
  delta_value INT NOT NULL,
  reason VARCHAR(120) NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_rating_events_match FOREIGN KEY (match_id) REFERENCES matches(id) ON DELETE CASCADE,
  CONSTRAINT fk_rating_events_user FOREIGN KEY (user_id) REFERENCES users(id),
  INDEX idx_rating_events_user (user_id, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
