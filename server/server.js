const express  = require('express');
const http     = require('http');
const { Server } = require('socket.io');

const app    = express();
const srv    = http.createServer(app);
const io     = new Server(srv, {
  cors: { origin: '*', methods: ['GET','POST'] },
  pingTimeout:  60000,
  pingInterval: 25000,
});

// rooms: code -> { hostSocketId, hostPid, state, playerMap: Map<pid,socketId> }
const rooms = new Map();

app.get('/',       (_, res) => res.send('TM Server OK'));
app.get('/health', (_, res) => res.json({ ok: true, rooms: rooms.size }));

io.on('connection', socket => {
  let myRoom = null;
  let myPid  = null;
  let amHost = false;

  // ── Host creates room ───────────────────────────────────────────────
  socket.on('create', ({ code, pid, name, state }) => {
    if (rooms.has(code)) { socket.emit('codeCollision'); return; }
    rooms.set(code, {
      hostSocketId: socket.id, hostPid: pid,
      state, playerMap: new Map([[pid, socket.id]]),
    });
    socket.join(code);
    myRoom = code; myPid = pid; amHost = true;
    socket.emit('created', { code });
    console.log(`Room ${code} created by ${name}`);
  });

  // ── Player joins room ───────────────────────────────────────────────
  socket.on('join', ({ code, pid, name }) => {
    const room = rooms.get(code);
    if (!room) { socket.emit('err', 'Room not found — check the code and make sure the host is still in the lobby.'); return; }
    if (room.state?.gameOver) { socket.emit('err', 'That game has ended.'); return; }
    room.playerMap.set(pid, socket.id);
    socket.join(code);
    myRoom = code; myPid = pid; amHost = false;
    socket.emit('joined', { state: room.state });
    io.to(room.hostSocketId).emit('joinRequest', { pid, name });
    console.log(`${name} joined room ${code}`);
  });

  // ── Client sends action → forwarded to host ─────────────────────────
  socket.on('action', ({ code, action }) => {
    const room = rooms.get(code || myRoom);
    if (!room) return;
    io.to(room.hostSocketId).emit('action', action);
  });

  // ── Host pushes state → broadcast to all others ─────────────────────
  socket.on('stateUpdate', ({ code, state }) => {
    const c    = code || myRoom;
    const room = rooms.get(c);
    if (!room || socket.id !== room.hostSocketId) return;
    room.state = state;
    socket.to(c).emit('state', state);
  });

  // ── Reconnecting player requests current state ──────────────────────
  socket.on('getState', ({ code }) => {
    const room = rooms.get(code);
    if (room) socket.emit('state', room.state);
    else socket.emit('err', 'Room not found.');
  });

  // ── Disconnect ──────────────────────────────────────────────────────
  socket.on('disconnect', () => {
    if (!myRoom) return;
    const room = rooms.get(myRoom);
    if (!room) return;
    if (socket.id === room.hostSocketId) {
      socket.to(myRoom).emit('hostLeft');
      // Auto-delete after 10 min if host never came back
      setTimeout(() => {
        const r = rooms.get(myRoom);
        if (r && r.hostSocketId === socket.id) rooms.delete(myRoom);
      }, 10 * 60 * 1000);
    }
  });
});

const PORT = process.env.PORT || 3001;
srv.listen(PORT, () => console.log(`Terraforming Mars server on port ${PORT}`));
