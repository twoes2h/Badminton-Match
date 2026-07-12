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
    ...fields
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
  requestFields
};
