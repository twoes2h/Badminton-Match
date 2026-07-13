const crypto = require('crypto');

function hashValue(value) {
  return crypto
    .createHash('sha256')
    .update(String(value || ''))
    .digest('hex')
    .slice(0, 16);
}

function sanitizeLogFields(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const out = {};
  for (const [key, item] of Object.entries(value)) {
    if (/password/i.test(key)) continue;
    if (key === 'username') {
      out.usernameHash = hashValue(item);
      continue;
    }
    if (key === 'avatarUrl') continue;
    out[key] = item && typeof item === 'object' && !Array.isArray(item)
      ? sanitizeLogFields(item)
      : item;
  }
  return out;
}

function requestFields(req) {
  if (!req) return {};
  return {
    method: req.method,
    path: req.originalUrl || req.url,
    ip: req.ip,
    userAgent: req.get ? req.get('user-agent') : undefined
  };
}

function logEvent(level, event, fields = {}) {
  const payload = {
    ts: new Date().toISOString(),
    event,
    ...sanitizeLogFields(fields)
  };
  const line = JSON.stringify(payload);
  if (level === 'error') {
    console.error(line);
  } else if (level === 'warn') {
    console.warn(line);
  } else {
    console.info(line);
  }
}

module.exports = {
  logEvent,
  requestFields,
  sanitizeLogFields
};
