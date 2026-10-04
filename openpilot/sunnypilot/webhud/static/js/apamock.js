// Mock automated parking (APA), for the car controls mockup (Assist > Parking > Mock APA). A demo parking
// lot appears around the car; the car scans along the aisle, offers the open spaces on its right, and parks
// itself in the one you pick. It plays both sides of the exchange the head unit and the ADAS would have on
// CAN (fisker_ocean_adas_world.dbc): the head unit's requests in ICC_0x35B and the ADAS's slots
// (ADAS_0x2D0..0x2EA), state (ADAS_0x314), selected slot (ADAS_0x2CD) and gear and standstill requests
// (ADAS_0x117), and shows them as they change. The ADAS side is fed to the HUD decoded the way
// fisker_world.py decodes it, so the HUD's own parking drawing shows it: the slot outlines, the parking
// sensors' arcs and the closest distance per bumper. The drive is simulated in the page and replaces the
// live data in the HUD while this runs. Nothing is sent anywhere.
//
// Lot frame: meters, x along the aisle (the way the car starts), y to its left; the car starts with its
// rear axle at the origin.
import * as THREE from '../vendor/three.module.min.js';
import { makeObject, makeGhost } from './models.js';
import { STEER_RATIO, WHEELBASE } from './vehicle.js';

const ROWS = {   // C a parked car, O open; the right row is the one scanned
  right: { entrance: -2.9, dir: -1, cars: 'COCCOOC', parked: [1, 0, 0, 1, 0, 0, 1] },   // parked: 1 = backed in
  left: { entrance: 3.1, dir: 1, cars: 'CCOCCCC', parked: [0, 1, 0, 0, 1, 0, 0] },
};
const FIRST = 4.0, PITCH = 2.7, DEPTH = 5.2;   // first space's center x, spacing, depth (m)
const CAR = { front: 3.824, rear: 0.97, center: 1.43, halfW: 0.97 };   // from the rear axle (the Ocean model)
const R_BACK = 5.0;       // m, rear-axle turning radius backing in...
const R_NOSE = 4.2;       // ...and at full lock driving in nose first
const SCAN_SPEED = 2.8;   // m/s (10 km/h) along the aisle while scanning
const PARK_SPEED = { straight: 1.3, arc: 0.8 };
const ACCEL = 0.6;        // m/s^2
const STEER_RATE = 330;   // deg/s at the steering wheel, turned at a standstill
const ECHO_S = 0.35;      // the ADAS's answer to a slot selection
const SLOT_MSG = { 1: 'ADAS_0x2D3', 2: 'ADAS_0x2D9', 3: 'ADAS_0x2DF', 4: 'ADAS_0x2E5', 5: 'ADAS_0x2C7', 6: 'ADAS_0x2EA' };

// the signals shown, with their message and value table (fisker_ocean_adas_world.dbc)
const SIG = {
  activation: ['to', 'ICC_0x35B', 'ICC_APAActivation', { 0: 'Cancel', 1: 'On' }],
  parkSelect: ['to', 'ICC_0x35B', 'ICC_APAParkSelect', { 0: 'Slot_not_selected', 1: 'Slot_1', 2: 'Slot_2', 3: 'Slot_3', 4: 'Slot_4', 5: 'Slot_5', 6: 'Slot_6' }],
  parkInDir: ['to', 'ICC_0x35B', 'ICC_APAParkInDirSetting', { 0: 'Nose-in', 1: 'Back-in' }],
  apaSts: ['from', 'ADAS_0x314', 'ADAS_APASts', { 0: 'Off', 1: 'Initialize', 2: 'Standby', 3: 'Scanning', 4: 'Slot_selected', 5: 'Park_In', 7: 'Aborted', 8: 'Parking_complete' }],
  available: ['from', 'ADAS_0x2CD', 'ADAS_APAAvailable', { 0: 'Not_available', 1: 'Park_in_available' }],
  scanSide: ['from', 'ADAS_0x2CD', 'ADAS_APAScanngSde', { 0: 'Not_scanning', 1: 'Left', 2: 'Right', 3: 'Both' }],
  slotSel: ['from', 'ADAS_0x2CD', 'ADAS_APASlotSelID', null],
  lgtTyp: ['from', 'ADAS_0x117', 'ADAS_LgtCtrl_Typ', { 0: 'Not_Active', 6: 'Full_Automatic_Park_Assist_System(APA)' }],
  gearReq: ['from', 'ADAS_0x117', 'ADAS_ParkGearReq', { 0: 'No_request', 1: 'P', 3: 'R', 4: 'D' }],
  standstill: ['from', 'ADAS_0x117', 'ADAS_ParkStandstillReq', { 0: 'No_standstill_request', 1: 'Standstill_request' }],
  latSts: ['from', 'ADAS_0x1C0', 'ADAS_LatCtrl_Sts', { 0: 'Inactive', 1: 'Active' }],
  chime: ['from', 'ADAS_0x317', 'ADAS_ChimeReq', { 0: 'No_chime', 9: 'Parking_complete' }],
};

