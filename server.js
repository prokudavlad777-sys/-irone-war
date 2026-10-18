// Iron War сервер: socket.io + акаунти (accounts.json) + ранкед
// Запуск: npm install && node server.js   (порт 3000 або PORT)
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Server } = require('socket.io');

const PORT = process.env.PORT || 3000;
const DB_FILE = process.env.DB_FILE || path.join(__dirname, 'accounts.json');
const ROOT = __dirname;

// ---------- Сховище акаунтів ----------
let DB = { users: {}, tokens: {} };
try { DB = Object.assign(DB, JSON.parse(fs.readFileSync(DB_FILE, 'utf8'))); } catch (e) {}
let saveT = null;
function save() {
  clearTimeout(saveT);
  saveT = setTimeout(() => {
    const tmp = DB_FILE + '.tmp';
    fs.writeFile(tmp, JSON.stringify(DB), err => { if (!err) fs.rename(tmp, DB_FILE, () => {}); });
  }, 150);
}
process.on('SIGINT', () => { try { fs.writeFileSync(DB_FILE, JSON.stringify(DB)); } catch (e) {} process.exit(0); });
process.on('SIGTERM', () => { try { fs.writeFileSync(DB_FILE, JSON.stringify(DB)); } catch (e) {} process.exit(0); });

const hashPw = (pw, salt) => crypto.scryptSync(pw, salt, 64).toString('hex');
const pub = u => ({ name: u.name, rp: u.rp, w: u.w, l: u.l });
const key = n => n.toLowerCase();
function newToken(k) {
  const t = crypto.randomBytes(24).toString('hex');
  DB.tokens[t] = k;
  save();
  return t;
}

// ---------- Ранг ----------
const WIN_RP = 25, LOSE_RP = 20, MAX_RP = 999;
function applyResult(k, win) {
  const u = DB.users[k];
  if (!u) return null;
  const old = u.rp;
  u.rp = Math.max(0, Math.min(MAX_RP, u.rp + (win ? WIN_RP : -LOSE_RP)));
  if (win) u.w++; else u.l++;
  save();
  return { rp: u.rp, delta: u.rp - old, win };
}

