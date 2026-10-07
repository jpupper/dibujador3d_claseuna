/**
 * DibujoLiveShare - cliente 3D colaborativo
 * three.js (core) + Socket.IO. Sin build step: se sirve tal cual desde public/.
 *
 * Idea: el pincel proyecta el mouse sobre un plano perpendicular a la camara
 * ubicado a "profundidad" (depth) unidades. El punto resultante queda en
 * coordenadas de MUNDO, asi que al rotar la camara los trazos se ven en 3D.
 */
import * as THREE from './vendor/three.module.js';
import { PALETTE, createView, CameraRig, StrokeBoard } from './engine3d.js';

/* ================================================================== */
/* constantes / estado                                                */
/* ================================================================== */

const CURSOR_MS = 45;           // throttle de envio de cursor
const FLUSH_MS = 40;            // cada cuanto se mandan puntos al servidor

const state = {
  name: localStorage.getItem('dls:name') || '',
  tool: 'brush',
  color: PALETTE[3],
  size: 0.12,
  depth: 5,
  drawing: null,       // trazo local en curso
  hovering: false,
};

let selfId = null;

/* ================================================================== */
/* escena                                                             */
/* ================================================================== */

const canvas = document.getElementById('scene');
const { renderer, scene, camera, strokesGroup } = createView(canvas);

/* ================================================================== */
/* camara orbital propia (no hay OrbitControls: el click izq. dibuja)  */
/* ================================================================== */

const rig = new CameraRig(camera);
rig.apply();

/* ================================================================== */
/* plano de dibujo (guia visual de la profundidad)                     */
/* ================================================================== */

const planeGroup = new THREE.Group();
{
  const half = 8;
  const pts = [];
  for (let i = -half; i <= half; i++) {
    pts.push(new THREE.Vector3(i, -half, 0), new THREE.Vector3(i, half, 0));
    pts.push(new THREE.Vector3(-half, i, 0), new THREE.Vector3(half, i, 0));
  }
  const grid = new THREE.LineSegments(
    new THREE.BufferGeometry().setFromPoints(pts),
    new THREE.LineBasicMaterial({ color: 0x4cc9f0, transparent: true, opacity: 0.22 }),
  );
  planeGroup.add(grid);

  const b = half;
  const border = new THREE.LineLoop(
    new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(-b, -b, 0), new THREE.Vector3(b, -b, 0),
      new THREE.Vector3(b, b, 0), new THREE.Vector3(-b, b, 0),
    ]),
    new THREE.LineBasicMaterial({ color: 0x4cc9f0, transparent: true, opacity: 0.4 }),
  );
  planeGroup.add(border);
}
scene.add(planeGroup);

// rayo guia desde la camara hasta el punto de dibujo
const beam = new THREE.Line(
  new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]),
  new THREE.LineDashedMaterial({
    color: 0x4cc9f0, transparent: true, opacity: 0.5,
    dashSize: 0.25, gapSize: 0.18,
  }),
);
beam.visible = false;
scene.add(beam);

// punto de mira (donde va a caer el pincel)
const reticle = new THREE.Group();
{
  const dot = new THREE.Mesh(
    new THREE.SphereGeometry(1, 12, 10),
    new THREE.MeshBasicMaterial({ color: 0xffffff }),
  );
  reticle.add(dot);
  const ring = new THREE.Mesh(
    new THREE.RingGeometry(1.6, 2.0, 32),
    new THREE.MeshBasicMaterial({ color: 0xffffff, side: THREE.DoubleSide, transparent: true, opacity: 0.8 }),
  );
  reticle.add(ring);
  reticle.visible = false;
}
scene.add(reticle);

/* ================================================================== */
/* motor de trazos (compartido con output3d via engine3d.js)           */
/* ================================================================== */

const board = new StrokeBoard(scene, strokesGroup);   // montado sobre strokesGroup: el borrador raycastea ahi
const strokes = board.strokes;                       // Map id -> trazo

const createStroke = (id, color, size, owner) => board.add(id, color, size, owner);
const pushPoint = (s, p) => board.push(s, p);
const addStrokeFromPoints = (points, color, size, id, owner) => board.addFromPoints(points, color, size, id, owner);
function removeStroke(id) {
  if (!board.remove(id)) return;
  if (state.drawing && state.drawing.id === id) state.drawing = null;
}
function clearAll() {
  board.clear();
  updateStats();
}

