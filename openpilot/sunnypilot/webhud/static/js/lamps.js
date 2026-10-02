// Lamps that light up on the car body itself: each lamp is a lens (the model's own light materials,
// or a small lens of its own on the procedural car) lit through its emissive, plus, for colored light,
// a soft glow over the lens so brake lights and indicators read from the chase camera. Nothing floats
// off the car.
import * as THREE from '../vendor/three.module.min.js';

export const LAMP = { white: 0xf2f6ff, amber: 0xffa01e, red: 0xff2414 };
const GLOW_PEAK = 1;   // glow brightness next to the lens at full level

// a soft round spot: bright in the middle, easing out to nothing at the rim
let spotTexture = null;
function spotTex() {
  if (spotTexture) return spotTexture;
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const ctx = c.getContext('2d');
  const g = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
  for (let i = 0; i <= 8; i++) {
    const r = i / 8;
    g.addColorStop(r, `rgba(255,255,255,${(Math.exp(-4 * r * r) * (1 - r * r)).toFixed(3)})`);
  }
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 64, 64);
  spotTexture = new THREE.CanvasTexture(c);
  return spotTexture;
}

export class Lamp {
  // color: lit color; lens: the unlit color of a lens of its own, or the model's light materials (left
  // as modeled when off)
  constructor(color, lens) {
    this.lens = Array.isArray(lens) ? null : new THREE.MeshStandardMaterial({
      color: lens, emissive: color, emissiveIntensity: 0, roughness: 0.25, metalness: 0,
      polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -2, side: THREE.DoubleSide,
    });
    this.lenses = this.lens ? [this.lens] : lens;
    // the glow's spots combine by max, not sum: however densely they overlap, the halo is as bright as
    // its nearest spot, so it fades smoothly with distance from the lens instead of piling up in blobs
    this.glow = new THREE.PointsMaterial({
      map: spotTex(), color, transparent: true, opacity: 0, depthWrite: false, toneMapped: false,
      blending: THREE.CustomBlending, blendEquation: THREE.MaxEquation, premultipliedAlpha: true,
    });
    this.glowMeshes = [];
    this.color = color;
    this.level = -1;
  }

  // level 0..1; color switches a combination lamp (e.g. red tail / amber indicator)
  set(level, color = this.color) {
    if (color !== this.shown) {
      this.shown = color;
      for (const m of this.lenses) m.emissive.setHex(color);
      this.glow.color.setHex(color);
      this.level = -1;
    }
    if (level === this.level) return;
    this.level = level;
    // colored lamps saturate (amber turns yellow) when pushed far past full emissive; the glow carries
    // the rest of their brightness
    for (const m of this.lenses) m.emissiveIntensity = level * (this.shown === LAMP.white ? 2.6 : 1.3);
    // white light shows on the lens alone: the lens is already full white, and a white halo over the
    // paint only greys it
    this.glow.opacity = this.shown === LAMP.white ? 0 : GLOW_PEAK * Math.min(1, level * 1.05);
    for (const m of this.glowMeshes) m.visible = this.glow.opacity > 0.01;
  }

  // Glow over the lens meshes (ego space): a soft spot of `radius` facing the camera every `step` over
  // the lens, lifted just in front of it (outward, away from `center`). Spots much closer together than
  // their size merge into an even halo.
  addGlow(parent, meshes, center, radius, step = radius / 6) {
    // sample the lens surface every `step` (its vertices can be several cm apart) and pool the samples
    // into `step` cells, each with the mean outward face normal
    const cells = new Map();
    const t = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()];
    const v = new THREE.Vector3(), n = new THREE.Vector3(), e = new THREE.Vector3();
    const add = (p) => {
      const k = `${Math.round(p.x / step)},${Math.round(p.y / step)},${Math.round(p.z / step)}`;
      if (!cells.has(k)) cells.set(k, { p: new THREE.Vector3(), n: new THREE.Vector3(), k: 0 });
      const c = cells.get(k);
      c.p.add(p);
      c.n.add(n);
      c.k += 1;
    };
    for (const mesh of meshes) {
      mesh.updateWorldMatrix(true, false);
      const pos = mesh.geometry.attributes.position, index = mesh.geometry.index;
      const count = index ? index.count : pos.count;
      for (let i = 0; i < count; i += 3) {
        for (let j = 0; j < 3; j++) t[j].fromBufferAttribute(pos, index ? index.getX(i + j) : i + j).applyMatrix4(mesh.matrixWorld);
        n.subVectors(t[1], t[0]).cross(e.subVectors(t[2], t[0]));
        if (n.lengthSq() < 1e-12) continue;
        n.normalize();
        v.copy(t[0]).add(t[1]).add(t[2]).divideScalar(3);
        if (n.dot(v) < n.dot(center)) n.negate();
        const k = Math.max(1, Math.ceil(Math.max(t[0].distanceTo(t[1]), t[1].distanceTo(t[2]), t[2].distanceTo(t[0])) / step));
        for (let a = 0; a <= k; a++) {
          for (let b = 0; a + b <= k; b++) add(v.copy(t[0]).multiplyScalar((k - a - b) / k).addScaledVector(t[1], a / k).addScaledVector(t[2], b / k));
        }
      }
    }
    if (!cells.size) return;
    const pts = [];
    for (const c of cells.values()) {
      c.p.divideScalar(c.k).addScaledVector(c.n.normalize(), 0.015);
      pts.push(c.p.x, c.p.y, c.p.z);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
    const m = new THREE.Points(geo, this.glow);
    // three sizes points as if the view were 90 deg tall; scale by the camera's focal length for meters
    m.onBeforeRender = (r, scene, camera) => { this.glow.size = 2 * radius * camera.projectionMatrix.elements[5]; };
    m.renderOrder = 3;
    m.visible = false;
    parent.add(m);
    this.glowMeshes.push(m);
  }
}

// Drive a car's lamps from VehicleState.lamps. Missing lamps (simpler models) are skipped.
export function applyLamps(lamps, L) {
  const pos = L.position || L.low || L.high;
  const set = (name, level, color) => { if (lamps[name]) lamps[name].set(level, color); };
  const drl = L.drl || pos ? 1 : 0;
  set('drl', drl);
  set('head', L.high ? 1 : L.low ? 0.9 : 0);
  set('tail', L.brake ? 1 : pos ? 0.5 : 0);
  set('chmsl', L.brake ? 1 : 0);
  set('reverse', L.reverse ? 1 : 0);
  for (const [s, on, active] of [['L', L.left, L.leftActive], ['R', L.right, L.rightActive]]) {
    set('front' + s, on ? 1 : 0);
    set('mirror' + s, on ? 1 : 0);
    set('side' + s, on ? 1 : 0);
    set('turn' + s, on ? 1 : 0);
    // the Ocean's lower front strip is a white DRL that turns amber while indicating (dark between flashes)
    if (active) set('lower' + s, on ? 1 : 0, LAMP.amber);
    else set('lower' + s, drl, LAMP.white);
    // the rear-quarter marker is part of the tail lamp: lit with it, bright for braking, and it
    // flashes with the indicator on its side
    set('marker' + s, L.brake ? 1 : active ? (on ? 1 : 0) : pos ? 0.5 : 0);
    // lower rear lamp: amber indicator, red tail otherwise
    if (active) set('rear' + s, on ? 1 : 0, LAMP.amber);
    else set('rear' + s, pos ? 0.45 : 0, LAMP.red);
  }
}
