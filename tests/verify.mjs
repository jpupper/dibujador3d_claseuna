#!/usr/bin/env node
/**
 * Verificacion de DibujoLiveShare.
 *
 * Arranca su PROPIA instancia del servidor (puerto libre + estado temporal en %TEMP%,
 * asi no toca data/strokes.json), ejerce el protocolo con 3 clientes socket reales
 * y la apaga al terminar. Sale con codigo != 0 si algo falla.
 *
 *   npm run verify
 */
import { spawn } from 'node:child_process';
import { io } from 'socket.io-client';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PORT = 3300 + Math.floor(Math.random() * 500);
const URL = `http://127.0.0.1:${PORT}`;
const STATE = path.join(os.tmpdir(), `hermes-verify-dls-${process.pid}.json`);

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const realStateExisted = fs.existsSync(path.join(ROOT, 'data', 'strokes.json'));
const checks = [];
const ok = (name, cond, extra = '') => checks.push({ name, pass: !!cond, extra });
const mkPoints = (n, z) => Array.from({ length: n }, (_, i) => [Math.round((-3 + i * 0.2) * 1e3) / 1e3, Math.round(Math.sin(i / 4) * 1e3) / 1e3, z]);
const sawEnd = (c, id) => c.ev.some((x) => x.e === 'stroke:end' && x.d.id === id);
const sawRemove = (c, id) => c.ev.some((x) => x.e === 'stroke:remove' && x.d.id === id);

function client(tag) {
  const s = io(URL, { transports: ['websocket'] });
  s.tag = tag;
  s.ev = [];
  s.onAny((e, d) => s.ev.push({ e, d }));
  s.last = (e) => { const h = s.ev.filter((x) => x.e === e); return h.length ? h[h.length - 1].d : null; };
  s.count = (e) => s.ev.filter((x) => x.e === e).length;
  s.pts = (id) => s.ev.filter((x) => x.e === 'stroke:point' && x.d.id === id).reduce((a, x) => a + (x.d.points || []).length, 0);
  s.init = () => new Promise((res, rej) => { s.once('init', res); setTimeout(() => rej(new Error('sin init de ' + tag)), 8000); });
  return s;
}

/* ---------------- servidor propio ---------------- */