/* ================================================================== */
/* proyeccion mouse -> mundo                                           */
/* ================================================================== */

const raycaster = new THREE.Raycaster();
const ndc = new THREE.Vector2(0, 0);
const hitPoint = new THREE.Vector3();
const hasHit = { v: false };

function forwardOf() {
  const v = new THREE.Vector3();
  camera.getWorldDirection(v);
  return v;
}

/** punto del mundo bajo (cx,cy) sobre el plano a distancia `depth` de la camara */
function screenToWorld(cx, cy, depth) {
  const r = canvas.getBoundingClientRect();
  ndc.x = ((cx - r.left) / r.width) * 2 - 1;
  ndc.y = -((cy - r.top) / r.height) * 2 + 1;

  const fwd = forwardOf();
  const origin = camera.position.clone().addScaledVector(fwd, depth);
  const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(fwd.clone().negate(), origin);

  raycaster.setFromCamera(ndc, camera);
  const out = new THREE.Vector3();
  return raycaster.ray.intersectPlane(plane, out) ? out : null;
}

/* ================================================================== */
/* red                                                                 */
/* ================================================================== */

const socket = io();
window.socket = socket;   // util para depurar
let pendingPoints = [];
let flushTimer = null;
let lastCursorSent = 0;
const pendingCursor = { p: null, depth: null };

function flushPoints(force) {
  if (pendingPoints.length === 0) return;
  if (!force && flushTimer) return;
  socket.emit('stroke:point', { id: state.drawing?.id, points: pendingPoints });
  pendingPoints = [];
}

function queuePoint(p) {
  pendingPoints.push(p);
  if (pendingPoints.length >= 24) { flushPoints(true); return; }
  if (!flushTimer) flushTimer = setTimeout(() => { flushTimer = null; flushPoints(true); }, FLUSH_MS);
}

function sendCursor(p, depth) {
  const now = performance.now();
  pendingCursor.p = p ? [p.x, p.y, p.z] : null;
  pendingCursor.depth = depth;
  if (now - lastCursorSent < CURSOR_MS) return;
  lastCursorSent = now;
  socket.emit('cursor', { p: pendingCursor.p, depth: pendingCursor.depth });
}

socket.on('connect', () => {
  setStatus('on', 'conectado');
  if (state.name) socket.emit('rename', state.name);
});

socket.on('disconnect', () => setStatus('off', 'desconectado'));
socket.io.on('reconnect_attempt', () => setStatus('', 'reconectando…'));

socket.on('init', (data) => {
  selfId = data.self.id;
  clearAll();
  for (const s of data.strokes || []) addStrokeFromPoints(s.points, s.color, s.size, s.id, s.owner);
  renderUsers(data.users || []);
  // el link a compartir es siempre la dirección de red: la de localhost no le sirve al celular
  const shareEl = document.getElementById('share-link');
  const lan = (data.urls || []).find((u) => !/localhost|127\.0\.0\.1/.test(u));
  if (shareEl) shareEl.value = lan || location.origin;
  updateStats(data.stats);
  toast(`Contexto cargado: ${(data.strokes || []).length} trazos compartidos`);
});

socket.on('users', (list) => {
  renderUsers(list);
  updateStats({ users: list.length });
});

socket.on('stats', (s) => updateStats(s));

socket.on('stroke:start', (d) => {
  createStroke(d.id, d.color, d.size, d.owner);
});

socket.on('stroke:point', (d) => {
  const s = strokes.get(d.id);
  if (!s) return;
  for (const p of d.points || []) pushPoint(s, p);
});

socket.on('stroke:end', (d) => {
  const s = strokes.get(d.id);
  if (s && s.points.length) updateStats();
});

socket.on('stroke:remove', (d) => removeStroke(d.id));

socket.on('strokes:add', (d) => {
  for (const s of d.strokes || []) addStrokeFromPoints(s.points, s.color, s.size, s.id, s.owner);
  updateStats();
});

socket.on('clear', (d) => {
  clearAll();
  toast(d && d.name ? `${d.name} limpió el lienzo` : 'El lienzo se limpió');
});

