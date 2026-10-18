
'use strict';

// Iron War — сервер: Socket.IO + акаунти + Ranked
// Запуск: npm install && node server.js
// Порт: process.env.PORT або 7680

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Server } = require('socket.io');

const PORT = Number(process.env.PORT || 7680);
const DB_FILE = process.env.DB_FILE || path.join(__dirname, 'accounts.json');
const ROOT = path.resolve(__dirname);

// ---------- Сховище акаунтів ----------

let DB = { users: {}, tokens: {} };

try {
  const loaded = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
  DB.users = loaded.users || {};
  DB.tokens = loaded.tokens || {};
} catch (err) {
  console.log('База акаунтів ще не створена. Створюємо нову.');
}

let saveT = null;

function save() {
  clearTimeout(saveT);

  saveT = setTimeout(() => {
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
  clearTimeout(saveT);
  try {
    fs.writeFileSync(DB_FILE, JSON.stringify(DB));
  } catch (err) {
    console.error('Не вдалося зберегти базу:', err.message);
  }
}

process.on('SIGINT', () => {
  saveSync();
  process.exit(0);
});

process.on('SIGTERM', () => {
  saveSync();
  process.exit(0);
});

const hashPw = (pw, salt) =>
  crypto.scryptSync(pw, salt, 64).toString('hex');

const pub = u => ({
  name: u.name,
  rp: u.rp,
  w: u.w,
  l: u.l
});

const key = name => name.toLowerCase();

function newToken(k) {
  const token = crypto.randomBytes(24).toString('hex');
  DB.tokens[token] = k;
  save();
  return token;
}

// ---------- Рейтинг ----------

const WIN_RP = 25;
const LOSE_RP = 20;
const MAX_RP = 999;

function applyResult(k, win) {
  const u = DB.users[k];
  if (!u) return null;

  const old = u.rp;

  u.rp = Math.max(
    0,
    Math.min(MAX_RP, u.rp + (win ? WIN_RP : -LOSE_RP))
  );

  if (win) u.w++;
  else u.l++;

  save();

  return {
    rp: u.rp,
    delta: u.rp - old,
    win
  };
}

// ---------- HTTP та файли гри ----------

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.ico': 'image/x-icon',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.wav': 'audio/wav',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
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

  // Забороняємо доступ до системних файлів сервера.
  const relative = pathname.replace(/^\/+/, '');
  const file = path.resolve(ROOT, relative);
  const base = path.basename(file);

  if (
    file !== ROOT &&
    !file.startsWith(ROOT + path.sep)
  ) {
    res.writeHead(403);
    return res.end('Forbidden');
  }

  if (
    /^(server\.js|accounts\.json.*|package(-lock)?\.json)$/i.test(base) ||
    base.startsWith('.')
  ) {
    res.writeHead(404);
    return res.end('Not Found');
  }

  fs.readFile(file, (err, data) => {
    if (err) {
      res.writeHead(404, {
        'Content-Type': 'text/plain; charset=utf-8'
      });
      return res.end('Not Found');
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

const io = new Server(server, {
  maxHttpBufferSize: 1e6,
  cors: {
    origin: true,
    methods: ['GET', 'POST']
  }
});

// ---------- Кімнати ----------

const rooms = new Map();
const sockRoom = new Map();
let queue = [];

const nameOf = (sock, defaultName) =>
  sock.user
    ? sock.user.name
    : (String(defaultName || '').trim().slice(0, 20) || 'Гравець');

function genCode() {
  let code;

  do {
    code = Math.random().toString(36).slice(2, 6).toUpperCase();
  } while (rooms.has(code));

  return code;
}

function roomUpdate(room) {
  io.to(room.code).emit('roomUpdate', {
    code: room.code,
    players: room.players.map(p => p.name)
  });
}

function startRoom(room) {
  if (room.started || room.players.length < 2) return;

  room.started = true;

  io.to(room.code).emit('gameStart', {
    host: room.host,
    seed: (Math.random() * 1e9) | 0,
    ranked: !!room.ranked
  });
}

function leave(sock) {
  const code = sockRoom.get(sock.id);

  queue = queue.filter(q => q.id !== sock.id);

  if (!code) return;

  sockRoom.delete(sock.id);
  sock.leave(code);

  const room = rooms.get(code);
  if (!room) return;

  // Вихід під час ранкеду зараховується як поразка.
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

  if (sock.id === room.host) {
    io.to(code).emit('roomClosed');

    for (const player of room.players) {
      sockRoom.delete(player.id);

      const s = io.sockets.sockets.get(player.id);
      if (s) s.leave(code);
    }

    rooms.delete(code);
  } else {
    room.players = room.players.filter(p => p.id !== sock.id);

    if (!room.players.length) {
      rooms.delete(code);
    } else {
      roomUpdate(room);
    }
  }
}

// ---------- Ранговий підбір ----------

function tryMatch() {
  queue = queue.filter(q => io.sockets.sockets.has(q.id));

  const now = Date.now();

  for (let i = 0; i < queue.length; i++) {
    for (let j = i + 1; j < queue.length; j++) {
      const a = queue[i];
      const b = queue[j];

      const wait = (now - Math.min(a.t, b.t)) / 1000;

      if (a.key === b.key) continue;

      const allowedDifference = 100 + wait * 15;

      if (Math.abs(a.rp - b.rp) <= allowedDifference) {
        queue = queue.filter(q => q !== a && q !== b);

        const sa = io.sockets.sockets.get(a.id);
        const sb = io.sockets.sockets.get(b.id);

        if (!sa || !sb || !sa.user || !sb.user) continue;

        const code = 'R' + genCode();

        const room = {
          code,
          host: a.id,
          ranked: true,
          started: false,
          over: false,
          players: [
            { id: a.id, name: sa.user.name, key: a.key },
            { id: b.id, name: sb.user.name, key: b.key }
          ]
        };

        rooms.set(code, room);

        for (const sock of [sa, sb]) {
          sock.join(code);
          sockRoom.set(sock.id, code);
        }

        startRoom(room);
        return tryMatch();
      }
    }
  }
}

setInterval(tryMatch, 2000);

// ---------- Захист від перебору паролів ----------

const limits = new Map();

function rateOk(ip) {
  const now = Date.now();
  const entry = limits.get(ip);

  if (!entry || now - entry.t > 60000) {
    limits.set(ip, { n: 1, t: now });
    return true;
  }

  return ++entry.n <= 12;
}

// ---------- Socket.IO ----------

io.on('connection', sock => {
  const ip = sock.handshake.address;

  sock.user = null;
  sock.ukey = null;

  const attach = k => {
    sock.user = DB.users[k];
    sock.ukey = k;
  };

  // Реєстрація.
  sock.on('register', (data, callback) => {
    const cb = typeof callback === 'function' ? callback : () => {};

    if (!rateOk(ip)) {
      return cb({
        ok: false,
        error: 'Забагато спроб, зачекай хвилину'
      });
    }

    const name = String((data && data.name) || '').trim();
    const pass = String((data && data.pass) || '');

    if (!/^[\p{L}\p{N}_\-]{3,16}$/u.test(name)) {
      return cb({
        ok: false,
        error: 'Логін: 3–16 символів (літери, цифри, _ -)'
      });
    }

    if (pass.length < 6 || pass.length > 64) {
      return cb({
        ok: false,
        error: 'Пароль має бути 6–64 символи'
      });
    }

    const k = key(name);

    if (DB.users[k]) {
      return cb({
        ok: false,
        error: 'Цей логін уже зайнятий'
      });
    }

    const salt = crypto.randomBytes(16).toString('hex');

    DB.users[k] = {
      name,
      salt,
      hash: hashPw(pass, salt),
      rp: 0,
      w: 0,
      l: 0,
      created: Date.now()
    };

    attach(k);

    cb({
      ok: true,
      user: pub(DB.users[k]),
      token: newToken(k)
    });
  });

  // Авторизація.
  sock.on('login', (data, callback) => {
    const cb = typeof callback === 'function' ? callback : () => {};

    if (!rateOk(ip)) {
      return cb({
        ok: false,
        error: 'Забагато спроб, зачекай хвилину'
      });
    }

    const name = String((data && data.name) || '').trim();
    const pass = String((data && data.pass) || '');
    const k = key(name);
    const user = DB.users[k];

    if (!user || pass.length > 64) {
      return cb({
        ok: false,
        error: 'Невірний логін або пароль'
      });
    }

    const a = Buffer.from(hashPw(pass, user.salt), 'hex');
    const b = Buffer.from(user.hash, 'hex');

    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
      return cb({
        ok: false,
        error: 'Невірний логін або пароль'
      });
    }

    attach(k);

    cb({
      ok: true,
      user: pub(user),
      token: newToken(k)
    });
  });

  // Відновлення сесії.
  sock.on('auth', (data, callback) => {
    const cb = typeof callback === 'function' ? callback : () => {};
    const token = data && DB.tokens[String(data.token)];
    const k = token;

    if (!k || !DB.users[k]) {
      return cb({ ok: false, error: 'bad_token' });
    }

    attach(k);
    cb({ ok: true, user: pub(DB.users[k]) });
  });

  // Вихід.
  sock.on('logout', data => {
    if (data && data.token && DB.tokens[data.token]) {
      delete DB.tokens[data.token];
      save();
    }

    sock.user = null;
    sock.ukey = null;

    queue = queue.filter(q => q.id !== sock.id);
  });

  // Створення приватної кімнати.
  sock.on('createRoom', (data, callback) => {
    const cb = typeof callback === 'function' ? callback : () => {};

    leave(sock);

    const code = genCode();

    const room = {
      code,
      host: sock.id,
      ranked: false,
      started: false,
      over: false,
      players: [{
        id: sock.id,
        name: nameOf(sock, data && data.name),
        key: sock.ukey || null
      }]
    };

    rooms.set(code, room);
    sock.join(code);
    sockRoom.set(sock.id, code);

    cb({ ok: true, code });
    roomUpdate(room);
  });

  // Приєднання до приватної кімнати.
  sock.on('joinPrivateRoom', (data, callback) => {
    const cb = typeof callback === 'function' ? callback : () => {};
    const code = String((data && data.code) || '').trim().toUpperCase();
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

    leave(sock);

    room.players.push({
      id: sock.id,
      name: nameOf(sock, data && data.name),
      key: sock.ukey || null
    });

    sock.join(code);
    sockRoom.set(sock.id, code);

    cb({ ok: true, code });
    roomUpdate(room);
  });

  // Запуск матчу хостом.
  sock.on('startGame', (data, callback) => {
    const cb = typeof callback === 'function' ? callback : () => {};
    const room = rooms.get(sockRoom.get(sock.id));

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

    leave(sock);

    let room = [...rooms.values()].find(
      r => r.quick && !r.started && r.players.length < 2
    );

    if (room) {
      room.players.push({
        id: sock.id,
        name: nameOf(sock, data && data.name),
        key: sock.ukey || null
      });

      sock.join(room.code);
      sockRoom.set(sock.id, room.code);

      cb({ ok: true, code: room.code, host: false });
      roomUpdate(room);
      startRoom(room);
    } else {
      const code = genCode();

      room = {
        code,
        host: sock.id,
        quick: true,
        ranked: false,
        started: false,
        over: false,
        players: [{
          id: sock.id,
          name: nameOf(sock, data && data.name),
          key: sock.ukey || null
        }]
      };

      rooms.set(code, room);
      sock.join(code);
      sockRoom.set(sock.id, code);

      cb({ ok: true, code, host: true });
      roomUpdate(room);
    }
  });

  // Черга ранкеду.
  sock.on('rankedQueue', (data, callback) => {
    const cb = typeof callback === 'function' ? callback : () => {};

    if (!sock.user) {
      return cb({ ok: false, error: 'Потрібен акаунт' });
    }

    leave(sock);

    queue.push({
      id: sock.id,
      key: sock.ukey,
      rp: sock.user.rp,
      t: Date.now()
    });

    cb({ ok: true });
    tryMatch();
  });

  sock.on('cancelRanked', () => {
    queue = queue.filter(q => q.id !== sock.id);
  });

  sock.on('leaveRoom', () => leave(sock));

  // Ігровий обмін: хост надсилає знімки, гість надсилає команди.
  sock.on('snap', data => {
    const room = rooms.get(sockRoom.get(sock.id));

    if (room && room.host === sock.id && room.started) {
      sock.to(room.code).emit('snap', data);
    }
  });

  sock.on('cmd', data => {
    const room = rooms.get(sockRoom.get(sock.id));

    if (room && room.host !== sock.id && room.started) {
      io.to(room.host).emit('cmd', data);
    }
  });

  // Завершення ранкед-матчу.
  sock.on('gameOver', data => {
    const room = rooms.get(sockRoom.get(sock.id));

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

        if (result) {
          io.to(player.id).emit('rankUpdate', result);
        }
      }
    }
  });

  sock.on('disconnect', () => leave(sock));
});

// ---------- Запуск ----------

server.on('error', err => {
  console.error('Помилка HTTP-сервера:', err);
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Iron War запущено на порту ${PORT}`);
  console.log(`Режим: ${process.env.NODE_ENV || 'production'}`);
});
