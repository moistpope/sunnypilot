import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BUS_CAM, BUS_PT, STALE_S, FiskerWorld, lanePolyline } from '../fisker_world.js';
import { worldDbc, rng } from './helpers.js';

function make() { return new FiskerWorld(worldDbc()); }

function frame(world, name, values, src = null) {
  const msg = world.dbc.byName[name];
  return [msg.address, msg.encode(values), src ?? (msg.transmitter === 'ADAS' ? BUS_CAM : BUS_PT)];
}

test('every message decodes to JSON', () => {
  const world = make();
  const r = rng(1);
  const frames = [...world.dbc.messages].map(([a, m]) => [a, Uint8Array.from({ length: m.size }, () => Math.floor(r() * 256)), world.nativeBus.get(a)]);
  world.update(frames, 10.0);
  const state = world.state();
  JSON.stringify(state);   // must be serializable
  assert.ok(state.active);
});

test('lane line', () => {
  const world = make();
  world.update([
    frame(world, 'ADAS_0x339', { ADAS_LeLine1Offset: 1.75, ADAS_LeLine1Hdng: 92.0, ADAS_LeLine1Crvt: -500, ADAS_LeLine1LnTyp: 2, ADAS_LeLine1LnColor: 1, ADAS_LeLine1Conf: 7 }),
    frame(world, 'ADAS_0x20C', { ADAS_RiLine1Offset: 1.6, ADAS_RiLine1Crvt: 3200, ADAS_RiLine1LnTyp: 0 }),
  ], 1.0);
  const lines = Object.fromEntries(world.state().lanes.lines.map(ln => [ln.id, ln]));
  const left = lines.L1;
  assert.equal(left.y0, 1.75);
  assert.equal(left.heading, -2.0);   // raw 92 deg = 2 deg to the right
  assert.equal(left.radius, -500);
  assert.equal(left.color, 'yellow');
  assert.equal(left.typeName, 'SingleLine_dashed');
  assert.equal(left.conf, 1.0);
  assert.ok(left.valid);
  const right = lines.R1;
  assert.equal(right.y0, -1.6);          // right lines are negative (y is +left)
  assert.equal(right.radius, null);     // 3200 = not displayed
  assert.ok(!right.valid);
  const pts = lanePolyline(left, 20, 10);
  assert.equal(pts.length, 3);
  assert.deepEqual(pts[0], [0, 1.75]);
});

test('objects and flags', () => {
  const world = make();
  world.update([
    frame(world, 'ADAS_0x33B', { ADAS_Obj1_ID: 42, ADAS_Obj1_LongDist: 30.4, ADAS_Obj1_LongDistSign: 0, ADAS_Obj1_LatDist: 3.4, ADAS_Obj1_LatDistSign: 1,
      ADAS_Obj1_Classification: 1, ADAS_Obj1_Width: 2.5, ADAS_Obj1_Length: 10.0, ADAS_VVP_ICC_Obj1Hdng: 357 }),
    frame(world, 'ADAS_0x34B', { ADAS_Obj2_ID: 7, ADAS_Obj2_LongDist: 5, ADAS_Obj2_LongDistSign: 1, ADAS_Obj2_LatDist: 3, ADAS_Obj2_LatDistSign: 0 }),
    frame(world, 'ADAS_0x32D', { ADAS_Obj3_ID: 0 }),   // empty slot
    frame(world, 'ADAS_0x31C', { ADAS_ACCPrimTgtID: 42, ADAS_AccTrgSpdDisp: 65, ADAS_TiGapSet_ACC: 3 }),
    frame(world, 'ADAS_0x313', { ADAS_Sts_ACC_ICC: 3 }),
    frame(world, 'ADAS_0x315', { ADAS_BSD_CID_RiDispReq: 1, ADAS_BSDRightThreatID: 7 }),
  ], 2.0);
  const state = world.state();
  const objs = Object.fromEntries(state.objects.map(o => [o.id, o]));
  assert.deepEqual(Object.keys(objs).map(Number).sort((a, b) => a - b), [7, 42]);
  const truck = objs[42];
  assert.equal(truck.x, 30.4);
  assert.equal(truck.y, 3.4);
  assert.equal(truck.cls, 'truck');
  assert.equal(truck.heading, -3.0);
  assert.deepEqual(truck.flags, ['accPrimary']);
  const behind = objs[7];
  assert.equal(behind.x, -5);
  assert.equal(behind.y, -3);
  assert.ok(behind.flags.includes('bsd'));
  assert.ok(state.acc.engaged);
  assert.equal(state.acc.setSpeed, 65);
  assert.equal(state.acc.timeGap, 3);
  assert.deepEqual(state.threats.right.bsd, { v: 1, n: 'Threat_present_on_right' });
});

