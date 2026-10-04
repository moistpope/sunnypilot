// Car controls mockup, the 3D side (carcontrols.js drives it). The roof fades to a glassy outline so the
// cabin shows from above, the parts a category is about glow, and what the model lacks is drawn over it:
// the drive units and battery in x-ray, the charge-port door, the trunk amplifier, air from the vents,
// sound rings over the seats, the sensors' coverage on the ground, and the ring of particles a drive-mode
// change sends out. It only draws: nothing here talks to the car.
//
// Car frame = scene frame (the ego car sits still at the origin): X right, Y up, Z back, the front bumper
// at Z = 0. The part names are the nodes tools/export_ocean_glb.py splits out of the Ocean model.
import * as THREE from '../vendor/three.module.min.js';
import { SPECK_FRAGMENT, speckBlending } from './tracks.js';

const ROOF_NODES = ['Roof', 'Tailgate__PBR_glass_dark', 'Tailgate__black'];   // everything between the rails, and the rear window
const ROOF_MIN = 0.08;      // the faded roof keeps this much opacity: a faint glassy edge
const DOORS = {             // hinge axis (glTF, local) and open angle, from the model's controls.json
  Door_Front_L: ['y', -1.134], Door_Front_R: ['y', 1.134], Door_Rear_L: ['y', -1.134], Door_Rear_R: ['y', 1.134], Tailgate: ['z', -1.396],
};
const WINDOWS = ['Window_Front_L', 'Window_Front_R', 'Window_Rear_L', 'Window_Rear_R', 'Window_Quarter_L', 'Window_Quarter_R', 'Tailgate__PBR_glass_dark'];
const WINDOW_DROP = 0.42;   // m the side glass winds down (into the door, cut at its sill)
const TIRES = ['Wheel_Front_L__PBR_tire', 'Wheel_Front_R__PBR_tire', 'Wheel_Rear_L__PBR_tire', 'Wheel_Rear_R__PBR_tire'];
const LAMP_NODES = ['Body__Light_Headlights_L', 'Body__Light_Headlights_R', 'Body__Light_DRL_L', 'Body__Light_DRL_R', 'Body__Light_DRL_Center'];

// Zones: what a category lights up and where a tap picks it. boxes: [x0, y0, z0, x1, y1, z1] tap targets
// (mirror: and the same on the right), at: where its badge sits, nodes: model parts that glow, built:
// drawn parts that glow.
export const ZONES = {
  lamps: { boxes: [[-0.98, 0.62, -0.1, 0.98, 1.05, 0.72]], at: [-0.6, 1.0, 0.36], nodes: LAMP_NODES },
  vents: { boxes: [[-0.75, 0.9, 1.42, 0.75, 1.25, 1.72]], at: [0.42, 1.12, 1.6], nodes: ['Dash_Vents', 'Console'] },
  seats: { boxes: [[-0.72, 0.3, 1.86, 0.72, 1.5, 2.8]], at: [-0.39, 1.25, 2.4], nodes: ['Seat_FL', 'Seat_FR'] },
  drive: { boxes: [[-0.72, 0.1, 2.8, 0.72, 1.3, 3.72]], at: [0, 1.15, 3.25], nodes: ['Seat_Rear'], built: ['motors'] },
  sensors: { boxes: [[-0.3, 1.2, 1.0, 0.3, 1.6, 1.75], [-0.3, 0.2, -0.15, 0.3, 0.5, 0.15]], at: [0.12, 0.9, 0.05], built: ['sensors'] },
  port: { boxes: [[-1.1, 0.75, 1.1, -0.75, 1.15, 1.6]], at: [-0.95, 0.98, 1.36], built: ['port'] },
  amp: { boxes: [[0.2, 0.55, 3.85, 0.95, 1.1, 4.65]], at: [0.55, 0.95, 4.2], built: ['amp'] },
  doors: { boxes: [[-1.05, 0.4, 1.6, -0.75, 1.3, 3.65]], mirror: true, at: [-0.98, 1.05, 2.55], nodes: [...Object.keys(DOORS)] },
  wheels: { boxes: [[0.72, 0, 0.5, 1.05, 0.78, 1.36], [0.72, 0, 3.4, 1.05, 0.78, 4.25]], mirror: true, at: [0.98, 0.8, 0.93], nodes: TIRES },
  screen: { boxes: [[-0.25, 0.7, 1.72, 0.25, 1.15, 2.0]], at: [0, 1.12, 1.86], nodes: ['Center_Screen', 'Driver_Display'] },
};

// Other places the UI pins things to
export const ANCHORS = {
  lampL: [-0.66, 0.92, 0.3], lampR: [0.66, 0.92, 0.3],
  seatFL: [-0.39, 1.3, 2.42], seatFR: [0.39, 1.3, 2.42], seatRL: [-0.48, 1.05, 3.2], seatRM: [0, 1.05, 3.25], seatRR: [0.48, 1.05, 3.2],
  wheelFL: [-0.96, 0.4, 0.93], wheelFR: [0.96, 0.4, 0.93], wheelRL: [-0.96, 0.4, 3.82], wheelRR: [0.96, 0.4, 3.82],
  doorFL: [-0.96, 1.0, 2.05], doorFR: [0.96, 1.0, 2.05], doorRL: [-0.96, 1.0, 3.05], doorRR: [0.96, 1.0, 3.05], tailgate: [0, 1.2, 4.75],
  port: [-0.95, 0.98, 1.36], camera: [0, 1.47, 1.82], radar: [0, 0.37, 0.0], amp: [0.55, 0.9, 4.2],
};

const SEAT_HEADS = { FL: [-0.39, 1.34, 2.55], FR: [0.39, 1.34, 2.55], RL: [-0.48, 1.18, 3.4], RR: [0.48, 1.18, 3.4] };

// ---- shaders -------------------------------------------------------------------------------------------

const RIM_VERT = `
  varying vec3 vN;
  varying vec3 vV;
  varying vec3 vP;
  void main() {
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    vN = normalize(normalMatrix * normal);
    vV = normalize(-mv.xyz);
    vP = position;
    gl_Position = projectionMatrix * mv;
  }`;