// parking sensors, from the rear axle (x forward, y left, direction deg): the HUD's sectors left to right
// (front, rear) and front to rear (sides), and the six distance sensors per bumper
const USS = {
  front: [[3.55, 0.85, 50], [3.8, 0.32, 10], [3.8, -0.32, -10], [3.55, -0.85, -50]],
  rear: [[-0.75, 0.85, 130], [-0.97, 0.32, 170], [-0.97, -0.32, -170], [-0.75, -0.85, -130]],
  left: [[2.9, 0.97, 90], [2.1, 0.97, 90], [1.1, 0.97, 90], [0.2, 0.97, 90]],
  right: [[2.9, -0.97, -90], [2.1, -0.97, -90], [1.1, -0.97, -90], [0.2, -0.97, -90]],
};
const PDC = {
  front: [[3.35, 0.95, 80], [3.65, 0.65, 40], [3.82, 0.22, 5], [3.82, -0.22, -5], [3.65, -0.65, -40], [3.35, -0.95, -80]],
  rear: [[-0.6, 0.95, 100], [-0.85, 0.65, 140], [-0.97, 0.22, 175], [-0.97, -0.22, -175], [-0.85, -0.65, -140], [-0.6, -0.95, -100]],
};
const DEG = Math.PI / 180;

const steerFor = (k) => Math.atan(k * WHEELBASE) / DEG * STEER_RATIO;   // steering wheel deg for a curvature

export class ApaMock {
  constructor(car) {
    this.car = car;
    this.scene = car.scene;
    this.t = 0;
    this.phase = 'init';     // init, scan, choose, confirm, ready, park, done, canceled
    this.sig = {};
    this.log = [];           // newest first: { t, dir, msg, text }
    this.found = [];         // the open spaces the ADAS reports, in the order found: { id, x, row }
    this.selected = null;    // a found space's id
    this.confirmAt = 0;
    this.gear = 'drive';
    this.v = 0;              // m/s, signed
    this.steer = 0;          // steering wheel deg
    this.brake = true;
    this.plan = null;        // { segs, i, phase, done, total }
    this.dirBack = car.v['icc.parkIn'] !== 0;
    this.origin = { ...this.scene.pose };
    this._build();
    this.set('parkInDir', this.dirBack ? 1 : 0);
    this.set('activation', 1, 'the P button');
    this.set('apaSts', 1);
    this.state = this._state();
  }

  // the pseudo-category CarControls shows it as
  get category() {
    return {
      id: 'apa', label: 'Automated parking', icon: 'radar', roof: false,
      focus: { at: [3.2, 0, 6.5], az: 180, el: 62, fit: [12, 15] },   // behind and right of the car: the spaces it has passed
      render: () => this._panel(), pins: (add) => this._pins(add),
    };
  }

  // HUD settings while it runs: the parking drawing, nothing of the road
  get settings() {
    return { ...this.car.app.settings, showRoad: false, showPath: false, showSigns: false, showTracks: false, showRadar: false, showObjectStats: false, showUss: true };
  }

  // ---- the lot -----------------------------------------------------------------------------------------

