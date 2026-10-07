/**
 * DibujoLiveShare - motor 3D compartido (three.js core).
 *
 * Lo usan las dos vistas:
 *   - public/app.js      -> lienzo interactivo (dibujar, camara, herramientas)
 *   - public/output3d.js -> pantalla de salida (solo lectura, resultado final)
 *
 * Aca vive lo comun: sala (renderer+escena+luces+grilla), camara orbital y el
 * motor de trazos (punto -> tubo 3D en coordenadas de mundo).
 */
import * as THREE from './vendor/three.module.js';

export const PALETTE = ['#ff4d6d', '#ffb703', '#8ac926', '#4cc9f0', '#b388ff', '#ff8fab', '#2ec4b6', '#f8f9fa'];
export const UP = new THREE.Vector3(0, 1, 0);
export const MIN_SEG = 0.012;   // distancia minima entre puntos de un trazo

const SPHERE_GEO = new THREE.SphereGeometry(1, 10, 8);
const CYL_GEO = new THREE.CylinderGeometry(1, 1, 1, 10, 1, true);
const matCache = new Map();

export function materialFor(color) {
  let m = matCache.get(color);
  if (!m) {
    const c = new THREE.Color(color);
    m = new THREE.MeshStandardMaterial({
      color: c,
      roughness: 0.38,
      metalness: 0.06,
      emissive: c.clone().multiplyScalar(0.16),
    });
    matCache.set(color, m);
  }
  return m;
}

/* ------------------------------------------------------------------ */
/* sala                                                                */
/* ------------------------------------------------------------------ */

export function createView(canvas) {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(window.innerWidth, window.innerHeight);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color('#070a12');
  scene.fog = new THREE.Fog('#070a12', 34, 120);

  const camera = new THREE.PerspectiveCamera(55, window.innerWidth / window.innerHeight, 0.05, 600);

  scene.add(new THREE.HemisphereLight(0xa9c6ff, 0x0a0e18, 0.85));
  const dir = new THREE.DirectionalLight(0xffffff, 1.15);
  dir.position.set(6, 12, 9);
  scene.add(dir);
  const fill = new THREE.DirectionalLight(0x7aa2ff, 0.5);
  fill.position.set(-8, -4, -6);
  scene.add(fill);

  // referencia espacial
  const groundGrid = new THREE.GridHelper(80, 80, 0x2b3a5c, 0x16203a);
  groundGrid.position.y = -5;
  groundGrid.material.transparent = true;
  groundGrid.material.opacity = 0.3;
  scene.add(groundGrid);
  const axes = new THREE.AxesHelper(1.6);
  scene.add(axes);

  const strokesGroup = new THREE.Group();
  scene.add(strokesGroup);

  window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
  });

  return { renderer, scene, camera, strokesGroup, groundGrid, axes };
}

/* ------------------------------------------------------------------ */
/* camara orbital propia (no hay OrbitControls: el click izq. dibuja)  */
/* ------------------------------------------------------------------ */

export class CameraRig {
  constructor(camera) {
    this.camera = camera;
    this.target = new THREE.Vector3(0, 0, 0);
    this.radius = 9;
    this.yaw = 0.55;
    this.pitch = 0.42;
  }

  apply() {
    const cp = Math.cos(this.pitch);
    this.camera.position.set(
      this.target.x + this.radius * cp * Math.sin(this.yaw),
      this.target.y + this.radius * Math.sin(this.pitch),
      this.target.z + this.radius * cp * Math.cos(this.yaw),
    );
    this.camera.lookAt(this.target);
    this.camera.updateMatrixWorld();
    return this;
  }

  reset() {
    this.target.set(0, 0, 0);
    this.radius = 9;
    this.yaw = 0.55;
    this.pitch = 0.42;
    return this.apply();
  }

  orbit(dx, dy) {
    this.yaw -= dx * 0.005;
    this.pitch = Math.max(-1.45, Math.min(1.45, this.pitch + dy * 0.005));
    return this.apply();
  }

  pan(dx, dy) {
    const right = new THREE.Vector3().setFromMatrixColumn(this.camera.matrixWorld, 0);
    const up = new THREE.Vector3().setFromMatrixColumn(this.camera.matrixWorld, 1);
    const k = this.radius * 0.0016;
    this.target.addScaledVector(right, -dx * k).addScaledVector(up, dy * k);
    return this.apply();
  }

  zoom(delta) {
    this.radius = Math.max(0.8, Math.min(120, this.radius * Math.exp(delta * 0.0012)));
    return this.apply();
  }
}

/* ------------------------------------------------------------------ */
/* motor de trazos                                                     */
/* ------------------------------------------------------------------ */

export class StrokeBoard {
  constructor(scene, parent = null) {
    this.strokes = new Map();   // id -> {id, color, size, owner, points:[Vector3], group, lastDir}
    this.group = new THREE.Group();
    (parent || scene).add(this.group);
  }

  get size() { return this.strokes.size; }
  get(id) { return this.strokes.get(id); }
  get pointCount() {
    let n = 0;
    for (const s of this.strokes.values()) n += s.points.length;
    return n;
  }

  add(id, color, size, owner) {
    let s = this.strokes.get(id);
    if (s) return s;
    const group = new THREE.Group();
    this.group.add(group);
    s = {
      id,
      color: color || PALETTE[3],
      size: typeof size === 'number' ? size : 0.12,
      owner: owner || null,
      points: [],
      group,
      lastDir: null,
    };
    this.strokes.set(id, s);
    return s;
  }

  _addDot(s, v, mat) {
    const d = new THREE.Mesh(SPHERE_GEO, mat);
    d.position.copy(v);
    d.scale.setScalar(s.size / 2);
    d.userData.sid = s.id;
    s.group.add(d);
  }

  /** agrega un punto al trazo; devuelve true si se acepto */
  push(s, p) {
    const v = p.isVector3 ? p.clone() : new THREE.Vector3(p[0], p[1], p[2]);
    const mat = materialFor(s.color);
    const prev = s.points.length ? s.points[s.points.length - 1] : null;

    if (!prev) {
      this._addDot(s, v, mat);
      s.points.push(v);
      return true;
    }

    const delta = new THREE.Vector3().subVectors(v, prev);
    const len = delta.length();
    if (len < MIN_SEG) return false;

    const nd = delta.clone().normalize();
    if (s.lastDir && s.lastDir.dot(nd) < 0.9) this._addDot(s, prev, mat);  // codo

    const cyl = new THREE.Mesh(CYL_GEO, mat);
    cyl.position.copy(prev).addScaledVector(delta, 0.5);
    cyl.quaternion.setFromUnitVectors(UP, nd);
    cyl.scale.set(s.size / 2, len, s.size / 2);
    cyl.userData.sid = s.id;
    s.group.add(cyl);

    s.lastDir = nd;
    s.points.push(v);
    return true;
  }

  /** trazo completo de una sola vez (init, import, trazo terminado) */
  addFromPoints(points, color, size, id, owner) {
    const s = this.add(id || `local-${Math.random().toString(36).slice(2, 10)}`, color, size, owner);
    for (const p of points || []) this.push(s, p);
    return s;
  }

  remove(id) {
    const s = this.strokes.get(id);
    if (!s) return false;
    s.group.removeFromParent();
    s.group.clear();
    this.strokes.delete(id);
    return true;
  }

  clear() {
    for (const s of [...this.strokes.values()]) this.remove(s.id);
    this.strokes.clear();
  }
}
