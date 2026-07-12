const path = require('path');
const http = require('http');
const express = require('express');
const session = require('express-session');
const helmet = require('helmet');
const { Server } = require('socket.io');
const config = require('./config');
const { initSchema, seedAdmin, cleanupExpiredTemporaryUsers } = require('./db');
const authRoutes = require('./routes/auth');
const roomRoutes = require('./routes/rooms');
const adminRoutes = require('./routes/admin');
const { attachRealtime } = require('./realtime');

async function main() {
  if (config.autoMigrate) {
    await initSchema();
    await seedAdmin();
  }
  await cleanupExpiredTemporaryUsers();

  const app = express();
  const server = http.createServer(app);
  const io = new Server(server, {
    cors: false
  });

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
  app.use(helmet({
    contentSecurityPolicy: false
  }));
  app.use(express.json({ limit: '1mb' }));
  app.use(sessionMiddleware);
  app.use(express.static(path.join(process.cwd(), 'public')));

  attachRealtime(io, sessionMiddleware);

  app.use('/api/auth', authRoutes);
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
    console.error(error);
    res.status(400).json({ error: error.message || '请求失败' });
  });

  server.listen(config.port, () => {
    console.log(`Badminton match room running at http://localhost:${config.port}`);
  });

  const cleanupTimer = setInterval(() => {
    cleanupExpiredTemporaryUsers().catch((error) => console.error(error));
  }, 1000 * 60 * 60 * 24);
  cleanupTimer.unref();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