socket.on('cursor', (d) => updateRemoteCursor(d.id, d.name, d.color, d.p, d.depth));

socket.on('user:join', (u) => toast(`${u.name} se unió`, u.color));
socket.on('user:leave', (d) => removeRemoteCursor(d.id));
socket.on('user:rename', (u) => renameRemoteCursor(u.id, u.name, u.color));

/* ================================================================== */
/* cursores remotos                                                    */
/* ================================================================== */

const remote = new Map(); // id -> {group, sprite, target, lastSeen, color, name}
let labelCanvas = null;

function makeLabel(name, color) {
  labelCanvas = labelCanvas || document.createElement('canvas');
  const c = document.createElement('canvas');
  c.width = 256; c.height = 64;
  const g = c.getContext('2d');
  g.font = 'bold 34px Segoe UI, sans-serif';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillStyle = 'rgba(8,11,20,0.72)';
  const w = Math.min(240, g.measureText(name).width + 30);
  const x = (256 - w) / 2;
  if (g.roundRect) { g.beginPath(); g.roundRect(x, 12, w, 40, 12); g.fill(); }
  else g.fillRect(x, 12, w, 40);
  g.fillStyle = color;
  g.fillText(name, 128, 33);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false }));
  sp.scale.set(1.5, 0.375, 1);
  sp.position.set(0, 0.42, 0);
  return sp;
}

function ensureRemote(id, name, color) {
  let r = remote.get(id);
  if (!r) {
    const group = new THREE.Group();
    const ball = new THREE.Mesh(
      new THREE.SphereGeometry(0.075, 12, 10),
      new THREE.MeshBasicMaterial({ color }),
    );
    group.add(ball);
    const glow = new THREE.Mesh(
      new THREE.SphereGeometry(0.15, 12, 10),
      new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.22 }),
    );
    group.add(glow);
    group.add(makeLabel(name || 'Invitado', color));
    group.visible = false;
    scene.add(group);
    r = { group, target: new THREE.Vector3(), lastSeen: 0, name: name || 'Invitado', color };
    remote.set(id, r);
  }
  return r;
}

function updateRemoteCursor(id, name, color, p, depth) {
  if (id === selfId || !p) return;
  const r = ensureRemote(id, name, color);
  r.target.set(p[0], p[1], p[2]);
  r.lastSeen = performance.now();
  r.group.visible = true;
}

function renameRemoteCursor(id, name, color) {
  const r = remote.get(id);
  if (!r) return;
  r.group.remove(r.group.children[2]);
  r.group.add(makeLabel(name, color));
  r.name = name;
}

function removeRemoteCursor(id) {
  const r = remote.get(id);
  if (!r) return;
  scene.remove(r.group);
  remote.delete(id);
}

/* ================================================================== */
/* entrada                                                             */
/* ================================================================== */

const pointers = new Map();
let gesture = null;   // {mode:'orbit'|'pan', x, y, dist}

canvas.addEventListener('contextmenu', (e) => e.preventDefault());

canvas.addEventListener('pointerdown', (e) => {
  // setPointerCapture puede lanzar (pointer ya inactivo): nunca debe abortar el handler
  try { canvas.setPointerCapture(e.pointerId); } catch (_) { /* noop */ }
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY, type: e.pointerType, button: e.button });

  // dos dedos => orbitar / zoom
  if (pointers.size === 2) {
    endDraw(true);
    const [a, b] = [...pointers.values()];
    gesture = { mode: 'touch', x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, dist: Math.hypot(a.x - b.x, a.y - b.y) };
    return;
  }

  if (e.pointerType === 'touch' && e.button === 0) { startDraw(e); return; }

  if (e.button === 2) { gesture = { mode: 'orbit', x: e.clientX, y: e.clientY }; return; }   // derecho: orbitar
  if (e.button === 1) { gesture = { mode: 'pan', x: e.clientX, y: e.clientY }; e.preventDefault(); return; }
  if (e.button === 0) {
    if (state.tool === 'eraser') eraseAt(e.clientX, e.clientY);
    else startDraw(e);
  }
});

