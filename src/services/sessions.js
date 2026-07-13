function parseStoredSession(value) {
  if (!value) return null;
  if (typeof value === 'string') {
    try {
      return JSON.parse(value);
    } catch {
      return null;
    }
  }
  return value;
}

function sessionBelongsToUser(sessionData, userId) {
  return Number(sessionData && sessionData.user && sessionData.user.id) === Number(userId);
}

function memoryStoreEntries(store) {
  if (!store || !store.sessions) return [];
  return Object.entries(store.sessions)
    .map(([sessionId, value]) => [sessionId, parseStoredSession(value)])
    .filter((entry) => entry[1]);
}

function entriesFromStoreAllResult(store, sessions) {
  if (Array.isArray(sessions)) {
    const entries = sessions
      .map((sessionData) => [
        sessionData && (sessionData.id || sessionData.sid || sessionData.sessionID),
        sessionData
      ])
      .filter(([sessionId]) => sessionId);
    return entries.length ? entries : memoryStoreEntries(store);
  }
  return Object.entries(sessions || {});
}

async function listStoreSessions(store) {
  if (!store) return [];
  if (typeof store.all === 'function') {
    const sessions = await new Promise((resolve, reject) => {
      store.all((error, result) => {
        if (error) reject(error);
        else resolve(result);
      });
    });
    return entriesFromStoreAllResult(store, sessions);
  }
  return memoryStoreEntries(store);
}

async function destroySession(store, sessionId) {
  if (!store || !sessionId || typeof store.destroy !== 'function') return false;
  await new Promise((resolve, reject) => {
    store.destroy(sessionId, (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
  return true;
}

async function destroyUserSessions(store, userId) {
  const entries = await listStoreSessions(store);
  let destroyed = 0;
  for (const [sessionId, sessionData] of entries) {
    if (!sessionBelongsToUser(sessionData, userId)) continue;
    if (await destroySession(store, sessionId)) destroyed += 1;
  }
  return destroyed;
}

module.exports = {
  destroyUserSessions,
  listStoreSessions,
  parseStoredSession,
  sessionBelongsToUser
};
