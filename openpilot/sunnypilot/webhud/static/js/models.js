// Procedural low-poly models in the soft, matte style of Tesla's visualization, and the detailed
// Ocean glTF model for the ego car.
// Model space: forward = -Z, right = +X, up = +Y, origin at the FRONT bumper on the ground,
// matching the ADAS/openpilot convention (distances measured from the front bumper).
import * as THREE from '../vendor/three.module.min.js';
import { GLTFLoader } from '../vendor/GLTFLoader.js';
import { Lamp, LAMP } from './lamps.js';

const geoCache = new Map();
function cached(key, make) {
  if (!geoCache.has(key)) geoCache.set(key, make());
  return geoCache.get(key);
}

// Average normals of coincident vertices: the extrusion is non-indexed, so without this every
// triangle is flat-shaded. Everything is beveled, so smoothing across all edges reads as soft paint.
function smoothNormals(geo) {
  geo.computeVertexNormals();
  const pos = geo.attributes.position, nrm = geo.attributes.normal;
  const sums = new Map();
  const key = (i) => `${Math.round(pos.getX(i) * 500)},${Math.round(pos.getY(i) * 500)},${Math.round(pos.getZ(i) * 500)}`;
  const keys = new Array(pos.count);
  for (let i = 0; i < pos.count; i++) {
    const k = keys[i] = key(i);
    const s = sums.get(k) || [0, 0, 0];
    s[0] += nrm.getX(i); s[1] += nrm.getY(i); s[2] += nrm.getZ(i);
    sums.set(k, s);
  }
  for (let i = 0; i < pos.count; i++) {
    const [x, y, z] = sums.get(keys[i]);
    const l = Math.hypot(x, y, z) || 1;
    nrm.setXYZ(i, x / l, y / l, z / l);
  }
  nrm.needsUpdate = true;
}

// Pull the extrusion in where real cars curve: the greenhouse leans inward (tumblehome), the
// corners round off in plan view and the sills tuck under. z runs from -length (nose) to 0 (rear).
function sculpt(geo, length, s) {
  const pos = geo.attributes.position;
  const zc = -length / 2, half = length / 2 + 0.1;
  for (let i = 0; i < pos.count; i++) {
    const y = pos.getY(i), u = (pos.getZ(i) - zc) / half;
    const ty = Math.min(1, Math.max(0, (y - s.belt) / (s.roof - s.belt)));
    const tb = Math.min(1, Math.max(0, (s.sill - y) / 0.3));
    const k = 1 - s.tumble * ty * ty - s.plan * u * u * u * u - 0.06 * tb;
    pos.setX(i, pos.getX(i) * k);
  }
}

// Side profile (x: rear->front, y: up) extruded across the width, with rounded edges.
function profileGeometry(points, width, bevel = 0.1, sculptSpec = null, length = 0) {
  const shape = new THREE.Shape();
  shape.moveTo(points[0][0], points[0][1]);
  for (let i = 1; i < points.length; i++) {
    const p = points[i];
    if (p.length === 4) shape.quadraticCurveTo(p[0], p[1], p[2], p[3]);
    else shape.lineTo(p[0], p[1]);
  }
  shape.closePath();
  const depth = Math.max(0.01, width - 2 * bevel);
  const geo = new THREE.ExtrudeGeometry(shape, {
    depth, bevelEnabled: true, bevelThickness: bevel, bevelSize: bevel * 0.7, bevelSegments: 4, curveSegments: 10,
  });
  geo.translate(0, 0, -depth / 2);
  geo.rotateY(Math.PI / 2);   // shape x -> -Z (forward), extrusion -> X (width)
  if (sculptSpec) sculpt(geo, length, sculptSpec);
  smoothNormals(geo);
  return geo;
}

