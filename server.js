/**
 * DibujoLiveShare - servidor de dibujo 3D colaborativo en tiempo real.
 *
 * Todos los clientes comparten UN MISMO contexto 3D:
 *   - el servidor guarda el estado (trazos con puntos en coordenadas de mundo)
 *   - todo lo que dibuja un cliente se replica a los demas en vivo
 *   - un cliente que entra tarde recibe el dibujo completo (init)
 *   - el estado se persiste en data/strokes.json (sobrevive al reinicio)
 *
 * Node + Express + Socket.IO + three.js (servido desde public/vendor).
 */
'use strict';

const os = require('os');
const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const express = require('express');
const { Server } = require('socket.io');

/* ------------------------------------------------------------------ */
/* configuracion                                                       */
/* ------------------------------------------------------------------ */

const PORT = Number(process.env.PORT || 3532);
const HOST = process.env.HOST || '0.0.0.0';

const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');
const DATA_DIR = path.join(ROOT, 'data');
// STATE_FILE permite correr instancias aisladas (tests, varias salas en un mismo equipo)
const STATE_FILE = process.env.STATE_FILE || path.join(DATA_DIR, 'strokes.json');

const MAX_STROKES = 20000;         // tope de trazos guardados
const MAX_POINTS_PER_STROKE = 8000; // tope de puntos por trazo
const MAX_IMPORT_STROKES = 5000;

const PALETTE = [
  '#ff4d6d', '#ffb703', '#8ac926', '#4cc9f0',
  '#b388ff', '#ff8fab', '#2ec4b6', '#f8f9fa',
];

/* ------------------------------------------------------------------ */
/* vendor: three.js -> public/vendor (asi el frontend vive en public/)  */
/* ------------------------------------------------------------------ */

function ensureThree() {
  const dest = path.join(PUBLIC_DIR, 'vendor');
  if (fs.existsSync(path.join(dest, 'three.module.js'))) return true;
  const src = path.join(ROOT, 'node_modules', 'three', 'build');
  if (!fs.existsSync(src)) {
    console.warn('[warn] three.js no esta en node_modules. Ejecuta install.bat.');
    return false;
  }
  fs.mkdirSync(dest, { recursive: true });
  for (const f of fs.readdirSync(src)) {
    const from = path.join(src, f);
    if (fs.statSync(from).isFile()) fs.copyFileSync(from, path.join(dest, f));
  }
  console.log('[ok] three.js copiado a public/vendor');
  return true;
}
ensureThree();

/* ------------------------------------------------------------------ */
/* estado compartido                                                   */
/* ------------------------------------------------------------------ */

/** trazos terminados: { id, color, size, points:[[x,y,z],...], owner, name } */
let strokes = [];
/** trazo en curso por socket: socket.id -> stroke */
const pending = new Map();
/** usuarios conectados: socket.id -> { id, name, color } */
const users = new Map();
/** contador de trazos para el id publico */
let strokeCounter = 0;

function clamp(v, a, b) { return Math.min(b, Math.max(a, v)); }
function randomId() { return crypto.randomBytes(9).toString('hex'); }

function sanitizeColor(c) {
  return (typeof c === 'string' && /^#[0-9a-fA-F]{6}$/.test(c.trim())) ? c.trim().toLowerCase() : '#4cc9f0';
}
function sanitizeSize(s) {
  const n = Number(s);
  return Number.isFinite(n) ? clamp(n, 0.005, 3) : 0.12;
}
function sanitizePoint(p) {
  if (!Array.isArray(p) || p.length < 3) return null;
  const x = Number(p[0]), y = Number(p[1]), z = Number(p[2]);
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return null;
  if (Math.abs(x) > 5000 || Math.abs(y) > 5000 || Math.abs(z) > 5000) return null;
  return [Math.round(x * 1000) / 1000, Math.round(y * 1000) / 1000, Math.round(z * 1000) / 1000];
}

function pickColor() {
  const used = new Set([...users.values()].map(u => u.color));
  const free = PALETTE.find(c => !used.has(c));
  if (free) return free;
  return PALETTE[Math.floor(Math.random() * PALETTE.length)];
}

function publicUser(u) { return { id: u.id, name: u.name, color: u.color }; }
function userList() { return [...users.values()].map(publicUser); }
function broadcastUsers() { io.emit('users', userList()); }

function broadcastStats() {
  io.emit('stats', { strokes: strokes.length, users: users.size });
}

/* ------------------------------------------------------------------ */
/* persistencia                                                        */
/* ------------------------------------------------------------------ */

function loadState() {
  try {
    const raw = fs.readFileSync(STATE_FILE, 'utf8');
    const json = JSON.parse(raw);
    const list = Array.isArray(json) ? json : json.strokes;
    if (Array.isArray(list)) {
      strokes = list
        .filter(s => s && Array.isArray(s.points))
        .map(s => ({
          id: String(s.id || randomId()),
          color: sanitizeColor(s.color),
          size: sanitizeSize(s.size),
          owner: s.owner || 'historico',
          name: s.name || s.ownerName || 'historico',
          points: s.points.map(sanitizePoint).filter(Boolean),
        }))
        .filter(s => s.points.length > 0)
        .slice(-MAX_STROKES);
    }
    console.log(`[ok] estado cargado: ${strokes.length} trazos`);
  } catch (err) {
    if (err.code !== 'ENOENT') console.warn('[warn] no se pudo leer data/strokes.json:', err.message);
    strokes = [];
  }
  strokeCounter = strokes.length;
}

let saveTimer = null;
function saveState() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      fs.mkdirSync(DATA_DIR, { recursive: true });
      fs.writeFileSync(STATE_FILE, JSON.stringify({
        savedAt: new Date().toISOString(),
        strokes,
      }));
    } catch (err) {
      console.error('[warn] no se pudo guardar el estado:', err.message);
    }
  }, 900);
}

