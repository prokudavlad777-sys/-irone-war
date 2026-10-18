
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Server } = require('socket.io');

// ---------- Конфігурація ----------

const PORT = Number(process.env.PORT || 7680);
const HOST = '0.0.0.0';
const ROOT = path.resolve(__dirname, 'public');
const DB_FILE = process.env.DB_FILE || path.join(__dirname, 'accounts.json');

if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) {
  throw new Error('Некоректний PORT: ' + process.env.PORT);
}

// ---------- База акаунтів ----------

let DB = { users: {}, tokens: {} };

try {
  const loaded = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
  DB.users = loaded.users || {};
  DB.tokens = loaded.tokens || {};
} catch (err) {
  console.log('База акаунтів буде створена автоматично.');
}

let saveTimer = null;

function save() {
  clearTimeout(saveTimer);

  saveTimer = setTimeout(() => {
    const tmp = DB_FILE + '.tmp';

    fs.writeFile(tmp, JSON.stringify(DB), err => {
      if (err) {
        console.error('Помилка запису бази:', err.message);
        return;
      }

      fs.rename(tmp, DB_FILE, err => {
        if (err) console.error('Помилка збереження бази:', err.message);
      });
    });
  }, 150);
}

function saveSync() {
  clearTimeout(saveTimer);

  try {
    fs.writeFileSync(DB_FILE, JSON.stringify(DB));
  } catch (err) {
    console.error('Не вдалося зберегти базу:', err.message);
  }
}

let shuttingDown = false;

function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;

  saveSync();

  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 5000).unref();
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

const hashPw = (password, salt) =>
  crypto.scryptSync(password, salt, 64).toString('hex');

const publicUser = user => ({
  name: user.name,
  rp: user.rp,
  w: user.w,
  l: user.l
});

const normalizeName = name => name.toLowerCase();

function newToken(userKey) {
  const token = crypto.randomBytes(32).toString('hex');
  DB.tokens[token] = userKey;
  save();
  return token;
}

// ---------- Рейтинг ----------

const WIN_RP = 25;
const LOSE_RP = 20;
const MAX_RP = 999;

function applyResult(userKey, won) {
  const user = DB.users[userKey];
  if (!user) return null;

  const oldRP = user.rp;

  user.rp = Math.max(
    0,
    Math.min(MAX_RP, user.rp + (won ? WIN_RP : -LOSE_RP))
  );

  if (won) user.w++;
  else user.l++;

  save();

  return {
    rp: user.rp,
    delta: user.rp - oldRP,
    win: won
  };
}

// ---------- HTTP та статичні файли ----------

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.wav': 'audio/wav',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf'
};

const server = http.createServer((req, res) => {
  let pathname;

  try {
    pathname = decodeURIComponent(
      (req.url || '/').split('?')[0]
    );
  } catch {
    res.writeHead(400);
    return res.end('Bad Request');
  }

  if (pathname === '/') pathname = '/index.html';

  const relative = pathname.replace(/^\/+/, '');
  const file = path.resolve(ROOT, relative);

  if (file !== ROOT && !file.startsWith(ROOT + path.sep)) {
    res.writeHead(403);
    return res.end('Forbidden');
  }

  if (path.basename(file).startsWith('.')) {
    res.writeHead(404);
    return res.end('Not Found');
  }

  fs.stat(file, (statErr, stat) => {
    if (statErr || !stat.isFile()) {
      res.writeHead(404, {
        'Content-Type': 'text/plain; charset=utf-8'
      });
      return res.end('Not Found');
    }

    fs.readFile(file, (err, data) => {
      if (err) {
        res.writeHead(500);
        return res.end('Internal Server Error');
      }

      res.writeHead(200, {
        'Content-Type':
          MIME[path.extname(file).toLowerCase()] ||
          'application/octet-stream',
        'X-Content-Type-Options': 'nosniff'
      });

      res.end(data);
    });
  });
});

// ---------- Socket.IO ----------

const io = new Server(server, {
  maxHttpBufferSize: 1e6,
  cors: {
    origin: true,
    methods: ['GET', 'POST']
  }
});

// ---------- Кімнати ----------