canvas.addEventListener('pointermove', (e) => {
  const prev = pointers.get(e.pointerId);
  if (prev) { prev.x = e.clientX; prev.y = e.clientY; }

  const sx = e.clientX, sy = e.clientY;

  // gesto tactil de 2 dedos
  if (pointers.size === 2 && gesture && gesture.mode === 'touch') {
    const [a, b] = [...pointers.values()];
    const cx = (a.x + b.x) / 2, cy = (a.y + b.y) / 2;
    const dist = Math.hypot(a.x - b.x, a.y - b.y);
    rig.orbit(cx - gesture.x, cy - gesture.y);
    if (gesture.dist > 0) rig.zoom(-(dist - gesture.dist) * 2);
    gesture.x = cx; gesture.y = cy; gesture.dist = dist;
    return;
  }

  if (gesture) {
    const dx = sx - gesture.x, dy = sy - gesture.y;
    if (gesture.mode === 'orbit') rig.orbit(dx, dy);
    else if (gesture.mode === 'pan') rig.pan(dx, dy);
    gesture.x = sx; gesture.y = sy;
    return;
  }

  const p = screenToWorld(sx, sy, state.depth);
  if (p) {
    hitPoint.copy(p); hasHit.v = true;
    state.hovering = true;
    if (state.drawing) extendDraw(p);
    else sendCursor(p, state.depth);
  } else {
    hasHit.v = false; state.hovering = false;
  }

  if (state.tool === 'eraser' && pointers.size === 1 && (e.buttons & 1)) eraseAt(sx, sy);
});

function onPointerUp(e) {
  pointers.delete(e.pointerId);
  if (pointers.size < 2) gesture = null;
  endDraw();   // no-op si no hay trazo en curso
}
canvas.addEventListener('pointerup', onPointerUp);
canvas.addEventListener('pointercancel', onPointerUp);
window.addEventListener('pointerup', onPointerUp);

canvas.addEventListener('wheel', (e) => {
  e.preventDefault();
  if (e.shiftKey) setDepth(state.depth - e.deltaY * 0.006);
  else rig.zoom(e.deltaY);
}, { passive: false });

function startDraw(e) {
  const p = screenToWorld(e.clientX, e.clientY, state.depth);
  if (!p) return;
  const id = (crypto.randomUUID ? crypto.randomUUID() : `s-${Date.now()}-${Math.random()}`).slice(0, 40);
  const s = createStroke(id, state.color, state.size, selfId || 'local');
  state.drawing = s;
  pushPoint(s, [p.x, p.y, p.z]);
  socket.emit('stroke:start', { id, color: state.color, size: state.size });
  queuePoint([p.x, p.y, p.z]);
  sendCursor(p, state.depth);
}

function extendDraw(p) {
  const s = state.drawing;
  if (!s) return;
  if (pushPoint(s, [p.x, p.y, p.z])) {
    const last = s.points[s.points.length - 1];
    queuePoint([last.x, last.y, last.z]);
  }
  sendCursor(p, state.depth);
}

function endDraw(cancelled) {
  const s = state.drawing;
  if (!s) return;
  state.drawing = null;
  flushPoints(true);
  if (cancelled && s.points.length < 2) {
    removeStroke(s.id);
    socket.emit('stroke:erase', { id: s.id });
    return;
  }
  socket.emit('stroke:end', { id: s.id });
  updateStats();
}

function eraseAt(cx, cy) {
  const r = canvas.getBoundingClientRect();
  ndc.x = ((cx - r.left) / r.width) * 2 - 1;
  ndc.y = -((cy - r.top) / r.height) * 2 + 1;
  raycaster.setFromCamera(ndc, camera);
  const hits = raycaster.intersectObjects(strokesGroup.children, true);
  const ids = new Set();
  for (const h of hits) {
    const sid = h.object.userData.sid;
    if (sid) ids.add(sid);
  }
  if (ids.size) { ids.forEach(id => { removeStroke(id); socket.emit('stroke:erase', { id }); }); updateStats(); }
}

/* ================================================================== */
/* teclado                                                             */
/* ================================================================== */