// Fisker Ocean-like SUV, 4.775 m long. Numbers: x from the rear, y up.
const OCEAN = {
  length: 4.775, width: 1.98, height: 1.63, wheelR: 0.38, axles: [0.93, 3.85],
  shape: { belt: 1.08, roof: 1.68, tumble: 0.26, plan: 0.12, sill: 0.42 },
  body: [
    [0.12, 0.32], [0.0, 0.42, 0.0, 0.6], [0.02, 0.98], [0.08, 1.12, 0.24, 1.2],
    [0.62, 1.58], [0.9, 1.63, 1.3, 1.63], [2.65, 1.62], [3.35, 1.18],
    [4.5, 1.0], [4.74, 0.96, 4.775, 0.74], [4.76, 0.36], [4.7, 0.3, 4.55, 0.3], [0.2, 0.3],
  ],
  glass: [
    [0.2, 1.17], [0.62, 1.57], [0.9, 1.645, 1.3, 1.645], [2.66, 1.635], [3.36, 1.17], [2.0, 1.09],
  ],
};

const SEDAN = {
  length: 4.7, width: 1.85, height: 1.45, wheelR: 0.33, axles: [0.95, 3.8],
  shape: { belt: 0.95, roof: 1.5, tumble: 0.3, plan: 0.14, sill: 0.4 },
  body: [
    [0.1, 0.3], [0.0, 0.4, 0.0, 0.58], [0.05, 0.98], [0.5, 1.02], [1.25, 1.42], [1.6, 1.46, 2.0, 1.46],
    [2.6, 1.44], [3.35, 1.0], [4.5, 0.86], [4.7, 0.82, 4.7, 0.6], [4.66, 0.32], [4.5, 0.28, 4.3, 0.28], [0.2, 0.28],
  ],
  glass: [[0.6, 1.0], [1.25, 1.415], [1.6, 1.475, 2.0, 1.475], [2.62, 1.455], [3.36, 0.99], [2.0, 0.93]],
};

const TRUCK = {
  length: 7.5, width: 2.4, height: 3.1, wheelR: 0.5, axles: [1.2, 2.6, 6.2],
  shape: { belt: 2.4, roof: 3.2, tumble: 0.04, plan: 0.03, sill: 0.7 },
  body: [[0, 0.55], [0, 3.1], [5.4, 3.1], [5.4, 2.6], [5.6, 2.6], [5.75, 2.45], [6.1, 2.4], [7.45, 1.4], [7.5, 0.55]],
  glass: [[5.95, 2.42], [6.95, 1.85], [6.6, 1.6], [5.9, 1.6]],
};

function wheel(r, w, dark) {
  const g = new THREE.Group();
  const tire = new THREE.Mesh(cached(`tire${r}${w}`, () => new THREE.CylinderGeometry(r, r, w, 28).rotateZ(Math.PI / 2)), dark);
  g.add(tire);
  const rim = new THREE.Mesh(
    cached(`rim${r}${w}`, () => new THREE.CylinderGeometry(r * 0.62, r * 0.62, w + 0.02, 24).rotateZ(Math.PI / 2)),
    rimMaterial,
  );
  g.add(rim);
  // three bars through the hub (six arms), so a spinning wheel reads as spinning
  for (let i = 0; i < 3; i++) {
    const spoke = new THREE.Mesh(cached(`spoke${r}${w}`, () => new THREE.BoxGeometry(w + 0.04, r * 1.18, r * 0.16)), spokeMaterial);
    spoke.rotation.x = i * Math.PI / 3;
    g.add(spoke);
  }
  return g;
}

const rimMaterial = new THREE.MeshStandardMaterial({ color: 0x8a9099, roughness: 0.35, metalness: 0.6 });
const spokeMaterial = new THREE.MeshStandardMaterial({ color: 0x5a6069, roughness: 0.4, metalness: 0.5 });
const tireMaterial = new THREE.MeshStandardMaterial({ color: 0x1c1d20, roughness: 0.9 });
const glassMaterial = new THREE.MeshStandardMaterial({ color: 0x15171b, roughness: 0.18, metalness: 0.4 });

let shadowTexture = null;
function shadowTex() {
  if (shadowTexture) return shadowTexture;
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const ctx = c.getContext('2d');
  const g = ctx.createRadialGradient(64, 64, 10, 64, 64, 64);
  g.addColorStop(0, 'rgba(0,0,0,0.55)');
  g.addColorStop(0.55, 'rgba(0,0,0,0.28)');
  g.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 128, 128);
  shadowTexture = new THREE.CanvasTexture(c);
  return shadowTexture;
}

