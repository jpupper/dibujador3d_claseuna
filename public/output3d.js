/**
 * output3d - pantalla de salida (solo lectura).
 *
 * Consume los MISMOS sockets que el lienzo (init / stroke:start / stroke:point /
 * stroke:end / strokes:add / stroke:remove / clear), pero muestra únicamente el
 * RESULTADO FINAL:
 *
 *   - los trazos a medio hacer NO se dibujan: se guardan en un buffer silencioso
 *   - recién cuando llega 'stroke:end' el trazo completo entra a la escena
 *   - al entrar, pide el estado y dibuja todo lo ya terminado
 *
 * Además se conecta como PANTALLA (?view=1): el servidor no la cuenta como
 * usuario y no le registra ningún evento de escritura, así que no puede dibujar
 * ni borrar nada, ni aparece en la lista de conectados del resto.
 *
 * Parámetros de URL:
 *   ?spin=0      desactiva el giro automático de cámara (por defecto gira lento)
 *   ?grid=0      oculta la grilla de referencia
 *   ?dist=14     distancia de cámara
 *   ?speed=0.05  velocidad del giro (rad/s)
 */
import * as THREE from './vendor/three.module.js';
import { createView, CameraRig, StrokeBoard } from './engine3d.js';

const params = new URLSearchParams(location.search);
const SPIN = params.get('spin') !== '0';
const SPEED = Number(params.get('speed')) || 0.09;

const canvas = document.getElementById('scene');
const { renderer, scene, camera, groundGrid } = createView(canvas);

if (params.get('grid') === '0') groundGrid.visible = false;

const rig = new CameraRig(camera);
const dist = Number(params.get('dist'));
if (Number.isFinite(dist) && dist > 0) rig.radius = dist;
rig.apply();

const board = new StrokeBoard(scene);

/* ------------------------------------------------------------------ */
/* red - solo escucha                                                  */
/* ------------------------------------------------------------------ */

const socket = io({ query: { view: '1' } });   // el servidor lo trata como pantalla, no como usuario
window.socket = socket;

/** trazos en curso: se acumulan sin dibujarse hasta que terminan */
const enCurso = new Map();

const $ = (id) => document.getElementById(id);

function setStatus(kind, text) {
  $('status-dot').className = 'dot ' + kind;
  $('status-text').textContent = text;
}

socket.on('connect', () => setStatus('on', 'conectada'));
socket.on('disconnect', () => setStatus('off', 'sin conexión'));
socket.io.on('reconnect_attempt', () => setStatus('', 'reconectando…'));

/** trazo completo terminado -> ahora sí, a la escena */
function mostrarTrazo(d) {
  const b = enCurso.get(d.id);
  enCurso.delete(d.id);
  if (!b) return;
  board.addFromPoints(b.points, b.color, b.size, d.id, b.owner);
}

socket.on('init', (d) => {
  board.clear();
  enCurso.clear();
  for (const s of d.strokes || []) board.addFromPoints(s.points, s.color, s.size, s.id, s.owner);
  setStatus('on', d.viewer ? 'pantalla conectada' : 'conectada');
});

// el trazo arranca: NO se dibuja nada todavía, sólo se recuerda cómo es
socket.on('stroke:start', (d) => {
  enCurso.set(d.id, { color: d.color, size: d.size, owner: d.owner, points: [], t: performance.now() });
});

// red de seguridad: si por lo que sea un trazo nunca termina, no se acumula para siempre
setInterval(() => {
  const ahora = performance.now();
  for (const [id, b] of enCurso) if (ahora - b.t > 180000) enCurso.delete(id);
}, 30000);

// puntos intermedios: se acumulan en silencio (nada visible)
socket.on('stroke:point', (d) => {
  const b = enCurso.get(d.id);
  if (!b) return;
  for (const p of d.points || []) b.points.push(p);
});

// terminó: recién acá aparece completo
socket.on('stroke:end', mostrarTrazo);

// trazos que llegan ya terminados (import)
socket.on('strokes:add', (d) => {
  for (const s of d.strokes || []) board.addFromPoints(s.points, s.color, s.size, s.id, s.owner);
});

socket.on('stroke:remove', (d) => {
  enCurso.delete(d.id);
  board.remove(d.id);
});

socket.on('clear', () => {
  enCurso.clear();
  board.clear();
});

/* ------------------------------------------------------------------ */
/* teclado                                                             */
/* ------------------------------------------------------------------ */

let girando = SPIN;

window.addEventListener('keydown', (e) => {
  switch (e.key.toLowerCase()) {
    case 'r': girando = !girando; break;
    case 'c': rig.reset(); break;
    case 'g': groundGrid.visible = !groundGrid.visible; break;
    case 'f':
      if (document.fullscreenElement) document.exitFullscreen();
      else document.documentElement.requestFullscreen?.();
      break;
    default: break;
  }
});

/* ------------------------------------------------------------------ */
/* loop - render puro, sin presencia ni herramientas                    */
/* ------------------------------------------------------------------ */

const clock = new THREE.Clock();

function tick() {
  const dt = Math.min(clock.getDelta(), 0.1);
  if (girando) {
    rig.yaw += dt * SPEED;
    rig.apply();
  }
  renderer.render(scene, camera);
  requestAnimationFrame(tick);
}
tick();

// la leyenda desaparece a los 8s (y vuelve si tocás una tecla)
setTimeout(() => $('hint').classList.add('fade'), 8000);
window.addEventListener('keydown', () => $('hint').classList.remove('fade'));

/* depuración */
window.__dlsOut = {
  THREE, scene, camera, rig, board, enCurso,
  get strokes() { return board.size; },
  get points() { return board.pointCount; },
  get pendientes() { return enCurso.size; },
  get girando() { return girando; },
};
console.log('[output3d] pantalla de salida lista (solo trazos terminados).');
