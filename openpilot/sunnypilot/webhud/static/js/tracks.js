// Power trails: the rear tires paint the road as they roll. Each wheel sprays flat dabs of paint
// across its tire width, colored by how hard the motors are asked to work at that moment -- blue at a
// light load through the spectrum to red at full power -- and denser, with more overspray, the harder
// the car pulls. Laid paint keeps its color, so a burst of power leaves a red stretch that slides
// back behind the car while the newest paint is already blue again. The trail grows with speed to
// one car length at 70 mph and fades out toward its end.
//
// The splats live in the `world` group (world-anchored), so the paint stays on the road; their fade
// is computed on the GPU from how far the wheel has rolled since each was laid.
import * as THREE from '../vendor/three.module.min.js';

const EGO_LEN = 4.775;
const FULL_SPEED = 31.3;    // m/s (70 mph): the trail is one car length from here on
const SPLATS = 1536;        // pool shared by both wheels (a full-power car length is ~600 per wheel)
const DENSITY = [60, 130];  // splats per meter per wheel, light load .. full power
const LIFT = 0.03;          // above lane lines (0.02)
const KW_FULL = 150;        // demanded power for full red...
const TQ_FULL = 6000;       // ...or wheel torque (both axles, Nm), e.g. a hard launch with little speed yet
const MASS = 2400;          // kg, for the estimate on cars without motor data

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

// 2x2 atlas of paint dabs with ragged edges, a touch lighter where the paint is thickest
function splatAtlas() {
  const S = 128, H = S / 2;
  const c = document.createElement('canvas');
  c.width = c.height = S;
  const ctx = c.getContext('2d');
  const img = ctx.createImageData(S, S);
  let seed = 7;
  const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  for (let v = 0; v < 4; v++) {
    const ox = (v % 2) * H, oy = (v >> 1) * H;
    const waves = [2, 3, 5, 7].map(k => [k, rnd() * Math.PI * 2, 0.03 + rnd() * 0.05]);
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < H; x++) {
        const dx = (x + 0.5) / H * 2 - 1, dy = (y + 0.5) / H * 2 - 1;
        const r = Math.hypot(dx, dy), a = Math.atan2(dy, dx);
        const edge = 0.74 + waves.reduce((acc, [k, ph, amp]) => acc + amp * Math.sin(k * a + ph), 0);
        const alpha = 1 - THREE.MathUtils.smoothstep(r, edge - 0.1, edge);
        const shade = Math.round(255 * (1 - 0.14 * THREE.MathUtils.smoothstep(r, 0, edge)));
        img.data.set([shade, shade, shade, Math.round(255 * alpha)], ((oy + y) * S + ox + x) * 4);
      }
    }
  }
  ctx.putImageData(img, 0, 0);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

// A pool of flat, instanced paint splats on the road. Per splat: center, orientation x radius, color
// with opacity, and (distance its wheel had rolled when laid, wheel, atlas cell) for the fade.
class Splats {
  constructor(n) {
    this.n = n;
    this.next = 0;
    this.pos = new Float32Array(n * 3);
    this.axis = new Float32Array(n * 2);
    this.color = new Float32Array(n * 4);
    this.trail = new Float32Array(n * 3);
    const geo = new THREE.InstancedBufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0], 3));
    geo.setIndex([0, 1, 2, 0, 2, 3]);
    this.attrs = {
      iPos: new THREE.InstancedBufferAttribute(this.pos, 3),
      iAxis: new THREE.InstancedBufferAttribute(this.axis, 2),
      iColor: new THREE.InstancedBufferAttribute(this.color, 4),
      iTrail: new THREE.InstancedBufferAttribute(this.trail, 3),
    };
    for (const [k, a] of Object.entries(this.attrs)) geo.setAttribute(k, a.setUsage(THREE.DynamicDrawUsage));
    geo.instanceCount = n;
    this.geo = geo;
    this.dirtyFrom = -1;   // first pool slot written since the last upload
    this.dirtyCount = 0;
    this.clear();
    this.material = new THREE.ShaderMaterial({
      uniforms: { uMap: { value: splatAtlas() }, uHead: { value: new THREE.Vector2() }, uLen: { value: 0 } },
      vertexShader: `
        attribute vec3 iPos;
        attribute vec2 iAxis;
        attribute vec4 iColor;
        attribute vec3 iTrail;
        uniform vec2 uHead;
        uniform float uLen;
        varying vec4 vColor;
        varying vec2 vUv;
        void main() {
          float head = iTrail.y < 0.5 ? uHead.x : uHead.y;
          float f = uLen > 0.01 ? clamp(1.0 - (head - iTrail.x) / uLen, 0.0, 1.0) : 0.0;
          vColor = vec4(iColor.rgb, iColor.a * pow(f, 1.3));
          if (vColor.a < 0.002) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }   // faded: skip it
          vec2 off = iAxis * position.x + vec2(-iAxis.y, iAxis.x) * position.y;
          vUv = (position.xy * 0.5 + 0.5 + vec2(mod(iTrail.z, 2.0), floor(iTrail.z / 2.0))) * 0.5;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(iPos + vec3(off.x, 0.0, off.y), 1.0);
        }`,
      fragmentShader: `
        uniform sampler2D uMap;
        varying vec4 vColor;
        varying vec2 vUv;
        void main() {
          vec4 t = texture2D(uMap, vUv);
          float a = vColor.a * t.a;
          if (a < 0.004) discard;
          gl_FragColor = vec4(vColor.rgb * t.rgb, a);
          #include <colorspace_fragment>
        }`,
      transparent: true, depthWrite: false, side: THREE.DoubleSide,
    });
    this.mesh = new THREE.Mesh(geo, this.material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 3;
  }

  clear() {
    this.color.fill(0);   // alpha 0 = unused
    this.full = true;     // upload everything next flush
  }

  add(x, z, radius, angle, r, g, b, alpha, s, wheel) {
    const i = this.next;
    this.next = (i + 1) % this.n;
    if (this.dirtyFrom < 0) this.dirtyFrom = i;
    this.dirtyCount++;
    this.pos.set([x, LIFT, z], i * 3);
    this.axis.set([Math.cos(angle) * radius, Math.sin(angle) * radius], i * 2);
    this.color.set([r, g, b, alpha], i * 4);
    this.trail.set([s, wheel, Math.floor(Math.random() * 4)], i * 3);
  }

  // upload only what was written this frame (two ranges when the ring wrapped)
  flush() {
    if (this.dirtyFrom < 0 && !this.full) return;
    const count = Math.min(this.dirtyCount, this.n);
    const first = Math.min(count, this.n - this.dirtyFrom), rest = count - first;
    for (const a of Object.values(this.attrs)) {
      const k = a.itemSize;
      a.clearUpdateRanges();
      if (!this.full) {
        a.addUpdateRange(this.dirtyFrom * k, first * k);
        if (rest > 0) a.addUpdateRange(0, rest * k);
      }
      a.needsUpdate = true;
    }
    this.full = false;
    this.dirtyFrom = -1;
    this.dirtyCount = 0;
  }
}

