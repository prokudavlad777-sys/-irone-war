const path = require('path');
const http = require('http');
const express = require('express');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } }); // якщо сайт і сервер на одному домені — cors можна прибрати

// Роздає гру: public/index.html, public/sounds/, public/iron-war.ico
app.use(express.static(path.join(__dirname, 'public')));

const PORT = process.env.PORT || 3000;
const MAX_PLAYERS = 2;
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // без схожих символів (0/O, 1/I)
const rooms = new Map(); // code -> { code, host, started, players: [{id, name}] }

function makeCode() {
  let code;
  do {
    code = Array.from({ length: 5 }, () => ALPHABET[Math.floor(Math.random() * ALPHABET.length)]).join('');
  } while (rooms.has(code));
  return code;
}
const cleanName = (n) => (typeof n === 'string' ? n.trim().slice(0, 20) : '') || 'Гравець';
const cleanCode = (c) => (typeof c === 'string' ? c.trim().toUpperCase() : '');

function publicRoom(room) {
  return {
    code: room.code,
    started: room.started,
    players: room.players.map((p) => ({ id: p.id, name: p.name, host: p.id === room.host })),
  };
}

const queue = { code: null }; // кімната, що чекає на суперника у швидкому пошуку
function startRoom(room) {
  room.started = true;
  // host = гравець 0 (синій), гість = гравець 1 (червоний)
  io.to(room.code).emit('gameStart', { seed: Math.floor(Math.random() * 1e9), host: room.host, players: publicRoom(room).players });
}
const broadcast = (room) => io.to(room.code).emit('roomUpdate', publicRoom(room));

function leave(socket) {
  const code = socket.data.room;
  if (!code) return;
  socket.data.room = null;
  socket.leave(code);
  const room = rooms.get(code);
  if (!room) return;
  room.players = room.players.filter((p) => p.id !== socket.id);
  if (socket.id === room.host || room.players.length === 0) {
    io.to(code).emit('roomClosed'); // хост вийшов — кімната закривається
    io.in(code).socketsLeave(code);
    if (queue.code === code) queue.code = null;
    rooms.delete(code);
    return;
  }
  broadcast(room);
}

io.on('connection', (socket) => {
  socket.on('createRoom', (data, cb) => {
    if (typeof cb !== 'function') return;
    leave(socket);
    const room = {
      code: makeCode(),
      host: socket.id,
      started: false,
      players: [{ id: socket.id, name: cleanName(data?.name) }],
    };
    rooms.set(room.code, room);
    socket.join(room.code);
    socket.data.room = room.code;
    cb({ ok: true, code: room.code });
    broadcast(room);
  });

  socket.on('joinPrivateRoom', (data, cb) => {
    if (typeof cb !== 'function') return;
    const room = rooms.get(cleanCode(data?.code));
    if (!room) return cb({ ok: false, error: 'Кімнату не знайдено' });
    if (room.players.some((p) => p.id === socket.id)) return cb({ ok: true, code: room.code });
    if (room.started) return cb({ ok: false, error: 'Гра вже почалась' });
    if (room.players.length >= MAX_PLAYERS) return cb({ ok: false, error: 'Кімната заповнена' });
    leave(socket);
    room.players.push({ id: socket.id, name: cleanName(data?.name) });
    socket.join(room.code);
    socket.data.room = room.code;
    cb({ ok: true, code: room.code });
    broadcast(room);
  });

  socket.on('startGame', (data, cb) => {
    const done = (r) => typeof cb === 'function' && cb(r);
    const room = rooms.get(socket.data.room);
    if (!room) return done({ ok: false, error: 'Ти не в кімнаті' });
    if (room.host !== socket.id) return done({ ok: false, error: 'Розпочати може тільки хост' });
    if (room.players.length < MAX_PLAYERS) return done({ ok: false, error: 'Чекаємо на другого гравця' });
    startRoom(room);
    done({ ok: true });
  });


  // ---- Швидкий пошук суперника (1 на 1, будь-який пристрій: ПК, телефон, планшет) ----
  socket.on('quickMatch', (data, cb) => {
    if (typeof cb !== 'function') return;
    leave(socket);
    const name = cleanName(data?.name);
    const waiting = rooms.get(queue.code);
    if (waiting && !waiting.started && waiting.players.length < MAX_PLAYERS && waiting.host !== socket.id) {
      waiting.players.push({ id: socket.id, name });
      socket.join(waiting.code);
      socket.data.room = waiting.code;
      queue.code = null;
      cb({ ok: true, code: waiting.code, host: false });
      broadcast(waiting);
      startRoom(waiting); // двоє є — стартуємо одразу
      return;
    }
    const room = { code: makeCode(), host: socket.id, started: false, players: [{ id: socket.id, name }] };
    rooms.set(room.code, room);
    socket.join(room.code);
    socket.data.room = room.code;
    queue.code = room.code;
    cb({ ok: true, code: room.code, host: true });
    broadcast(room);
  });

  socket.on('cancelMatch', () => { if (queue.code && queue.code === socket.data.room) queue.code = null; leave(socket); });

  // ---- Ретрансляція ігрових подій між двома гравцями ----
  // cmd  : команда гравця (купівля юніта, удар по цілі) -> суперник
  // snap : знімок стану від хоста -> гість (хост рахує гру, гість показує)
  const relay = (ev) => socket.on(ev, (data) => {
    const room = rooms.get(socket.data.room);
    if (!room || !room.started) return;
    if (ev === 'snap' && room.host !== socket.id) return; // знімки приймаємо тільки від хоста
    socket.to(room.code).emit(ev, data);
  });
  ['cmd', 'snap', 'gameOver'].forEach(relay);

  // Перевірка затримки: клієнт шле ping, отримує pong
  socket.on('ping2', (cb) => typeof cb === 'function' && cb());

  socket.on('disconnect', () => leave(socket));
});

server.listen(PORT, () => console.log('Iron War server: http://localhost:' + PORT));