const rooms = new Map();
const socketRooms = new Map();
let queue = [];

function playerName(sock, fallback) {
  return sock.user
    ? sock.user.name
    : String(fallback || '').trim().slice(0, 20) || 'Гравець';
}

function generateCode() {
  let code;

  do {
    code = Math.random().toString(36).slice(2, 6).toUpperCase();
  } while (rooms.has(code));

  return code;
}

function updateRoom(room) {
  io.to(room.code).emit('roomUpdate', {
    code: room.code,
    players: room.players.map(player => player.name)
  });
}

function startRoom(room) {
  if (room.started || room.players.length < 2) return;

  room.started = true;

  io.to(room.code).emit('gameStart', {
    host: room.host,
    seed: crypto.randomInt(0, 1000000000),
    ranked: Boolean(room.ranked)
  });
}

function leaveRoom(sock) {
  queue = queue.filter(item => item.id !== sock.id);

  const code = socketRooms.get(sock.id);
  if (!code) return;

  socketRooms.delete(sock.id);
  sock.leave(code);

  const room = rooms.get(code);
  if (!room) return;

  if (room.ranked && room.started && !room.over) {
    room.over = true;

    const loser = room.players.find(p => p.id === sock.id);
    const winner = room.players.find(p => p.id !== sock.id);

    if (loser) {
      const result = applyResult(loser.key, false);
      if (result) io.to(loser.id).emit('rankUpdate', result);
    }

    if (winner) {
      const result = applyResult(winner.key, true);
      if (result) io.to(winner.id).emit('rankUpdate', result);
    }
  }

  if (room.host === sock.id) {
    io.to(code).emit('roomClosed');

    for (const player of room.players) {
      socketRooms.delete(player.id);

      const other = io.sockets.sockets.get(player.id);
      if (other) other.leave(code);
    }

    rooms.delete(code);
    return;
  }

  room.players = room.players.filter(p => p.id !== sock.id);

  if (room.players.length === 0) {
    rooms.delete(code);
  } else {
    updateRoom(room);
  }
}

// ---------- Пошук ранкед-матчів ----------

function tryMatch() {
  queue = queue.filter(item =>
    io.sockets.sockets.has(item.id)
  );

  const now = Date.now();

  for (let i = 0; i < queue.length; i++) {
    for (let j = i + 1; j < queue.length; j++) {
      const a = queue[i];
      const b = queue[j];

      if (a.key === b.key) continue;

      const wait = (now - Math.min(a.t, b.t)) / 1000;
      const maxDifference = 100 + wait * 15;

      if (Math.abs(a.rp - b.rp) > maxDifference) continue;

      const sa = io.sockets.sockets.get(a.id);
      const sb = io.sockets.sockets.get(b.id);

      if (!sa || !sb || !sa.user || !sb.user) continue;

      queue = queue.filter(item => item !== a && item !== b);

      const code = 'R' + generateCode();

      const room = {
        code,
        host: sa.id,
        ranked: true,
        started: false,
        over: false,
        players: [
          { id: sa.id, name: sa.user.name, key: a.key },
          { id: sb.id, name: sb.user.name, key: b.key }
        ]
      };

      rooms.set(code, room);

      sa.join(code);
      sb.join(code);

      socketRooms.set(sa.id, code);
      socketRooms.set(sb.id, code);

      startRoom(room);
      return tryMatch();
    }
  }
}

const matchTimer = setInterval(tryMatch, 2000);

// ---------- Обмеження запитів ----------

const rateLimits = new Map();

function rateOk(ip) {
  const now = Date.now();
  const entry = rateLimits.get(ip);

  if (!entry || now - entry.t > 60000) {
    rateLimits.set(ip, { n: 1, t: now });
    return true;
  }

  entry.n++;
  return entry.n <= 12;
}

// ---------- Обробники Socket.IO ----------

