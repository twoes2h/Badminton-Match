async function emitRoomChanged(io, roomId) {
  if (!io || !roomId) return;
  io.to(`room:${roomId}`).emit('room:changed', { roomId: Number(roomId) });
}

function attachRealtime(io, sessionMiddleware) {
  io.engine.use(sessionMiddleware);

  io.on('connection', (socket) => {
    const user = socket.request.session && socket.request.session.user;
    if (!user) {
      socket.disconnect(true);
      return;
    }

    socket.on('room:join', (roomId) => {
      if (!roomId) return;
      socket.join(`room:${Number(roomId)}`);
    });

    socket.on('room:leave', (roomId) => {
      if (!roomId) return;
      socket.leave(`room:${Number(roomId)}`);
    });
  });
}

module.exports = {
  attachRealtime,
  emitRoomChanged
};
