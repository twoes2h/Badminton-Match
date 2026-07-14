function pick(source, fields) {
  const out = {};
  for (const field of fields) {
    if (source[field] !== undefined) out[field] = source[field];
  }
  return out;
}

function sanitizeRoomMember(member, options = {}) {
  const safe = pick(member, [
    'id',
    'room_id',
    'user_id',
    'presence_status',
    'play_status',
    'match_preference',
    'match_preferences',
    'match_pool_joined_at',
    'current_match_id',
    'consecutive_play_count',
    'rest_streak',
    'joined_at',
    'last_seen_at',
    'display_name',
    'avatar_url',
    'gender',
    'rating',
    'skill_level',
    'role',
    'account_type'
  ]);

  if (options.canManage) {
    Object.assign(safe, pick(member, [
      'username',
      'birth_year',
      'temporary_expires_at',
      'is_blacklisted'
    ]));
  }

  return safe;
}

function sanitizeRoomMembers(members, options = {}) {
  return members.map((member) => sanitizeRoomMember(member, options));
}

module.exports = {
  sanitizeRoomMember,
  sanitizeRoomMembers
};