export function softShadow(w, l) {
  const m = new THREE.Mesh(
    cached('shadowplane', () => new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2)),
    new THREE.MeshBasicMaterial({ map: shadowTex(), transparent: true, depthWrite: false }),
  );
  m.scale.set(w * 1.35, 1, l * 1.2);
  m.position.y = 0.01;
  m.renderOrder = 1;
  return m;
}

// A car-like vehicle built from a profile spec. Returns a Group sized to spec, front bumper at z=0.
function vehicle(spec, paint, opts = {}) {
  const g = new THREE.Group();
  const bevel = opts.bevel ?? 0.12;
  const body = new THREE.Mesh(cached(`body${spec.length}/${bevel}`, () => profileGeometry(spec.body, spec.width, bevel, spec.shape, spec.length)), paint);
  const glass = new THREE.Mesh(cached(`glass${spec.length}`, () => profileGeometry(spec.glass, spec.width + 0.03, 0.1, spec.shape, spec.length)), glassMaterial);
  // after profileGeometry's rotation the rear sits at z=0 and the nose at z=-length; shift by +length
  body.position.z = spec.length;
  glass.position.z = spec.length;
  g.add(body, glass);

  // each wheel hangs off steer (yaw, front axle only) -> spin (roll about the axle, X)
  const tw = 0.26 * (spec.width / 1.9);
  const wheels = [];
  const frontAxle = Math.max(...spec.axles);
  for (const ax of spec.axles) {
    for (const side of [-1, 1]) {
      const steer = new THREE.Group();
      steer.position.set(side * (spec.width / 2 - tw / 2 + 0.03), spec.wheelR, spec.length - ax);
      const spin = new THREE.Group();
      spin.add(wheel(spec.wheelR, tw, tireMaterial));
      steer.add(spin);
      g.add(steer);
      wheels.push({ steer, spin, axis: 'x', pos: steer.position, r: spec.wheelR, w: tw, front: ax === frontAxle, spokes: 6 });
    }
  }
  const shadow = softShadow(spec.width, spec.length);
  shadow.position.z = spec.length / 2;
  g.add(shadow);
  g.userData = { paint: [paint], length: spec.length, width: spec.width, height: spec.height, wheels, rearAxleZ: spec.length - Math.min(...spec.axles) };
  return g;
}

// ---- ego ---------------------------------------------------------------------------------------

// procedural Ocean, used until the glTF model has loaded (or if it can't be)
export function makeEgo(color = 0x2a2d33) {
  const paint = new THREE.MeshStandardMaterial({ color, roughness: 0.38, metalness: 0.35 });
  const g = vehicle(OCEAN, paint, { bevel: 0.14 });
  const L = OCEAN.length, W = OCEAN.width;
  const lamps = {
    drl: new Lamp(LAMP.white, 0x8d939b), tail: new Lamp(LAMP.red, 0x4a0c0a), reverse: new Lamp(LAMP.white, 0x6a6e74),
    frontL: new Lamp(LAMP.amber, 0x3a3127), frontR: new Lamp(LAMP.amber, 0x3a3127),
    rearL: new Lamp(LAMP.amber, 0x4a0c0a), rearR: new Lamp(LAMP.amber, 0x4a0c0a),
  };
  // the bevel grows the body ~0.1 m past its profile, so the lenses sit just outside that
  const box = (lamp, w, h, x, y, z) => {
    const m = new THREE.Mesh(cached(`lens${w}/${h}`, () => new THREE.BoxGeometry(w, h, 0.03)), lamp.lens);
    m.position.set(x, y, z);
    g.add(m);
  };
  box(lamps.drl, W - 0.3, 0.045, 0, 0.86, -0.11);
  box(lamps.tail, W - 0.25, 0.06, 0, 1.02, L + 0.11);
  for (const s of [-1, 1]) {
    const side = s < 0 ? 'L' : 'R';
    box(lamps['front' + side], 0.22, 0.05, s * 0.66, 0.6, -0.1);
    box(lamps['rear' + side], 0.26, 0.04, s * 0.62, 0.58, L + 0.11);
    box(lamps.reverse, 0.1, 0.04, s * 0.4, 0.58, L + 0.11);
  }
  g.userData.lamps = lamps;
  return g;
}

