const assert = require('assert');
const { sanitizeLogFields } = require('../src/logger');
const { sanitizeRoomMember } = require('../src/services/privacy');

const member = {
  id: 1,
  room_id: 2,
  user_id: 3,
  username: 'secret_user',
  display_name: 'Saber',
  avatar_url: '/uploads/a.png',
  gender: 'male',
  birth_year: 1988,
  rating: 1200,
  skill_level: 6,
  role: 'user',
  account_type: 'normal',
  temporary_expires_at: '2026-08-01',
  is_blacklisted: 1,
  password_hash: 'never'
};

const publicMember = sanitizeRoomMember(member, { canManage: false });
assert.strictEqual(publicMember.display_name, 'Saber');
assert.strictEqual(publicMember.rating, 1200);
assert.strictEqual(publicMember.username, undefined);
assert.strictEqual(publicMember.birth_year, undefined);
assert.strictEqual(publicMember.temporary_expires_at, undefined);
assert.strictEqual(publicMember.is_blacklisted, undefined);
assert.strictEqual(publicMember.password_hash, undefined);

const managedMember = sanitizeRoomMember(member, { canManage: true });
assert.strictEqual(managedMember.username, 'secret_user');
assert.strictEqual(managedMember.birth_year, 1988);
assert.strictEqual(managedMember.temporary_expires_at, '2026-08-01');
assert.strictEqual(managedMember.is_blacklisted, 1);
assert.strictEqual(managedMember.password_hash, undefined);

const logFields = sanitizeLogFields({
  username: 'saber',
  password: 'plain',
  nested: {
    currentPassword: 'plain',
    ok: true
  }
});
assert.ok(logFields.usernameHash);
assert.strictEqual(logFields.username, undefined);
assert.strictEqual(logFields.password, undefined);
assert.deepStrictEqual(logFields.nested, { ok: true });

console.log('privacy tests passed');