export class PowerTrails {
  constructor(world) {
    this.world = world;
    this.splats = new Splats(SPLATS);
    world.add(this.splats.mesh);
    this.load = 0;
    this.color = new THREE.Color();
    this.wheels = [0, 1].map(() => ({ last: null, s: 0, carry: 0 }));
    this.enabled = true;
    this._v = new THREE.Vector3();
    this.setTheme(false);
  }

  setTheme(dark) {
    this.dark = dark;
  }

  clear() {
    this.splats.clear();
    for (const w of this.wheels) w.last = null;
  }

  // ego: the car model (rear wheel positions); load: motorLoad() or null
  update(dt, vehicle, ego, load, enabled) {
    if (!enabled || !vehicle) {
      if (this.enabled) this.clear();
      this.enabled = false;
      this.splats.mesh.visible = false;
      return;
    }
    this.enabled = true;
    this.splats.mesh.visible = true;
    // the request arrives at 20 Hz in steps; ease it so the colors flow
    this.load += ((load ?? 0) - this.load) * (1 - Math.exp(-dt * 8));
    const L = this.load, col = loadColor(L, this.color, this.dark ? 0.55 : 0.47);
    const density = DENSITY[0] + (DENSITY[1] - DENSITY[0]) * L;
    const spray = 0.08 + 0.17 * L;   // share of fine overspray flung past the tire

    const rear = (ego.userData.wheels || []).filter(w => !w.front).map(w => w.steer.position);
    const zr = ego.userData.rearAxleZ ?? EGO_LEN - 0.93;
    const contacts = rear.length === 2 ? rear : [{ x: -0.83, z: zr }, { x: 0.83, z: zr }];
    this.world.updateMatrixWorld();
    contacts.forEach((c, wi) => {
      const w = this.wheels[wi];
      const p = this.world.worldToLocal(this._v.set(c.x, 0, c.z));
      const last = w.last;
      w.last = { x: p.x, z: p.z };
      if (!last) return;
      const dx = p.x - last.x, dz = p.z - last.z, d = Math.hypot(dx, dz);
      if (d > 6) { this.splats.clear(); return; }   // teleported (seek / pose wrap)
      if (d < 1e-4) return;
      const nx = -dz / d, nz = dx / d;   // across the tire
      const s0 = w.s;
      w.s += d;
      w.carry += d * density;
      for (; w.carry >= 1; w.carry -= 1) {
        const f = Math.random();
        let off, radius;
        if (Math.random() < spray) {
          off = (Math.random() < 0.5 ? -1 : 1) * (0.12 + Math.random() * (0.14 + 0.12 * L));
          radius = 0.012 + Math.random() * 0.022;
        } else {
          off = Math.max(-0.14, Math.min(0.14, (Math.random() + Math.random() + Math.random() - 1.5) * 0.13));
          radius = 0.03 + Math.random() * 0.045 + 0.012 * L;
        }
        const shade = 0.88 + Math.random() * 0.24;   // uneven paint
        this.splats.add(last.x + dx * f + nx * off, last.z + dz * f + nz * off, radius, Math.random() * Math.PI * 2,
          Math.min(1, col.r * shade), Math.min(1, col.g * shade), Math.min(1, col.b * shade),
          0.75 + Math.random() * 0.25, s0 + d * f, wi);
      }
    });
    this.splats.flush();
    const u = this.splats.material.uniforms;
    u.uHead.value.set(this.wheels[0].s, this.wheels[1].s);
    u.uLen.value = EGO_LEN * clamp01(vehicle.speed / FULL_SPEED);
  }
}