loadState();

/* ------------------------------------------------------------------ */
/* http + socket.io                                                    */
/* ------------------------------------------------------------------ */

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' },
  maxHttpBufferSize: 5e6,
  pingTimeout: 25000,
});

app.use(express.static(PUBLIC_DIR, { extensions: ['html'] }));

app.get('/health', (_req, res) => {
  res.json({
    ok: true,
    uptime: Math.round(process.uptime()),
    users: users.size,
    strokes: strokes.length,
    points: strokes.reduce((a, s) => a + s.points.length, 0),
  });
});

app.get('/api/state', (_req, res) => {
  res.json({ strokes, users: userList() });
});

function localUrls() {
  const urls = [`http://localhost:${PORT}`];
  const nets = os.networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const net of nets[name] || []) {
      if (net.family === 'IPv4' && !net.internal) urls.push(`http://${net.address}:${PORT}`);
    }
  }
  return urls;
}

/* ------------------------------------------------------------------ */
/* logica de trazos                                                    */
/* ------------------------------------------------------------------ */

function startStroke(socket, data) {
  const user = users.get(socket.id);
  const id = (typeof data?.id === 'string' && data.id.length <= 64 && data.id.length > 0)
    ? data.id
    : `${socket.id.slice(0, 6)}-${randomId()}`;

  // si habia un trazo sin cerrar de este socket, lo cerramos y lo ANUNCIAMOS:
  // asi todos (incluida la pantalla output3d) lo ven como terminado
  if (pending.has(socket.id)) finishStroke(socket);

  const stroke = {
    id,
    color: sanitizeColor(data?.color),
    size: sanitizeSize(data?.size),
    points: [],
    owner: socket.id,
    name: user ? user.name : 'Invitado',
  };
  pending.set(socket.id, stroke);
  socket.broadcast.emit('stroke:start', {
    id: stroke.id,
    color: stroke.color,
    size: stroke.size,
    owner: stroke.owner,
    name: stroke.name,
  });
  return stroke;
}

function appendPoints(socket, data) {
  const stroke = pending.get(socket.id);
  if (!stroke) return;
  const list = Array.isArray(data?.points) ? data.points : (data?.point ? [data.point] : []);
  const clean = [];
  for (const p of list) {
    const q = sanitizePoint(p);
    if (q) clean.push(q);
    if (stroke.points.length + clean.length >= MAX_POINTS_PER_STROKE) break;
  }
  if (clean.length === 0) return;
  stroke.points.push(...clean);
  socket.broadcast.emit('stroke:point', { id: stroke.id, points: clean });
}

function finishStroke(socket) {
  const stroke = pending.get(socket.id);
  if (!stroke) return;
  pending.delete(socket.id);
  if (stroke.points.length > 0) {
    strokes.push(stroke);
    strokeCounter = strokes.length;
    if (strokes.length > MAX_STROKES) strokes.splice(0, strokes.length - MAX_STROKES);
    saveState();
    broadcastStats();
  }
  socket.broadcast.emit('stroke:end', { id: stroke.id });
}

function removeStrokeById(id, by) {
  let removed = false;
  for (const [sid, s] of pending) {
    if (s.id === id) { pending.delete(sid); removed = true; }
  }
  const idx = strokes.findIndex(s => s.id === id);
  if (idx !== -1) { strokes.splice(idx, 1); removed = true; }
  if (removed) {
    saveState();
    broadcastStats();
    io.emit('stroke:remove', { id, by: by || null });
  }
  return removed;
}

function undoFor(socket) {
  // ultimo trazo de este socket (terminado o en curso)
  for (let i = strokes.length - 1; i >= 0; i--) {
    if (strokes[i].owner === socket.id) return removeStrokeById(strokes[i].id, socket.id);
  }
  const p = pending.get(socket.id);
  if (p) { pending.delete(socket.id); return removeStrokeById(p.id, socket.id); }
  return false;
}

/* ------------------------------------------------------------------ */
/* eventos                                                             */
/* ------------------------------------------------------------------ */