window.addEventListener('keydown', (e) => {
  if (e.target && /INPUT|TEXTAREA/.test(e.target.tagName)) {
    if (e.key === 'Enter' && e.target.id === 'name-input') confirmName();
    return;
  }
  const k = e.key.toLowerCase();
  if (e.ctrlKey && k === 'z') { e.preventDefault(); undo(); return; }
  if (/^[1-8]$/.test(k)) selectColor(PALETTE[Number(k) - 1]);
  else if (k === 'b') setTool('brush');
  else if (k === 'e') setTool('eraser');
  else if (k === 'h') toggleHelp();
  else if (k === 'r') { rig.reset(); toast('Cámara reseteada'); }
  else if (k === 'arrowup') { e.preventDefault(); setDepth(state.depth - 0.5); }
  else if (k === 'arrowdown') { e.preventDefault(); setDepth(state.depth + 0.5); }
  else if (k === 'escape') document.getElementById('help').classList.remove('show');
});

/* ================================================================== */
/* UI                                                                  */
/* ================================================================== */

const $ = (id) => document.getElementById(id);

function setStatus(kind, text) {
  const d = $('status-dot');
  d.className = `dot ${kind}`;
  $('status-text').textContent = text;
}

function renderUsers(list) {
  const box = $('users');
  box.innerHTML = '';
  for (const u of list) {
    const el = document.createElement('span');
    el.className = 'chip' + (u.id === selfId ? ' me' : '');
    el.innerHTML = `<i style="background:${u.color};box-shadow:0 0 8px ${u.color}"></i><b></b>`;
    el.querySelector('b').textContent = u.id === selfId ? `${u.name} (vos)` : u.name;
    box.appendChild(el);
  }
}

function updateStats(s) {
  if (!s) return;
  if (typeof s.users === 'number') $('stat-users').textContent = s.users === 1 ? '1 en línea' : `${s.users} en línea`;
  if (typeof s.strokes === 'number') $('stat-strokes').textContent = s.strokes === 1 ? '1 trazo' : `${s.strokes} trazos`;
  else $('stat-strokes').textContent = `${strokes.size} trazos`;
}

function toast(msg, color) {
  const box = $('toasts');
  const el = document.createElement('div');
  el.className = 'toast';
  if (color) el.style.color = color;
  el.textContent = msg;
  box.appendChild(el);
  setTimeout(() => el.remove(), 2600);
  while (box.children.length > 4) box.firstChild.remove();
}

function setTool(t) {
  state.tool = t;
  document.querySelectorAll('.tool').forEach(b => b.classList.toggle('active', b.dataset.tool === t));
  canvas.style.cursor = t === 'eraser' ? 'cell' : 'crosshair';
}

function selectColor(c) {
  state.color = c;
  document.querySelectorAll('.swatch').forEach(s => {
    const on = s.dataset.color === c;
    s.classList.toggle('active', on);
    s.style.color = c;
  });
  beam.material.color.set(c);
  reticle.children.forEach(m => m.material.color.set(c));
}

function setDepth(d) {
  state.depth = Math.max(0.6, Math.min(40, d));
  $('depth').value = state.depth;
  $('depth-value').textContent = state.depth.toFixed(1);
  if (state.hovering && hasHit.v) sendCursor(hitPoint, state.depth);
}

function undo() {
  if (state.drawing) { endDraw(true); return; }
  socket.emit('undo');
}

function toggleHelp() { $('help').classList.toggle('show'); }

function confirmName() {
  const v = $('name-input').value.trim().slice(0, 24) || `Invitado${Math.floor(Math.random() * 90 + 10)}`;
  state.name = v;
  localStorage.setItem('dls:name', v);
  socket.emit('rename', v);
  $('name-overlay').classList.remove('show');
  toast(`Hola ${v}, ya estás dibujando en 3D`);
}

// swatches de color
{
  const box = $('colors');
  for (const c of PALETTE) {
    const b = document.createElement('button');
    b.className = 'swatch';
    b.dataset.color = c;
    b.style.background = c;
    b.title = c;
    b.addEventListener('click', () => selectColor(c));
    box.appendChild(b);
  }
}