// ---------- HTTP ----------
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.ico': 'image/x-icon', '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.wav': 'audio/wav', '.png': 'image/png', '.css': 'text/css' };
const server = http.createServer((req, res) => {
  let p = decodeURIComponent((req.url || '/').split('?')[0]);
  if (p === '/') p = '/index.html';
  const f = path.normalize(path.join(ROOT, p));
  const base = path.basename(f);
  // не віддаємо код сервера та базу акаунтів
  if (!f.startsWith(ROOT + path.sep) || /^(server\.js|accounts\.json.*|package(-lock)?\.json)$/.test(base) || base.startsWith('.')) { res.writeHead(404); return res.end('not found'); }
  fs.readFile(f, (err, data) => {
    if (err) { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream' });
    res.end(data);
  });
});
const io = new Server(server, { maxHttpBufferSize: 1e6 });

// ---------- Кімнати ----------
const rooms = new Map(); // code -> {code, host, players:[{id,name,key}], started, ranked, over}
const sockRoom = new Map(); // socket.id -> code
let queue = []; // [{id, key, rp}]
const nameOf = (s, d) => (s.user ? s.user.name : (String(d || '').trim().slice(0, 20) || 'Гравець'));
const genCode = () => { let c; do { c = Math.random().toString(36).slice(2, 6).toUpperCase(); } while (rooms.has(c)); return c; };

function roomUpdate(r) {
  io.to(r.code).emit('roomUpdate', { code: r.code, players: r.players.map(p => p.name) });
}
function startRoom(r) {
  r.started = true;
  io.to(r.code).emit('gameStart', { host: r.host, seed: (Math.random() * 1e9) | 0, ranked: !!r.ranked });
}
function leave(sock, why) {
  const code = sockRoom.get(sock.id);
  queue = queue.filter(q => q.id !== sock.id);
  if (!code) return;
  sockRoom.delete(sock.id);
  const r = rooms.get(code);
  sock.leave(code);
  if (!r) return;
  // вихід з ранкеду посеред гри = поразка
  if (r.ranked && r.started && !r.over) {
    r.over = true;
    const lp = r.players.find(p => p.id === sock.id);
    const wp = r.players.find(p => p.id !== sock.id);
    if (lp) { const res = applyResult(lp.key, false); if (res) io.to(lp.id).emit('rankUpdate', res); }
    if (wp) { const res = applyResult(wp.key, true); if (res) io.to(wp.id).emit('rankUpdate', res); }
  }
  if (sock.id === r.host) {
    io.to(code).emit('roomClosed');
    for (const p of r.players) { sockRoom.delete(p.id); const s = io.sockets.sockets.get(p.id); if (s) s.leave(code); }
    rooms.delete(code);
  } else {
    r.players = r.players.filter(p => p.id !== sock.id);
    if (!r.players.length) rooms.delete(code); else roomUpdate(r);
  }
}

function tryMatch() {
  queue = queue.filter(q => io.sockets.sockets.get(q.id));
  // чим довше чекаєш — тим ширше допустима різниця RP
  const now = Date.now();
  for (let i = 0; i < queue.length; i++) {
    for (let j = i + 1; j < queue.length; j++) {
      const a = queue[i], b = queue[j];
      const wait = (now - Math.min(a.t, b.t)) / 1000;
      if (a.key === b.key) continue;
      if (Math.abs(a.rp - b.rp) <= 100 + wait * 15) {
        queue = queue.filter(q => q !== a && q !== b);
        const sa = io.sockets.sockets.get(a.id), sb = io.sockets.sockets.get(b.id);
        const code = 'R' + genCode();
        const r = { code, host: a.id, ranked: true, started: false, over: false, players: [{ id: a.id, name: sa.user.name, key: a.key }, { id: b.id, name: sb.user.name, key: b.key }] };
        rooms.set(code, r);
        for (const s of [sa, sb]) { s.join(code); sockRoom.set(s.id, code); }
        startRoom(r);
        return tryMatch();
      }
    }
  }
}
setInterval(tryMatch, 2000);

// ---------- Сокети ----------
const lim = new Map(); // ip -> {n, t} проти підбору паролів
function rateOk(ip) {
  const n = Date.now(), e = lim.get(ip);
  if (!e || n - e.t > 60000) { lim.set(ip, { n: 1, t: n }); return true; }
  return ++e.n <= 12;
}

io.on('connection', sock => {
  const ip = sock.handshake.address;
  sock.user = null;
  const attach = k => { sock.user = DB.users[k]; sock.ukey = k; };

  sock.on('register', (d, cb) => {
    cb = typeof cb === 'function' ? cb : () => {};
    if (!rateOk(ip)) return cb({ ok: false, error: 'Забагато спроб, зачекай хвилину' });
    const name = String((d && d.name) || '').trim(), pass = String((d && d.pass) || '');
    if (!/^[\p{L}\p{N}_\-]{3,16}$/u.test(name)) return cb({ ok: false, error: 'Логін: 3–16 символів (літери, цифри, _ -)' });
    if (pass.length < 6 || pass.length > 64) return cb({ ok: false, error: 'Пароль має бути 6–64 символи' });
    const k = key(name);
    if (DB.users[k]) return cb({ ok: false, error: 'Цей логін уже зайнятий' });
    const salt = crypto.randomBytes(16).toString('hex');
    DB.users[k] = { name, salt, hash: hashPw(pass, salt), rp: 0, w: 0, l: 0, created: Date.now() };
    attach(k);
    cb({ ok: true, user: pub(DB.users[k]), token: newToken(k) });
  });

  sock.on('login', (d, cb) => {
    cb = typeof cb === 'function' ? cb : () => {};
    if (!rateOk(ip)) return cb({ ok: false, error: 'Забагато спроб, зачекай хвилину' });
    const name = String((d && d.name) || '').trim(), pass = String((d && d.pass) || '');
    const k = key(name), u = DB.users[k];
    if (!u || pass.length > 64) return cb({ ok: false, error: 'Невірний логін або пароль' });
    const a = Buffer.from(hashPw(pass, u.salt), 'hex'), b = Buffer.from(u.hash, 'hex');
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return cb({ ok: false, error: 'Невірний логін або пароль' });
    attach(k);
    cb({ ok: true, user: pub(u), token: newToken(k) });
  });

  sock.on('auth', (d, cb) => {
    cb = typeof cb === 'function' ? cb : () => {};
    const k = d && DB.tokens[String(d.token)];
    if (!k || !DB.users[k]) return cb({ ok: false, error: 'bad_token' });
    attach(k);
    cb({ ok: true, user: pub(DB.users[k]) });
  });

  sock.on('logout', d => {
    if (d && d.token && DB.tokens[d.token]) { delete DB.tokens[d.token]; save(); }
    sock.user = null; sock.ukey = null;
    queue = queue.filter(q => q.id !== sock.id);
  });

  sock.on('createRoom', (d, cb) => {
    cb = typeof cb === 'function' ? cb : () => {};
    leave(sock);
    const code = genCode();
    const r = { code, host: sock.id, ranked: false, started: false, over: false, players: [{ id: sock.id, name: nameOf(sock, d && d.name), key: sock.ukey || null }] };
    rooms.set(code, r); sock.join(code); sockRoom.set(sock.id, code);
    cb({ ok: true, code }); roomUpdate(r);
  });

  sock.on('joinPrivateRoom', (d, cb) => {
    cb = typeof cb === 'function' ? cb : () => {};
    const code = String((d && d.code) || '').trim().toUpperCase();
    const r = rooms.get(code);
    if (!r || r.ranked) return cb({ ok: false, error: 'Кімнату не знайдено' });
    if (r.started) return cb({ ok: false, error: 'Гра вже почалась' });
    if (r.players.length >= 2) return cb({ ok: false, error: 'Кімната повна' });
    leave(sock);
    r.players.push({ id: sock.id, name: nameOf(sock, d && d.name), key: sock.ukey || null });
    sock.join(code); sockRoom.set(sock.id, code);
    cb({ ok: true, code }); roomUpdate(r);
  });

  sock.on('startGame', (d, cb) => {
    cb = typeof cb === 'function' ? cb : () => {};
    const r = rooms.get(sockRoom.get(sock.id));
    if (!r || r.host !== sock.id) return cb({ ok: false, error: 'Розпочати може лише хост' });
    if (r.players.length < 2) return cb({ ok: false, error: 'Потрібен другий гравець' });
    startRoom(r); cb({ ok: true });
  });

  // швидкий пошук (неранговий)
  sock.on('quickMatch', (d, cb) => {
    cb = typeof cb === 'function' ? cb : () => {};
    leave(sock);
    let r = [...rooms.values()].find(x => x.quick && !x.started && x.players.length < 2);
    if (r) {
      r.players.push({ id: sock.id, name: nameOf(sock, d && d.name), key: sock.ukey || null });
      sock.join(r.code); sockRoom.set(sock.id, r.code);
      cb({ ok: true, code: r.code, host: false }); roomUpdate(r); startRoom(r);
    } else {
      const code = genCode();
      r = { code, host: sock.id, quick: true, ranked: false, started: false, over: false, players: [{ id: sock.id, name: nameOf(sock, d && d.name), key: sock.ukey || null }] };
      rooms.set(code, r); sock.join(code); sockRoom.set(sock.id, code);
      cb({ ok: true, code, host: true }); roomUpdate(r);
    }
  });

  // ранкед — лише з акаунтом
  sock.on('rankedQueue', (d, cb) => {
    cb = typeof cb === 'function' ? cb : () => {};
    if (!sock.user) return cb({ ok: false, error: 'Потрібен акаунт' });
    leave(sock);
    queue.push({ id: sock.id, key: sock.ukey, rp: sock.user.rp, t: Date.now() });
    cb({ ok: true }); tryMatch();
  });
  sock.on('cancelRanked', () => { queue = queue.filter(q => q.id !== sock.id); });
  sock.on('leaveRoom', () => leave(sock));

  // ігровий обмін: хост -> гість знімки, гість -> хост команди
  sock.on('snap', d => { const r = rooms.get(sockRoom.get(sock.id)); if (r && r.host === sock.id && r.started) sock.to(r.code).emit('snap', d); });
  sock.on('cmd', d => { const r = rooms.get(sockRoom.get(sock.id)); if (r && r.host !== sock.id && r.started) io.to(r.host).emit('cmd', d); });

  sock.on('gameOver', d => {
    const r = rooms.get(sockRoom.get(sock.id));
    if (!r || r.host !== sock.id || !r.started || r.over) return;
    r.over = true;
    sock.to(r.code).emit('gameOver', d);
    if (r.ranked && d && (d.w === 0 || d.w === 1)) {
      const host = r.players.find(p => p.id === r.host), guest = r.players.find(p => p.id !== r.host);
      const hw = d.w === 0;
      for (const [p, win] of [[host, hw], [guest, !hw]]) {
        if (!p) continue;
        const res = applyResult(p.key, win);
        if (res) io.to(p.id).emit('rankUpdate', res);
      }
    }
  });

  sock.on('disconnect', () => leave(sock));
});

server.listen(PORT, () => console.log('Iron War: http://localhost:' + PORT));
