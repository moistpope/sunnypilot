// Car controls mockup, the 3D side (carcontrols.js drives it). The roof fades to a glassy outline so the
// cabin shows from above, the parts a category is about glow, and what the model lacks is drawn over it:
// the drive units and battery in x-ray, the charge-port door, the trunk amplifier, air from the vents,
// sound rings over the seats, the sensors' coverage on the ground, and the ring of particles a drive-mode
// change sends out. It also moves the model's own parts: the doors and liftgate swing open, the windows
// and sunroof open, the front seats slide, tilt and recline, and the center screen turns for Hollywood Mode. It only draws: nothing here
// talks to the car.
//
// Car frame = scene frame (the ego car sits still at the origin): X right, Y up, Z back, the front bumper
// at Z = 0. The part names are the nodes tools/export_ocean_glb.py splits out of the Ocean model.
import * as THREE from '../vendor/three.module.min.js';
import { SPECK_FRAGMENT, speckBlending } from './tracks.js';

// everything between the rails (with the sunroof and the trim under it), and the rear window
const ROOF_NODES = ['Roof', 'Sunroof', 'Sunshade', 'Tailgate__PBR_glass_dark', 'Tailgate__black'];
const ROOF_MIN = 0.08;      // the faded roof keeps this much opacity: a faint glassy edge
// The doors that open: hinge axis (glTF, the node's own) and open angle, from the model's controls.json
const DOORS = {
  Door_Front_L: ['y', -1.134], Door_Front_R: ['y', 1.134], Door_Rear_L: ['y', -1.134], Door_Rear_R: ['y', 1.134], Tailgate: ['z', -1.396],
};
// The windows that open, by short name: their glass, and the axis along them in their parent's frame (glTF:
// x forward, z right). Each winds down into its door: its top edge, as modeled (curved, slanted), sinks
// down the opening and the glass under it shows full width to the sill. The model has only the glass in
// the opening, so moving the glass itself would show its narrower top sinking, as if it shrank. The rear
// window's glass and its black frit go down together.
const WINDOWS = {
  FL: ['x', 'Window_Front_L'], FR: ['x', 'Window_Front_R'], RL: ['x', 'Window_Rear_L'], RR: ['x', 'Window_Rear_R'],
  QL: ['x', 'Window_Quarter_L'], QR: ['x', 'Window_Quarter_R'], rear: ['z', 'Tailgate__PBR_glass_dark', 'Tailgate__black'],
};
const DOOR_SKIN = 'PBR_carpaint';   // a door's glow: its paint only
const WINDOW_RATE = 0.3;    // of the travel per second: ~3.3 s top to bottom, like a power window
const EDGE_N = 48;          // samples of a window's top edge
const SUNROOF_LIFT = 0.045; // m the sunroof's panel rises before it slides back over the rear panel...
const SUNROOF_SLIDE = 0.72; // m ...and how far back it goes
const SUNROOF_TILT = -0.055;  // rad, tilted: the panel's rear edge raised (about its front edge)
const SEAT_LEN = 0.5;       // m between the cushion's front and rear lifts (its tilt)
const SCREEN_PORTRAIT = Math.PI / 2;   // the model's screen is landscape; the car's shows portrait until Hollywood Mode
const TIRES = ['Wheel_Front_L__PBR_tire', 'Wheel_Front_R__PBR_tire', 'Wheel_Rear_L__PBR_tire', 'Wheel_Rear_R__PBR_tire'];
const LAMP_NODES = ['Body__Light_Headlights_L', 'Body__Light_Headlights_R', 'Body__Light_DRL_L', 'Body__Light_DRL_R', 'Body__Light_DRL_Center'];