  _build() {
    const dark = this.scene.theme.bg < 0x808080;
    const lot = this.lot = new THREE.Group();
    lot.name = 'apa-lot';
    // the lot's frame in the HUD's world (see scene._ground): world axes are the absolute frame's, x -> -Z, y -> -X
    lot.position.set(-this.origin.y, 0, -this.origin.x);
    lot.rotation.y = this.origin.h;
    this.scene.world.add(lot);
    this.disposables = [];
    const own = (o) => { this.disposables.push(o); return o; };
    // a flat rectangle on the ground, lenX along the aisle and lenY across it, centered on (x, y)
    const flat = (x, y, lenX, lenY, material, lift) => {
      const m = new THREE.Mesh(own(new THREE.PlaneGeometry(lenY, lenX).rotateX(-Math.PI / 2)), material);
      m.position.set(-y, lift, -x);
      lot.add(m);
      return m;
    };
    const rows = Object.values(ROWS);
    const n = Math.max(...rows.map(r => r.cars.length));
    flat(FIRST + (n - 1) * PITCH / 2, 0.1, n * PITCH + 24, 26, own(new THREE.MeshStandardMaterial({ color: dark ? 0x1c1f25 : 0xd5d9df, roughness: 0.95 })), 0.004);
    const paint = own(new THREE.MeshBasicMaterial({ color: dark ? 0xc9ced6 : 0xffffff, transparent: true, opacity: dark ? 0.55 : 0.95 }));
    const curbMat = own(new THREE.MeshStandardMaterial({ color: dark ? 0x3a3f48 : 0xb9bec6, roughness: 0.9 }));
    const objColor = this.scene.theme.object;
    this.obstacles = [];
    this.slots = [];
    for (const [side, row] of Object.entries(ROWS)) {
      const count = row.cars.length, back = row.entrance + row.dir * DEPTH, mid = FIRST + (count - 1) * PITCH / 2;
      for (let i = 0; i <= count; i++) flat(FIRST + (i - 0.5) * PITCH, row.entrance + row.dir * DEPTH / 2, 0.12, DEPTH, paint, 0.012);
      flat(mid, back, count * PITCH, 0.12, paint, 0.012);
      // a curb along the back
      const curb = new THREE.Mesh(own(new THREE.BoxGeometry(0.25, 0.15, count * PITCH + 1)), curbMat);
      curb.position.set(-(back + row.dir * 0.3), 0.075, -mid);
      lot.add(curb);
      this.obstacles.push({ x: mid, y: back + row.dir * 0.3, h: 0, hl: count * PITCH / 2 + 0.5, hw: 0.125 });
      for (let i = 0; i < count; i++) {
        const x = FIRST + i * PITCH, cy = row.entrance + row.dir * DEPTH / 2;
        if (row.cars[i] === 'C') {
          // parked cars face into or out of their space, a little off center like real ones
          const heading = row.dir * Math.PI / 2 * (row.parked[i] ? -1 : 1);
          const g = makeObject('car', new THREE.Color(objColor).offsetHSL(0, 0, (i % 3 - 1) * 0.05).getHex());
          this.disposables.push(...g.userData.paint);
          g.position.z = -g.userData.length / 2;   // pivot at its center
          const pivot = new THREE.Group();
          pivot.add(g);
          const px = x + (i % 2 ? 0.08 : -0.06), py = cy + row.dir * 0.15;
          pivot.position.set(-py, 0, -px);
          pivot.rotation.y = heading;
          lot.add(pivot);
          this.obstacles.push({ x: px, y: py, h: heading, hl: g.userData.length / 2, hw: g.userData.width / 2 });
        } else if (side === 'right') {
          // an open space: a fill shown once the ADAS reports it
          const fill = flat(x, cy, PITCH - 0.3, DEPTH - 0.3,
            own(new THREE.MeshBasicMaterial({ color: this.scene.cutaway.accent, transparent: true, opacity: 0, depthWrite: false })), 0.014);
          fill.renderOrder = 1;
          fill.visible = false;
          this.slots.push({ x, y: cy, row: side, fill, found: false, id: 0 });
        }
      }
    }
    // where the car will stand in the selected space
    this.ghost = makeGhost(this.scene.cutaway.accent.getHex(), 0.28);
    this.disposables.push(...this.ghost.userData.paint);
    this.ghost.position.z = -this.ghost.userData.length / 2;
    this.ghostPivot = new THREE.Group();
    this.ghostPivot.add(this.ghost);
    this.ghostPivot.visible = false;
    lot.add(this.ghostPivot);
  }

