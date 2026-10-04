// Power trails: the rear tires leave a trail of fine glowing particles as they roll -- a dense, bright
// band as wide as each tire with a glow about it, and sparser dust that spreads out behind -- colored by
// how hard the motors are asked to work at that moment: blue at a light load through the spectrum to red
// at full power. A light load lays a sparse, faint trail of fine specks; the harder the car pulls, the
// denser, brighter and coarser it gets and the more dust it throws, up to a solid glowing band at full
// power. Laid particles keep their look, so a burst of power leaves a bright red stretch that slides back
// behind the car while the newest trail is already faint and blue again. The trail grows with speed to one
// car length at 70 mph and fades out toward its end.
//
// The particles live in the `world` group (world-anchored), so the trail stays on the road; their fade,
// spread and twinkle are computed on the GPU from how far the wheel has rolled since each was laid.
import * as THREE from '../vendor/three.module.min.js';

const EGO_LEN = 4.775;
const FULL_SPEED = 31.3;    // m/s (70 mph): the trail is one car length from here on
const PARTICLES = 32768;    // pool shared by both wheels (a full-power car length is ~14300 per wheel)
// light load .. full power (in between by the load):
const DENSITY = [250, 3000];  // particles per meter per wheel
const BRIGHT = [0.4, 1];      // opacity
const SIZE = [0.7, 1];        // speck size
const TIRE_W = 0.28;        // m, if the car model doesn't say
const GLOW = 0.12;          // share of particles that are soft halo rather than specks
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

// The particles' look, shared with the drive-mode pulse (cutaway.js). Per point: vColor (alpha included)
// and vGlow, 0 for a crisp speck, 1 for a soft halo that adds up into a glow where points are dense.
export const SPECK_FRAGMENT = `
  varying vec4 vColor;
  varying float vGlow;
  void main() {
    float d = length(gl_PointCoord - 0.5) * 2.0;
    float a = vColor.a * mix(1.0 - smoothstep(0.45, 1.0, d), exp(-d * d * 4.0) * (1.0 - d), vGlow);
    if (a < 0.003) discard;
    gl_FragColor = vec4(vColor.rgb, a);
    #include <colorspace_fragment>
  }`;

// light adds up on a dark road; on a light one the colors would wash out to white, so the specks are
// laid like ink there
export function speckBlending(dark) {
  return dark ? THREE.AdditiveBlending : THREE.NormalBlending;
}

// blue (240 deg) -> cyan -> green -> yellow -> red (0 deg)
function loadColor(load, out, light) {
  return out.setHSL((1 - load) * 240 / 360, 1, light, THREE.SRGBColorSpace);
}