// a glow over a part: a light wash, brightest at its silhouette
const GLOW_FRAG = `
  uniform vec3 uColor;
  uniform float uLevel;
  varying vec3 vN;
  varying vec3 vV;
  void main() {
    float rim = 1.0 - abs(dot(normalize(vN), normalize(vV)));
    float a = uLevel * (0.3 + 0.7 * rim * rim);
    if (a < 0.003) discard;
    gl_FragColor = vec4(uColor * (0.7 + 0.6 * rim), a);
    #include <colorspace_fragment>
  }`;

// the rest of the car, see-through: faces nearly clear, outlines kept
const GHOST_FRAG = `
  uniform vec3 uColor;
  uniform float uFade;
  varying vec3 vN;
  varying vec3 vV;
  void main() {
    float rim = 1.0 - abs(dot(normalize(vN), normalize(vV)));
    float a = mix(0.85, 0.035 + 0.5 * pow(rim, 2.5), uFade);
    gl_FragColor = vec4(uColor * (0.75 + 0.5 * rim), a);
    #include <colorspace_fragment>
  }`;

// drawn parts seen through the body: rim-lit, with an optional grid of cells filled up to uFill along z
const XRAY_FRAG = `
  uniform vec3 uColor;
  uniform float uLevel;
  uniform float uFill;
  uniform float uGrid;
  uniform vec3 uSize;
  uniform float uTime;
  varying vec3 vN;
  varying vec3 vV;
  varying vec3 vP;
  void main() {
    float rim = 1.0 - abs(dot(normalize(vN), normalize(vV)));
    float a = 0.18 + 0.6 * rim * rim;
    if (uGrid > 0.5) {
      vec3 u = vP / uSize + 0.5;                  // 0..1 across the box
      float along = 1.0 - u.z;                    // the pack fills from the rear forward
      vec2 cell = fract(vec2(u.x * 2.0, u.z * 12.0));
      float edge = 1.0 - smoothstep(0.0, 0.06, min(min(cell.x, 1.0 - cell.x), min(cell.y, 1.0 - cell.y)));
      float full = step(along, uFill);
      float front = exp(-pow((along - uFill) * 30.0, 2.0)) * (0.6 + 0.4 * sin(uTime * 6.0));
      a = 0.08 + 0.35 * full + 0.3 * edge + 0.5 * front + 0.4 * rim * rim;
    }
    a *= uLevel;
    if (a < 0.003) discard;
    gl_FragColor = vec4(uColor, a);
    #include <colorspace_fragment>
  }`;

// expanding rings over a seat (a disc in its plane)
const RINGS_FRAG = `
  uniform vec3 uColor;
  uniform float uLevel;
  uniform float uTime;
  varying vec2 vUv;
  void main() {
    float r = length(vUv * 2.0 - 1.0);
    if (r > 1.0) discard;
    float a = 0.0;
    for (int i = 0; i < 3; i++) {
      float ri = fract(uTime * 0.55 + float(i) / 3.0);
      a += exp(-pow((r - ri) / 0.045, 2.0)) * (1.0 - ri) * smoothstep(0.0, 0.15, ri);
    }
    a *= uLevel;
    if (a < 0.003) discard;
    gl_FragColor = vec4(uColor, a);
    #include <colorspace_fragment>
  }`;

// a sensor's field of view on the ground: fading with range, a brighter rim, a sweep running out
const FAN_FRAG = `
  uniform vec3 uColor;
  uniform float uLevel;
  uniform float uTime;
  uniform float uRange;
  uniform float uHalf;
  varying vec3 vP;
  void main() {
    float r = length(vP.xy) / uRange;
    if (r > 1.0) discard;
    float angle = abs(atan(vP.x, vP.y));
    float side = 1.0 - smoothstep(0.0, 0.06, abs(angle - uHalf) * r * uRange);   // the edges, ~6 cm lines
    float sweep = exp(-pow((r - fract(uTime * 0.45)) * 9.0, 2.0));
    float a = (0.22 * pow(1.0 - r, 1.3) + 0.35 * side * (1.0 - r) + 0.25 * sweep * (1.0 - r)) * uLevel;
    if (a < 0.003) discard;
    gl_FragColor = vec4(uColor, a);
    #include <colorspace_fragment>
  }`;

const UNIFORM = (v) => ({ value: v });

function glowMaterial(color) {
  return new THREE.ShaderMaterial({
    uniforms: { uColor: UNIFORM(new THREE.Color(color)), uLevel: UNIFORM(0) },
    vertexShader: RIM_VERT, fragmentShader: GLOW_FRAG,
    transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -4,
  });
}

function xrayMaterial(color, extra = {}) {
  return new THREE.ShaderMaterial({
    uniforms: {
      uColor: UNIFORM(new THREE.Color(color)), uLevel: UNIFORM(0), uFill: UNIFORM(1), uGrid: UNIFORM(0),
      uSize: UNIFORM(new THREE.Vector3(1, 1, 1)), uTime: UNIFORM(0), ...extra,
    },
    vertexShader: RIM_VERT, fragmentShader: XRAY_FRAG,
    transparent: true, depthWrite: false, depthTest: false,
  });
}

const ease = (k, dt, rate) => k * (1 - Math.exp(-dt * rate));
const smooth = (t) => t * t * (3 - 2 * t);

export class Cutaway {
  constructor(scene) {
    this.scene = scene;
    this.ego = null;
    this.dark = false;
    this.time = 0;
    this.roof = { k: 0, want: 0, mats: [] };
    this.ghost = { k: 0, want: 0, keep: new Set(), applied: null };
    this.glows = new Map();      // node or built part -> { meshes, material, want: {level, color, pulse}, level }
    this.lit = new Set();        // zones glowing
    this.overview = false;       // all zones pulse softly
    this.tints = new Map();      // node -> { color, level }: steady glows set by a control (seat heat)
    this.doors = new Map();      // node -> { node, axis, angle, k, want }
    this.windows = { k: 0, want: 0, list: [] };
    this.built = {};             // drawn parts
    this.groups = new THREE.Group();   // everything drawn here, in the car frame
    this.groups.name = 'cutaway';
    this._v = new THREE.Vector3();
    this.accent = new THREE.Color(0x3e6ae1);
  }

