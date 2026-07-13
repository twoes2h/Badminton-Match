const assert = require('assert');
const rooms = require('../src/routes/rooms')._test;
const auth = require('../src/routes/auth')._test;
const admin = require('../src/routes/admin')._test;
const { pool } = require('../src/db');

assert.deepStrictEqual(rooms.normalizeUserIds(['1', '2', '2', '-1', 'x', '0']), [1, 2]);
assert.deepStrictEqual(rooms.normalizeMatchPreferences([]), ['any']);
assert.deepStrictEqual(rooms.normalizeMatchPreferences(['md', 'xd', 'bad']), ['md', 'xd']);
assert.deepStrictEqual(rooms.normalizeMatchTypes(['any', 'bad']), ['md', 'wd', 'xd', 'ms', 'ws', 'xs']);
assert.deepStrictEqual(rooms.normalizeMatchTypes(['bad']), []);
assert.strictEqual(rooms.normalizeMatchDate('2026-07-13'), '2026-07-13');
assert.strictEqual(rooms.normalizeMatchDate('2026-7-13'), null);

assert.throws(() => rooms.normalizeTemporaryMemberInput({ displayName: '' }), /不能为空/);
assert.throws(() => rooms.normalizeTemporaryMemberInput({ displayName: 'a', username: 'x' }), /用户名/);
assert.strictEqual(rooms.normalizeTemporaryMemberInput({ displayName: 'a'.repeat(80), username: 'u'.repeat(20) }).username, 'u'.repeat(20));
assert.throws(() => rooms.normalizeTemporaryMemberInput({ displayName: 'a'.repeat(81), username: 'user123' }), /昵称/);
assert.throws(() => rooms.normalizeTemporaryMemberInput({ displayName: 'a', username: 'u'.repeat(21) }), /用户名/);
assert.throws(() => rooms.normalizeTemporaryMemberInput({ displayName: 'a', skillLevel: 0 }), /技术等级/);
assert.throws(() => rooms.normalizeTemporaryMemberInput({ displayName: 'a', skillLevel: 11 }), /技术等级/);
assert.strictEqual(rooms.normalizeTemporaryMemberInput({ displayName: 'a', rating: -99 }).rating, 0);
assert.strictEqual(rooms.normalizeTemporaryMemberInput({ displayName: 'a', rating: 9999 }).rating, 3000);
assert.strictEqual(rooms.USERNAME_MAX_LENGTH, 20);
assert.strictEqual(auth.USERNAME_MAX_LENGTH, 20);
assert.strictEqual(auth.USERNAME_PATTERN.test('u'.repeat(20)), true);
assert.strictEqual(auth.USERNAME_PATTERN.test('u'.repeat(21)), false);

assert.throws(() => auth.profileInput({ displayName: '', gender: 'male', skillLevel: 5 }), /昵称/);
assert.throws(() => auth.profileInput({ displayName: 'a', gender: 'bad', skillLevel: 5 }), /性别/);
assert.throws(() => auth.profileInput({ displayName: 'a', gender: 'male', skillLevel: 0 }), /技术等级/);
assert.strictEqual(auth.profileInput({ displayName: ' a ', gender: 'male', skillLevel: 10 }).displayName, 'a');

assert.strictEqual(admin.normalizeDateTime('2026-07-13T19:30', '开始时间'), '2026-07-13 19:30:00');
assert.throws(() => admin.normalizeDateTime('2026/07/13 19:30', '开始时间'), /格式/);
assert.throws(() => admin.normalizeVenueInput({
  name: '球场',
  courtCount: 2,
  startsAt: '2026-07-13T20:00',
  endsAt: '2026-07-13T19:00',
  locationUrl: ''
}), /结束时间/);
assert.throws(() => admin.normalizeVenueInput({
  name: '球场',
  courtCount: 2,
  startsAt: '2026-07-13T19:00',
  endsAt: '2026-07-13T20:00',
  locationUrl: 'javascript:alert(1)'
}), /位置链接/);

pool.end()
  .then(() => {
    console.log('input boundary tests passed');
  })
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