// ---- the Ocean glTF model ----------------------------------------------------------------------

// Pulse Ocean v0.10 (third_party/webhud/models): a detailed Fisker Ocean rigged for ADAS views. It is
// in meters, +X forward, +Y up, -Z to the car's left, and is used at that scale: it measures within
// 2% of the real car (4.79 m long vs 4.775, 1.94 m wide without mirrors vs 1.98, 1.64 m tall vs 1.63,
// wheelbase 2.90 m vs 2.92). Turned to face -Z with the front bumper at z=0 on the ground.

// Factory paints, from the model's paint-colours.json: digital approximations of the paint chips,
// applied to its PBR_carpaint material. The swatch is sRGB (three converts it to the linear values
// the model lists).
const PAINT_FINISH = {
  'Gloss solid': { metalness: 0.05, roughness: 0.24, clearcoat: 0.5 },
  'Gloss metallic': { metalness: 0.7, roughness: 0.24, clearcoat: 0.5 },
  'Matte metallic': { metalness: 0.7, roughness: 0.53, clearcoat: 0 },
  'Pearl': { metalness: 0.7, roughness: 0.24, clearcoat: 0.5 },
};
export const OCEAN_PAINTS = [
  ['CWH', 'Great White', '#d6ddde', 'Gloss solid'],
  ['CWP', 'Marine Layer', '#dddfdc', 'Pearl'],
  ['CSI', 'Silver Lining', '#acbac2', 'Gloss metallic'],
  ['CEC', 'Sun Soaked', '#776f68', 'Gloss metallic'],
  ['CGR', 'Horizon Gray', '#47484e', 'Gloss metallic'],
  ['CGG', 'Sea Grass', '#353a3d', 'Gloss metallic'],
  ['CGM', 'Stealth Green', '#3a3e42', 'Matte metallic'],
  ['CBG', 'Mariana', '#363f49', 'Gloss metallic'],
  ['CBM', 'Big Sur Blue', '#373e4a', 'Matte metallic'],
  ['CBE', 'Blue Planet', '#326083', 'Gloss metallic'],
  ['COR', 'Solar Orange', '#c55b25', 'Gloss metallic'],
  ['CRE', 'Red Planet', '#9e1d21', 'Gloss solid'],
  ['CBB', 'Black Pearl', '#313136', 'Gloss metallic'],
  ['CBK', 'Night Drive', '#1f1f20', 'Gloss solid'],
].map(([code, name, hex, finish]) => ({ code, name, hex, finish, ...PAINT_FINISH[finish] }));
export const OCEAN_PAINT_DEFAULT = 'CSI';
export function oceanPaint(code) {
  return OCEAN_PAINTS.find(p => p.code === code) || OCEAN_PAINTS.find(p => p.code === OCEAN_PAINT_DEFAULT);
}

// Wheel options, from the model's wheel-options.json: a design (rim groups under every wheel's spin
// pivot; F3 is the Ocean's aero wheel, F5 and F6 are modeled from photos) in a finish applied to the
// Wheel_Face material. F6 only comes in alloy.
const WHEEL_DESIGNS = { F3: { spokes: 5 }, F5: { spokes: 7 }, F6: { spokes: 10 } };
const WHEEL_FINISH = {
  A: { name: 'Alloy', rgb: [0.65, 0.69, 0.73], metalness: 0.9, roughness: 0.23 },     // clear-coated alloy (linear RGB)
  B: { name: 'Black', rgb: [0.006, 0.007, 0.009], metalness: 0.2, roughness: 0.18 },  // gloss powder-coated black
};
export const OCEAN_WHEELS = ['F3A', 'F3B', 'F5A', 'F5B', 'F6A'].map(id => (
  { id, design: id.slice(0, 2), finish: id[2], label: `${id.slice(0, 2)} ${WHEEL_FINISH[id[2]].name.toLowerCase()}` }));