const server = spawn(process.execPath, ['server.js'], {
  cwd: ROOT,
  env: { ...process.env, PORT: String(PORT), STATE_FILE: STATE },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let banner = '';
server.stdout.on('data', (d) => { banner += d; });
server.stderr.on('data', (d) => { banner += d; });

async function waitReady() {
  for (let i = 0; i < 40; i++) {
    try { if ((await fetch(`${URL}/health`)).ok) return true; } catch (_) { /* reintenta */ }
    await wait(250);
  }
  return false;
}

let A, B, C;
try {
  ok('el servidor arranca', await waitReady());
  ok('el arranque informa el link de red', /Red\s*:/.test(banner), banner.split('\n').filter((l) => /Red\s*:/.test(l))[0]?.trim());

  /* ---------------- estaticos ---------------- */
  for (const p of ['/', '/app.js', '/style.css', '/vendor/three.module.js', '/vendor/three.core.js', '/socket.io/socket.io.js', '/health']) {
    const r = await fetch(URL + p);
    ok(`HTTP 200 ${p}`, r.status === 200, 'status=' + r.status);
  }
  const h0 = await (await fetch(`${URL}/health`)).json();
  ok('health responde ok', h0.ok === true, JSON.stringify(h0));

  /* ---------------- usuarios ---------------- */
  A = client('A'); await A.init();
  B = client('B'); await B.init();
  A.emit('rename', 'VerificadorA');
  B.emit('rename', 'VerificadorB');
  await wait(400);

  const ul = A.last('users') || [];
  const names = JSON.stringify(ul.map((u) => u.name));
  ok('la lista ve a los 2 conectados', ul.length === 2, names);
  ok('los nombres se propagan', ul.some((u) => u.name === 'VerificadorA') && ul.some((u) => u.name === 'VerificadorB'));
  ok('el servidor asigna un color a cada usuario', ul.every((u) => /^#[0-9a-f]{6}$/.test(u.color)));

  /* ---------------- A dibuja -> B lo ve en vivo ---------------- */
  A.emit('stroke:start', { id: 'S1', color: '#ff4d6d', size: 0.2 });
  A.emit('stroke:point', { id: 'S1', points: mkPoints(30, 0) });
  await wait(150);
  A.emit('stroke:end', { id: 'S1' });
  await wait(500);

  ok('B recibe stroke:start del trazo de A', (B.last('stroke:start') || {}).id === 'S1');
  ok('B recibe los 30 puntos', B.pts('S1') === 30, 'puntos=' + B.pts('S1'));
  ok('B recibe color y grosor', (B.last('stroke:start') || {}).color === '#ff4d6d' && (B.last('stroke:start') || {}).size === 0.2);
  ok('B recibe stroke:end', B.count('stroke:end') >= 1);
  ok('el emisor NO recibe eco de su propio trazo', A.count('stroke:start') === 0, 'ecos=' + A.count('stroke:start'));

  /* ---------------- persistencia ---------------- */
  await wait(1600);
  const stored = (() => { try { return JSON.parse(fs.readFileSync(STATE, 'utf8')).strokes.find((s) => s.id === 'S1'); } catch (_) { return null; } })();
  ok('el trazo se persiste en disco', !!stored && stored.points.length === 30, stored ? 'puntos=' + stored.points.length : 'no esta en el archivo');

  /* ---------------- C entra tarde: contexto compartido ---------------- */
  C = client('C');
  const cInit = await C.init();
  await wait(300);
  ok('el que entra tarde recibe el dibujo completo', (cInit.strokes || []).some((s) => s.id === 'S1' && s.points.length === 30), 'trazos=' + (cInit.strokes || []).length);
  ok('el que entra tarde ve a los demas usuarios', (cInit.users || []).length === 3);
  ok('init trae los links de red', (cInit.urls || []).length >= 1);

  /* ---------------- sentido inverso ---------------- */
  B.emit('stroke:start', { id: 'S2', color: '#8ac926', size: 0.1 });
  B.emit('stroke:point', { id: 'S2', points: mkPoints(12, 1.5) });
  B.emit('stroke:end', { id: 'S2' });
  await wait(500);
  ok('A ve el trazo dibujado por B', A.pts('S2') === 12, 'puntos=' + A.pts('S2'));
  ok('C ve el trazo dibujado por B', C.pts('S2') === 12, 'puntos=' + C.pts('S2'));

  /* ---------------- cursor 3D ---------------- */
  A.emit('cursor', { p: [1.25, -2.5, 4.75], depth: 6.5 });
  await wait(300);
  const cur = B.last('cursor');
  ok('B recibe el cursor 3D de A (punto + profundidad)', !!cur && JSON.stringify(cur.p) === '[1.25,-2.5,4.75]' && cur.depth === 6.5, JSON.stringify(cur));
  ok('el cursor lleva el color del usuario', !!cur && /^#[0-9a-f]{6}$/.test(cur.color));

  /* ---------------- deshacer ---------------- */
  A.emit('undo');
  await wait(400);
  ok('deshacer borra el ultimo trazo propio', (B.last('stroke:remove') || {}).id === 'S1', JSON.stringify(B.last('stroke:remove')));
  ok('deshacer no toca el trazo del otro', (B.last('stroke:remove') || {}).id !== 'S2');
  ok('el servidor queda con 1 trazo', (await (await fetch(`${URL}/health`)).json()).strokes === 1);

  /* ---------------- import ---------------- */
  B.emit('import', { strokes: [{ color: '#b388ff', size: 0.15, points: [[0, 0, 0], [1, 1, 1]] }, { color: '#2ec4b6', size: 0.1, points: [[2, 2, 2], [3, 3, 3]] }] });
  await wait(400);
  ok('importar replica los trazos a todos', ((A.last('strokes:add') || {}).strokes || []).length === 2);

  /* ---------------- pantalla de salida (output3d): solo lectura ---------------- */
  const usersAntes = (A.last('users') || []).length;   // A, B y C (C sigue sin renombrarse)
  const V = io(URL, { transports: ['websocket'], query: { view: '1' } });
  V.ev = [];
  V.onAny((e, d) => V.ev.push({ e, d }));
  const vLast = (e) => { const h = V.ev.filter((x) => x.e === e); return h.length ? h[h.length - 1].d : null; };
  const vInit = await new Promise((res, rej) => { V.once('init', res); setTimeout(() => rej(new Error('la pantalla no recibio init')), 8000); });
  const hNow = await (await fetch(`${URL}/health`)).json();
  await wait(300);

  ok('output3d se conecta como pantalla (?view=1)', vInit.viewer === true && vInit.self === null, JSON.stringify(vInit.viewer));
  ok('output3d recibe el mismo estado que el servidor', (vInit.strokes || []).length === hNow.strokes, `init=${(vInit.strokes || []).length} servidor=${hNow.strokes}`);
  ok('output3d NO aparece en la lista de usuarios', (A.last('users') || []).length === usersAntes,
    `antes=${usersAntes} despues=${(A.last('users') || []).length} :: ${JSON.stringify((A.last('users') || []).map((u) => u.name))}`);

  const startsBefore = A.count('stroke:start');
  B.emit('stroke:start', { id: 'S3', color: '#ffb703', size: 0.12 });
  B.emit('stroke:point', { id: 'S3', points: mkPoints(5, 0.5) });
  B.emit('stroke:end', { id: 'S3' });
  await wait(450);
  const vPts = V.ev.filter((x) => x.e === 'stroke:point' && x.d.id === 'S3').reduce((a, x) => a + (x.d.points || []).length, 0);
  ok('output3d recibe start + puntos + end del trazo en vivo',
    (vLast('stroke:start') || {}).id === 'S3' && vPts === 5 && (vLast('stroke:end') || {}).id === 'S3', 'puntos=' + vPts);

  const hBefore = await (await fetch(`${URL}/health`)).json();
  V.emit('stroke:start', { id: 'V1', color: '#ffffff', size: 0.2 });
  V.emit('stroke:point', { id: 'V1', points: mkPoints(5, 0) });
  V.emit('stroke:end', { id: 'V1' });
  V.emit('clear');
  V.emit('undo');
  await wait(500);
  const hAfter = await (await fetch(`${URL}/health`)).json();
  ok('output3d no puede dibujar ni borrar (solo lee)',
    hAfter.strokes === hBefore.strokes && A.count('stroke:start') === startsBefore + 1 && A.count('clear') === 0,
    `trazos ${hBefore.strokes}->${hAfter.strokes}, starts=${A.count('stroke:start')}, clear=${A.count('clear')}`);
  V.disconnect();

  /* ---------------- trazo sin cerrar: lo cierra el servidor y lo anuncia ---------------- */
  A.emit('stroke:start', { id: 'H1', color: '#ff4d6d', size: 0.1 });
  A.emit('stroke:point', { id: 'H1', points: mkPoints(4, 0) });
  await wait(250);
  A.emit('stroke:start', { id: 'H2', color: '#4cc9f0', size: 0.1 });   // arranca otro SIN cerrar H1
  A.emit('stroke:point', { id: 'H2', points: mkPoints(4, 1) });
  A.emit('stroke:end', { id: 'H2' });
  await wait(500);
  ok('un trazo sin cerrar se anuncia como terminado al empezar otro',
    sawEnd(B, 'H1') && sawEnd(B, 'H2'), `end(H1)=${sawEnd(B, 'H1')} end(H2)=${sawEnd(B, 'H2')}`);

  /* ---------------- trazo abandonado (se corta la conexion a medias) ---------------- */
  const hAb = await (await fetch(`${URL}/health`)).json();
  const E = client('E');
  await E.init();
  E.emit('stroke:start', { id: 'AB1', color: '#ffb703', size: 0.1 });
  E.emit('stroke:point', { id: 'AB1', points: mkPoints(6, 0) });
  await wait(300);
  E.disconnect();
  await wait(600);
  const hAb2 = await (await fetch(`${URL}/health`)).json();
  ok('un trazo abandonado se avisa y no queda en el estado compartido',
    sawRemove(B, 'AB1') && hAb2.strokes === hAb.strokes, `remove=${sawRemove(B, 'AB1')} trazos ${hAb.strokes}->${hAb2.strokes}`);

  /* ---------------- salida + limpiar ---------------- */
  C.disconnect();
  await wait(500);
  ok('la lista se actualiza al salir alguien', (A.last('users') || []).length === 2, JSON.stringify((A.last('users') || []).map((u) => u.name)));

  B.emit('clear');
  await wait(400);
  ok('limpiar llega a los demas clientes', A.count('clear') >= 1);
  const h2 = await (await fetch(`${URL}/health`)).json();
  ok('el servidor queda vacio tras limpiar', h2.strokes === 0 && h2.points === 0, JSON.stringify(h2));

  /* ---------------- no ensucia el estado real ---------------- */
  const realState = path.join(ROOT, 'data', 'strokes.json');
  ok('no crea ni pisa data/strokes.json del proyecto', fs.existsSync(realState) === realStateExisted);
} catch (err) {
  ok('la verificacion corre sin excepciones', false, err.message);
} finally {
  A?.disconnect(); B?.disconnect(); C?.disconnect();
  server.kill();
  try { fs.rmSync(STATE, { force: true }); } catch (_) { /* noop */ }
}

/* ---------------- reporte ---------------- */
const failed = checks.filter((c) => !c.pass);
for (const c of checks) console.log(`  ${c.pass ? 'OK   ' : 'FALLA'} ${c.name}${c.extra ? '   [' + c.extra + ']' : ''}`);
console.log(`\n  ${checks.length - failed.length}/${checks.length} comprobaciones OK${failed.length ? ` — ${failed.length} FALLARON` : ''}\n`);
process.exit(failed.length ? 1 : 0);
