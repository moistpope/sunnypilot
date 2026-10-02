// Procedural low-poly models in the soft, matte style of Tesla's visualization.
// Model space: forward = -Z, right = +X, up = +Y, origin at the FRONT bumper on the ground,
// matching the ADAS/openpilot convention (distances measured from the front bumper).
import * as THREE from '../vendor/three.module.min.js';
import { GLTFLoader } from '../vendor/GLTFLoader.js';
import { Lamp, LAMP, conform, centerline, splitMesh } from './lamps.js';

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
      wheels.push({ steer, spin, r: spec.wheelR, w: tw, front: ax === frontAxle, spokes: 6 });
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

// The Fisker Ocean glTF model (third_party/webhud/models/fisker_ocean.glb, CC BY 4.0 LagzDesign). The
// file is Y-up with the nose at +X; turn it to face -Z, scale it to the real car's length and put
// the front bumper at z=0 on the ground, like the procedural models.
const OCEAN_GLTF = {
  paint: ['Material.001'],
  head: ['Material.004'],     // full-width front light bar
  tail: ['Material.005'],     // tail light strips, wrapping onto the rear quarters
  chmsl: ['Material.006'],    // third brake light
  body: ['Material.001', 'Material.002', 'Material.003', 'Material.010'],   // surfaces lamps can be laid on
  // Lamps the model has no geometry for, laid onto the body. Left-side polylines in ego space (x < 0
  // is the car's left; mirrored for the right), pushed along `dir` until they meet the surface.
  // Placed from photos of the real car.
  added: {
    front: { pts: [[-0.55, 0.665], [-0.7, 0.665], [-0.78, 0.655], [-0.82, 0.62], [-0.845, 0.55], [-0.86, 0.48]], z: -0.4, dir: 1, width: 0.024, glow: 0.07 },   // amber, along the lower intakes
    mirror: { pts: [[-0.95, 1.13], [-1.02, 1.135], [-1.045, 1.16], [-1.05, 1.2]], z: 1.4, dir: 1, width: 0.018, glow: 0.05 },   // amber, mirror caps
    rear: { pts: [[-0.52, 0.564], [-0.64, 0.56], [-0.76, 0.552]], z: 5.2, dir: -1, width: 0.03, glow: 0.07 },   // lower rear: amber indicator / red tail
    reverse: { pts: [[-0.42, 0.566], [-0.5, 0.565]], z: 5.2, dir: -1, width: 0.032, glow: 0.07 },
  },
  wheel: ['MA_tire_003', 'Material.007', 'Material.008', 'Material.009'],   // tire + rim parts, per wheel
  spokes: 5,
  // The rims are black mirror-metal, which renders flat black without an environment map. A satin
  // finish with lighter spokes makes them visibly turn.
  finish: {
    'Material.007': { color: 0x2c3036, metalness: 0.3, roughness: 0.45 },   // aero disc
    'Material.008': { color: 0xa3aab4, metalness: 0.4, roughness: 0.35 },   // the five spokes
    'Material.009': { color: 0x454a52, metalness: 0.3, roughness: 0.5 },    // hub
    'MA_tire_003': { color: 0x1b1c1f, metalness: 0, roughness: 0.9 },
  },
};

// Turn the model's light meshes into switchable lamps and lay the missing ones onto the body.
function oceanLamps(g, meshes, L) {
  const lens = { clear: 0x9aa0a8, red: 0x5a0d0b, darkRed: 0x3c0a08, amber: 0x2e2a26 };
  const lamps = {
    drl: new Lamp(LAMP.white, lens.clear), head: new Lamp(LAMP.white, lens.clear),
    tail: new Lamp(LAMP.red, lens.red), chmsl: new Lamp(LAMP.red, lens.darkRed), reverse: new Lamp(LAMP.white, 0x5c6066),
  };
  for (const s of ['L', 'R']) {   // per side: names like markerL / markerR
    lamps['marker' + s] = new Lamp(LAMP.red, lens.red);
    lamps['front' + s] = new Lamp(LAMP.amber, lens.amber);
    lamps['mirror' + s] = new Lamp(LAMP.amber, 0x3a3833);
    lamps['rear' + s] = new Lamp(LAMP.amber, lens.red);
  }
  g.updateMatrixWorld(true);
  const center = new THREE.Vector3(0, 0.8, L / 2);
  const size = new THREE.Vector3();
  const side = (list, s) => list.filter(t => Math.sign(t.c.x) === s);
  const glowAlong = (lamp, list, order, width, step = 0.02, extend = 0.02) => {
    const c = centerline(list, order, center, step);
    lamp.addGlow(g, c.points, c.normals, width, extend);
  };

  // front light bar: the two short vertical bars in each housing are the headlights, the long
  // horizontal bar is the DRL
  for (const mesh of meshes.head) {
    const parts = splitMesh(mesh, t => (t.box.getSize(size), size.x < 0.03 && size.y > 0.03 ? lamps.head.lens : lamps.drl.lens));
    for (const s of [-1, 1]) {
      glowAlong(lamps.drl, side(parts.get(lamps.drl.lens) || [], s), c => Math.abs(c.x) + c.z, 0.05, 0.03);
      const bars = new Map();
      for (const t of side(parts.get(lamps.head.lens) || [], s)) {
        const k = Math.round(t.c.x / 0.04);
        if (!bars.has(k)) bars.set(k, []);
        bars.get(k).push(t);
      }
      for (const bar of bars.values()) glowAlong(lamps.head, bar, c => c.y, 0.045, 0.02, 0.025);
    }
  }
  // tail strips: the part wrapped onto the rear quarter is the side marker
  for (const mesh of meshes.tail) {
    const marker = (t) => t.c.z < L - 0.3;
    const parts = splitMesh(mesh, t => (marker(t) ? lamps['marker' + (t.c.x < 0 ? 'L' : 'R')].lens : lamps.tail.lens));
    for (const s of [-1, 1]) {
      glowAlong(lamps.tail, side(parts.get(lamps.tail.lens) || [], s), c => Math.abs(c.x), 0.055);
      const m = lamps['marker' + (s < 0 ? 'L' : 'R')];
      glowAlong(m, parts.get(m.lens) || [], c => -c.z, 0.055);
    }
  }
  for (const mesh of meshes.chmsl) {
    const parts = splitMesh(mesh, () => lamps.chmsl.lens);
    glowAlong(lamps.chmsl, parts.get(lamps.chmsl.lens) || [], c => c.x, 0.05, 0.04);
  }

  // lamps the model doesn't have, laid flush on the body (raycast double-sided, then restored)
  const sides = meshes.body.map(m => m.material.side);
  meshes.body.forEach(m => { m.material.side = THREE.DoubleSide; });
  for (const [name, spec] of Object.entries(OCEAN_GLTF.added)) {
    for (const s of [-1, 1]) {
      const lamp = lamps[name] || lamps[name + (s < 0 ? 'L' : 'R')];
      const pts = spec.pts.map(([x, y]) => [x * -s, y, spec.z]);
      const c = conform(meshes.body, pts, [0, 0, spec.dir]);
      lamp.addStrip(g, c.points, c.normals, spec.width, spec.glow);
    }
  }
  meshes.body.forEach((m, i) => { m.material.side = sides[i]; });
  for (const lamp of Object.values(lamps)) lamp.set(0);
  return lamps;
}