export const OCEAN_WHEELS_DEFAULT = 'F3A';

const RIG = {
  paint: 'PBR_carpaint',
  wheelFace: 'Wheel_Face',
  tire: 'PBR_tire',
  corners: ['Front_L', 'Front_R', 'Rear_L', 'Rear_R'],
  glow: 0.05,   // m: radius of the glow spots over lit lamps
  // lamp -> lit color and the light materials it drives (the model's light-map.json)
  lamps: {
    drl: [LAMP.white, 'Light_DRL_L', 'Light_DRL_R', 'Light_DRL_Center'],   // the center bar includes OCEAN
    head: [LAMP.white, 'Light_Headlights_L', 'Light_Headlights_R'],
    tail: [LAMP.red, 'Light_TailBrake_L', 'Light_TailBrake_R'],
    chmsl: [LAMP.red, 'Light_Brake_Center'],
    reverse: [LAMP.white, 'Light_Reverse_L', 'Light_Reverse_R'],
    lowerL: [LAMP.white, 'Light_LowerDRLIndicator_L'], lowerR: [LAMP.white, 'Light_LowerDRLIndicator_R'],   // front: DRL, amber indicator
    sideL: [LAMP.amber, 'Light_Indicator_Side_L'], sideR: [LAMP.amber, 'Light_Indicator_Side_R'],   // behind the rear quarter windows
    turnL: [LAMP.amber, 'Light_Indicator_Rear_L'], turnR: [LAMP.amber, 'Light_Indicator_Rear_R'],   // strips in the rear clusters
  },
};

export function loadEgoModel(url) {
  return new Promise((resolve, reject) => {
    new GLTFLoader().load(url, (gltf) => {
      const model = gltf.scene;
      model.rotation.y = Math.PI / 2;
      model.updateMatrixWorld(true);
      const box = new THREE.Box3().setFromObject(model);
      model.position.set(-(box.min.x + box.max.x) / 2, -box.min.y, -box.min.z);
      const size = box.getSize(new THREE.Vector3());

      const g = new THREE.Group();
      g.add(model);
      g.updateMatrixWorld(true);
      const mats = new Map(), meshes = new Map();   // by material name
      model.traverse((o) => {
        if (!o.isMesh) return;
        mats.set(o.material.name, o.material);
        meshes.set(o.material.name, [...(meshes.get(o.material.name) || []), o]);
      });
      const center = new THREE.Vector3(0, 0.8, size.z / 2);
      const lamps = {};
      for (const [name, [color, ...names]] of Object.entries(RIG.lamps)) {
        const lamp = lamps[name] = new Lamp(color, names.map(n => mats.get(n)).filter(Boolean));
        lamp.addGlow(g, names.flatMap(n => meshes.get(n) || []), center, RIG.glow);
        lamp.set(0);
      }

      // Each corner is Steer_<corner> (yaw about its Y; only the front pair turns) -> Wheel_<corner>
      // (roll about its Z, the car's right) -> the tire, brake disc and the rim of each design
      const wheels = [];
      for (const c of RIG.corners) {
        const steer = model.getObjectByName('Steer_' + c), spin = model.getObjectByName('Wheel_' + c);
        if (!steer || !spin) continue;
        const tire = new THREE.Box3();
        spin.traverse((o) => { if (o.isMesh && o.material.name === RIG.tire) tire.expandByObject(o); });
        const t = tire.getSize(new THREE.Vector3());
        wheels.push({ steer, spin, axis: 'z', pos: tire.getCenter(new THREE.Vector3()), r: t.y / 2, w: t.x, front: c.startsWith('Front'), spokes: 5 });
      }
      const rims = {};
      for (const d of Object.keys(WHEEL_DESIGNS)) rims[d] = RIG.corners.map(c => model.getObjectByName(`Rim_${d}_${c}`)).filter(Boolean);

      const shadow = softShadow(OCEAN.width, size.z);
      shadow.position.z = size.z / 2;
      g.add(shadow);
      const rear = wheels.filter(w => !w.front);
      Object.assign(g.userData, {
        paint: [mats.get(RIG.paint)].filter(Boolean), wheelFace: mats.get(RIG.wheelFace), rims, lamps, wheels,
        length: size.z, width: OCEAN.width, height: size.y, gltf: true,
        rearAxleZ: rear.length ? rear.reduce((a, w) => a + w.pos.z, 0) / rear.length : size.z - OCEAN.axles[0],
      });
      resolve(g);
    }, undefined, reject);
  });
}