  // where the rear axle ends up in a space (lot frame), backing in or nose first from the aisle at y
  finalPose(slot, y = 0) {
    return this.dirBack
      ? { x: slot.x, y: ROWS.right.entrance - DEPTH + CAR.rear + 0.15, h: Math.PI / 2 }
      : { x: slot.x, y: y - R_NOSE, h: -Math.PI / 2 };
  }

  dispose() {
    this.scene.world.remove(this.lot);
    for (const d of this.disposables) d.dispose?.();
  }

  // the car's rear axle in the lot frame, from the HUD's own odometry
  pose() {
    const p = this.scene.pose, o = this.origin, c = Math.cos(o.h), s = Math.sin(o.h);
    const dx = p.x - o.x, dy = p.y - o.y;
    return { x: dx * c + dy * s, y: -dx * s + dy * c, h: p.h - o.h };
  }

  // ---- signals -----------------------------------------------------------------------------------------

  set(key, value, why) {
    if (this.sig[key] === value) return;
    this.sig[key] = value;
    const [dir, msg, name, table] = SIG[key];
    this._log(dir, msg, `${name} = ${table ? table[value] ?? value : value}${why ? ` (${why})` : ''}`);
  }

  _log(dir, msg, text) {
    this.log.unshift({ t: this.t, dir, msg, text });
    if (this.log.length > 40) this.log.pop();
    this.changed = true;
  }

  // ---- what you do -------------------------------------------------------------------------------------

  choose(id) {
    if (!['scan', 'choose', 'confirm', 'ready'].includes(this.phase) || !this.found.some(s => s.id === id)) return;
    this.selected = id;
    this.set('parkSelect', id);
    this.confirmAt = this.t + ECHO_S;
    if (this.phase !== 'scan') this.phase = 'confirm';
    this.changed = true;
  }

  setDirection(back) {
    if (this.phase === 'park') return;
    this.dirBack = back;
    this.car.v['icc.parkIn'] = back ? 1 : 0;
    this.set('parkInDir', back ? 1 : 0);
    this.changed = true;
  }

  start() {
    if (this.phase !== 'ready') return;
    const slot = this.found.find(s => s.id === this.selected);
    this._log('to', 'HMI', 'Start parking pressed (ICC_0x35B has no signal of its own for it: the ADAS starts on the confirmed slot)');
    this.plan = this._plan(slot, this.pose());
    this.phase = 'park';
    this.set('apaSts', 5);
    this.set('lgtTyp', 6);
    this.set('latSts', 1);
    this.changed = true;
  }

  cancel() {
    if (['done', 'canceled'].includes(this.phase)) return;
    this.set('activation', 0, 'P pressed again');
    this.set('apaSts', 7);
    this.set('lgtTyp', 0);
    this.set('latSts', 0);
    this.set('gearReq', 0);
    this.phase = 'canceled';
    this.offAt = this.t + 1.2;
    this.changed = true;
  }