// Zones: what a category lights up and where a tap picks it. boxes: [x0, y0, z0, x1, y1, z1] tap targets
// (mirror: and the same on the right; the nearest box along a tap wins, so a box over the cabin would
// take the taps meant for the parts inside), roofBoxes: tap targets on parts that fade with the roof, which
// count only while the car is solid, at: where its badge sits, nodes: model parts that glow, built: drawn
// parts that glow.
export const ZONES = {
  lamps: { boxes: [[-0.98, 0.62, -0.1, 0.98, 1.05, 0.72]], at: [-0.6, 1.0, 0.36], nodes: LAMP_NODES },
  vents: { boxes: [[-0.75, 0.9, 1.42, 0.75, 1.25, 1.72]], at: [0.42, 1.12, 1.6], nodes: ['Dash_Vents', 'Console'] },
  seats: { boxes: [[-0.72, 0.3, 1.86, 0.72, 1.5, 2.8]], at: [-0.39, 1.25, 2.4], nodes: ['Seat_FL', 'Seat_FR'] },
  drive: { boxes: [[-0.72, 0.1, 2.8, 0.72, 1.3, 3.72]], at: [0, 1.15, 3.25], nodes: ['Seat_Rear'], built: ['motors'] },
  // the front radar; the camera behind the mirror, over the dash, only while the roof is solid
  sensors: { boxes: [[-0.3, 0.2, -0.15, 0.3, 0.5, 0.15]], roofBoxes: [[-0.3, 1.2, 1.0, 0.3, 1.6, 1.75]], at: [0.12, 0.9, 0.05], built: ['sensors'] },
  port: { boxes: [[-1.1, 0.75, 1.1, -0.75, 1.15, 1.6]], at: [-0.95, 0.98, 1.36], built: ['port'] },
  amp: { boxes: [[0.2, 0.55, 3.85, 0.95, 1.1, 4.65]], at: [0.55, 0.95, 4.2], built: ['amp'] },
  // the doors (outside the seats), the quarter windows, the liftgate under its window; the rear window
  // (over the trunk) only while it's solid; not the sunroof, which lies over the whole cabin
  doors: { boxes: [[-1.08, 0.3, 1.62, -0.73, 1.56, 3.63], [-0.76, 1.26, 3.63, -0.58, 1.53, 4.05], [-0.62, 0.65, 4.6, 0.62, 1.2, 4.8]],
    roofBoxes: [[-0.56, 1.17, 4.28, 0.56, 1.48, 4.6]], mirror: true, at: [-0.86, 1.36, 2.2], nodes: [...Object.keys(DOORS), ...Object.values(WINDOWS).flatMap(([, ...names]) => names), 'Sunroof'] },
  wheels: { boxes: [[0.72, 0, 0.5, 1.05, 0.78, 1.36], [0.72, 0, 3.4, 1.05, 0.78, 4.25]], mirror: true, at: [0.98, 0.8, 0.93], nodes: TIRES },
  screen: { boxes: [[-0.25, 0.7, 1.72, 0.25, 1.15, 2.0]], at: [0, 1.12, 1.86], nodes: ['Center_Screen', 'Driver_Display'] },
};

// Other places the UI pins things to
export const ANCHORS = {
  lampL: [-0.66, 0.92, 0.3], lampR: [0.66, 0.92, 0.3],
  seatFL: [-0.39, 1.3, 2.42], seatFR: [0.39, 1.3, 2.42], seatRL: [-0.48, 1.05, 3.2], seatRM: [0, 1.05, 3.25], seatRR: [0.48, 1.05, 3.2],
  wheelFL: [-0.96, 0.4, 0.93], wheelFR: [0.96, 0.4, 0.93], wheelRL: [-0.96, 0.4, 3.82], wheelRR: [0.96, 0.4, 3.82],
  winFL: [-0.8, 1.33, 2.2], winFR: [0.8, 1.33, 2.2], winRL: [-0.79, 1.35, 3.06], winRR: [0.79, 1.35, 3.06],
  winQL: [-0.7, 1.4, 3.78], winQR: [0.7, 1.4, 3.78], winRear: [0, 1.33, 4.43], sunroof: [0, 1.64, 2.6],
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

// A window wound down: what's above its top edge (sampled along it), lowered by uDrop, isn't drawn.
// vEdge: the point along the window and up, in the window's parent's frame.
const EDGE_FRAG = `
  uniform float uDrop;
  uniform float uEdge[${EDGE_N}];
  uniform vec2 uEdgeSpan;
  varying vec2 vEdge;
  void windowCut() {
    float t = clamp((vEdge.x - uEdgeSpan.x) / (uEdgeSpan.y - uEdgeSpan.x), 0.0, 1.0) * ${EDGE_N - 1}.0;
    int i = int(t);
    float top = mix(uEdge[i], uEdge[min(i + 1, ${EDGE_N - 1})], t - float(i));
    if (vEdge.y > top - uDrop) discard;
  }`;

// Have a material (a window's glass, or its glow) wind down with the window: edge = { drop, edge, span }
// uniforms the window's meshes share, toEdge: the mesh's frame to (along, up) in the window's parent's.
function windowCut(material, edge, toEdge) {
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, { uDrop: edge.drop, uEdge: edge.edge, uEdgeSpan: edge.span, uToEdge: { value: toEdge } });
    shader.vertexShader = shader.vertexShader.replace('void main() {',
      'uniform mat4 uToEdge;\nvarying vec2 vEdge;\nvoid main() {\n  vEdge = (uToEdge * vec4(position, 1.0)).xy;');
    shader.fragmentShader = shader.fragmentShader.replace('void main() {', `${EDGE_FRAG}\nvoid main() {\n  windowCut();`);
  };
  material.customProgramCacheKey = () => 'windowCut';
  material.userData.cut = true;
}