  // the glTF ego car has loaded
  attach(ego) {
    this.ego = ego;
    const model = ego.userData.model;
    if (!model) return;
    this.scene.renderer.localClippingEnabled = true;
    ego.add(this.groups);
    model.updateMatrixWorld(true);
    const find = (name) => model.getObjectByName(name);
    this.meshes = [];   // the model's own meshes (for the ghost)
    model.traverse((o) => { if (o.isMesh) this.meshes.push(o); });

    // Windows: each its own glass, cut at its sill so it winds down into the door. The rear window is
    // also part of the roof (below), which fades this same copy.
    for (const name of WINDOWS) {
      const node = find(name);
      if (!node) continue;
      const box = new THREE.Box3().setFromObject(node);
      const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -(box.min.y + 0.01));   // keeps what's above the sill
      node.traverse((o) => {
        if (!o.isMesh) return;
        o.material = o.material.clone();
        o.material.clippingPlanes = [plane];
        o.material.userData.own = true;
      });
      this.windows.list.push({ node, rest: node.position.clone(), drop: name.includes('Quarter') || name.startsWith('Tailgate') ? 0.3 : WINDOW_DROP });
    }

    // roof: its own copies of the materials it shares with the body, so it can fade alone
    const fading = new Set(), clones = new Map();
    for (const name of ROOF_NODES) {
      find(name)?.traverse((o) => {
        if (!o.isMesh) return;
        const m = o.material;
        if (!m.userData.own && !clones.has(m)) clones.set(m, m.clone());
        o.material = m.userData.own ? m : clones.get(m);
        fading.add(o.material);
      });
    }
    for (const m of fading) m.userData.base = { opacity: m.opacity, transparent: m.transparent, depthWrite: m.depthWrite };
    this.roof.mats = [...fading];

    // front seats, which the position pad moves
    this.seats = new Map();
    for (const name of ['Seat_FL', 'Seat_FR']) {
      const node = find(name);
      if (node) this.seats.set(name, { node, rest: node.position.clone(), fwd: 0, up: 0, k: [0, 0] });
    }

    // doors
    for (const [name, [axis, angle]] of Object.entries(DOORS)) {
      const node = find(name);
      if (node) this.doors.set(name, { node, axis, angle, k: 0, want: 0 });
    }

    // glows over the model's parts: one per node, sharing its geometry and following its moves
    const nodes = new Set(Object.values(ZONES).flatMap(z => z.nodes || []));
    for (const name of nodes) {
      const node = find(name);
      if (!node) continue;
      const material = glowMaterial(this.accent);
      const meshes = [];
      node.traverse((o) => {
        if (!o.isMesh || o.userData.cutaway || o.material.clippingPlanes) return;   // not the winding glass
        const m = new THREE.Mesh(o.geometry, material);
        m.userData.cutaway = true;
        m.renderOrder = 6;
        m.visible = false;
        o.add(m);
        meshes.push(m);
      });
      this.glows.set(name, { meshes, material, level: 0 });
    }

