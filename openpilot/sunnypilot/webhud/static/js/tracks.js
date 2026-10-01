// Power trails: glowing tire tracks behind the rear wheels, colored by how hard the motors are asked
// to work at the moment each bit is laid -- blue at a light load through the spectrum to red at full
// power -- so a burst of power leaves a red stretch that slides back behind the car while the newest
// track is already blue again. The trail grows with speed to one car length at 70 mph and fades out
// toward its end; light motes kick up off the tires, more of them the harder the car pulls.
//
// Everything lives in the `world` group (world-anchored), so laid track stays on the road.
import * as THREE from '../vendor/three.module.min.js';

const EGO_LEN = 4.775;
const FULL_SPEED = 31.3;    // m/s (70 mph): the trail is one car length from here on
const STEP = 0.1;           // m between laid track points
const MAX_PTS = 64;         // laid points kept per wheel (one car length is ~48)
const WIDTH = 0.3;          // m, a little wider than the tire so the soft edge glows past it
const LIFT = 0.03;          // above lane lines (0.02)
const GROOVE_PITCH = 0.42;  // m per repeat of the tire groove pattern
const KW_FULL = 150;        // demanded power for full red...
const TQ_FULL = 6000;       // ...or wheel torque (both axles, Nm), e.g. a hard launch with little speed yet
const MASS = 2400;          // kg, for the estimate on cars without motor data
const MOTES = 384;

const clamp01 = (x) => Math.min(1, Math.max(0, x));

// How hard the drive is working, 0 (coasting / regen) .. 1 (full power), or null without data. The
// Fisker reports the driver's torque request per axle and the motors' speed (fisker_world._power);
// other cars get a road-load estimate from openpilot's acceleration.
export function motorLoad(state) {
  const p = state && state.fisker && state.fisker.power;
  const kw = p ? p.demandKw ?? p.kw : null;
  if (kw != null) {
    if (kw < -1) return 0;   // regen
    return clamp01(Math.max(kw / KW_FULL, Math.abs(p.tqReq || 0) / TQ_FULL));
  }
  const cs = state && state.op && state.op.carState;
  if (!cs || cs.aEgo == null) return null;
  const v = Math.abs(cs.vEgo || 0);
  const force = MASS * (cs.aEgo + 0.11) + 0.42 * v * v;   // + rolling resistance and drag
  if (force <= 0) return 0;
  return clamp01(Math.max(force * v / 1000 / KW_FULL, force * 0.39 / TQ_FULL));
}

// blue (240 deg) -> cyan -> green -> yellow -> red (0 deg)
function loadColor(load, out, light) {
  return out.setHSL((1 - load) * 240 / 360, 1, light, THREE.SRGBColorSpace);
}

// soft-edged strip across its width with tire grooves along it (alpha in all channels)
function grooveTexture() {
  const W = 64, H = 64;
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const ctx = c.getContext('2d');
  const img = ctx.createImageData(W, H);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const u = Math.abs((x + 0.5) / W - 0.5) * 2;                // 0 center .. 1 edge
      const edge = 1 - THREE.MathUtils.smoothstep(u, 0.55, 1);
      // chevron grooves, mirrored about the center line
      const g = ((y / H + u * 0.35) % 0.5) < 0.12 && u < 0.8 ? 0.55 : 1;
      const a = Math.round(255 * edge * g);
      img.data.set([a, a, a, 255], (y * W + x) * 4);
    }
  }
  ctx.putImageData(img, 0, 0);
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  return tex;
}

