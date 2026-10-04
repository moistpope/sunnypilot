import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BUS_RADAR, HEADER, SLOTS, STALE_S, FiskerRadar } from '../fisker_radar.js';
import { StateBuilder } from '../state.js';
import { hexToBytes } from '../dbc.js';
import { radarDbc, worldDbc } from './helpers.js';

// A real slot frame from the drive the DBC was decoded from: track 0x6F4, a stationary target
// straight ahead while closing at ~7 m/s.
const REAL_SLOT = hexToBytes('29000006f47ffff400cb9b7008040af3c30302c83cfcc48005beafe03f800000000000a9c15000000000000000000000');

function make() {
  const radar = new FiskerRadar(radarDbc());
  const dbc = radar.dbc;
  const header = (n = 1, cycle = 5) => [HEADER, dbc.messages.get(HEADER).encode({ MRR_NumObjects: n, MRR_CycleCounter: cycle }), BUS_RADAR];
  const slot = (i, values) => {
    const msg = dbc.messages.get(SLOTS[i]);
    const nn = String(i).padStart(2, '0');
    return [msg.address, msg.encode(Object.fromEntries(Object.entries(values).map(([k, v]) => [`MRR_Obj${nn}_${k}`, v]))), BUS_RADAR];
  };
  const empty = (i) => [SLOTS[i], Uint8Array.from([0, 0, 0, 0, 0, 0x40, ...new Array(42).fill(0)]), BUS_RADAR];   // ID 0, as the radar sends unused slots
  return { radar, dbc, header, slot, empty };
}

test('object frame', () => {
  const { radar, header, slot, empty } = make();
  radar.update([
    header(1, 9),
    slot(0, { ID: 1780, Age: 40, DistLong: 50.0, DistLat: 1.5, VrelLong: -7.2, VrelLat: 0.6, ArelLong: -0.3, Heading: 10.0, Class: 1, DynProp: 5, Width: 2.0, Length: 4.6 }),
    empty(1),
  ], 1.0);
  const st = radar.state(1.0);
  JSON.stringify(st);
  assert.equal(st.count, 1);
  assert.equal(st.cycle, 9);
  assert.equal(st.objects.length, 1);
  const o = st.objects[0];
  assert.equal(o.id, 1780);
  assert.equal(o.x, 50.0);
  assert.equal(o.age, 40);
  assert.equal(o.y, -1.5);        // the radar's lateral axis is +right; ours is +left
  assert.equal(o.vy, -0.6);
  assert.equal(o.vx, -7.2);
  assert.equal(o.ax, -0.3);
  assert.equal(o.heading, -9.8);  // 10 deg clockwise, on the 360/256 deg grid
  assert.equal(o.cls, 'car');
  assert.equal(o.dyn, 5);
  assert.equal(o.w, 2.0);
  assert.equal(o.l, 4.6);
});

test('real frame', () => {
  const { radar, header } = make();
  radar.update([header(), [SLOTS[0], REAL_SLOT, BUS_RADAR]], 1.0);
  const [o] = radar.state(1.0).objects;
  assert.equal(o.id, 0x6F4);
  assert.equal(o.age, 50);
  assert.equal(o.x, 87.8);
  assert.equal(o.y, -0.4);
  assert.equal(o.vx, -7.32);
  assert.equal(o.heading, 1.4);
  assert.equal(o.cls, 'unclassified');
  assert.equal(o.dyn, 5);
  assert.equal(o.w, null);
});

test('heading unavailable', () => {
  const { radar, header, slot } = make();
  radar.update([header(), slot(0, { ID: 5, DistLong: 20, Heading: 178.6 })], 1.0);   // raw 255
  assert.equal(radar.state(1.0).objects[0].heading, null);
});

test('track caught in two slots keeps newer', () => {
  const { radar, header, slot } = make();
  radar.update([header(2), slot(0, { ID: 7, DistLong: 30.0 }), slot(1, { ID: 8, DistLong: 40.0 })], 1.0);
  // next cycle: track 7 moved to slot 1 and the snapshot ran before slot 0 was rewritten
  radar.update([slot(1, { ID: 7, DistLong: 29.5 })], 1.065);
  const objs = radar.state(1.07).objects;
  assert.deepEqual(objs.map(o => [o.id, o.x]), [[7, 29.5]]);
});

test('resent cycle is handed out once', () => {
  // the radar now and then sends a cycle again with the same MeasTime and counter (000000b5--bfe13ac451--13);
  // handed out twice, every track in it would be measured twice at once
  const { radar, dbc, slot } = make();
  const cycle = (t, c, measNs, x) => {
    const hdr = dbc.messages.get(HEADER).encode({ MRR_NumObjects: 1, MRR_CycleCounter: c, MRR_MeasTime_Sec: 100, MRR_MeasTime_NSec: measNs });
    radar.update([[HEADER, hdr, BUS_RADAR], slot(0, { ID: 7, Age: 40, DistLong: x, CycleCounter: c })], t);
    return radar.takeCycles(t + 0.05);
  };
  const cycles = [...cycle(1.0, 5, 0, 30.0), ...cycle(1.065, 5, 0, 30.0), ...cycle(1.13, 6, 65_000_000, 29.5)];
  assert.deepEqual(cycles.map(([, objs]) => objs[0].x), [30.0, 29.5]);
});

test('silent or stale bus', () => {
  const { radar, header, slot } = make();
  assert.equal(radar.state(1.0), null);
  radar.update([slot(0, { ID: 3, DistLong: 10 })], 1.0);
  assert.equal(radar.state(1.0), null);              // no header: not a radar cycle
  radar.update([header()], 1.0);
  assert.equal(radar.state(1.0).objects.length, 1);
  assert.equal(radar.state(1.0 + STALE_S + 0.1), null);
});

test('only bus 1', () => {
  const { radar, header, slot } = make();
  const [addr, data] = slot(0, { ID: 3, DistLong: 10 });
  radar.update([[HEADER, header()[1], 0], [addr, data, 2], [addr, data, 128 + BUS_RADAR]], 1.0);
  assert.equal(radar.state(1.0), null);
});

test('snapshot', () => {
  const { header, slot } = make();
  const b = new StateBuilder(worldDbc(), radarDbc());
  b.feedCan([header(), slot(0, { ID: 3, DistLong: 10 })], 1.0);
  assert.equal(b.snapshot(1.0).radar.objects[0].id, 3);
  b.setBrand('toyota');
  assert.equal(b.snapshot(1.0).radar, null);
});

test('no radar DBC: radar view disabled', () => {
  const radar = new FiskerRadar(null);
  radar.update([[HEADER, new Uint8Array(32), BUS_RADAR]], 1.0);
  assert.equal(radar.state(1.0), null);
  assert.deepEqual(radar.takeCycles(2.0), []);
});