io.on('connection', sock => {
  const ip = sock.handshake.address;

  sock.user = null;
  sock.userKey = null;

  function attach(userKey) {
    sock.user = DB.users[userKey];
    sock.userKey = userKey;
  }

  // Реєстрація.
  sock.on('register', (data, callback) => {
    const cb = typeof callback === 'function' ? callback : () => {};

    if (!rateOk(ip)) {
      return cb({ ok: false, error: 'Забагато спроб, зачекай хвилину' });
    }

    const name = String(data?.name || '').trim();
    const password = String(data?.pass || '');

    if (!/^[\p{L}\p{N}_-]{3,16}$/u.test(name)) {
      return cb({
        ok: false,
        error: 'Логін: 3–16 символів (літери, цифри, _ -)'
      });
    }

    if (password.length < 6 || password.length > 64) {
      return cb({
        ok: false,
        error: 'Пароль має бути 6–64 символи'
      });
    }

    const userKey = normalizeName(name);

    if (DB.users[userKey]) {
      return cb({ ok: false, error: 'Цей логін уже зайнятий' });
    }

    const salt = crypto.randomBytes(16).toString('hex');

    DB.users[userKey] = {
      name,
      salt,
      hash: hashPw(password, salt),
      rp: 0,
      w: 0,
      l: 0,
      created: Date.now()
    };

    attach(userKey);

    cb({
      ok: true,
      user: publicUser(DB.users[userKey]),
      token: newToken(userKey)
    });
  });

  // Вхід.
  sock.on('login', (data, callback) => {
    const cb = typeof callback === 'function' ? callback : () => {};

    if (!rateOk(ip)) {
      return cb({ ok: false, error: 'Забагато спроб, зачекай хвилину' });
    }

    const name = String(data?.name || '').trim();
    const password = String(data?.pass || '');
    const userKey = normalizeName(name);
    const user = DB.users[userKey];

    if (!user || password.length > 64) {
      return cb({ ok: false, error: 'Невірний логін або пароль' });
    }

    const actual = Buffer.from(hashPw(password, user.salt), 'hex');
    const expected = Buffer.from(user.hash, 'hex');

    if (
      actual.length !== expected.length ||
      !crypto.timingSafeEqual(actual, expected)
    ) {
      return cb({ ok: false, error: 'Невірний логін або пароль' });
    }

    attach(userKey);

    cb({
      ok: true,
      user: publicUser(user),
      token: newToken(userKey)
    });
  });

  // Відновлення сесії.
  sock.on('auth', (data, callback) => {
    const cb = typeof callback === 'function' ? callback : () => {};
    const token = String(data?.token || '');
    const userKey = DB.tokens[token];

    if (!userKey || !DB.users[userKey]) {
      return cb({ ok: false, error: 'bad_token' });
    }

    attach(userKey);
    cb({ ok: true, user: publicUser(DB.users[userKey]) });
  });

  // Вихід.
  sock.on('logout', data => {
    const token = String(data?.token || '');

    if (token && DB.tokens[token]) {
      delete DB.tokens[token];
      save();
    }

    sock.user = null;
    sock.userKey = null;

    queue = queue.filter(item => item.id !== sock.id);
  });

  // Створення кімнати.
  sock.on('createRoom', (data, callback) => {
    const cb = typeof callback === 'function' ? callback : () => {};

    leaveRoom(sock);

    const code = generateCode();

    const room = {
      code,
      host: sock.id,
      ranked: false,
      started: false,
      over: false,
      players: [{
        id: sock.id,
        name: playerName(sock, data?.name),
        key: sock.userKey
      }]
    };

    rooms.set(code, room);
    sock.join(code);
    socketRooms.set(sock.id, code);

    cb({ ok: true, code });
    updateRoom(room);
  });

  // Приєднання до приватної кімнати.
  sock.on('joinPrivateRoom', (data, callback) => {
    const cb = typeof callback === 'function' ? callback : () => {};
    const code = String(data?.code || '').trim().toUpperCase();
    const room = rooms.get(code);

    if (!room || room.ranked) {
      return cb({ ok: false, error: 'Кімнату не знайдено' });
    }

    if (room.started) {
      return cb({ ok: false, error: 'Гра вже почалась' });
    }

    if (room.players.length >= 2) {
      return cb({ ok: false, error: 'Кімната повна' });
    }

    leaveRoom(sock);

    room.players.push({
      id: sock.id,
      name: playerName(sock, data?.name),
      key: sock.userKey
    });

    sock.join(code);
    socketRooms.set(sock.id, code);

    cb({ ok: true, code });
    updateRoom(room);
  });

  // Початок матчу.
  sock.on('startGame', (data, callback) => {
    const cb = typeof callback === 'function' ? callback : () => {};
    const room = rooms.get(socketRooms.get(sock.id));

    if (!room || room.host !== sock.id) {
      return cb({ ok: false, error: 'Розпочати може лише хост' });
    }

    if (room.players.length < 2) {
      return cb({ ok: false, error: 'Потрібен другий гравець' });
    }

    startRoom(room);
    cb({ ok: true });
  });

  // Швидкий пошук.
  sock.on('quickMatch', (data, callback) => {
    const cb = typeof callback === 'function' ? callback : () => {};

    leaveRoom(sock);

    let room = [...rooms.values()].find(
      r => r.quick && !r.started && r.players.length < 2
    );

    if (room) {
      room.players.push({
        id: sock.id,
        name: playerName(sock, data?.name),
        key: sock.userKey
      });

      sock.join(room.code);
      socketRooms.set(sock.id, room.code);

      cb({ ok: true, code: room.code, host: false });
      updateRoom(room);
      startRoom(room);
    } else {
      const code = generateCode();

      room = {
        code,
        host: sock.id,
        quick: true,
        ranked: false,
        started: false,
        over: false,
        players: [{
          id: sock.id,
          name: playerName(sock, data?.name),
          key: sock.userKey
        }]
      };

      rooms.set(code, room);
      sock.join(code);
      socketRooms.set(sock.id, code);

      cb({ ok: true, code, host: true });
      updateRoom(room);
    }
  });

  // Ранговий пошук.
  sock.on('rankedQueue', (data, callback) => {
    const cb = typeof callback === 'function' ? callback : () => {};

    if (!sock.user) {
      return cb({ ok: false, error: 'Потрібен акаунт' });
    }

    leaveRoom(sock);

    queue.push({
      id: sock.id,
      key: sock.userKey,
      rp: sock.user.rp,
      t: Date.now()
    });

    cb({ ok: true });
    tryMatch();
  });

  sock.on('cancelRanked', () => {
    queue = queue.filter(item => item.id !== sock.id);
  });

  sock.on('leaveRoom', () => leaveRoom(sock));

  // Хост -> гість: ігрові знімки.
  sock.on('snap', data => {
    const room = rooms.get(socketRooms.get(sock.id));

    if (room && room.host === sock.id && room.started) {
      sock.to(room.code).emit('snap', data);
    }
  });

  // Гість -> хост: ігрові команди.
  sock.on('cmd', data => {
    const room = rooms.get(socketRooms.get(sock.id));

    if (room && room.host !== sock.id && room.started) {
      io.to(room.host).emit('cmd', data);
    }
  });

  // Завершення ранкед-матчу.
  sock.on('gameOver', data => {
    const room = rooms.get(socketRooms.get(sock.id));

    if (!room || room.host !== sock.id || !room.started || room.over) {
      return;
    }

    room.over = true;
    sock.to(room.code).emit('gameOver', data);

    if (room.ranked && data && (data.w === 0 || data.w === 1)) {
      const host = room.players.find(p => p.id === room.host);
      const guest = room.players.find(p => p.id !== room.host);
      const hostWon = data.w === 0;

      for (const [player, won] of [
        [host, hostWon],
        [guest, !hostWon]
      ]) {
        if (!player) continue;

        const result = applyResult(player.key, won);
        if (result) io.to(player.id).emit('rankUpdate', result);
      }
    }
  });

  sock.on('disconnect', () => leaveRoom(sock));
});

// ---------- Запуск сервера ----------

server.on('error', err => {
  console.error('HTTP server error:', err);
});

server.listen(PORT, HOST, () => {
  console.log(`Iron War запущено на ${HOST}:${PORT}`);
  console.log(`Статичні файли: ${ROOT}`);
  console.log(`База акаунтів: ${DB_FILE}`);
});

io.engine.on('connection_error', err => {
  console.error('Socket.IO connection error:', err.message);
});

process.on('unhandledRejection', err => {
  console.error('Unhandled rejection:', err);
});