// A window's top edge: the highest point of its glass at EDGE_N points along it (and the lowest, for how far
// it goes down), from its triangles' edges. meshes: [mesh, toEdge].
function topEdge(meshes) {
  const segs = [], p = new THREE.Vector3();
  let lo = Infinity, hi = -Infinity;
  for (const [mesh, toEdge] of meshes) {
    const pos = mesh.geometry.attributes.position, idx = mesh.geometry.index;
    const pts = [];
    for (let i = 0; i < pos.count; i++) {
      p.fromBufferAttribute(pos, i).applyMatrix4(toEdge);
      pts.push([p.x, p.y]);
      lo = Math.min(lo, p.x); hi = Math.max(hi, p.x);
    }
    const n = idx ? idx.count : pos.count, at = (k) => (idx ? idx.getX(k) : k);
    for (let k = 0; k < n; k += 3) {
      const a = pts[at(k)], b = pts[at(k + 1)], c = pts[at(k + 2)];
      segs.push(a, b, b, c, c, a);
    }
  }
  const edge = new Float32Array(EDGE_N);
  let travel = 0;
  for (let i = 0; i < EDGE_N; i++) {
    const x = lo + 0.001 + (hi - lo - 0.002) * i / (EDGE_N - 1);
    let top = -Infinity, bottom = Infinity;
    for (let k = 0; k < segs.length; k += 2) {
      const [ax, ay] = segs[k], [bx, by] = segs[k + 1];
      if ((ax - x) * (bx - x) > 0 || ax === bx) continue;
      const y = ay + (by - ay) * (x - ax) / (bx - ax);
      top = Math.max(top, y); bottom = Math.min(bottom, y);
    }
    edge[i] = top + 0.002;
    if (top > bottom) travel = Math.max(travel, top - bottom);
  }
  return { edge: { value: edge }, span: { value: new THREE.Vector2(lo + 0.001, hi - 0.001) }, drop: { value: 0 }, travel: travel + 0.01 };
}

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
    this.doors = new Map();      // node name -> { node, axis, angle, k, want }: open 0..1
    this.windows = new Map();    // WINDOWS key -> { nodes, edge, k, want }: open 0..1
    this.seats = new Map();      // 'FL' | 'FR' -> { node, back, rest, want, k }: slide, front, rear (m), recline (rad)
    this.sunroof = null;         // { hinge, rest, k, want, tilt, wantTilt }: the panel (and its trim) hangs from hinge
    this.screen = null;          // { node, face, k, want (1 = portrait) }
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
    ego.add(this.groups);
    model.updateMatrixWorld(true);
    const find = (name) => model.getObjectByName(name);
    this.meshes = [];   // the model's own meshes (for the ghost)
    model.traverse((o) => { if (o.isMesh) this.meshes.push(o); });

    // doors (closed: the model's rest pose)
    for (const [name, [axis, angle]] of Object.entries(DOORS)) {
      const node = find(name);
      if (node) this.doors.set(name, { node, axis, angle, k: 0, want: 0 });
    }

    // windows: their own glass, wound down by its top edge (WINDOWS); the rear window's copy also fades
    // with the roof (below). Measured in the parent's frame, so a window winds the same with its door open.
    const cuts = new Map();   // node name -> [edge uniforms, its meshes' frame to the edge's]
    const across = new THREE.Matrix4().set(0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 0, 0, 0, 0, 1);   // (z, y, x): along z
    for (const [key, [axis, ...names]] of Object.entries(WINDOWS)) {
      const nodes = names.map(find).filter(Boolean);
      if (!nodes.length) continue;
      const toParent = new THREE.Matrix4().copy(nodes[0].parent.matrixWorld).invert();
      if (axis === 'z') toParent.premultiply(across);
      const meshes = [];
      for (const n of nodes) n.traverse((o) => { if (o.isMesh) meshes.push([o, new THREE.Matrix4().multiplyMatrices(toParent, o.matrixWorld)]); });
      const edge = topEdge(meshes);
      for (const [o, toEdge] of meshes) {
        o.material = o.material.clone();
        o.material.userData.own = true;
        windowCut(o.material, edge, toEdge);
      }
      for (const n of nodes) cuts.set(n.name, [edge, meshes.find(([o]) => n.getObjectById(o.id))[1]]);
      this.windows.set(key, { nodes, edge, k: 0, want: 0 });
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

    // The sunroof's panel hangs from a hinge at its front edge (Body's frame = glTF axes: +x forward, +y up),
    // so it can tilt about it, then rise and slide back over the rear panel. The trim under its glass
    // (Sunshade, the same size, 1 cm lower) goes with it: moved apart, the two read as the sunroof splitting.
    const panel = find('Sunroof');
    if (panel) {
      const box = new THREE.Box3().setFromObject(panel);
      const hinge = new THREE.Group();
      hinge.name = 'Sunroof_Hinge';
      panel.parent.add(hinge);
      hinge.position.copy(panel.parent.worldToLocal(new THREE.Vector3(0, box.max.y, box.min.z)));
      hinge.attach(panel);
      const shade = find('Sunshade');
      if (shade) hinge.attach(shade);
      this.sunroof = { hinge, rest: hinge.position.clone(), k: 0, want: 0, tilt: 0, wantTilt: 0 };
    }

    // front seats: the cushion slides and tilts about its middle, the back reclines at the hip
    for (const side of ['FL', 'FR']) {
      const node = find('Seat_' + side);
      if (!node) continue;
      const zero = { slide: 0, front: 0, rear: 0, recline: 0 };
      this.seats.set(side, { node, back: find(`Seat_${side}_Back`), rest: node.position.clone(), want: { ...zero }, k: { ...zero } });
    }

    this._buildScreen(find);

    // glows over the model's parts: one per node, sharing its geometry and following its moves
    const nodes = new Set(Object.values(ZONES).flatMap(z => z.nodes || []));
    for (const name of nodes) {
      const node = find(name);
      if (!node) continue;
      const material = glowMaterial(this.accent);
      const cut = cuts.get(name);
      if (cut) windowCut(material, ...cut);   // a window's glow winds down with it
      const meshes = [];
      node.traverse((o) => {
        if (!o.isMesh || o.userData.cutaway || (!cut && o.material.userData.cut)) return;   // a door's glow leaves out its window
        if (DOORS[name] && o.material.name !== DOOR_SKIN) return;   // and its trim inside: three times the triangles
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

  // a front seat ('FL' | 'FR') from where it's modeled: slide forward, the cushion's front and rear edges
  // up (m), the back reclined (rad)
  seatPose(side, pose) {
    this.awake = true;
    const s = this.seats.get(side);
    if (s) Object.assign(s.want, pose);
  }

  // a door (DOORS name) open or shut
  setDoor(name, open) {
    this.awake = true;
    const d = this.doors.get(name);
    if (d) d.want = open ? 1 : 0;
  }

  // A point of the car (car frame, the doors shut) on a door, as a function giving where it is now
  doorPoint(name, at) {
    const d = this.doors.get(name), p = new THREE.Vector3(...at);
    if (!d) return () => p;
    const local = d.node.parent.worldToLocal(p.clone()).sub(d.node.position), out = new THREE.Vector3();   // from the hinge, shut
    return () => out.copy(local).applyEuler(d.node.rotation).add(d.node.position).applyMatrix4(d.node.parent.matrixWorld);
  }

  // a window (WINDOWS key) open 0..1
  setWindow(key, open) {
    this.awake = true;
    const w = this.windows.get(key);
    if (w) w.want = Math.max(0, Math.min(1, open));
  }

  // the sunroof open 0..1 (slid back), or tilted
  setSunroof(open, tilt = false) {
    this.awake = true;
    if (!this.sunroof) return;
    this.sunroof.want = Math.max(0, Math.min(1, open));
    this.sunroof.wantTilt = tilt && open <= 0 ? 1 : 0;
  }

  // the center screen landscape (Hollywood Mode) or portrait, how bright, and in which appearance
  setScreen(landscape, brightness = 1, light = false) {
    this.awake = true;
    const sc = this.screen;
    if (!sc) return;
    sc.want = landscape ? 0 : 1;
    sc.mat.color.setScalar(0.3 + 0.7 * brightness);
    if (sc.light !== light) { sc.light = light; this._drawScreen(); }
  }

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
    const solid = !this.roof.want && !this.ghost.want;   // the faded roof and the see-through body don't catch taps
    for (const [id, z] of Object.entries(ZONES)) {
      for (const b of solid && z.roofBoxes ? [...z.boxes, ...z.roofBoxes] : z.boxes) {
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

  // The center screen sits portrait until Hollywood Mode turns it landscape, as the model has it. Its face
  // shows a picture drawn here: the car's home screen (light or dark), or a film for Hollywood Mode.
  _buildScreen(find) {
    const node = find('Center_Screen');
    let face = null;
    node?.traverse((o) => { if (o.isMesh && o.material.name === 'PBR_intD') face = o; });
    if (!face) return;
    // UVs across and up the face as the driver sees it (+z is the car's right)
    const pos = face.geometry.attributes.position;
    const box = new THREE.Box3().setFromBufferAttribute(pos);
    const uv = new Float32Array(pos.count * 2);
    for (let i = 0; i < pos.count; i++) {
      uv[i * 2] = (pos.getZ(i) - box.min.z) / (box.max.z - box.min.z);
      uv[i * 2 + 1] = (pos.getY(i) - box.min.y) / (box.max.y - box.min.y);
    }
    face.geometry.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    const canvas = document.createElement('canvas');
    canvas.width = 512;
    canvas.height = Math.round(512 * (box.max.y - box.min.y) / (box.max.z - box.min.z));
    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    const mat = face.material = new THREE.MeshBasicMaterial({ map: tex, toneMapped: false });
    this.screen = { node, mat, canvas, tex, k: 1, want: 1, portrait: true, light: false };   // mat: the ghost may swap the face's
    node.rotation.x = SCREEN_PORTRAIT;
    this._drawScreen();
  }

  _drawScreen() {
    const sc = this.screen, c = sc.canvas, ctx = c.getContext('2d');
    ctx.save();
    if (sc.portrait) {   // drawn sideways: the screen turned a quarter shows it upright
      ctx.translate(0, c.height);
      ctx.rotate(-Math.PI / 2);
      drawHome(ctx, c.height, c.width, sc.light);
    } else drawFilm(ctx, c.width, c.height);
    ctx.restore();
    sc.tex.needsUpdate = true;
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
    // (all at once they'd wash the cabin in color, and draw every part twice); tints win
    const want = new Map();
    let i = 0;
    const zones = Object.keys(ZONES).length;
    for (const [id, z] of Object.entries(ZONES)) {
      const on = this.lit.has(id);
      const wave = Math.max(0, Math.sin(clock * 1.4 - (i / zones) * Math.PI * 2));
      const level = this.overview ? 0.35 * wave ** 6 : on ? 0.3 + 0.08 * Math.sin(clock * 3) : 0;
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

    // doors swing, easing in and out; windows wind at a power window's steady rate, their top edge going
    // down the opening
    for (const d of this.doors.values()) {
      if (d.k === d.want) continue;
      d.k = Math.abs(d.want - d.k) < 0.002 ? d.want : d.k + ease(d.want - d.k, dt, 3.2);
      d.node.rotation[d.axis] = d.angle * smooth(d.k);
    }
    const step = (k, want, rate) => (k < want ? Math.min(want, k + rate * dt) : Math.max(want, k - rate * dt));
    for (const w of this.windows.values()) {
      if (w.k === w.want) continue;
      w.k = step(w.k, w.want, WINDOW_RATE);
      w.edge.drop.value = w.edge.travel * w.k;
    }
    // the sunroof: tilted about its front edge, or raised and slid back
    const sr = this.sunroof;
    if (sr && (sr.k !== sr.want || sr.tilt !== sr.wantTilt)) {
      sr.tilt = sr.k > 0 ? step(sr.tilt, 0, 1.2) : step(sr.tilt, sr.wantTilt, 1.2);
      sr.k = sr.tilt > 0 ? step(sr.k, 0, 0.3) : step(sr.k, sr.want, 0.3);
      const lift = Math.min(1, sr.k / 0.12), slide = Math.max(0, (sr.k - 0.12) / 0.88);
      sr.hinge.position.set(sr.rest.x - SUNROOF_SLIDE * smooth(slide), sr.rest.y + SUNROOF_LIFT * smooth(lift), sr.rest.z);
      sr.hinge.rotation.z = SUNROOF_TILT * smooth(sr.tilt);
    }
    // front seats follow their controls closely (the buttons step them)
    for (const st of this.seats.values()) {
      const k = st.k, want = st.want;
      for (const key of ['slide', 'front', 'rear', 'recline']) k[key] += ease(want[key] - k[key], dt, 7);
      st.node.position.set(st.rest.x + k.slide, st.rest.y + (k.front + k.rear) / 2, st.rest.z);   // glTF: +x forward, +y up
      st.node.rotation.z = Math.atan2(k.front - k.rear, SEAT_LEN);   // front up = nose up
      if (st.back) st.back.rotation.z = k.recline;                   // + leans it back
    }
    // the center screen turns between portrait and landscape; its picture swaps halfway
    const sc = this.screen;
    if (sc && sc.k !== sc.want) {
      sc.k = step(sc.k, sc.want, 0.8);
      sc.node.rotation.x = SCREEN_PORTRAIT * smooth(sc.k);
      const portrait = sc.k > 0.5;
      if (portrait !== sc.portrait) { sc.portrait = portrait; this._drawScreen(); }
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
    const posed = (st) => ['slide', 'front', 'rear', 'recline'].some(key => Math.abs(st.k[key]) > 1e-4 || st.want[key]);
    this.awake = this.lit.size > 0 || this.overview || this.tints.size > 0 || r.k > 0 || r.want > 0 || this.ghost.k > 0 || this.ghost.want > 0
      || [...this.glows.values()].some(x => x.level > 0.004) || [...this.windows.values()].some(moving) || [...this.doors.values()].some(moving)
      || (sr && (moving(sr) || sr.tilt > 0 || sr.wantTilt > 0)) || (sc && sc.k !== sc.want)
      || ['motors', 'battery', 'port', 'amp', 'sensors', 'air'].some(k => moving(B[k])) || Object.values(B.rings || {}).some(moving)
      || (B.pulse && B.pulse.points.visible) || [...this.seats.values()].some(posed);
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

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

// the head unit's home screen, portrait w x h: a map with the route, a media card and the dock
function drawHome(ctx, w, h, light) {
  const bg = light ? '#eef1f5' : '#0d1015', card = light ? '#ffffff' : '#1a1f27', line = light ? '#d5dbe3' : '#2a313c';
  const fg = light ? '#1a1d22' : '#e9edf3', accent = '#3e8bff';
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, w, h);
  ctx.fillStyle = fg;
  ctx.font = `600 ${Math.round(h * 0.026)}px sans-serif`;
  ctx.fillText('9:41', w * 0.06, h * 0.035);
  ctx.fillText('72°', w * 0.82, h * 0.035);
  // map
  const mx = w * 0.05, my = h * 0.055, mw = w * 0.9, mh = h * 0.55;
  ctx.save();
  roundRect(ctx, mx, my, mw, mh, 12);
  ctx.fillStyle = light ? '#e3e8ee' : '#141922';
  ctx.fill();
  ctx.clip();
  ctx.strokeStyle = light ? '#ffffff' : '#252c37';
  ctx.lineWidth = w * 0.035;
  for (const [x0, y0, x1, y1] of [[0.1, 0.1, 0.9, 0.35], [0.25, 0, 0.35, 1], [0.6, 0, 0.75, 1], [0, 0.7, 1, 0.55]]) {
    ctx.beginPath();
    ctx.moveTo(mx + x0 * mw, my + y0 * mh);
    ctx.lineTo(mx + x1 * mw, my + y1 * mh);
    ctx.stroke();
  }
  ctx.strokeStyle = accent;
  ctx.lineWidth = w * 0.025;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(mx + 0.32 * mw, my + 0.92 * mh);
  ctx.lineTo(mx + 0.3 * mw, my + 0.62 * mh);
  ctx.lineTo(mx + 0.67 * mw, my + 0.6 * mh);
  ctx.lineTo(mx + 0.62 * mw, my + 0.18 * mh);
  ctx.stroke();
  ctx.fillStyle = '#ffffff';
  ctx.beginPath();
  ctx.arc(mx + 0.32 * mw, my + 0.92 * mh, w * 0.03, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
  // media card
  const cy = my + mh + h * 0.025, ch = h * 0.13;
  roundRect(ctx, mx, cy, mw, ch, 10);
  ctx.fillStyle = card;
  ctx.fill();
  const art = ctx.createLinearGradient(mx, cy, mx + ch, cy + ch);
  art.addColorStop(0, '#ff7a2f');
  art.addColorStop(1, '#8a3cff');
  roundRect(ctx, mx + h * 0.015, cy + h * 0.015, ch - h * 0.03, ch - h * 0.03, 8);
  ctx.fillStyle = art;
  ctx.fill();
  ctx.fillStyle = line;
  for (const [y, l] of [[0.32, 0.45], [0.55, 0.3]]) {
    roundRect(ctx, mx + ch + w * 0.02, cy + ch * y, mw * l, h * 0.014, 4);
    ctx.fill();
  }
  // dock
  const dy = h * 0.93;
  ctx.fillStyle = card;
  ctx.fillRect(0, dy - h * 0.045, w, h * 0.115);
  for (let i = 0; i < 5; i++) {
    ctx.fillStyle = i === 2 ? accent : line;
    ctx.beginPath();
    ctx.arc(w * (0.14 + i * 0.18), dy, w * 0.045, 0, Math.PI * 2);
    ctx.fill();
  }
}

// Hollywood Mode, landscape w x h: a film playing, with its controls
function drawFilm(ctx, w, h) {
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, w, h);
  const fh = h * 0.86, fw = Math.min(w, fh * 16 / 9), fx = (w - fw) / 2, fy = (h - fh) / 2;
  const sky = ctx.createLinearGradient(0, fy, 0, fy + fh);
  sky.addColorStop(0, '#2b1a5c');
  sky.addColorStop(0.55, '#e4683a');
  sky.addColorStop(1, '#f5b04c');
  ctx.fillStyle = sky;
  ctx.fillRect(fx, fy, fw, fh);
  ctx.fillStyle = '#ffd98a';
  ctx.beginPath();
  ctx.arc(fx + fw * 0.62, fy + fh * 0.62, fh * 0.16, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = '#1b1430';
  ctx.beginPath();
  ctx.moveTo(fx, fy + fh);
  for (const [x, y] of [[0, 0.72], [0.18, 0.55], [0.32, 0.7], [0.5, 0.5], [0.7, 0.74], [0.85, 0.6], [1, 0.7], [1, 1]]) ctx.lineTo(fx + x * fw, fy + y * fh);
  ctx.fill();
  ctx.fillStyle = 'rgba(255,255,255,0.85)';
  ctx.beginPath();
  ctx.moveTo(fx + fw * 0.47, fy + fh * 0.36);
  ctx.lineTo(fx + fw * 0.47, fy + fh * 0.56);
  ctx.lineTo(fx + fw * 0.55, fy + fh * 0.46);
  ctx.fill();
  ctx.fillStyle = 'rgba(255,255,255,0.35)';
  ctx.fillRect(fx + fw * 0.06, fy + fh * 0.9, fw * 0.88, h * 0.012);
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(fx + fw * 0.06, fy + fh * 0.9, fw * 0.33, h * 0.012);
}

// cold blue .. a cool neutral (about 22 deg C) .. warm orange, over 16..28 deg C
function tempColor(t) {
  const c = new THREE.Color();
  const u = Math.max(0, Math.min(1, (t - 16) / 12));
  return u < 0.5 ? c.set(0x3f7dff).lerp(new THREE.Color(0x9fd8ff), u * 2) : c.set(0x9fd8ff).lerp(new THREE.Color(0xff7a2f), (u - 0.5) * 2);
}