export function loadEgoModel(url) {
  return new Promise((resolve, reject) => {
    new GLTFLoader().load(url, (gltf) => {
      const model = gltf.scene;
      model.rotation.y = Math.PI / 2;
      model.updateMatrixWorld(true);
      const box = new THREE.Box3().setFromObject(model);
      model.scale.setScalar(OCEAN.length / (box.max.z - box.min.z));
      model.updateMatrixWorld(true);
      box.setFromObject(model);
      model.position.set(-(box.min.x + box.max.x) / 2, -box.min.y, -box.min.z);

      const g = new THREE.Group();
      g.add(model);
      g.updateMatrixWorld(true);
      const L = OCEAN.length, W = OCEAN.width;

      // materials by role; light and body meshes for the lamps
      const paint = new Set();
      const meshes = { head: [], tail: [], chmsl: [], body: [] };
      const wheelMeshes = [];
      model.traverse((o) => {
        if (!o.isMesh) return;
        const name = o.material.name;
        if (OCEAN_GLTF.paint.includes(name)) paint.add(o.material);
        for (const role of Object.keys(meshes)) if (OCEAN_GLTF[role].includes(name)) meshes[role].push(o);
        if (OCEAN_GLTF.wheel.includes(name)) wheelMeshes.push(o);
        const finish = OCEAN_GLTF.finish[name];
        if (finish) { o.material.color.setHex(finish.color); o.material.metalness = finish.metalness; o.material.roughness = finish.roughness; }
      });
      const lamps = oceanLamps(g, meshes, L);

      // Re-hang each wheel's tire + rim meshes on steer -> spin pivots at the tire's center.
      // attach() keeps their world transform, so nothing moves until the pivots rotate.
      const clusters = new Map();
      for (const m of wheelMeshes) {
        const box = new THREE.Box3().setFromObject(m);
        const c = box.getCenter(new THREE.Vector3());
        const key = `${c.x < 0 ? 'l' : 'r'}${c.z < L / 2 ? 'f' : 'b'}`;
        if (!clusters.has(key)) clusters.set(key, { meshes: [], tire: new THREE.Box3(), all: new THREE.Box3() });
        const cl = clusters.get(key);
        cl.meshes.push(m);
        cl.all.union(box);
        if (m.material.name === OCEAN_GLTF.wheel[0]) cl.tire.union(box);
      }
      const wheels = [];
      for (const [key, cl] of clusters) {
        const box = cl.tire.isEmpty() ? cl.all : cl.tire;
        const steer = new THREE.Group();
        steer.position.copy(box.getCenter(new THREE.Vector3()));
        const spin = new THREE.Group();
        steer.add(spin);
        g.add(steer);
        g.updateMatrixWorld(true);
        for (const m of cl.meshes) spin.attach(m);
        const size = box.getSize(new THREE.Vector3());
        wheels.push({ steer, spin, r: size.y / 2, w: size.x, front: key.endsWith('f'), spokes: OCEAN_GLTF.spokes });
      }

      const shadow = softShadow(W, L);
      shadow.position.z = L / 2;
      g.add(shadow);
      const rear = wheels.filter(w => !w.front);
      Object.assign(g.userData, {
        paint: [...paint], lamps, wheels, length: L, width: W, height: OCEAN.height, gltf: true,
        rearAxleZ: rear.length ? rear.reduce((a, w) => a + w.steer.position.z, 0) / rear.length : L - OCEAN.axles[0],
        originalPaint: [...paint].map(m => m.color.clone()),
      });
      resolve(g);
    }, undefined, reject);
  });
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