$('size').addEventListener('input', (e) => {
  state.size = Number(e.target.value);
  $('size-value').textContent = state.size.toFixed(2);
});
$('depth').addEventListener('input', (e) => setDepth(Number(e.target.value)));
$('btn-depth-up').addEventListener('click', () => setDepth(state.depth + 0.5));
$('btn-depth-down').addEventListener('click', () => setDepth(state.depth - 0.5));
$('btn-reset-cam').addEventListener('click', () => { rig.reset(); toast('Cámara reseteada'); });
$('btn-undo').addEventListener('click', undo);
$('btn-help').addEventListener('click', toggleHelp);
$('btn-hud').addEventListener('click', () => document.body.classList.toggle('oculto'));
$('btn-help-close').addEventListener('click', toggleHelp);
$('btn-name-go').addEventListener('click', confirmName);
$('btn-copy').addEventListener('click', async () => {
  try { await navigator.clipboard.writeText($('share-link').value); toast('Link copiado'); }
  catch { $('share-link').select(); document.execCommand?.('copy'); toast('Link copiado'); }
});
$('btn-clear').addEventListener('click', () => {
  if (confirm('¿Borrar TODO el dibujo para todos los conectados?')) socket.emit('clear');
});
$('btn-export').addEventListener('click', () => {
  const data = [...strokes.values()].map(s => ({
    color: s.color, size: s.size,
    points: s.points.map(p => [+p.x.toFixed(3), +p.y.toFixed(3), +p.z.toFixed(3)]),
  }));
  const blob = new Blob([JSON.stringify({ app: 'DibujoLiveShare', strokes: data }, null, 1)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `dibujo3d-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
  toast(`Exportados ${data.length} trazos`);
});
$('btn-import').addEventListener('click', () => $('file-import').click());
$('file-import').addEventListener('change', async (e) => {
  const file = e.target.files?.[0];
  if (!file) return;
  try {
    const json = JSON.parse(await file.text());
    const list = Array.isArray(json) ? json : json.strokes;
    if (!Array.isArray(list)) throw new Error('formato');
    socket.emit('import', { strokes: list });
    toast(`Importando ${list.length} trazos`);
  } catch {
    toast('No pude leer ese JSON');
  }
  e.target.value = '';
});
document.querySelectorAll('.tool').forEach(b => b.addEventListener('click', () => setTool(b.dataset.tool)));

// nombre inicial
if (state.name) {
  $('name-input').value = state.name;
  $('name-overlay').classList.remove('show');
} else {
  setTimeout(() => $('name-input').focus(), 150);
}

/* ================================================================== */
/* loop                                                                */
/* ================================================================== */

const clock = new THREE.Clock();
const tmpFwd = new THREE.Vector3();

function tick() {
  const dt = Math.min(clock.getDelta(), 0.1);
  camera.getWorldDirection(tmpFwd);

  // plano de profundidad
  planeGroup.position.copy(camera.position).addScaledVector(tmpFwd, state.depth);
  planeGroup.quaternion.copy(camera.quaternion);

  // punto de mira + rayo
  const active = state.hovering && hasHit.v && !gesture && pointers.size < 2;
  reticle.visible = active;
  beam.visible = active;
  if (active) {
    reticle.position.copy(hitPoint);
    const scale = Math.max(0.06, state.size * 1.15);
    reticle.scale.setScalar(scale / 1.8);
    reticle.quaternion.copy(camera.quaternion);
    const a = beam.geometry.attributes.position;
    const start = camera.position.clone().addScaledVector(tmpFwd, 0.25);
    a.setXYZ(0, start.x, start.y, start.z);
    a.setXYZ(1, hitPoint.x, hitPoint.y, hitPoint.z);
    a.needsUpdate = true;
    beam.computeLineDistances();
  }

  // cursores remotos: suavizado + ocultar inactivos
  const now = performance.now();
  for (const [id, r] of remote) {
    r.group.position.lerp(r.target, Math.min(1, dt * 12));
    const idle = now - r.lastSeen;
    r.group.visible = idle < 4000;
    const pulse = idle > 1200 ? 0.55 + 0.45 * Math.sin(now * 0.005) : 1;
    r.group.children[1].material.opacity = 0.22 * pulse;
  }

  renderer.render(scene, camera);
  requestAnimationFrame(tick);
}
tick();

/* ================================================================== */
/* API de depuracion                                                   */
/* ================================================================== */
window.__dls = {
  THREE, scene, camera, rig, strokes, strokesGroup, state,
  addStrokeFromPoints, removeStroke, clearAll, setDepth,
  get strokeCount() { return strokes.size; },
  get pointCount() { return [...strokes.values()].reduce((a, s) => a + s.points.length, 0); },
};
console.log('[DibujoLiveShare] listo. Usá window.__dls para depurar.');