  // a tap on the 3D view: a reported space under it is chosen
  tap(x, y) {
    const ray = this.scene._ray(x, y);
    const hit = ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 1, 0), 0), new THREE.Vector3());
    if (!hit) return false;
    const p = this.lot.worldToLocal(hit);
    const lx = -p.z, ly = -p.x;
    const s = this.slots.find(q => q.found && Math.abs(lx - q.x) < PITCH / 2 && Math.abs(ly - q.y) < DEPTH / 2);
    if (!s) return false;
    this.choose(s.id);
    return true;
  }

  // ---- the drive ---------------------------------------------------------------------------------------

  // Back in: reverse along the aisle until the space is R behind the rear axle's turning circle, back round
  // a quarter turn into it on full right lock, then straight to the back. Nose in: reverse past it, then a
  // quarter turn forward on full lock. Segments: dir (+1 forward), curvature (1/m, + left), length (m).
  _plan(slot, p) {
    const segs = [];
    if (this.dirBack) {
      const startX = slot.x + R_BACK;
      if (Math.abs(p.x - startX) > 0.05) segs.push({ dir: p.x > startX ? -1 : 1, k: 0, len: Math.abs(p.x - startX) });
      segs.push({ dir: -1, k: -1 / R_BACK, len: R_BACK * Math.PI / 2 });
      const endY = p.y - R_BACK, parkedY = this.finalPose(slot).y;
      if (endY - parkedY > 0.05) segs.push({ dir: -1, k: 0, len: endY - parkedY });
    } else {
      const startX = slot.x - R_NOSE;
      if (Math.abs(p.x - startX) > 0.05) segs.push({ dir: p.x > startX ? -1 : 1, k: 0, len: Math.abs(p.x - startX) });
      segs.push({ dir: 1, k: -1 / R_NOSE, len: R_NOSE * Math.PI / 2 });
    }
    return { segs, i: 0, step: 'steer', run: 0, done: 0, total: segs.reduce((a, s) => a + s.len, 0) };
  }

  tick(dt) {
    dt = Math.min(dt, 0.1);   // as the HUD integrates it
    this.t += dt;
    const p = this.pose();
    const center = { x: p.x + CAR.center * Math.cos(p.h), y: p.y + CAR.center * Math.sin(p.h) };

    if (this.phase === 'init' && this.t > 0.8) {
      this.phase = 'scan';
      this.set('apaSts', 3);
      this.set('available', 1);
      this.set('scanSide', 2);
    }
    if (this.phase === 'scan') {
      // the driver drives along the aisle; spaces are reported once the car has passed them
      for (const s of this.slots) {
        if (!s.found && center.x > s.x + 1.2 && this.found.length < 6) {
          s.found = true;
          s.id = this.found.length + 1;
          this.found.push(s);
          this._log('from', SLOT_MSG[s.id], `ADAS_APASlot${s.id}ID = ${s.id} · Perpendicular · Right · Open`);
          this.car.buildPins(this.car.category);
        }
      }
      const stopX = Math.max(...this.slots.map(s => s.x)) + 6.5;
      const want = Math.min(SCAN_SPEED, Math.sqrt(Math.max(0, 2 * 0.9 * (stopX - p.x))));
      this.v = Math.min(want, this.v + ACCEL * 1.5 * dt);
      this.brake = false;
      if (stopX - p.x < 0.03) {
        this.v = 0;
        this.brake = true;
        this.phase = this.selected ? 'confirm' : 'choose';
        this.changed = true;
      }
    }
    if (this.phase === 'confirm' && this.t >= this.confirmAt) {
      // the ADAS echoes the slot it will park in: the head unit waits for this before offering Start
      const s = this.found.find(q => q.id === this.selected);
      this.set('slotSel', s.id);
      this._log('from', 'ADAS_0x2CA', `ADAS_APASlotSel corners · ADAS_APASlotSelTyp = Perpendicular · ADAS_APASlotSelSid = Right`);
      this.set('apaSts', 4);
      this.phase = 'ready';
    }
    if (this.phase === 'park') this._drive(dt);
    if (this.phase === 'canceled') {
      this.v = Math.sign(this.v) * Math.max(0, Math.abs(this.v) - 1.5 * dt);
      this.brake = true;
      if (this.t > this.offAt && this.sig.apaSts !== 0) this.set('apaSts', 0);
    }
    if (this.phase === 'done' && this.sig.chime === 9 && this.t > this.chimeOff) this.set('chime', 0);

    // the selected space and where the car will stand in it
    for (const s of this.slots) {
      const sel = s.id === this.selected && s.found;
      const want = !s.found || (this.phase === 'park' || this.phase === 'done') && !sel ? 0 : sel ? 0.32 + 0.1 * Math.sin(this.t * 4) : 0.12;
      s.fill.material.opacity += (want - s.fill.material.opacity) * Math.min(1, dt * 6);
      s.fill.visible = s.fill.material.opacity > 0.005;
    }
    const sel = this.found.find(s => s.id === this.selected);
    this.ghostPivot.visible = !!sel && this.phase !== 'done' && this.phase !== 'canceled';
    if (sel) {
      const f = this.finalPose(sel);
      this.ghostPivot.position.set(-(f.y + CAR.center * Math.sin(f.h)), 0.01, -(f.x + CAR.center * Math.cos(f.h)));
      this.ghostPivot.rotation.y = f.h;
    }

    this.state = this._state(p, center);
  }

  _drive(dt) {
    const plan = this.plan, seg = plan.segs[plan.i];
    if (!seg || dt <= 0) return;
    const gear = seg.dir > 0 ? 'drive' : 'reverse';
    if (plan.step === 'steer') {
      // stopped: the ADAS asks for the gear and turns the wheel before it moves
      this.brake = true;
      this.v = 0;
      this.set('standstill', 1);
      this.set('gearReq', seg.dir > 0 ? 4 : 3);
      this.gear = gear;
      const target = steerFor(seg.k);
      const d = target - this.steer;
      this.steer += Math.sign(d) * Math.min(Math.abs(d), STEER_RATE * dt);
      if (Math.abs(target - this.steer) < 0.5) { this.steer = target; plan.step = 'move'; plan.run = 0; }
      return;
    }
    this.set('standstill', 0);
    this.brake = false;
    const left = seg.len - plan.run;
    const top = seg.k ? PARK_SPEED.arc : PARK_SPEED.straight;
    const speed = Math.min(top, Math.sqrt(Math.max(0, 2 * ACCEL * left)) + 0.05, Math.abs(this.v) + ACCEL * dt);
    const ds = Math.min(left, speed * dt);
    plan.run += ds;
    plan.done += ds;
    this.v = seg.dir * ds / dt;
    if (left - ds < 0.002) {
      plan.i++;
      plan.step = 'steer';
      if (plan.i >= plan.segs.length) this._finish();
    }
  }

  _finish() {
    this.v = 0;
    this.brake = true;
    this.steer = 0;
    this.gear = 'park';
    this.set('standstill', 1);
    this.set('gearReq', 1);
    this.set('apaSts', 8);
    this.set('chime', 9);
    this.set('lgtTyp', 0);
    this.set('latSts', 0);
    this.set('activation', 0, 'the head unit closes park assist');
    this.chimeOff = this.t + 1.2;
    this.phase = 'done';
    this.changed = true;
  }

  // ---- what the HUD sees -------------------------------------------------------------------------------

  _state(p = this.pose(), center = null) {
    center = center || { x: p.x + CAR.center * Math.cos(p.h), y: p.y + CAR.center * Math.sin(p.h) };
    const speed = Math.abs(this.v);
    const gearCode = { drive: 'D_gear', reverse: 'R_gear', park: 'gear_P' }[this.gear];
    const c = Math.cos(p.h), s = Math.sin(p.h);
    const rel = (x, y) => { const dx = x - center.x, dy = y - center.y; return [+(dx * c + dy * s).toFixed(2), +(-dx * s + dy * c).toFixed(2)]; };
    const slotOut = (sl) => {
      const x0 = sl.x - PITCH / 2 + 0.1, x1 = sl.x + PITCH / 2 - 0.1, ye = ROWS.right.entrance - 0.05, yb = ROWS.right.entrance - DEPTH + 0.05;
      return { id: sl.id, type: 'Perpendicular', side: 'Right', occupied: 0, corners: [rel(x0, ye), rel(x1, ye), rel(x1, yb), rel(x0, yb)] };
    };
    const parking = this.phase === 'park' || this.phase === 'done';
    const apa = this.sig.apaSts ? {
      state: { v: this.sig.apaSts, n: SIG.apaSts[3][this.sig.apaSts] },
      available: this.sig.available ? 'Park_in_available' : 'Not_available',
      scanning: this.sig.scanSide ? 'Right' : 'Not_scanning',
      speedWarning: 0,
      slots: parking ? [] : this.found.map(slotOut),
      selected: this.sig.slotSel ? slotOut(this.found.find(q => q.id === this.sig.slotSel)) : null,
    } : null;
    return {
      mode: 'live',
      op: { carState: { vEgo: speed, aEgo: 0, gear: this.gear, steeringAngleDeg: this.steer, brakePressed: this.brake, standstill: speed < 0.01 } },
      fisker: {
        active: true,
        vehicle: { speedKph: speed * 3.6, gear: gearCode, ready: true },
        parking: { ...this._sensors(p), apa },
      },
    };
  }

  // the parking sensors: zones per sector and distances per bumper sensor, from the obstacles' outlines
  _sensors(p) {
    const c = Math.cos(p.h), s = Math.sin(p.h);
    const read = ([sx, sy, dirDeg]) => {
      const x = p.x + sx * c - sy * s, y = p.y + sx * s + sy * c, dir = p.h + dirDeg * DEG;
      let best = Infinity;
      for (const o of this.obstacles) {
        // the nearest point of the obstacle's rectangle, if it's in front of the sensor (within 60 deg)
        const oc = Math.cos(o.h), os = Math.sin(o.h), dx = x - o.x, dy = y - o.y;
        const lx = Math.max(-o.hl, Math.min(o.hl, dx * oc + dy * os)), ly = Math.max(-o.hw, Math.min(o.hw, -dx * os + dy * oc));
        const nx = o.x + lx * oc - ly * os - x, ny = o.y + lx * os + ly * oc - y, d = Math.hypot(nx, ny);
        if (d < best && (d < 0.05 || Math.cos(Math.atan2(ny, nx) - dir) > 0.5)) best = d;
      }
      return best;
    };
    const zone = (d, rear) => {
      const step = rear ? 0.22 : 0.3;
      return d > 0.25 + step * 7.5 ? 0 : Math.max(1, Math.min(8, Math.round((d - 0.25) / step) + 1));
    };
    const uss = {};
    for (const [side, list] of Object.entries(USS)) uss[side] = list.map(q => zone(read(q), side === 'rear'));
    const cm = (d) => (d < 2.54 ? Math.round(d * 100) : null);
    return { uss, pdc: { front: PDC.front.map(q => cm(read(q))), rear: PDC.rear.map(q => cm(read(q))) } };
  }

  // ---- the panel and the space badges ------------------------------------------------------------------

  _pins(add) {
    for (const s of this.found) {
      const b = document.createElement('button');
      b.className = 'callout slotpin';
      b.textContent = `P${s.id}`;
      b.addEventListener('click', () => this.choose(s.id));
      const v = new THREE.Vector3();
      add(b, [0, 0, 0], 'badge', { atFn: () => this.lot.localToWorld(v.set(-s.y, 0.05, -s.x)), slot: s.id });
    }
  }

  // status line and what can be done next
  status() {
    const sel = this.selected;
    switch (this.phase) {
      case 'init': return ['Starting park assist', 'ICC_APAActivation sent'];
      case 'scan': return ['Searching for spaces', this.found.length ? `${this.found.length} found · keep driving slowly` : 'Drive slowly past the spaces'];
      case 'choose': return ['Choose a space', 'Tap one on the screen or below'];
      case 'confirm': return [`Space P${sel}`, 'Waiting for the ADAS to confirm it'];
      case 'ready': return [`Space P${sel} confirmed`, `${this.dirBack ? 'Backing' : 'Driving'} in · press Start parking`];
      case 'park': {
        const seg = this.plan.segs[this.plan.i];
        const what = !seg ? '' : this.plan.step === 'steer' ? 'Turning the wheel' : seg.dir > 0 ? 'Moving forward' : 'Reversing';
        return ['Parking', `${what} · keep your foot near the brake`];
      }
      case 'done': return ['Parked', 'Park assist is off · shifted to P'];
      default: return ['Park assist canceled', 'Take over'];
    }
  }

  progress() { return this.plan ? Math.min(1, this.plan.done / this.plan.total) : 0; }

  _panel() { return this.car.apaPanel(this); }
}

export { SIG as APA_SIGNALS };