class Trail {
  constructor(material) {
    this.pts = [];   // laid points, oldest first: {x, z, s, r, g, b} (world-local; s = distance along)
    const n = MAX_PTS + 2;   // + the moving head at the tire + the cut at the trail's end
    this.n = n;
    this.pos = new Float32Array(n * 6);
    this.col = new Float32Array(n * 8);
    this.uv = new Float32Array(n * 4);
    const idx = [];
    for (let i = 0; i < n - 1; i++) {
      const a = i * 2;
      idx.push(a, a + 2, a + 1, a + 1, a + 2, a + 3);
    }
    this.geo = new THREE.BufferGeometry();
    this.geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    this.geo.setAttribute('color', new THREE.BufferAttribute(this.col, 4).setUsage(THREE.DynamicDrawUsage));
    this.geo.setAttribute('uv', new THREE.BufferAttribute(this.uv, 2).setUsage(THREE.DynamicDrawUsage));
    this.geo.setIndex(idx);
    this.mesh = new THREE.Mesh(this.geo, material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 3;
    this.mesh.visible = false;
  }

  clear() { this.pts.length = 0; this.mesh.visible = false; }

  // lay track up to the tire at (x, z), colored c from here on; returns false after a jump
  lay(x, z, c) {
    const P = this.pts;
    const last = P[P.length - 1];
    if (!last) { P.push({ x, z, s: 0, r: c.r, g: c.g, b: c.b }); return true; }
    const dx = x - last.x, dz = z - last.z, d = Math.hypot(dx, dz);
    if (d > 6) { this.clear(); P.push({ x, z, s: 0, r: c.r, g: c.g, b: c.b }); return false; }
    // fill in every STEP, blending from the last laid color so a fast frame doesn't band
    const n = Math.floor(d / STEP);
    for (let i = 1; i <= n; i++) {
      const f = i * STEP / d;
      P.push({ x: last.x + dx * f, z: last.z + dz * f, s: last.s + i * STEP,
        r: last.r + (c.r - last.r) * f, g: last.g + (c.g - last.g) * f, b: last.b + (c.b - last.b) * f });
    }
    if (P.length > MAX_PTS) P.splice(0, P.length - MAX_PTS);
    return true;
  }

  // draw from the tire back over `len` meters, fading out toward the end
  draw(x, z, c, len, alpha) {
    const P = this.pts;
    const last = P[P.length - 1];
    if (!last || len < 0.05) { this.mesh.visible = false; return; }
    const head = { x, z, s: last.s + Math.hypot(x - last.x, z - last.z), r: c.r, g: c.g, b: c.b };
    const line = [head];
    let d = 0;
    for (let i = P.length - 1; i >= 0; i--) {
      const a = line[line.length - 1], b = P[i];
      const seg = Math.hypot(b.x - a.x, b.z - a.z);
      if (seg < 1e-4) continue;
      if (d + seg >= len) {   // cut exactly at the trail's length
        const f = (len - d) / seg;
        line.push({ x: a.x + (b.x - a.x) * f, z: a.z + (b.z - a.z) * f, s: a.s + (b.s - a.s) * f,
          r: a.r + (b.r - a.r) * f, g: a.g + (b.g - a.g) * f, b: a.b + (b.b - a.b) * f });
        d = len;
        break;
      }
      d += seg;
      line.push(b);
    }
    if (line.length < 2) { this.mesh.visible = false; return; }
    const hw = WIDTH / 2;
    let dist = 0;
    for (let i = 0; i < line.length; i++) {
      const p = line[i];
      if (i > 0) dist += Math.hypot(p.x - line[i - 1].x, p.z - line[i - 1].z);
      const a = line[Math.max(0, i - 1)], b = line[Math.min(line.length - 1, i + 1)];
      let tx = b.x - a.x, tz = b.z - a.z;
      const tl = Math.hypot(tx, tz) || 1;
      tx /= tl; tz /= tl;
      const nx = -tz * hw, nz = tx * hw;
      this.pos.set([p.x + nx, LIFT, p.z + nz, p.x - nx, LIFT, p.z - nz], i * 6);
      const fade = alpha * Math.pow(1 - Math.min(1, dist / len), 1.4);
      this.col.set([p.r, p.g, p.b, fade, p.r, p.g, p.b, fade], i * 8);
      const v = p.s / GROOVE_PITCH;
      this.uv.set([0, v, 1, v], i * 4);
    }
    this.geo.setDrawRange(0, (line.length - 1) * 6);
    for (const k of ['position', 'color', 'uv']) this.geo.attributes[k].needsUpdate = true;
    this.mesh.visible = true;
  }
}

// glowing motes: a fixed pool of points that rise, slow down and fade
class Motes {
  constructor(n) {
    this.n = n;
    this.pos = new Float32Array(n * 3);
    this.col = new Float32Array(n * 4);
    this.size = new Float32Array(n);
    this.vel = new Float32Array(n * 3);
    this.age = new Float32Array(n);
    this.life = new Float32Array(n);
    this.base = new Float32Array(n);   // start size
    this.next = 0;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute('aColor', new THREE.BufferAttribute(this.col, 4).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute('aSize', new THREE.BufferAttribute(this.size, 1).setUsage(THREE.DynamicDrawUsage));
    this.geo = geo;
    this.material = new THREE.ShaderMaterial({
      uniforms: { uScale: { value: 800 } },
      vertexShader: `
        attribute vec4 aColor;
        attribute float aSize;
        uniform float uScale;
        varying vec4 vColor;
        void main() {
          vColor = aColor;
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          gl_PointSize = aColor.a > 0.0 ? aSize * uScale / max(0.5, -mv.z) : 0.0;
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: `
        varying vec4 vColor;
        void main() {
          float d = length(gl_PointCoord - 0.5) * 2.0;
          float a = vColor.a * (1.0 - smoothstep(0.0, 1.0, d)) * (1.0 - smoothstep(0.0, 0.35, d) * 0.4);
          if (a < 0.003) discard;
          gl_FragColor = vec4(vColor.rgb, a);
          #include <colorspace_fragment>
        }`,
      transparent: true, depthWrite: false,
    });
    this.points = new THREE.Points(geo, this.material);
    this.points.frustumCulled = false;
    this.points.renderOrder = 4;
  }

  emit(x, z, vx, vy, vz, c) {
    const i = this.next;
    this.next = (i + 1) % this.n;
    this.pos.set([x, 0.06, z], i * 3);
    this.vel.set([vx, vy, vz], i * 3);
    this.col.set([c.r, c.g, c.b, 0], i * 4);
    this.age[i] = 0;
    this.life[i] = 0.45 + Math.random() * 0.45;
    this.base[i] = 0.16 + Math.random() * 0.2;
  }

  clear() { this.life.fill(0); this.col.fill(0); this.geo.attributes.aColor.needsUpdate = true; }

  update(dt, alpha) {
    const drag = Math.exp(-dt * 2.2);
    for (let i = 0; i < this.n; i++) {
      if (this.life[i] <= 0) continue;
      const age = (this.age[i] += dt);
      const t = age / this.life[i];
      if (t >= 1) { this.life[i] = 0; this.col[i * 4 + 3] = 0; continue; }
      const k = i * 3;
      this.vel[k] *= drag; this.vel[k + 2] *= drag;
      this.vel[k + 1] = this.vel[k + 1] * drag + 0.5 * dt;   // light: drifts up
      this.pos[k] += this.vel[k] * dt;
      this.pos[k + 1] += this.vel[k + 1] * dt;
      this.pos[k + 2] += this.vel[k + 2] * dt;
      this.col[i * 4 + 3] = alpha * Math.min(1, age / 0.06) * (1 - t) * (1 - t);
      this.size[i] = this.base[i] * (1 - 0.5 * t);
    }
    this.geo.attributes.position.needsUpdate = true;
    this.geo.attributes.aColor.needsUpdate = true;
    this.geo.attributes.aSize.needsUpdate = true;
  }
}

export class PowerTrails {
  constructor(world) {
    this.world = world;
    this.material = new THREE.MeshBasicMaterial({
      vertexColors: true, transparent: true, depthWrite: false, side: THREE.DoubleSide, alphaMap: grooveTexture(),
    });
    this.trails = [new Trail(this.material), new Trail(this.material)];
    this.motes = new Motes(MOTES);
    for (const t of this.trails) world.add(t.mesh);
    world.add(this.motes.points);
    this.load = 0;
    this.color = new THREE.Color();
    this.moteColor = new THREE.Color();
    this.carry = [0, 0];
    this.enabled = true;
    this._v = new THREE.Vector3();
    this._o = new THREE.Vector3();
    this._f = new THREE.Vector3();
    this._r = new THREE.Vector3();
    this.setTheme(false);
  }

  setTheme(dark) {
    this.dark = dark;
    // light adds up on a dark road; on a light one the colors would wash out to white
    const blending = dark ? THREE.AdditiveBlending : THREE.NormalBlending;
    this.material.blending = blending;
    this.motes.material.blending = blending;
    this.material.needsUpdate = this.motes.material.needsUpdate = true;
    this.alpha = dark ? 0.9 : 0.8;
  }

  clear() {
    for (const t of this.trails) t.clear();
    this.motes.clear();
  }

  // ego: the car model (rear wheel positions); load: motorLoad() or null; pxScale: pixels per meter at 1 m
  update(dt, vehicle, ego, load, enabled, pxScale) {
    if (!enabled || !vehicle) {
      if (this.enabled) this.clear();
      this.enabled = false;
      this.motes.points.visible = false;
      return;
    }
    this.enabled = true;
    this.motes.points.visible = true;
    this.motes.material.uniforms.uScale.value = pxScale;
    // the request arrives at 20 Hz in steps; ease it so the colors flow
    this.load += ((load ?? 0) - this.load) * (1 - Math.exp(-dt * 8));
    loadColor(this.load, this.color, this.dark ? 0.55 : 0.47);
    loadColor(this.load, this.moteColor, this.dark ? 0.68 : 0.5);

    const len = EGO_LEN * clamp01(vehicle.speed / FULL_SPEED);
    const v = vehicle.v;
    const rear = (ego.userData.wheels || []).filter(w => !w.front).map(w => w.steer.position);
    const zr = ego.userData.rearAxleZ ?? EGO_LEN - 0.93;
    const contacts = rear.length === 2 ? rear : [{ x: -0.83, z: zr }, { x: 0.83, z: zr }];
    this.world.updateMatrixWorld();
    // the car's forward and right directions in world-local axes, for the motes' drift
    const W = this.world, o = W.worldToLocal(this._o.set(0, 0, 0));
    const fwd = W.worldToLocal(this._f.set(0, 0, -1)).sub(o), right = W.worldToLocal(this._r.set(1, 0, 0)).sub(o);
    const rate = Math.abs(v) < 0.3 ? 0 : 48 * (0.2 + 0.8 * this.load) * clamp01(Math.abs(v) / 6);
    contacts.forEach((c, i) => {
      const p = this.world.worldToLocal(this._v.set(c.x, 0, c.z));
      const trail = this.trails[i];
      if (!trail.lay(p.x, p.z, this.color)) this.motes.clear();   // teleported (seek / pose wrap)
      trail.draw(p.x, p.z, this.color, len, this.alpha);

      this.carry[i] += rate * dt;
      const side = c.x < 0 ? -1 : 1;   // scene X: + right
      while (this.carry[i] >= 1) {
        this.carry[i] -= 1;
        // released just behind the contact patch, carried along a little and flung outward
        const back = 0.15 + Math.random() * 0.3, lat = (Math.random() - 0.5) * 0.25;
        const out = side * (0.15 + Math.random() * 0.45);
        const along = 0.25 * v + (Math.random() - 0.5) * 0.6;
        this.motes.emit(
          p.x - fwd.x * back + right.x * lat, p.z - fwd.z * back + right.z * lat,
          fwd.x * along + right.x * out, 0.5 + Math.random() * 0.9, fwd.z * along + right.z * out, this.moteColor);
      }
    });
    this.motes.update(dt, this.alpha);
  }
}
