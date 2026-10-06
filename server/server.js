/* ==========================================================================
   Emergency Party Board — backend
   Node.js built-ins only (no npm packages) so it runs offline on one laptop.
   The API itself lives in app.js (shared with the GitHub Pages build); this
   file adds the HTTP server, the database file, live updates and passwords.

     Roles     admin    Management Centre + moderator (in-session) tools
               officer  creates and runs a session when Officer of the Day
               user     registers, waits for assignment, submits remarks
     Storage   data/db.json (see store.js)
     Live      Server-Sent Events on /api/events — pages refresh themselves
     VR        /api/vr/:code/state and /api/vr/:code/events, keyed per session
   ========================================================================== */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const defaults = require('./defaults');
const { Store } = require('./store');
const { createApi, seed } = require('./app');

const PORT = Number(process.env.PORT) || 8080;
const HOST = process.env.HOST || '0.0.0.0';
const ROOT = path.join(__dirname, '..');
const PUBLIC = path.join(ROOT, 'public');
const DB_FILE = process.env.HEP_DB || path.join(ROOT, 'data', 'db.json');
/* Every account starts with this password unless another is given. */
const DEFAULT_PASSWORD = process.env.HEP_DEFAULT_PASSWORD || '123456';

class HttpError extends Error { constructor(status, msg) { super(msg); this.status = status; } }

/* ------------------------------------------------------------------ crypto */
const sha256 = s => crypto.createHash('sha256').update(s).digest('hex');
function hashPassword(pw) {
  const salt = crypto.randomBytes(16).toString('hex');
  return salt + ':' + crypto.scryptSync(pw, salt, 32).toString('hex');
}
function checkPassword(pw, stored) {
  if (!stored) return false;
  const [salt, hash] = stored.split(':');
  const test = crypto.scryptSync(pw, salt, 32);
  return crypto.timingSafeEqual(test, Buffer.from(hash, 'hex'));
}

/* ------------------------------------------------------------------ live updates (SSE) */
const clients = new Set();
const online = new Map();   // userId -> open connection count
function broadcast(kind, payload) {
  const msg = `event: ${kind}\ndata: ${JSON.stringify(payload || {})}\n\n`;
  for (const c of clients) c.res.write(msg);
}
setInterval(() => { for (const c of clients) c.res.write(': ping\n\n'); }, 25000).unref();

/* ------------------------------------------------------------------ store + API (app.js) */
const store = new Store(DB_FILE, () => seed(defaults));
const api = createApi({
  db: store.data, defaults, save: () => store.save(), broadcast,
  isOnline: id => online.has(id), onlineCount: () => online.size, defaultPassword: DEFAULT_PASSWORD,
  crypto: {
    randomHex: n => crypto.randomBytes(n).toString('hex'),
    randomBytes: n => crypto.randomBytes(n),
    sha256, hashPassword, checkPassword
  }
});
const bearer = req => { const h = req.headers.authorization || ''; return h.startsWith('Bearer ') ? h.slice(7) : null; };

/* ------------------------------------------------------------------ static files */
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
                '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.json': 'application/json', '.ico': 'image/x-icon', '.pdf': 'application/pdf' };
function serveStatic(url, res) {
  let p = decodeURIComponent(url.pathname);
  if (p === '/') p = '/index.html';
  const file = path.normalize(path.join(PUBLIC, p));
  if (!file.startsWith(PUBLIC + path.sep)) { res.writeHead(403); return res.end('Forbidden'); }
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain' }); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(buf);
  });
}

/* ------------------------------------------------------------------ server */
function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', c => { size += c.length; if (size > 1e6) { reject(new HttpError(413, 'Request too large.')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch (e) { reject(new HttpError(400, 'Invalid JSON.')); }
    });
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const isVR = url.pathname.startsWith('/api/vr/');
  if (isVR) {                                   // the headset app may run on another origin
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-VR-Key');
    if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
  }

  if (url.pathname === '/api/events') {        // live update stream
    const user = api.authUser(bearer(req) || url.searchParams.get('token'));
    if (!user) { res.writeHead(401); return res.end(); }
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    res.write('retry: 3000\n\n');
    const c = { res, user };
    clients.add(c);
    online.set(user.id, (online.get(user.id) || 0) + 1);
    broadcast('presence');
    req.on('close', () => {
      clients.delete(c);
      const n = (online.get(user.id) || 1) - 1;
      if (n <= 0) online.delete(user.id); else online.set(user.id, n);
      broadcast('presence');
    });
    return;
  }

  if (!url.pathname.startsWith('/api/')) return serveStatic(url, res);

  let out;
  try {
    const body = ['POST', 'PUT', 'PATCH'].includes(req.method) ? await readBody(req) : {};
    out = await api.handle(req.method, url.pathname, {
      body, token: bearer(req) || url.searchParams.get('token'),
      vrKey: req.headers['x-vr-key'] || url.searchParams.get('key')
    });
  } catch (e) {                                 // bad or oversized request body
    out = { status: e.status || 500, body: { error: e.status ? e.message : 'Server error.' } };
  }
  res.writeHead(out.status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(out.body));
});

// the administrator account exists from the first start (login "admin")
api.ensureAdmin();

// expired tokens are cleared once an hour
setInterval(() => api.pruneTokens(), 3600e3).unref();

for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { store.flush(); process.exit(0); });

server.listen(PORT, HOST, () => {
  const nets = Object.values(require('os').networkInterfaces()).flat().filter(n => n && n.family === 'IPv4' && !n.internal);
  console.log('\n  Emergency Party Board is running');
  console.log('  This computer:   http://localhost:' + PORT);
  for (const n of nets) console.log('  Same network:    http://' + n.address + ':' + PORT);
  console.log('  Database:        ' + DB_FILE);
  console.log('  Administrator:   login "admin" · new accounts get password ' + DEFAULT_PASSWORD);
  console.log('');
});
