const path = require('path');
const http = require('http');
const express = require('express');
const session = require('express-session');
const helmet = require('helmet');
const { Server } = require('socket.io');
const config = require('./config');
const {
  initSchema,
  seedAdmin,
  cleanupExpiredTemporaryUsers,
  cleanupExpiredVenueRooms
} = require('./db');
const authRoutes = require('./routes/auth');
const roomRoutes = require('./routes/rooms');
const adminRoutes = require('./routes/admin');
const announcementRoutes = require('./routes/announcements');
const { attachRealtime, emitRoomChanged } = require('./realtime');
const { logEvent, requestFields } = require('./logger');
const { finalizeTimedOutResults } = require('./services/results');
const { healthSnapshot, repairStuckState } = require('./services/health');
const { onlineSnapshot, touchActiveSession } = require('./services/online');

async function main() {
  if (config.autoMigrate) {
    await initSchema();
    await seedAdmin();
  }
  const app = express();
  const server = http.createServer(app);
  const io = new Server(server, {
    cors: false
  });
  let venueCleanupRunning = false;
  let resultTimeoutRunning = false;
  let stateRepairRunning = false;

  async function runVenueCleanup() {
    if (venueCleanupRunning) return;
    venueCleanupRunning = true;
    try {
      const result = await cleanupExpiredVenueRooms();
      if (result.venueIds.length || result.roomIds.length) {
        logEvent('info', 'venues.cleanup_expired', {
          venueIds: result.venueIds,
          roomIds: result.roomIds
        });
        for (const roomId of result.roomIds) {
          await emitRoomChanged(io, roomId);
        }
      }
    } catch (error) {
      logEvent('error', 'venues.cleanup_failed', {
        message: error.message,
        code: error.code,
        errno: error.errno,
        sqlState: error.sqlState
      });
    } finally {
      venueCleanupRunning = false;
    }
  }

  async function runResultTimeouts() {
    if (resultTimeoutRunning) return;
    resultTimeoutRunning = true;
    try {
      const result = await finalizeTimedOutResults();
      if (result.finalized.length) {
        logEvent('info', 'matches.timeout_finalized', {
          finalized: result.finalized
        });
        for (const roomId of result.roomIds) {
          await emitRoomChanged(io, roomId);
        }
      }
    } catch (error) {
      logEvent('error', 'matches.timeout_failed', {
        message: error.message,
        code: error.code,
        errno: error.errno,
        sqlState: error.sqlState
      });
    } finally {
      resultTimeoutRunning = false;
    }
  }

  async function runStateRepair() {
    if (stateRepairRunning) return;
    stateRepairRunning = true;
    try {
      const result = await repairStuckState();
      if (result.timedOut.length || result.cancelledStaleMatches.length
        || result.orphanMembersReleased || result.floatingStatusesReleased) {
        logEvent('warn', 'state.repaired', result);
        for (const roomId of result.roomIds) {
          await emitRoomChanged(io, roomId);
        }
      }
    } catch (error) {
      logEvent('error', 'state.repair_failed', {
        message: error.message,
        code: error.code,
        errno: error.errno,
        sqlState: error.sqlState
      });
    } finally {
      stateRepairRunning = false;
    }
  }

  await cleanupExpiredTemporaryUsers();
  await runVenueCleanup();
  await runResultTimeouts();
  await runStateRepair();

  const sessionMiddleware = session({
    name: 'badminton.sid',
    secret: config.sessionSecret,
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      sameSite: 'lax',
      maxAge: 1000 * 60 * 60 * 24 * 14
    }
  });

  app.set('io', io);
  app.set('sessionStore', sessionMiddleware.store);
  app.use(helmet({
    contentSecurityPolicy: false
  }));
  app.use(express.json({ limit: '3mb' }));
  app.use(sessionMiddleware);
  app.use('/api', (req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
  });
  app.use('/api', (req, res, next) => {
    if (req.session && req.session.user) {
      touchActiveSession(req.sessionID, req.session.user).catch((error) => {
        logEvent('error', 'online.touch_failed', {
          ...requestFields(req),
          message: error.message,
          code: error.code,
          errno: error.errno,
          sqlState: error.sqlState
        });
      });
    }
    next();
  });
  app.use(express.static(path.join(process.cwd(), 'public')));

  attachRealtime(io, sessionMiddleware);

  app.get('/api/healthz', async (req, res, next) => {
    try {
      res.json(await healthSnapshot({ strict: req.query.strict === '1' }));
    } catch (error) {
      next(error);
    }
  });
  app.use('/api/auth', authRoutes);
  app.use('/api/announcements', announcementRoutes);
  app.use('/api/rooms', roomRoutes);
  app.use('/api/admin', adminRoutes);

  app.get(['/login', '/login.html'], (req, res) => {
    res.sendFile(path.join(process.cwd(), 'public', 'login.html'));
  });
  app.get(['/rooms', '/rooms.html'], (req, res) => {
    res.sendFile(path.join(process.cwd(), 'public', 'rooms.html'));
  });
  app.get(['/room', '/room.html'], (req, res) => {
    res.sendFile(path.join(process.cwd(), 'public', 'room.html'));
  });
  app.get(['/profile', '/profile.html'], (req, res) => {
    res.sendFile(path.join(process.cwd(), 'public', 'profile.html'));
  });
  app.get(['/admin', '/admin.html'], (req, res) => {
    res.sendFile(path.join(process.cwd(), 'public', 'admin.html'));
  });

  app.get('*', (req, res) => {
    res.sendFile(path.join(process.cwd(), 'public', 'index.html'));
  });

  app.use((error, req, res, next) => {
    if (res.headersSent) return next(error);
    logEvent('error', 'request.error', {
      ...requestFields(req),
      message: error.message,
      code: error.code,
      errno: error.errno,
      sqlState: error.sqlState,
      stack: error.stack && error.stack.split('\n').slice(0, 4).join(' | ')
    });
    res.status(400).json({ error: error.message || '请求失败' });
  });

  server.listen(config.port, () => {
    console.log(`Badminton match room running at http://localhost:${config.port}`);
  });

  const cleanupTimer = setInterval(() => {
    cleanupExpiredTemporaryUsers().catch((error) => console.error(error));
  }, 1000 * 60 * 60 * 24);
  cleanupTimer.unref();

  const venueCleanupTimer = setInterval(runVenueCleanup, 1000 * 60);
  venueCleanupTimer.unref();

  const resultTimeoutTimer = setInterval(runResultTimeouts, 1000 * 30);
  resultTimeoutTimer.unref();

  const stateRepairTimer = setInterval(runStateRepair, 1000 * 60);
  stateRepairTimer.unref();

  const onlineCleanupTimer = setInterval(() => {
    onlineSnapshot().catch((error) => {
      logEvent('error', 'online.cleanup_failed', {
        message: error.message,
        code: error.code,
        errno: error.errno,
        sqlState: error.sqlState
      });
    });
  }, 1000 * 60);
  onlineCleanupTimer.unref();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