// Paint the ego car (by OCEAN_PAINTS code); the procedural stand-in takes the same color.
export function paintEgo(g, code) {
  const p = oceanPaint(code);
  for (const m of g.userData.paint) {
    m.color.set(p.hex);
    m.metalness = p.metalness;
    m.roughness = p.roughness;
    if ('clearcoat' in m) m.clearcoat = p.clearcoat;
  }
}

// Fit one of OCEAN_WHEELS (by id): its design's rims shown, the others hidden (zero scale too, as the
// model's integration notes ask), the faces in its finish. Cars without the options keep their wheels.
export function fitWheels(g, id) {
  const ud = g.userData;
  if (!ud.rims) return;
  const opt = OCEAN_WHEELS.find(o => o.id === id) || OCEAN_WHEELS.find(o => o.id === OCEAN_WHEELS_DEFAULT);
  for (const [design, nodes] of Object.entries(ud.rims)) {
    for (const n of nodes) {
      n.visible = design === opt.design;
      n.scale.setScalar(n.visible ? 1 : 0);
    }
  }
  const f = WHEEL_FINISH[opt.finish], m = ud.wheelFace;
  if (m) {
    m.color.setRGB(...f.rgb);
    m.metalness = f.metalness;
    m.roughness = f.roughness;
  }
  for (const w of ud.wheels) w.spokes = WHEEL_DESIGNS[opt.design].spokes;
}

function paintMat(color) {
  return new THREE.MeshStandardMaterial({ color, roughness: 0.55, metalness: 0.1, transparent: true, opacity: 1 });
}

function twoWheeler(color, motor) {
  const g = new THREE.Group();
  const paint = paintMat(color);
  const L = motor ? 2.1 : 1.75, r = motor ? 0.32 : 0.34;
  const tire = new THREE.MeshStandardMaterial({ color: 0x1c1d20, roughness: 0.9, transparent: true });
  for (const z of [r, L - r]) {
    const t = new THREE.Mesh(cached(`torus${r}`, () => new THREE.TorusGeometry(r, motor ? 0.07 : 0.03, 8, 24).rotateY(Math.PI / 2)), tire);
    t.position.set(0, r, z);
    g.add(t);
  }
  const frame = new THREE.Mesh(cached(`frame${motor}`, () => new THREE.BoxGeometry(motor ? 0.32 : 0.06, motor ? 0.42 : 0.08, L - 2 * r)), paint);
  frame.position.set(0, motor ? r + 0.25 : r + 0.3, L / 2);
  g.add(frame);
  const rider = person(color, 1.05);
  rider.position.set(0, motor ? 0.55 : 0.65, L / 2 + 0.15);
  rider.rotation.x = -0.35;
  g.add(rider);
  const shadow = softShadow(0.6, L);
  shadow.position.z = L / 2;
  g.add(shadow);
  g.userData = { paint: [paint, ...rider.userData.paint], length: L, width: 0.7, height: 1.6 };
  return g;
}

function person(color, scale = 1) {
  const g = new THREE.Group();
  const paint = paintMat(color);
  const body = new THREE.Mesh(cached('torso', () => new THREE.CapsuleGeometry(0.2, 0.62, 4, 12)), paint);
  body.position.y = 1.05 * scale - 0.1;
  const head = new THREE.Mesh(cached('head', () => new THREE.SphereGeometry(0.13, 16, 12)), paint);
  head.position.y = 1.62 * scale - 0.1;
  const legs = new THREE.Mesh(cached('legs', () => new THREE.CapsuleGeometry(0.16, 0.55, 4, 10)), paint);
  legs.position.y = 0.42 * scale;
  g.add(body, head, legs);
  g.userData = { paint: [paint], length: 0.5, width: 0.5, height: 1.75 };
  return g;
}