test('object distance resolution', () => {
  // the object list is 0.2 m/bit (corrected in the DBC subset; the OEM matrix says 0.5)
  const world = make();
  const msg = world.dbc.byName.ADAS_0x33B;
  const raw = msg.encode({ ADAS_Obj1_ID: 9 });
  raw[1] = 202; raw[2] = 6;   // LongDist / LatDist raw counts, as the ACC target read on the car
  world.update([[msg.address, raw, world.nativeBus.get(msg.address)]], 3.0);
  const obj = world.state().objects[0];
  assert.equal(obj.x, 40.4);
  assert.equal(obj.y, -1.2);
});

test('traffic light active color', () => {
  const world = make();
  const active = (values) => {
    world.update([frame(world, 'ADAS_0x210', { ADAS_TLR_EgoLaneColor: 0, ADAS_TrafficLightShape: 0, ADAS_TLR_WarnReq: 0, ...values })], 4.0);
    const tlr = world.state().tlr;
    return [tlr.active, tlr.detected];
  };
  // the ego-lane color wins, keeping its arrow / supplementary combination
  assert.deepEqual(active({ ADAS_TLR_EgoLaneColor: 5, ADAS_TrafficLightShape: 3 }), [{ color: 'Red_With_Supp_green', source: 'egoLane' }, true]);
  // no ego-lane color (none / unknown): the plain light color
  assert.deepEqual(active({ ADAS_TLR_EgoLaneColor: 8, ADAS_TrafficLightShape: 2 }), [{ color: 'Amber', source: 'light' }, true]);
  // neither: what the warning implies
  assert.deepEqual(active({ ADAS_TLR_WarnReq: 1 }), [{ color: 'Red', source: 'warning' }, true]);
  assert.deepEqual(active({}), [null, false]);
});

test('motor power', () => {
  const world = make();
  world.update([
    frame(world, 'VCU_0x102', { VCU_DrvrFrntMotTqReq: 1044, VCU_DrvrFrntMotTqReqVld: 1, VCU_DrvrReMotTqReq: 1301, VCU_DrvrReMotTqReqVld: 1 }),
    frame(world, 'MCU_F_0x150', { MCU_F_CrtSpd: 1500, MCU_F_CrtSpdSigVld: 1, MCU_F_CrtTq: 84, MCU_F_CrtTqVld: 1 }),
    frame(world, 'MCU_R_0x151', { MCU_R_CrtSpd: 1500, MCU_R_CrtSpdSigVld: 1, MCU_R_CrtTq: 103.5, MCU_R_CrtTqVld: 1 }),
  ], 5.0);
  let power = world.state().power;
  assert.equal(power.tqReq, 2345);
  assert.deepEqual(power.front, { tqReq: 1044, tq: 84.0, rpm: 1500 });
  assert.equal(power.demandKw, 32.0);     // 2345 Nm at the wheels x 157 rad/s at the motors / 11.5
  assert.equal(power.kw, 29.5);           // 187.5 Nm x 157 rad/s
  // an invalid request drops out; a motor without its speed falls back to road speed
  world.update([
    frame(world, 'VCU_0x102', { VCU_DrvrFrntMotTqReq: -500, VCU_DrvrFrntMotTqReqVld: 1, VCU_DrvrReMotTqReqVld: 2 }),
    frame(world, 'MCU_F_0x150', { MCU_F_CrtSpdSigVld: 2 }),
    frame(world, 'ESP_0x318', { ESP_VehSpd: 36 }),
  ], 5.1);
  power = world.state().power;
  assert.equal(power.tqReq, -500);
  assert.equal(power.rear.tqReq, null);
  assert.equal(power.front.rpm, null);
  assert.equal(power.demandKw, -12.8);    // regen: -500 Nm x 10 m/s / 0.39 m
});