    this._buildPowertrain();
    this._buildBattery();
    this._buildPort(find);
    this._buildAmp();
    this._buildSensors();
    this._buildAirflow();
    this._buildSound();
    this._buildPulse();
    this.setTheme(this.dark);
  }

  setTheme(dark) {
    this.dark = dark;
    this.accent.set(dark ? 0x5b86ff : 0x3e6ae1);
    const blend = speckBlending(dark);
    for (const g of this.glows.values()) { g.material.blending = blend; g.material.needsUpdate = true; }
    for (const m of this._blended || []) { m.blending = blend; m.needsUpdate = true; }
    if (this.ghostMat) this.ghostMat.uniforms.uColor.value.set(dark ? 0x9aa6bb : 0x5d6675);
  }

  // ---- what carcontrols.js sets ------------------------------------------------------------------------

  setRoof(open) { this.roof.want = open ? 1 : 0; this.awake = true; }

  // the rest of the car see-through except these nodes
  setGhost(on, keep = []) {
    this.awake = true;
    this.ghost.want = on ? 1 : 0;
    if (on) this.ghost.keep = new Set(keep);
  }

  // zones that glow; overview: all of them pulse softly instead
  setZones(ids, overview = false) {
    this.awake = true;
    this.lit = new Set(ids);
    this.overview = overview;
  }

  // a steady glow of its own on a node (seat heating / ventilation), or null
  tint(node, color, level) {
    this.awake = true;
    if (color == null || level <= 0) this.tints.delete(node);
    else this.tints.set(node, { color: new THREE.Color(color), level });
  }

  // move a front seat from where it's modeled: fwd, up (m)
  seatOffset(name, fwd, up) {
    this.awake = true;
    const s = this.seats && this.seats.get(name);
    if (s) { s.fwd = fwd; s.up = up; }
  }

  setDoor(name, open) { const d = this.doors.get(name); if (d) d.want = open ? 1 : 0; this.awake = true; }
  doorOpen(name) { const d = this.doors.get(name); return !!(d && d.want); }
  setWindows(down) { this.windows.want = down ? 1 : 0; this.awake = true; }

  // x-ray drive units, in the drive mode's color
  setPowertrain(on, color) {
    this.awake = true;
    const p = this.built.motors;
    if (!p) return;
    p.want = on ? 1 : 0;
    if (color != null) p.color.set(color);
  }

  setBattery(on, soc, charging) {
    this.awake = true;
    const b = this.built.battery;
    if (!b) return;
    b.want = on ? 1 : 0;
    b.fill = soc;
    b.charging = charging;
  }

  setPort(open, charging) {
    this.awake = true;
    const p = this.built.port;
    if (!p) return;
    p.want = open ? 1 : 0;
    p.charging = charging;
  }

  setAmp(on) { if (this.built.amp) this.built.amp.want = on ? 1 : 0; this.awake = true; }
  setSensors(on, which = null) {
    this.awake = true;
    const s = this.built.sensors;
    if (!s) return;
    s.want = on ? 1 : 0;
    for (const f of s.fans) f.on = !which || which.includes(f.kind);
  }

  // air from the vents: fan 0..7 (0 = off), temperatures (deg C) left and right, where it goes
  setAirflow(on, fan, tempL, tempR, mode) {
    this.awake = true;
    const a = this.built.air;
    if (!a) return;
    a.want = on && fan > 0 ? 1 : 0;
    a.fan = fan;
    a.material.uniforms.uColorL.value.copy(tempColor(tempL));
    a.material.uniforms.uColorR.value.copy(tempColor(tempR));
    if (mode !== a.mode) { a.mode = mode; this._aimAir(mode); }
  }

  // sound rings over these seats ('FL', 'FR', 'RL', 'RR')
  setSound(seats) {
    this.awake = true;
    for (const [k, r] of Object.entries(this.built.rings || {})) r.want = seats.includes(k) ? 1 : 0;
  }

  // a ring of particles out from the car in this color (a drive-mode change)
  pulse(color) {
    this.awake = true;
    const p = this.built.pulse;
    if (!p) return;
    p.material.uniforms.uColor.value.set(color);
    p.material.uniforms.uStart.value = this.time;
    p.points.visible = true;
  }

  // the zone a tap ray hits first, or null
  pick(ray) {
    if (!ray || !this.ego) return null;
    let best = null, bestD = Infinity;
    const box = this._box || (this._box = new THREE.Box3());
    for (const [id, z] of Object.entries(ZONES)) {
      for (const b of z.boxes) {
        for (const s of z.mirror ? [1, -1] : [1]) {
          box.min.set(s > 0 ? b[0] : -b[3], b[1], b[2]);
          box.max.set(s > 0 ? b[3] : -b[0], b[4], b[5]);
          const hit = ray.intersectBox(box, this._v);
          if (hit) {
            const d = hit.distanceTo(ray.origin);
            if (d < bestD) { bestD = d; best = id; }
          }
        }
      }
    }
    return best;
  }

  // ---- drawn parts ---------------------------------------------------------------------------------------

  _blend(m) { (this._blended || (this._blended = [])).push(m); return m; }

  _buildPowertrain() {
    const g = new THREE.Group();
    const color = new THREE.Color(0x2fa84f);
    const mat = this._blend(xrayMaterial(color));
    const motor = new THREE.CylinderGeometry(0.13, 0.13, 0.36, 28).rotateZ(Math.PI / 2);
    const gearbox = new THREE.BoxGeometry(0.2, 0.26, 0.24);
    const inverter = new THREE.BoxGeometry(0.34, 0.08, 0.22);
    const shaft = new THREE.CylinderGeometry(0.025, 0.025, 0.56, 10).rotateZ(Math.PI / 2);
    for (const z of [0.93, 3.82]) {
      const unit = new THREE.Group();
      unit.position.set(0, 0.38, z);
      const m = new THREE.Mesh(motor, mat); m.position.x = -0.12;
      const b = new THREE.Mesh(gearbox, mat); b.position.x = 0.15;
      const inv = new THREE.Mesh(inverter, mat); inv.position.set(-0.08, 0.2, 0);
      const l = new THREE.Mesh(shaft, mat); l.position.x = -0.55;
      const r = new THREE.Mesh(shaft, mat); r.position.x = 0.52;
      unit.add(m, b, inv, l, r);
      g.add(unit);
    }
    g.traverse((o) => { o.renderOrder = 9; });
    g.visible = false;
    this.groups.add(g);
    this.built.motors = { group: g, material: mat, color, k: 0, want: 0, glow: 0 };
  }

  _buildBattery() {
    const size = new THREE.Vector3(1.42, 0.12, 2.3);
    const mat = this._blend(xrayMaterial(0x2fa84f, { uSize: UNIFORM(size) }));
    mat.uniforms.uGrid.value = 1;
    const m = new THREE.Mesh(new THREE.BoxGeometry(size.x, size.y, size.z), mat);
    m.position.set(0, 0.2, 2.38);
    m.renderOrder = 8;
    m.visible = false;
    this.groups.add(m);
    this.built.battery = { mesh: m, material: mat, k: 0, want: 0, fill: 0.7, shown: 0.7, charging: false };
  }

  // The charge-port door on the front left fender (placed on the paint by a ray from outside), hinged at
  // its front edge, with the socket behind it.
  _buildPort(find) {
    const paint = this.ego.userData.paint[0];
    const targets = [];
    find('Body__PBR_carpaint')?.traverse((o) => { if (o.isMesh) targets.push(o); });
    const rc = new THREE.Raycaster(new THREE.Vector3(-1.6, 0.98, 1.36), new THREE.Vector3(1, 0, 0), 0, 2);
    const hit = targets.length ? rc.intersectObjects(targets, false)[0] : null;
    if (!hit) return;
    const n = hit.face.normal.clone().transformDirection(hit.object.matrixWorld).normalize();
    if (n.x > 0) n.negate();
    const frame = new THREE.Group();   // z out of the fender, y up along it
    frame.position.copy(hit.point).addScaledVector(n, 0.003);
    frame.quaternion.setFromRotationMatrix(new THREE.Matrix4().lookAt(new THREE.Vector3(), n.clone().negate(), new THREE.Vector3(0, 1, 0)));
    const W = 0.15, H = 0.13, R = 0.025;
    const shape = new THREE.Shape();
    shape.moveTo(-W / 2 + R, -H / 2);
    shape.lineTo(W / 2 - R, -H / 2); shape.quadraticCurveTo(W / 2, -H / 2, W / 2, -H / 2 + R);
    shape.lineTo(W / 2, H / 2 - R); shape.quadraticCurveTo(W / 2, H / 2, W / 2 - R, H / 2);
    shape.lineTo(-W / 2 + R, H / 2); shape.quadraticCurveTo(-W / 2, H / 2, -W / 2, H / 2 - R);
    shape.lineTo(-W / 2, -H / 2 + R); shape.quadraticCurveTo(-W / 2, -H / 2, -W / 2 + R, -H / 2);
    // the hinge is the door's edge toward the front of the car: local -x or +x, whichever points forward
    const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(frame.quaternion.clone().invert());
    const hingeX = fwd.x >= 0 ? W / 2 : -W / 2;
    const hinge = new THREE.Group();
    hinge.position.x = hingeX;
    const door = new THREE.Mesh(new THREE.ExtrudeGeometry(shape, { depth: 0.006, bevelEnabled: false, curveSegments: 4 }).translate(-hingeX, 0, 0), paint);
    hinge.add(door);
    const seam = new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints(shape.getPoints(6).map(p => new THREE.Vector3(p.x, p.y, 0.007))),
      new THREE.LineBasicMaterial({ color: 0x0b0c0e, transparent: true, opacity: 0.55 }));
    const socket = new THREE.Mesh(new THREE.CircleGeometry(0.045, 32), new THREE.MeshStandardMaterial({ color: 0x0d0e10, roughness: 0.6 }));
    socket.position.z = 0.0005;   // on the paint, under the closed door
    const ringMat = new THREE.MeshBasicMaterial({ color: 0x2fa84f, transparent: true, opacity: 0, toneMapped: false });
    const ring = new THREE.Mesh(new THREE.RingGeometry(0.047, 0.058, 40), ringMat);
    ring.position.z = 0.001;
    socket.visible = ring.visible = false;
    frame.add(hinge, seam, socket, ring);
    this.groups.add(frame);
    const glow = glowMaterial(this.accent);
    const shell = new THREE.Mesh(door.geometry, glow);
    shell.renderOrder = 6;
    door.add(shell);
    this.glows.set('port', { meshes: [shell], material: glow, level: 0 });
    this.built.port = { frame, hinge, socket, ring, ringMat, sign: hingeX > 0 ? 1 : -1, k: 0, want: 0, charging: false };
  }

  _buildAmp() {
    const g = new THREE.Group();
    const mat = this._blend(xrayMaterial(0x3e6ae1));
    g.add(new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.2, 0.3), mat));
    for (let i = -2; i <= 2; i++) {
      const fin = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.18, 0.012), mat);
      fin.position.set(-0.045, 0, i * 0.055);
      g.add(fin);
    }
    g.position.set(0.62, 0.86, 4.2);
    g.traverse((o) => { o.renderOrder = 9; });
    g.visible = false;
    this.groups.add(g);
    this.built.amp = { group: g, material: mat, k: 0, want: 0 };
    this.glows.set('amp', { meshes: [], material: mat, level: 0, xray: true });
  }

  // Coverage on the ground. Ranges are drawn short of the sensors' real reach, so the fans fit the view.
  _buildSensors() {
    const g = new THREE.Group();
    const fans = [];
    const fan = (kind, color, x, z, heading, half, range) => {
      const mat = this._blend(new THREE.ShaderMaterial({
        uniforms: { uColor: UNIFORM(new THREE.Color(color)), uLevel: UNIFORM(0), uTime: UNIFORM(0), uRange: UNIFORM(range), uHalf: UNIFORM(half) },
        vertexShader: 'varying vec3 vP; void main() { vP = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
        fragmentShader: FAN_FRAG, transparent: true, depthWrite: false,
      }));
      // CircleGeometry sweeps from +x counterclockwise; centered on +y, then laid flat facing `heading`
      const geo = new THREE.CircleGeometry(range, 48, Math.PI / 2 - half, 2 * half);
      const m = new THREE.Mesh(geo, mat);
      m.rotation.order = 'YXZ';
      m.rotation.set(-Math.PI / 2, heading, 0);
      m.position.set(x, 0.025, z);
      m.renderOrder = 2;
      g.add(m);
      fans.push({ kind, mesh: m, material: mat, on: true });
    };
    const DEG = Math.PI / 180;
    // heading: 0 = forward (-Z), +90 = left
    fan('camera', 0x3e6ae1, 0, 0.1, 0, 26 * DEG, 11);
    fan('radar', 0x0a9fb2, 0, 0.02, 0, 45 * DEG, 8);
    fan('corner', 0x0a9fb2, -0.85, 0.3, 50 * DEG, 55 * DEG, 4.2);
    fan('corner', 0x0a9fb2, 0.85, 0.3, -50 * DEG, 55 * DEG, 4.2);
    fan('corner', 0x0a9fb2, -0.85, 4.5, 130 * DEG, 55 * DEG, 4.2);
    fan('corner', 0x0a9fb2, 0.85, 4.5, -130 * DEG, 55 * DEG, 4.2);
    fan('ultrasonic', 0x2fa84f, 0, 0.05, 0, 80 * DEG, 1.4);
    fan('ultrasonic', 0x2fa84f, 0, 4.75, 180 * DEG, 80 * DEG, 1.4);
    g.visible = false;
    this.groups.add(g);
    // the sensors themselves: the windshield camera and the radar behind the front badge
    const dotMat = this._blend(xrayMaterial(0x3e6ae1));
    const glowMats = [dotMat];
    for (const at of [ANCHORS.camera, ANCHORS.radar]) {
      const d = new THREE.Mesh(new THREE.SphereGeometry(0.045, 20, 12), dotMat);
      d.position.set(...at);
      d.renderOrder = 9;
      this.groups.add(d);
      d.visible = false;
      glowMats.push(d);
    }
    this.built.sensors = { group: g, fans, dots: glowMats.slice(1), k: 0, want: 0 };
    this.glows.set('sensors', { meshes: [], material: dotMat, level: 0, xray: true });
  }

  // Air from the dash vents: particles that leave the vent strip and drift into the cabin, tinted by
  // each side's temperature. Moved on the GPU: position = origin + velocity x age, recycled.
  _buildAirflow() {
    const N = 1400;
    const origin = new Float32Array(N * 3), vel = new Float32Array(N * 3), phase = new Float32Array(N), side = new Float32Array(N);
    for (let i = 0; i < N; i++) {
      const x = (Math.random() * 2 - 1) * 0.66;
      origin.set([x, 1.06 + (Math.random() - 0.5) * 0.03, 1.62 + Math.random() * 0.04], i * 3);
      phase[i] = Math.random();
      side[i] = x < 0 ? 0 : 1;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(origin, 3));
    geo.setAttribute('aVel', new THREE.BufferAttribute(vel, 3));
    geo.setAttribute('aPhase', new THREE.BufferAttribute(phase, 1));
    geo.setAttribute('aSide', new THREE.BufferAttribute(side, 1));
    const material = this._blend(new THREE.ShaderMaterial({
      uniforms: {
        uTime: UNIFORM(0), uRate: UNIFORM(0.6), uLevel: UNIFORM(0), uScale: UNIFORM(800),
        uColorL: UNIFORM(new THREE.Color(0x5b9cff)), uColorR: UNIFORM(new THREE.Color(0x5b9cff)),
      },
      vertexShader: `
        attribute vec3 aVel;
        attribute float aPhase;
        attribute float aSide;
        uniform float uTime;
        uniform float uRate;
        uniform float uLevel;
        uniform float uScale;
        uniform vec3 uColorL;
        uniform vec3 uColorR;
        varying vec4 vColor;
        varying float vGlow;
        void main() {
          float t = fract(uTime * uRate + aPhase);
          vec3 p = position + aVel * t + vec3(sin(aPhase * 40.0 + uTime * 3.0), cos(aPhase * 23.0 + uTime * 2.0), 0.0) * 0.02 * t;
          vGlow = step(0.9, fract(aPhase * 17.0));
          vColor = vec4(mix(uColorL, uColorR, aSide), uLevel * sin(3.14159 * t) * (vGlow > 0.5 ? 0.12 : 0.75));
          vec4 mv = modelViewMatrix * vec4(p, 1.0);
          gl_PointSize = max(1.5, (vGlow > 0.5 ? 0.05 : 0.012) * uScale / max(0.3, -mv.z));
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: SPECK_FRAGMENT, transparent: true, depthWrite: false,
    }));
    const points = new THREE.Points(geo, material);
    points.frustumCulled = false;
    points.renderOrder = 7;
    points.visible = false;
    this.groups.add(points);
    this.built.air = { points, material, geo, k: 0, want: 0, fan: 3, mode: null };
    this._aimAir('face');
  }

  _aimAir(mode) {
    const a = this.built.air;
    const pos = a.geo.attributes.position.array, vel = a.geo.attributes.aVel.array;
    const n = pos.length / 3;
    for (let i = 0; i < n; i++) {
      const x = pos[i * 3];
      const m = mode === 'both' ? (i % 2 ? 'face' : 'feet') : mode;
      // where this particle is headed: the faces, the footwells or up the windshield
      let tx, ty, tz;
      if (m === 'feet') { tx = x * 0.9; ty = 0.42; tz = 1.95 + Math.random() * 0.3; }
      else if (m === 'windshield') { tx = x * 1.05; ty = 1.38; tz = 1.15 + Math.random() * 0.15; }
      else { tx = x * 0.8 + (Math.random() - 0.5) * 0.2; ty = 1.15 + Math.random() * 0.25; tz = 2.45 + Math.random() * 0.9; }
      vel.set([tx - x, ty - pos[i * 3 + 1], tz - pos[i * 3 + 2]], i * 3);
    }
    a.geo.attributes.aVel.needsUpdate = true;
  }

  _buildSound() {
    this.built.rings = {};
    const geo = new THREE.PlaneGeometry(0.9, 0.9).rotateX(-Math.PI / 2);
    for (const [k, at] of Object.entries(SEAT_HEADS)) {
      const mat = this._blend(new THREE.ShaderMaterial({
        uniforms: { uColor: UNIFORM(new THREE.Color(0x3e6ae1)), uLevel: UNIFORM(0), uTime: UNIFORM(Math.random() * 3) },
        vertexShader: 'varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
        fragmentShader: RINGS_FRAG, transparent: true, depthWrite: false, depthTest: false, side: THREE.DoubleSide,
      }));
      const m = new THREE.Mesh(geo, mat);
      m.position.set(...at);
      m.renderOrder = 9;
      m.visible = false;
      this.groups.add(m);
      this.built.rings[k] = { mesh: m, material: mat, k: 0, want: 0 };
    }
  }

  // Drive-mode pulse: specks start on the car's footprint (a rounded rectangle) and run out ~7 m over
  // ~1.2 s, thinning, twinkling and fading as they go, a few rising. Ages come from a time uniform.
  _buildPulse() {
    const N = 6000;
    const pos = new Float32Array(N * 3), dir = new Float32Array(N * 4), look = new Float32Array(N * 4);
    const HW = 1.0, HL = 2.4, R = 0.6, CZ = 2.4;
    const straightW = 2 * (HW - R), straightL = 2 * (HL - R), arc = Math.PI * R / 2;
    const per = 2 * straightW + 2 * straightL + 4 * arc;
    for (let i = 0; i < N; i++) {
      // a point on the footprint's outline and the outward normal there
      let s = Math.random() * per, x, z, nx, nz;
      const seg = [straightW, arc, straightL, arc, straightW, arc, straightL, arc];
      let k = 0;
      while (s > seg[k]) { s -= seg[k]; k++; }
      const corner = (cx, cz, a0) => { const a = a0 + s / R; nx = Math.cos(a); nz = Math.sin(a); x = cx + R * nx; z = cz + R * nz; };
      if (k === 0) { x = -HW + R + s; z = -HL; nx = 0; nz = -1; }
      else if (k === 1) corner(HW - R, -HL + R, -Math.PI / 2);
      else if (k === 2) { x = HW; z = -HL + R + s; nx = 1; nz = 0; }
      else if (k === 3) corner(HW - R, HL - R, 0);
      else if (k === 4) { x = HW - R - s; z = HL; nx = 0; nz = 1; }
      else if (k === 5) corner(-HW + R, HL - R, Math.PI / 2);
      else if (k === 6) { x = -HW; z = HL - R - s; nx = -1; nz = 0; }
      else corner(-HW + R, -HL + R, Math.PI);
      const j = (Math.random() - 0.5) * 0.12;
      pos.set([x + nx * j, 0.05 + Math.random() * 0.05, CZ + z + nz * j], i * 3);
      const glow = Math.random() < 0.1 ? 1 : 0;
      dir.set([nx, nz, 0.75 + Math.random() * 0.5, Math.random() < 0.15 ? Math.random() * 0.5 : 0], i * 4);   // normal, speed, rise
      look.set([glow ? 0.18 + Math.random() * 0.1 : 0.02 + Math.random() * 0.03, Math.random(), glow, 0.4 + 0.6 * Math.random() ** 2], i * 4);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('aDir', new THREE.BufferAttribute(dir, 4));
    geo.setAttribute('aLook', new THREE.BufferAttribute(look, 4));
    const material = this._blend(new THREE.ShaderMaterial({
      uniforms: { uTime: UNIFORM(0), uStart: UNIFORM(-10), uColor: UNIFORM(new THREE.Color(0x2fa84f)), uScale: UNIFORM(800), uDur: UNIFORM(1.2), uDist: UNIFORM(7) },
      vertexShader: `
        attribute vec4 aDir;    // outward normal (x, z), speed, rise
        attribute vec4 aLook;   // size, twinkle phase, glow, brightness
        uniform float uTime;
        uniform float uStart;
        uniform vec3 uColor;
        uniform float uScale;
        uniform float uDur;
        uniform float uDist;
        varying vec4 vColor;
        varying float vGlow;
        void main() {
          float t = (uTime - uStart) / uDur;
          if (t < 0.0 || t >= 1.0) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); gl_PointSize = 0.0; return; }
          float d = uDist * aDir.z * (1.0 - pow(1.0 - t, 2.2));
          vec3 p = position + vec3(aDir.x, 0.0, aDir.y) * d + vec3(0.0, aDir.w * t, 0.0);
          float twinkle = 0.65 + 0.35 * sin(uTime * (9.0 + 8.0 * aLook.y) + aLook.y * 6.2832);
          float thin = step(aLook.y, 1.0 - 0.7 * t);   // the ring thins as it spreads
          vGlow = aLook.z;
          vColor = vec4(uColor, aLook.w * pow(1.0 - t, 1.4) * thin * mix(twinkle, 0.35, vGlow));
          vec4 mv = modelViewMatrix * vec4(p, 1.0);
          gl_PointSize = max(1.5, aLook.x * uScale / max(0.5, -mv.z));
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: SPECK_FRAGMENT, transparent: true, depthWrite: false,
    }));
    const points = new THREE.Points(geo, material);
    points.frustumCulled = false;
    points.renderOrder = 3;
    points.visible = false;
    this.groups.add(points);
    this.built.pulse = { points, material };
  }

  // ---- per frame -----------------------------------------------------------------------------------------

  update(dt, clock) {
    this.time = clock;
    if (!this.ego || !this.ego.userData.model || !this.awake) return;   // nothing to do with the car controls closed
    const cam = this.scene.camera;
    const h = this.scene.renderer.getDrawingBufferSize(this._buf || (this._buf = new THREE.Vector2())).y;
    const pxScale = h / (2 * Math.tan(cam.fov * Math.PI / 360));

    // roof
    const r = this.roof;
    if (r.k !== r.want) {
      r.k = Math.abs(r.want - r.k) < 0.002 ? r.want : r.k + ease(r.want - r.k, dt, 5);
      const f = smooth(r.k);
      for (const m of r.mats) {
        const b = m.userData.base;
        const fading = r.k > 0.001;
        if (m.transparent !== (fading || b.transparent)) { m.transparent = fading || b.transparent; m.needsUpdate = true; }
        m.depthWrite = fading ? false : b.depthWrite;
        m.opacity = b.opacity * (1 - (1 - ROOF_MIN) * f);
      }
    }

    this._updateGhost(dt);

    // glows: the lit zones steady and bright, or on the overview a soft pulse running from part to part
    // (all at once they'd wash the cabin in color); tints win
    const want = new Map();
    let i = 0;
    const zones = Object.keys(ZONES).length;
    for (const [id, z] of Object.entries(ZONES)) {
      const on = this.lit.has(id);
      const wave = Math.max(0, Math.sin(clock * 1.4 - (i / zones) * Math.PI * 2));
      const level = this.overview ? 0.05 + 0.3 * wave ** 6 : on ? 0.3 + 0.08 * Math.sin(clock * 3) : 0;
      i++;
      for (const n of [...(z.nodes || []), ...(z.built || [])]) {
        if (this.glows.has(n) && level > (want.get(n)?.level || 0)) want.set(n, { level, color: this.accent });
      }
    }
    for (const [n, t] of this.tints) want.set(n, { level: t.level * (0.85 + 0.15 * Math.sin(clock * 2.5)), color: t.color });
    for (const [n, g] of this.glows) {
      const w = want.get(n);
      const target = w ? w.level : 0;
      g.level += ease(target - g.level, dt, 8);
      if (g.xray) continue;   // drawn parts glow through their own material (below)
      if (w) g.material.uniforms.uColor.value.lerp(w.color, Math.min(1, dt * 8));
      g.material.uniforms.uLevel.value = g.level * (this.dark ? 1 : 0.85);
      const vis = g.level > 0.004;
      for (const m of g.meshes) m.visible = vis;
    }

    // doors and windows
    for (const d of this.doors.values()) {
      if (d.k === d.want) continue;
      d.k = Math.abs(d.want - d.k) < 0.002 ? d.want : d.k + ease(d.want - d.k, dt, 3.2);
      d.node.rotation[d.axis] = d.angle * smooth(d.k);
    }
    for (const s of (this.seats || new Map()).values()) {
      s.k[0] += ease(s.fwd - s.k[0], dt, 6);
      s.k[1] += ease(s.up - s.k[1], dt, 6);
      s.node.position.set(s.rest.x + s.k[0], s.rest.y + s.k[1], s.rest.z);   // glTF: +x forward, +y up
    }
    const w = this.windows;
    if (w.k !== w.want) {
      w.k = Math.abs(w.want - w.k) < 0.002 ? w.want : w.k + ease(w.want - w.k, dt, 2.2);
      for (const x of w.list) x.node.position.y = x.rest.y - x.drop * smooth(w.k);
    }

    const B = this.built;
    const fade = (p, rate = 5) => { p.k = Math.abs(p.want - p.k) < 0.003 ? p.want : p.k + ease(p.want - p.k, dt, rate); return p.k; };
    if (B.motors) {
      const k = fade(B.motors);
      B.motors.group.visible = k > 0.003;
      const u = B.motors.material.uniforms;
      u.uColor.value.lerp(B.motors.color, Math.min(1, dt * 4));
      u.uLevel.value = k * (this.dark ? 0.9 : 1.2) * (1 + 0.6 * (this.glows.get('Seat_Rear')?.level || 0));
    }
    if (B.battery) {
      const b = B.battery, k = fade(b);
      b.mesh.visible = k > 0.003;
      b.shown += ease(b.fill - b.shown, dt, 2.5);
      const u = b.material.uniforms;
      u.uLevel.value = k * (this.dark ? 1 : 1.3);
      u.uFill.value = b.shown;
      u.uTime.value = b.charging ? clock : 0;
      u.uColor.value.set(b.shown < 0.2 ? 0xf0a020 : 0x2fa84f);
    }
    if (B.port) {
      const p = B.port, k = fade(p, 4);
      p.hinge.rotation.y = p.sign * 1.75 * smooth(k);   // the free edge swings out
      p.socket.visible = p.ring.visible = k > 0.01;
      p.ringMat.opacity = k * (p.charging ? 0.55 + 0.45 * Math.sin(clock * 4) : 0.9);
      p.ringMat.color.set(p.charging ? 0x2fa84f : 0x8d939c);
    }
    if (B.amp) {
      const k = fade(B.amp);
      B.amp.group.visible = k > 0.003;
      B.amp.material.uniforms.uLevel.value = k * (0.8 + 0.6 * (this.glows.get('amp')?.level || 0));
    }
    if (B.sensors) {
      const s = B.sensors, k = fade(s, 4);
      s.group.visible = k > 0.003;
      for (const f of s.fans) {
        f.level = (f.level || 0) + ease((f.on ? 1 : 0) - (f.level || 0), dt, 5);
        f.material.uniforms.uLevel.value = k * f.level * (this.dark ? 1 : 1.6);
        f.material.uniforms.uTime.value = clock;
        f.mesh.visible = f.level > 0.01;
      }
      const glow = this.glows.get('sensors')?.level || 0;
      for (const d of s.dots) d.visible = k > 0.003 || glow > 0.01;
      this.glows.get('sensors').material.uniforms.uLevel.value = Math.max(k, glow * 2) * (this.dark ? 1.2 : 1.6);
    }
    if (B.air) {
      const a = B.air, k = fade(a, 3);
      a.points.visible = k > 0.003;
      const u = a.material.uniforms;
      u.uLevel.value = k;
      u.uTime.value = clock;
      u.uRate.value = 0.25 + 0.1 * a.fan;
      u.uScale.value = pxScale;
    }
    for (const ring of Object.values(B.rings || {})) {
      const k = fade(ring, 4);
      ring.mesh.visible = k > 0.003;
      ring.material.uniforms.uLevel.value = k * (this.dark ? 0.9 : 1.2);
      ring.material.uniforms.uTime.value += dt;
      ring.material.uniforms.uColor.value.copy(this.accent);
    }
    if (B.pulse && B.pulse.points.visible) {
      const u = B.pulse.material.uniforms;
      u.uTime.value = clock;
      u.uScale.value = pxScale;
      if (clock - u.uStart.value > u.uDur.value) B.pulse.points.visible = false;
    }

    // asleep once everything is back as modeled
    const moving = (p) => p && (p.k > 0 || p.want > 0);
    this.awake = this.lit.size > 0 || this.overview || this.tints.size > 0 || r.k > 0 || r.want > 0 || this.ghost.k > 0 || this.ghost.want > 0
      || [...this.glows.values()].some(x => x.level > 0.004) || [...this.doors.values()].some(moving) || moving(w)
      || ['motors', 'battery', 'port', 'amp', 'sensors', 'air'].some(k => moving(B[k])) || Object.values(B.rings || {}).some(moving)
      || (B.pulse && B.pulse.points.visible) || [...(this.seats || new Map()).values()].some(x => Math.abs(x.k[0]) + Math.abs(x.k[1]) > 1e-4 || x.fwd || x.up);
  }

  // Swap every model mesh but the kept ones to one see-through material (and back). Opaque kept parts
  // draw first, so the body's faint outline lies over them; with depth writes on, only the body's
  // nearest surface shows, not every panel behind it.
  _updateGhost(dt) {
    const g = this.ghost;
    if (g.k === g.want && !(g.want && !g.applied)) return;
    g.k = Math.abs(g.want - g.k) < 0.003 ? g.want : g.k + ease(g.want - g.k, dt, 5);
    if (!this.ghostMat) {
      this.ghostMat = new THREE.ShaderMaterial({
        uniforms: { uColor: UNIFORM(new THREE.Color(this.dark ? 0x9aa6bb : 0x5d6675)), uFade: UNIFORM(0) },
        vertexShader: RIM_VERT, fragmentShader: GHOST_FRAG, transparent: true, depthWrite: true,
      });
    }
    if (g.k > 0.003 && !g.applied) {
      g.applied = new Map();
      const keep = new Set();
      for (const n of g.keep) this.ego.userData.model.getObjectByName(n)?.traverse((o) => keep.add(o));
      // drawn after the glows, or its depth would hide the glows on the parts it lets show through
      for (const m of this.meshes) if (!keep.has(m)) { g.applied.set(m, [m.material, m.renderOrder]); m.material = this.ghostMat; m.renderOrder = 7; }
    } else if (g.k <= 0.003 && g.applied) {
      for (const [m, [mat, order]] of g.applied) { m.material = mat; m.renderOrder = order; }
      g.applied = null;
    }
    this.ghostMat.uniforms.uFade.value = smooth(g.k);
  }
}

// cold blue .. a cool neutral (about 22 deg C) .. warm orange, over 16..28 deg C
function tempColor(t) {
  const c = new THREE.Color();
  const u = Math.max(0, Math.min(1, (t - 16) / 12));
  return u < 0.5 ? c.set(0x3f7dff).lerp(new THREE.Color(0x9fd8ff), u * 2) : c.set(0x9fd8ff).lerp(new THREE.Color(0xff7a2f), (u - 0.5) * 2);
}
