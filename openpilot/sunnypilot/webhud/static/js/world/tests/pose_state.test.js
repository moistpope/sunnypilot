// The pose estimator fed through StateBuilder: the TBOX GPS and heading frames on the comma's bus 0 (the
// ADAS-bus DBC) and on the car's own buses (the IBUS DBC: 0x526 on IBUS2, 0x179 on IBUS1), and the comma's
// GPS service standing in when the car's own fixes stop.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DBC } from '../dbc.js';
import { StateBuilder } from '../state.js';
import { worldDbc } from './helpers.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const ibusDbc = new DBC(fs.readFileSync(path.join(here, '../../../../../../third_party/webhud/dbc/fisker_ocean_ibus.dbc'), 'latin1'));
const LAT = 33.9883, LON = -83.3427;
const DEG = Math.PI / 180, R = 6378137.0;

/** Drive north at v m/s for `seconds`, with the car's frames on the given buses; fixes follow the truth 0.2 s late. */
function drive(builder, dbc, { v = 20, seconds = 8, gpsBus = 0, headingBus = 0, gearMsg = 0x214, fixesUntil = Infinity } = {}) {
  const enc = (addr, values) => dbc.messages.get(addr).encode(values);
  const kph = v / 1.031 * 3.6;   // the wheel speed reads 3% low
  let n = 0;
  for (let t = 0; t <= seconds + 1e-9; t += 0.01) {
    const frames = [[0x318, enc(0x318, { ESP_VehSpd: kph, ESP_VehSpdVld: 1 }), 0], [0x112, enc(0x112, { YRS_YawRate: 0.0 }), 0],
                    [gearMsg, enc(gearMsg, { VCU_GearSig: 4 }), 0]];
    if (Math.round(t * 100) % 10 === 0) {   // 10 Hz: where the car was 0.2 s ago
      const y = v * Math.max(0, t - 0.2);
      if (t <= fixesUntil) frames.push([0x526, enc(0x526, { TBOX_GPSLati: LAT + y / (DEG * R), TBOX_GPSLongi: LON }), gpsBus]);
      frames.push([0x179, enc(0x179, { TBOX_Heading: 0.0, TBOX_HeadingStdDev: 0.15 }), headingBus]);
    }
    builder.feedCan(frames, t);
    n++;
  }
  return builder.snapshot(seconds);
}

describe('pose through StateBuilder', () => {
  test('a reset (seek, a new viewer) moves the origin: the map is re-projected and matches again', async () => {
    const { MapData } = await import('../mapdata.js');
    const md = new MapData(async () => null);
    const b = new StateBuilder(worldDbc(), null, { mapData: md });
    b.setBrand('fisker');
    drive(b, worldDbc(), { seconds: 2 });
    const seq1 = b.pose.seq, o1 = { ...md.origin };
    assert.ok(o1.lat && md.origin.seq === seq1);
    b.reset();
    // the drive goes on from 160 m north (a different first fix), as a seek or a reconnect would
    const far = 2.0;
    const enc = (addr, values) => worldDbc().messages.get(addr).encode(values);
    for (let t = 0; t <= far; t += 0.01) {
      const frames = [[0x318, enc(0x318, { ESP_VehSpd: 60, ESP_VehSpdVld: 1 }), 0], [0x112, enc(0x112, { YRS_YawRate: 0.0 }), 0], [0x214, enc(0x214, { VCU_GearSig: 4 }), 0]];
      if (Math.round(t * 100) % 10 === 0) frames.push([0x526, enc(0x526, { TBOX_GPSLati: LAT + (500 + 16 * t) / (DEG * R), TBOX_GPSLongi: LON }), 0]);
      b.feedCan(frames, 100 + t);
    }
    b.snapshot(102);
    assert.ok(b.pose.seq > seq1, 'the origin counter keeps counting across the reset');
    assert.ok(md.origin.seq === b.pose.seq && Math.abs(md.origin.lat - o1.lat) > 1e-4, 'the map follows the new origin');
  });

  test('comma path: TBOX fixes and heading on bus 0 anchor the pose', () => {
    const b = new StateBuilder(worldDbc(), null);
    b.setBrand('fisker');
    const snap = drive(b, worldDbc());
    const p = snap.pose;
    assert.equal(p.quality, 'gps');
    assert.ok(Math.abs(p.h - Math.PI / 2) < 0.01, `heading ${p.h}`);          // north
    assert.ok(Math.abs(p.y - 20 * 8) < 1.0 && Math.abs(p.x) < 0.5, `${p.x}, ${p.y}`);   // 160 m north of the start
    assert.ok(Math.abs(p.lat - (LAT + 160 / (DEG * R))) < 1e-5 && Math.abs(p.lon - LON) < 1e-6);
    assert.ok(p.gpsAge < 0.5 && p.headingAge < 0.5);
    assert.ok(Math.abs(p.speedScale - 1.031) < 0.01, `scale ${p.speedScale}`);
  });

  test('car-only path: the same from IBUS2 (fixes) and IBUS1 (heading) with the IBUS DBC', () => {
    const b = new StateBuilder(ibusDbc, null, { gearMsg: 0x234 });
    b.setBrand('fisker');
    const snap = drive(b, ibusDbc, { gpsBus: 2, headingBus: 0, gearMsg: 0x234 });
    const p = snap.pose;
    assert.equal(p.quality, 'gps');
    assert.ok(Math.abs(p.h - Math.PI / 2) < 0.01 && Math.abs(p.y - 160) < 1.0, `${p.y}, ${p.h}`);
  });

  test("the comma's GPS service stands in once the car's fixes stop", () => {
    const b = new StateBuilder(worldDbc(), null);
    b.setBrand('fisker');
    drive(b, worldDbc(), { seconds: 4, fixesUntil: 2 });           // car fixes for 2 s, then none
    const s1 = b.snapshot(4).pose;
    assert.ok(s1.gpsAge > 1.5, `age ${s1.gpsAge}`);
    for (let t = 4.05; t <= 6; t += 0.1) b.feedService('gpsLocationExternal', { lat: LAT + 20 * (t - 0.2) / (DEG * R), lon: LON, bearing: 0, speed: 20, fix: true }, t);
    const s2 = b.snapshot(6).pose;
    assert.ok(s2.gpsAge < 0.5, `age ${s2.gpsAge}`);
    assert.equal(s2.quality, 'gps');
    // a fix on the bus within the last second keeps the comma's out
    const bb = new StateBuilder(worldDbc(), null);
    bb.setBrand('fisker');
    drive(bb, worldDbc(), { seconds: 3 });
    const before = bb.pose.fixes;
    bb.feedService('gpsLocationExternal', { lat: LAT, lon: LON, bearing: 0, speed: 20, fix: true }, 3.05);
    assert.equal(bb.pose.fixes, before);
  });
});