// A pool of fine points on the road. Per particle: where it was laid, how it drifts per meter its wheel
// has rolled since (across, up) and its size, color with opacity, and (distance its wheel had rolled
// when laid, wheel, twinkle phase, glow) for the fade.
class Particles {
  constructor(n) {
    this.n = n;
    this.next = 0;
    this.pos = new Float32Array(n * 3);
    this.move = new Float32Array(n * 4);
    this.color = new Float32Array(n * 4);
    this.trail = new Float32Array(n * 4);
    const geo = new THREE.BufferGeometry();
    this.attrs = {
      position: new THREE.BufferAttribute(this.pos, 3),
      aMove: new THREE.BufferAttribute(this.move, 4),
      aColor: new THREE.BufferAttribute(this.color, 4),
      aTrail: new THREE.BufferAttribute(this.trail, 4),
    };
    for (const [k, a] of Object.entries(this.attrs)) geo.setAttribute(k, a.setUsage(THREE.DynamicDrawUsage));
    this.geo = geo;
    this.dirtyFrom = -1;   // first pool slot written since the last upload
    this.dirtyCount = 0;
    this.clear();
    this.material = new THREE.ShaderMaterial({
      uniforms: {
        uHead: { value: new THREE.Vector2() }, uLen: { value: 0 }, uScale: { value: 800 }, uTime: { value: 0 },
        uGlow: { value: 1 },
      },
      vertexShader: `
        attribute vec4 aMove;
        attribute vec4 aColor;
        attribute vec4 aTrail;
        uniform vec2 uHead;
        uniform float uLen;
        uniform float uScale;
        uniform float uTime;
        uniform float uGlow;
        varying vec4 vColor;
        varying float vGlow;
        void main() {
          float age = (aTrail.y < 0.5 ? uHead.x : uHead.y) - aTrail.x;   // meters rolled since laid
          float f = uLen > 0.01 ? clamp(1.0 - age / uLen, 0.0, 1.0) : 0.0;
          float twinkle = 0.6 + 0.4 * sin(uTime * (2.0 + 5.0 * fract(aTrail.z * 7.13)) + aTrail.z * 6.2832);
          float fresh = 1.0 + 0.8 * (1.0 - smoothstep(0.0, 0.4, age));   // hot where it leaves the tire
          vGlow = aTrail.w;
          vColor = vec4(aColor.rgb, aColor.a * pow(f, 1.3) * mix(twinkle * fresh, uGlow, vGlow));
          if (vColor.a < 0.002) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); gl_PointSize = 0.0; return; }
          vec4 mv = modelViewMatrix * vec4(position + aMove.xyz * age, 1.0);
          gl_PointSize = max(1.5, aMove.w * uScale / max(0.5, -mv.z));
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: SPECK_FRAGMENT,
      transparent: true, depthWrite: false,
    });
    this.points = new THREE.Points(geo, this.material);
    this.points.frustumCulled = false;
    this.points.renderOrder = 3;
  }

  clear() {
    this.color.fill(0);   // alpha 0 = unused
    this.full = true;     // upload everything next flush
  }

  add(x, z, dx, rise, dz, size, r, g, b, alpha, s, wheel, glow) {
    const i = this.next;
    this.next = (i + 1) % this.n;
    if (this.dirtyFrom < 0) this.dirtyFrom = i;
    this.dirtyCount++;
    this.pos.set([x, LIFT, z], i * 3);
    this.move.set([dx, rise, dz, size], i * 4);
    this.color.set([r, g, b, alpha], i * 4);
    this.trail.set([s, wheel, Math.random(), glow], i * 4);
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

// unit-ish normal spread, cheap
const gauss = () => (Math.random() + Math.random() + Math.random() - 1.5) * 2;

export class PowerTrails {
  constructor(world) {
    this.world = world;
    this.particles = new Particles(PARTICLES);
    world.add(this.particles.points);
    this.load = 0;
    this.core = new THREE.Color();
    this.dust = new THREE.Color();
    this.wheels = [0, 1].map(() => ({ last: null, s: 0, carry: 0 }));
    this.enabled = true;
    this._v = new THREE.Vector3();
    this.setTheme(false);
  }

  setTheme(dark) {
    this.dark = dark;
    // on a light road the halo is only a faint tint (see speckBlending)
    const m = this.particles.material;
    m.blending = speckBlending(dark);
    m.uniforms.uGlow.value = dark ? 1 : 0.4;
    m.needsUpdate = true;
  }

  clear() {
    this.particles.clear();
    for (const w of this.wheels) w.last = null;
  }

  // ego: the car model (rear wheel positions); load: motorLoad() or null; pxScale: pixels per meter at 1 m
  update(dt, vehicle, ego, load, enabled, pxScale) {
    const P = this.particles;
    if (!enabled || !vehicle) {
      if (this.enabled) this.clear();
      this.enabled = false;
      P.points.visible = false;
      return;
    }
    this.enabled = true;
    P.points.visible = true;
    // the request arrives at 20 Hz in steps; ease it so the colors flow
    this.load += ((load ?? 0) - this.load) * (1 - Math.exp(-dt * 8));
    const L = this.load, dark = this.dark;
    const core = loadColor(L, this.core, dark ? 0.6 : 0.42), dust = loadColor(L, this.dust, dark ? 0.55 : 0.45);
    const ramp = ([lo, hi]) => lo + (hi - lo) * L;
    const density = ramp(DENSITY), grow = ramp(SIZE);
    const coreShare = 0.62 - 0.17 * L;   // the rest is dust, more of it the harder the car pulls
    const alpha = ramp(BRIGHT) * (dark ? 1 : 0.85);

    const rearWheels = (ego.userData.wheels || []).filter(w => !w.front);
    const rear = rearWheels.map(w => w.pos);
    const half = ((rearWheels[0] && rearWheels[0].w) || TIRE_W) / 2;
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
      if (d > 6) { P.clear(); return; }   // teleported (seek / pose wrap)
      if (d < 1e-4) return;
      const tx = dx / d, tz = dz / d, nx = -tz, nz = tx;   // along and across the tire
      const s0 = w.s;
      w.s += d;
      w.carry += d * density;
      for (; w.carry >= 1; w.carry -= 1) {
        const f = Math.random(), k = Math.random();
        // off: across the track; lat/fwd/rise: drift per meter rolled since (it spreads as it trails)
        let off, lat = 0, fwd = 0, rise = 0, size, a, col = core, glow = 0;
        if (k < GLOW) {   // halo
          off = (Math.random() - 0.5) * 1.4 * half;
          size = 1.4 * half + Math.random() * 0.08;
          a = 0.04 + Math.random() * 0.03;
          glow = 1;
        } else if (k < GLOW + coreShare) {   // the band itself, even across the tire with soft edges
          off = (Math.random() - 0.5) * 2 * half + gauss() * 0.012;
          size = (0.006 + Math.random() * 0.008) * grow;
          a = 0.3 + 0.7 * Math.random() ** 2;   // mostly dim, a few bright sparks
          lat = Math.sign(off) * Math.random() * 0.012;
        } else {   // dust, thinning out away from the track and drifting further out
          const side = Math.random() < 0.5 ? -1 : 1;
          off = side * (0.8 * half + Math.min(4, -Math.log(1 - Math.random())) * (0.05 + 0.07 * L));
          size = (0.005 + Math.random() * 0.007) * grow;
          a = 0.15 + 0.6 * Math.random() ** 2;
          lat = side * (0.008 + Math.random() * (0.03 + 0.05 * L));
          fwd = (Math.random() - 0.5) * 0.02;
          rise = Math.random() * 0.015;
          col = dust;
        }
        const shade = 0.85 + Math.random() * 0.3;
        P.add(last.x + dx * f + nx * off, last.z + dz * f + nz * off,
          nx * lat + tx * fwd, rise, nz * lat + tz * fwd, size,
          Math.min(1, col.r * shade), Math.min(1, col.g * shade), Math.min(1, col.b * shade),
          a * alpha, s0 + d * f, wi, glow);
      }
    });
    P.flush();
    const u = P.material.uniforms;
    u.uHead.value.set(this.wheels[0].s, this.wheels[1].s);
    u.uLen.value = EGO_LEN * clamp01(vehicle.speed / FULL_SPEED);
    u.uScale.value = pxScale;
    u.uTime.value = (u.uTime.value + dt) % 1000;
  }
}
