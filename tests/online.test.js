const assert = require('assert');
const { canLoginByCapacity } = require('../src/services/online');
const { normalizeAnnouncementInput } = require('../src/services/announcements');
const { pool } = require('../src/db');

assert.strictEqual(canLoginByCapacity({
  role: 'user',
  activeUsers: 99,
  userAlreadyActive: false,
  limit: 100
}), true);

assert.strictEqual(canLoginByCapacity({
  role: 'user',
  activeUsers: 100,
  userAlreadyActive: false,
  limit: 100
}), false);

assert.strictEqual(canLoginByCapacity({
  role: 'user',
  activeUsers: 100,
  userAlreadyActive: true,
  limit: 100
}), true);

assert.strictEqual(canLoginByCapacity({
  role: 'admin',
  activeUsers: 100,
  userAlreadyActive: false,
  limit: 100
}), true);

assert.deepStrictEqual(normalizeAnnouncementInput({
  title: '  今日安排  ',
  body: '  19:00 开始  ',
  isActive: true
}), {
  title: '今日安排',
  body: '19:00 开始',
  isActive: true
});

assert.throws(() => normalizeAnnouncementInput({
  title: '',
  body: '',
  isActive: true
}), /公告内容/);

assert.strictEqual(normalizeAnnouncementInput({
  title: '',
  body: '',
  isActive: false
}).title, '公告');

pool.end()
  .then(() => {
    console.log('online and announcement tests passed');
  })
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