io.on('connection', (socket) => {
  // Pantalla de salida (?view=1): recibe el estado y los eventos de lectura,
  // pero no se registra como usuario ni puede escribir nada.
  if (String(socket.handshake.query?.view || '') === '1') {
    socket.emit('init', {
      viewer: true,
      self: null,
      users: userList(),
      strokes,
      stats: { strokes: strokes.length, users: users.size },
      urls: localUrls(),
      limits: { maxPointsPerStroke: MAX_POINTS_PER_STROKE },
    });
    console.log(`[view] pantalla de salida conectada (${socket.id.slice(0, 6)})`);
    socket.on('disconnect', () => console.log('[view] pantalla de salida desconectada'));
    return;
  }

  const user = {
    id: socket.id,
    name: 'Invitado',
    color: pickColor(),
  };
  users.set(socket.id, user);

  socket.emit('init', {
    self: publicUser(user),
    users: userList(),
    strokes,
    stats: {
      strokes: strokes.length,
      users: users.size,
    },
    urls: localUrls(),
    limits: { maxPointsPerStroke: MAX_POINTS_PER_STROKE },
  });

  socket.broadcast.emit('user:join', publicUser(user));
  broadcastUsers();
  broadcastStats();
  console.log(`[+] ${user.name} (${socket.id.slice(0, 6)}) conectado - ${users.size} en linea`);

  socket.on('rename', (name) => {
    const clean = String(name || '').replace(/[\u0000-\u001f]/g, '').trim().slice(0, 24);
    user.name = clean || 'Invitado';
    broadcastUsers();
    io.emit('user:rename', publicUser(user));
  });

  socket.on('stroke:start', (data) => { startStroke(socket, data); });

  socket.on('stroke:point', (data) => { appendPoints(socket, data); });

  socket.on('stroke:end', () => { finishStroke(socket); });

  socket.on('stroke:erase', (data) => {
    const id = String(data?.id || '');
    if (id) removeStrokeById(id, socket.id);
  });

  socket.on('undo', () => { undoFor(socket); });

  socket.on('clear', () => {
    strokes = [];
    pending.clear();
    saveState();
    broadcastStats();
    io.emit('clear', { by: socket.id, name: user.name });
  });

  // importar un dibujo (JSON exportado por otro usuario)
  socket.on('import', (data) => {
    const list = Array.isArray(data?.strokes) ? data.strokes.slice(0, MAX_IMPORT_STROKES) : [];
    const added = [];
    for (const raw of list) {
      if (!raw || !Array.isArray(raw.points)) continue;
      const points = raw.points.map(sanitizePoint).filter(Boolean);
      if (points.length === 0) continue;
      added.push({
        id: `imp-${randomId()}`,
        color: sanitizeColor(raw.color),
        size: sanitizeSize(raw.size),
        points,
        owner: socket.id,
        name: user.name,
      });
    }
    if (added.length === 0) return;
    strokes.push(...added);
    if (strokes.length > MAX_STROKES) strokes.splice(0, strokes.length - MAX_STROKES);
    saveState();
    broadcastStats();
    io.emit('strokes:add', { strokes: added });
    console.log(`[i] ${user.name} importo ${added.length} trazos`);
  });

  socket.on('cursor', (data) => {
    const p = sanitizePoint(data?.p);
    socket.broadcast.emit('cursor', {
      id: socket.id,
      name: user.name,
      color: user.color,
      p,
      depth: Number(data?.depth) || null,
    });
  });

  socket.on('disconnect', (reason) => {
    // trazo que quedo a medio hacer: no entra al estado compartido, pero avisamos
    // para que los clientes (y la pantalla output3d) suelten lo que bufferizaron
    const abierto = pending.get(socket.id);
    pending.delete(socket.id);
    if (abierto) io.emit('stroke:remove', { id: abierto.id, by: socket.id, reason: 'abandonado' });
    users.delete(socket.id);
    socket.broadcast.emit('user:leave', { id: socket.id });
    broadcastUsers();
    broadcastStats();
    console.log(`[-] ${user.name} (${socket.id.slice(0, 6)}) salio (${reason}) - ${users.size} en linea`);
  });
});

/* ------------------------------------------------------------------ */
/* arranque                                                            */
/* ------------------------------------------------------------------ */

server.listen(PORT, HOST, () => {
  const urls = localUrls();
  console.log('');
  console.log('  ==============================================');
  console.log('   DibujoLiveShare - servidor arriba');
  console.log('  ==============================================');
  console.log('');
  console.log(`   Local    : ${urls[0]}`);
  for (const u of urls.slice(1)) console.log(`   Red      : ${u}   <-- pasa este link a los demas`);
  console.log('');
  console.log(`   Trazos en memoria : ${strokes.length}`);
  console.log('   Ctrl+C para detener');
  console.log('');
});

process.on('SIGINT', () => {
  console.log('\nGuardando estado y saliendo...');
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify({ savedAt: new Date().toISOString(), strokes }));
  } catch (_) { /* noop */ }
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1500);
});