test('native bus preferred and echoes ignored', () => {
  const w = make();
  w.update([frame(w, 'ADAS_0x31C', { ADAS_AccTrgSpdDisp: 50 })], 1.0);
  // the same message forwarded onto bus 0 doesn't replace the fresh cam-side frame
  w.update([frame(w, 'ADAS_0x31C', { ADAS_AccTrgSpdDisp: 99 }, BUS_PT)], 1.1);
  assert.equal(w.state().acc.setSpeed, 50);
  // TX echoes (src >= 128) are never parsed
  w.update([frame(w, 'ADAS_0x31C', { ADAS_AccTrgSpdDisp: 77 }, 128 + BUS_CAM)], 1.2);
  assert.equal(w.state().acc.setSpeed, 50);
  // once the native bus goes quiet the other bus fills in
  w.update([frame(w, 'ADAS_0x31C', { ADAS_AccTrgSpdDisp: 61 }, BUS_PT)], 2.0);
  assert.equal(w.state().acc.setSpeed, 61);
  // ...but never the radar's private bus (1), whose 48-byte frames reuse ADASBUS IDs
  w.update([[0x31C, Uint8Array.from({ length: 48 }, (_, i) => i), 1]], 3.0);
  assert.equal(w.state().acc.setSpeed, 61);
  assert.equal(w.frames.get(0x31C)[2], BUS_PT);
});

test('stale messages drop out', () => {
  const w = make();
  w.update([frame(w, 'ADAS_0x31C', { ADAS_AccTrgSpdDisp: 50 })], 1.0);
  w.update([frame(w, 'ICC_0x531', { ICC_DispVehSpd: 30, ICC_DispVehSpdUnit: 1 })], 1.0 + STALE_S + 0.5);
  const state = w.state();
  assert.equal(state.acc.setSpeed, null);
  assert.equal(state.vehicle.displaySpeed, 30);
  assert.equal(state.vehicle.displayUnit, 'mph');
});

test('parking sensors', () => {
  const w = make();
  w.update([
    frame(w, 'ADAS_0x352', { ADAS_USS_B1: 2, ADAS_USS_F0: 9, ADAS_USS_L3: 15 }),
    frame(w, 'ADAS_0x359', { ADAS_ObjDst_RLC: 45, ADAS_ObjDst_RRC: 255 }),
  ], 3.0);
  const park = w.state().parking;
  assert.equal(park.uss.rear[1], 2);
  assert.equal(park.uss.front[0], 9);
  assert.equal(park.uss.left[3], 15);
  assert.equal(park.pdc.rear[1], 45);
  assert.equal(park.pdc.rear[4], null);
});

test('raw messages', () => {
  const w = make();
  w.update([frame(w, 'ADAS_0x31C', { ADAS_AccTrgSpdDisp: 50 })], 1.0);
  const raw = w.rawMessages([0x31C, 0x999], 1.5);
  assert.deepEqual(Object.keys(raw), ['0x31C']);
  assert.equal(raw['0x31C'].signals.ADAS_AccTrgSpdDisp, 50);
  assert.equal(raw['0x31C'].age, 0.5);
});