function cone(color) {
  const g = new THREE.Group();
  const paint = paintMat(color);
  const c = new THREE.Mesh(cached('cone', () => new THREE.ConeGeometry(0.22, 0.75, 20)), paint);
  c.position.y = 0.375;
  g.add(c, softShadow(0.45, 0.45));
  g.userData = { paint: [paint], length: 0.45, width: 0.45, height: 0.75 };
  return g;
}

function block(color) {
  const g = new THREE.Group();
  const paint = paintMat(color);
  const b = new THREE.Mesh(cached('block', () => new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0.5)), paint);
  const shadow = softShadow(1, 1);
  shadow.position.z = 0.5;
  g.add(b, shadow);
  g.userData = { paint: [paint], length: 1, width: 1, height: 1 };
  return g;
}

// class -> builder producing a Group whose userData.paint materials can be recolored
export function makeObject(cls, color) {
  switch (cls) {
    case 'truck': return vehicle(TRUCK, paintMat(color), { bevel: 0.08 });
    case 'motorcycle': return twoWheeler(color, true);
    case 'bicycle': return twoWheeler(color, false);
    case 'pedestrian': { const p = person(color); p.add(softShadow(0.6, 0.6)); return p; }
    case 'animal': { const b = block(color); b.scale.set(0.5, 0.9, 1.2); return b; }
    case 'small': return cone(color);
    case 'large':
    case 'unknown': return block(color);
    case 'sedan': return vehicle(SEDAN, paintMat(color));
    default: return vehicle(OCEAN, paintMat(color));
  }
}

// See-through car for the radar view: body, glass and wheels in one translucent tint (darker for the
// glass and wheels), no ground shadow, and no depth writes so a camera car it overlaps still shows
// through. userData.paint = [shell, dark] for recoloring and fading.
export function makeGhost(color, opacity) {
  const shell = new THREE.MeshStandardMaterial({ color, roughness: 0.5, metalness: 0.1, transparent: true, opacity, depthWrite: false });
  const dark = shell.clone();
  dark.color.multiplyScalar(0.35);
  const g = vehicle(OCEAN, shell);
  const shadows = [];
  g.traverse((o) => {
    if (!o.isMesh) return;
    if (o.material.map) shadows.push(o);
    else if (o.material !== shell) o.material = dark;
    o.renderOrder = 4;   // after the camera's cars, which it is drawn around
  });
  for (const s of shadows) { s.parent.remove(s); s.material.dispose(); }
  g.userData.paint = [shell, dark];
  return g;
}

// Fit a prototype to the object's measured size, within sane bounds per class.
const SIZE_BOUNDS = {
  car: [[1.5, 2.3], [3.4, 6.0], [1.2, 2.2]],
  truck: [[2.0, 2.8], [5.0, 18.0], [2.2, 4.2]],
  motorcycle: [[0.5, 1.2], [1.5, 2.6], [1.2, 1.9]],
  bicycle: [[0.4, 1.0], [1.4, 2.2], [1.2, 1.9]],
  pedestrian: [[0.3, 1.0], [0.3, 1.0], [1.0, 2.1]],
};
export function fitScale(group, cls, w, l, h) {
  const ud = group.userData;
  const b = SIZE_BOUNDS[cls];
  const pick = (v, def, range) => (v > 0.2 && range ? Math.min(range[1], Math.max(range[0], v)) : (v > 0.2 ? v : def));
  const W = pick(w, ud.width, b && b[0]), L = pick(l, ud.length, b && b[1]), H = pick(h, ud.height, b && b[2]);
  if (cls === 'pedestrian' || cls === 'bicycle' || cls === 'motorcycle') {
    const s = H / ud.height;
    group.scale.set(s, s, s);
  } else {
    group.scale.set(W / ud.width, H / ud.height, L / ud.length);
  }
}
