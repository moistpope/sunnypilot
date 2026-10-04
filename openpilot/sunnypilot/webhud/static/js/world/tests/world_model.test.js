import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { CONF_STANDING, FRONT_TO_REAR_AXLE, FUSION_DELAY_S, MEASURED_CALIBRATION, NO_CALIBRATION, RADAR_MIN_AGE, EgoOdometry, WorldModel,
  adasMeasurement, opMeasurements, radarMeasurements, toEgo, toWorld } from '../world_model.js';

const SHOWN = 0.65, HIDDEN = 0.35;   // the view's fade (scene.js CONF_FULL / CONF_HIDE)
const hypot = (x, y) => Math.sqrt(x * x + y * y);

function radarObj(oid, x, y, { vx = 0.0, vy = 0.0, age = 40, cls = 'unclassified', w = null, l = null } = {}) {
  return { id: oid, x, y, vx, vy, age, hist: 0x3FFF, state: 3, quality: 13, cls, heading: null, w, l };
}

describe('EgoOdometry', () => {
  test('circle', () => {
    const odo = new EgoOdometry();
    const v = 5.0, w = 0.5;   // a 10 m radius left turn
    for (let i = 0; i <= Math.floor(Math.PI / w / 0.01); i++) odo.update(i * 0.01, v, w);
    const [x, y, h] = odo.pose(Math.PI / w);   // half a lap: 20 m to the left, facing back
    assert.ok(Math.abs(x) < 0.1 && Math.abs(y - 20) < 0.1 && Math.abs(h - Math.PI) < 0.01);
    const [xm, ym] = odo.pose(Math.PI / w / 2);   // interpolated quarter lap
    assert.ok(Math.abs(xm - 10) < 0.1 && Math.abs(ym - 10) < 0.1);
  });

  test('frames round trip', () => {
    const pose = [3.0, -2.0, 0.7];
    const back = toEgo(pose, ...toWorld(pose, 12.0, -1.5));
    assert.ok(Math.abs(back[0] - 12.0) < 1e-9 && Math.abs(back[1] + 1.5) < 1e-9);
  });
});

describe('WorldModel', () => {
  let model;
  beforeEach(() => { model = new WorldModel(); });

  /** Drive at (v, w); every radar cycle `see(t, odo)` returns what's measured then. */
  function drive(tEnd, v, w, see = null, dt = 0.01, cycle = 0.065) {
    const odo = model.odo;
    let nextCycle = 0.0;
    const out = [];
    for (let i = 0; i <= Math.floor(tEnd / dt); i++) {
      const t = i * dt;
      odo.update(t, v, w);
      if (see !== null && t >= nextCycle) {
        model.add(see(t, odo));
        nextCycle += cycle;
      }
      if (i % 5 === 0) out.push([t, model.step(t)]);   // 20 Hz snapshots
    }
    return out;
  }

  test('stationary object stays put through a turn', () => {
    const wx = 25.0, wy = 6.0;   // a parked car, in world coordinates
    const see = (t, odo) => {   // reported at t, measured 0.1 s earlier (the radar's latency)
      const [x, y] = toEgo(odo.pose(t - 0.1), wx, wy);
      return x > 0 ? radarMeasurements(t - 0.1, [radarObj(7, x, y, { vx: -4.0 })], 4.0) : [];
    };
    const snaps = drive(3.0, 4.0, 0.35, see);
    const errs = [];
    for (const [t, objs] of snaps.slice(20)) {
      if (objs.length) {
        const o = objs[0];
        const [ox, oy] = toWorld(model.odo.pose(t), o.x, o.y);
        errs.push(hypot(ox - wx, oy - wy));
        assert.ok(o.stationary && o.sources[0].src === 'radar');
      }
    }
    assert.ok(errs.length && Math.max(...errs) < 0.5, String(Math.max(...errs)));
  });

  test('sources weighted by what they measure well', () => {
    // the same car 30 m ahead: the radar has its range right, the ADAS camera reads 1.7 m long and a bit
    // off laterally; openpilot reads 3 m short
    for (let i = 0; i < 40; i++) {
      const t = i * 0.05;
      model.odo.update(t, 0.0, 0.0);
      model.add(radarMeasurements(t, [radarObj(5, 30.0, 0.8)], 0.0));
      model.add([adasMeasurement(t + 0.12, { id: 9, x: 31.7, y: 0.5, cls: 'car', w: 1.9, l: 4.7, h: 1.5 })]);
      model.add(opMeasurements(t, { leadOne: { present: true, dRel: 27.0, yRel: 0.4, vLead: 0.0, modelProb: 0.9 } }, 0.0));
    }
    const objs = model.step(2.0 + FUSION_DELAY_S);
    assert.equal(objs.length, 1);
    const o = objs[0];
    assert.ok(Math.abs(o.x - 30.0) < 0.3, String(o.x));                 // range from the radar
    assert.ok(0.45 < o.y && o.y < 0.8, String(o.y));                     // lateral leans to the camera
    assert.equal(o.cls, 'car');
    assert.equal(o.w, 1.9);                                              // class and size from the camera
    assert.deepEqual(new Set(o.sources.map(s => s.src)), new Set(['radar', 'adas', 'op']));
    const adas = o.sources.find(s => s.src === 'adas');
    assert.ok(1.4 < adas.dx && adas.dx < 2.0);                          // the camera's range offset shows in its residual
  });

  test('young radar tracks and lone openpilot leads are left out', () => {
    assert.deepEqual(radarMeasurements(0.0, [radarObj(1, 20.0, 0.0, { age: RADAR_MIN_AGE - 1 })], 0.0), []);
    for (let i = 0; i < 40; i++) {
      const t = i * 0.05;
      model.odo.update(t, 0.0, 0.0);
      model.add(radarMeasurements(t, [radarObj(2, 40.0, 3.0)], 0.0));   // the radar is there...
      model.add(opMeasurements(t, { leadOne: { present: true, dRel: 6.0, yRel: 0.0, vLead: 0.0, modelProb: 0.95 } }, 0.0));
    }
    const objs = model.step(2.0 + FUSION_DELAY_S);
    assert.deepEqual(objs.map(o => Math.round(o.x)), [40]);   // ...so a lead nothing else sees isn't shown
  });

  test('openpilot alone still shows', () => {
    let objs = [];
    for (let i = 0; i < 40; i++) {   // held for a second with nothing else around (other makes have no radar here)
      const t = i * 0.05;
      model.odo.update(t, 10.0, 0.0);
      model.add(opMeasurements(t, { leadOne: { present: true, dRel: 30.0, yRel: 0.0, vLead: 9.0, modelProb: 0.9 } }, 10.0));
      objs = model.step(t);
    }
    assert.equal(objs.length, 1);
    assert.equal(objs[0].sources[0].src, 'op');
    assert.ok(Math.abs(objs[0].speed - 9.0) < 1.0);
  });

  test('moving car velocity and heading', () => {
    // a car crossing left to right 20 m ahead at 8 m/s while we stand still
    const see = (t) => radarMeasurements(t, [radarObj(3, 20.0, 10.0 - 8.0 * t, { vx: 0.0, vy: -8.0 })], 0.0);
    const snaps = drive(1.5, 0.0, 0.0, see);
    const o = snaps[snaps.length - 1][1][0];
    assert.ok(Math.abs(o.vy + 8.0) < 1.0 && Math.abs(o.heading + 90) < 10, `${o.vy} ${o.heading}`);
    assert.ok(Math.abs(o.y - (10.0 - 8.0 * 1.5)) < 0.6);     // predicted to now, past the fusion delay
  });

  test('paused time takes everything', () => {
    // right after a seek a paused replay asks again and again for the same moment: the camera's
    // latest reading (newer than the fusion delay) must still get in
    model.odo.update(0.0, 0.0, 0.0);
    model.add([adasMeasurement(1.0, { id: 4, x: 12.0, y: 0.0, cls: 'car' })]);
    assert.deepEqual(model.step(1.0), []);
    const objs = model.step(1.0);
    assert.equal(objs.length, 1);
    assert.equal(objs[0].cls, 'car');
    assert.equal(objs[0].sources[0].src, 'adas');
  });

  test('reset', () => {
    model.odo.update(0.0, 1.0, 0.0);
    model.add([adasMeasurement(0.2, { id: 4, x: 12.0, y: 0.0, cls: 'car' })]);
    model.step(0.2);
    const [before] = model.step(0.2);
    model.reset();
    assert.deepEqual(model.step(1.0), []);
    assert.deepEqual(model.odo.pose(1.0), [0.0, 0.0, 0.0]);
    model.add([adasMeasurement(1.0, { id: 4, x: 12.0, y: 0.0, cls: 'car' })]);
    model.step(1.0);
    const [after] = model.step(1.0);
    assert.notEqual(after.id, before.id);   // ids keep counting, so a viewer never mixes the two up
  });
});

/** At 22 m/s on a straight road, with openpilot's model running; `world` maps each radar id to a
 *  ground-fixed [x, y, w, l, cls] (cls may be a function of time), `leads` the openpilot leads to report [dRel, yRel, vLead]. */
describe('Confidence', () => {
  const V = 22.0;
  let model;
  beforeEach(() => { model = new WorldModel(); });

  function runFor(tEnd, world, { leads = () => [], moving = null, age = () => 40, adas = () => [] } = {}) {
    const odo = model.odo, out = [];
    let nextCycle = 0.0;
    for (let i = 0; i <= Math.floor(tEnd / 0.01); i++) {
      const t = i * 0.01;
      odo.update(t, V, 0.0);
      if (t >= nextCycle) {
        const objs = [];
        for (const rid of Object.keys(world)) {
          const [wx0, wy, w, l, cls] = world[rid];
          const wx = wx0 + ((moving && moving[rid]) || 0.0) * t;
          const [x, y] = toEgo(odo.pose(t), wx, wy);
          if (0 < x && x < 170) objs.push(radarObj(Number(rid), x, y, { vx: ((moving && moving[rid]) || 0.0) - V, age: age(t), cls: typeof cls === 'function' ? cls(t) : cls, w, l }));
        }
        model.add(radarMeasurements(t, objs, V));
        const rs = {};
        leads(t).forEach(([d, y, v], k) => { rs[['leadOne', 'leadTwo'][k]] = { present: true, dRel: d, yRel: y, vLead: v, modelProb: 0.9 }; });
        model.add(opMeasurements(t, rs, V));
        model.add(adas(t).map(o => adasMeasurement(t + 0.12, o)));
        model.modelRan(t);
        nextCycle += 0.065;
      }
      if (i % 5 === 0) out.push([t, model.step(t)]);
    }
    return out;
  }

  /** [conf, why] of every object reported within xRange ahead. */
  const conf = (snaps, xRange) => snaps.flatMap(([, objs]) => objs.filter(o => xRange[0] < o.x && o.x < xRange[1]).map(o => [o.conf, o.confWhy]));
  const last = (snaps) => snaps[snaps.length - 1][1];

  test('overhead sign in our path stays hidden', () => {
    // route 000000b5--bfe13ac451--12, radar track 791: a traffic light the radar calls a car, 3 m wide and 0.6 m long,
    // standing in our lane; openpilot's model sees no lead there
    const snaps = runFor(3.5, { 791: [110.0, 0.3, 3.0, 0.6, 'car'] });
    const seen = conf(snaps, [8.0, 90.0]);
    assert.ok(seen.length && Math.max(...seen.map(([c]) => c)) < HIDDEN);
    assert.equal(seen[seen.length - 1][1], 'unseen');
  });

  test('a stopped car the camera sees shows', () => {
    const snaps = runFor(3.5, { 5: [110.0, 0.3, 2.0, 1.0, 'car'] }, { leads: t => (t > 1.0 ? [[106.2 - V * t, -0.3, 0.0]] : []) });
    assert.equal(last(snaps)[0].confWhy, 'vision');
    assert.ok(last(snaps)[0].conf > SHOWN);
  });

  test("a stopped car behind a lead isn't doubted", () => {
    // the model can't see past the car ahead of us; the radar sees under it
    const snaps = runFor(3.0, { 1: [20.0, 0.0, 2.0, 4.0, 'car'], 2: [60.0, 0.2, 2.0, 1.0, 'car'] },
      { moving: { 1: V, 2: 0.0 }, leads: () => [[20.0 - 3.8, 0.0, V]] });
    const stopped = last(snaps).filter(o => o.sources[0].id === 2);
    assert.ok(stopped.length);
    assert.equal(stopped[0].confWhy, 'standing');
    assert.ok(stopped[0].conf > HIDDEN);
  });

  test('parked car beside the road shows softer', () => {
    const [o] = last(runFor(3.0, { 3: [60.0, 5.0, 2.0, 4.2, 'car'] }));
    assert.equal(o.confWhy, 'standing');
    assert.ok(Math.abs(o.conf - CONF_STANDING) < 0.05);
  });

  test('wide thin strip beside the road is doubted', () => {
    const [o] = last(runFor(3.0, { 4: [60.0, 5.0, 3.0, 0.6, 'car'] }));
    assert.equal(o.confWhy, 'thin');
    assert.ok(o.conf < HIDDEN);
  });

  test('unclassified radar needs a second factor', () => {
    // a point target the radar never classified, moving with traffic ahead of us
    const world = { 8: [40.0, 0.0, null, null, 'unclassified'] }, moving = { 8: 15.0 };
    const ahead = (t) => 40.0 - FRONT_TO_REAR_AXLE + (15.0 - V) * t;   // m ahead of our bumper

    const alone = runFor(3.0, world, { moving }).flatMap(([, objs]) => objs);
    assert.ok(alone.length && alone.every(o => o.confWhy === 'unclassified' && o.conf < HIDDEN));

    model = new WorldModel();   // radar classes flicker: one cycle of "small" (radar track 468) doesn't make it classified
    const flicker = { 8: [40.0, 0.0, null, null, (t) => (1.0 <= t && t < 1.065 ? 'small' : 'unclassified')] };
    assert.equal(last(runFor(3.0, flicker, { moving }))[0].confWhy, 'unclassified');

    model = new WorldModel();   // the same, and openpilot's model sees a car there
    let [o] = last(runFor(3.0, world, { moving, leads: t => [[ahead(t) - 1.0, 0.0, 15.0]] }));
    assert.equal(o.confWhy, 'vision');
    assert.ok(o.conf > SHOWN);

    model = new WorldModel();   // or the ADAS camera lists something there it can't classify
    [o] = last(runFor(3.0, world, { moving, adas: t => [{ id: 3, x: ahead(t) + 1.7, y: 0.0, cls: 'unknown' }] }));
    assert.equal(o.confWhy, 'moving');
    assert.ok(o.conf > SHOWN);
  });

  test('young radar tracks wait to show', () => {
    // radar track 783 on the same drive: a 0.8 s "pedestrian" sprinting across our lane at 50 mph, really its bearing settling
    const snaps = runFor(2.0, { 7: [60.0, 0.0, 2.0, 4.0, 'car'] }, { moving: { 7: 15.0 }, age: t => 8 + Math.floor(t / 0.065) });
    const young = snaps.filter(([t]) => t < 0.8).flatMap(([, objs]) => objs);
    assert.ok(young.length && young.every(o => o.conf < HIDDEN));
    assert.equal(young[young.length - 1].confWhy, 'young');   // classified by then
    assert.equal(last(snaps)[0].confWhy, 'moving');          // past RADAR_MATURE_AGE (1.3 s of radar track)
  });

  test('moving car is trusted without the camera', () => {
    const [o] = last(runFor(3.0, { 6: [40.0, 0.0, 2.0, 4.0, 'car'] }, { moving: { 6: 15.0 } }));
    assert.equal(o.confWhy, 'moving');
    assert.ok(o.conf > SHOWN);
  });

  test('paused replay settles', () => {
    // scrubbed to a moment and paused: an object that came in just before it shows at once, not half faded in
    model.odo.update(0.0, 0.0, 0.0);
    model.add([adasMeasurement(1.0, { id: 4, x: 12.0, y: 0.0, cls: 'car' })]);
    model.step(1.0);
    const [o] = model.step(1.0);
    assert.equal(o.conf, 1.0);
  });
});

/** Ways one car used to become two (or a ghost), found replaying routes 000000b5--bfe13ac451 and 000000b4--d0f733ebb2. */
describe('Fusion fixes', () => {
  let model;
  beforeEach(() => { model = new WorldModel(); });

  /** Standing still, add measure(t) every cycle from t0 to t1; returns [[t, objects]] at each cycle. */
  function cycles(t0, t1, measure, dt = 0.065) {
    const out = [];
    for (let t = t0; t <= t1 + 1e-9; t += dt) {
      model.odo.update(t, 0.0, 0.0);
      model.add(measure(t));
      out.push([t, model.step(t)]);
    }
    return out;
  }

  test('a cycle measured twice is one object', () => {
    // the radar re-sends a cycle now and then, and both copies reach the model with one MeasTime: the second
    // copy mustn't start a track of its own (which would show until merged, or coast on as a ghost)
    const first = model.nextId;
    const snaps = cycles(0.0, 1.5, t => radarMeasurements(t, [radarObj(5, 20.0, 0.0, { cls: 'car', w: 2.0, l: 4.5 }), radarObj(5, 20.0, 0.0, { cls: 'car', w: 2.0, l: 4.5 })], 0.0));
    assert.equal(model.nextId, first + 1);
    assert.equal(snaps[snaps.length - 1][1].length, 1);
  });

  test('track split by a jump is merged back', () => {
    // the radar's point on a car jumps 3.5 m as we come alongside (track 479 on 000000b5--bfe13ac451--12): out of
    // its own track's gate, so it starts a new one, which is the same car
    const see = t => radarMeasurements(t, [radarObj(479, t < 1.0 ? 20.0 : 23.5, 0.0, { cls: 'car', w: 2.0, l: 4.5 })], 0.0);
    const snaps = cycles(0.0, 2.0, see);
    const objs = snaps[snaps.length - 1][1];
    assert.equal(objs.length, 1);
    assert.ok(Math.abs(objs[0].x - 23.5) < 0.5, String(objs[0].x));
  });

  test('lead two that is lead one is dropped', () => {
    const leads = (two, radar = false) => opMeasurements(0.0, {
      leadOne: { present: true, dRel: 30.0, yRel: 0.0, vLead: 10.0, modelProb: 0.9 },
      leadTwo: { present: true, dRel: two, yRel: 0.4, vLead: 10.0, modelProb: 0.8, radar },
    }, 10.0);
    assert.deepEqual(leads(33.0).map(m => m.sid), [0]);            // the model's lead 2 s from now: the same car (000000b4--d0f733ebb2--5)
    assert.deepEqual(leads(55.0).map(m => m.sid), [0, 1]);         // a car beyond it
    assert.deepEqual(leads(33.0, true).map(m => m.sid), [0, 1]);   // another radar track, on a car with a radar in radarState
  });

  test('lost moving car fades and a standing one waits', () => {
    const see = t => (t > 1.5 ? [] : radarMeasurements(t, [   // both stop being reported
      radarObj(1, 20.0 + 8.0 * t, 3.5, { vx: 8.0, cls: 'car', w: 2.0, l: 4.5 }),
      radarObj(2, 30.0, -3.5, { cls: 'car', w: 2.0, l: 4.5 }),
    ], 0.0));
    const snaps = cycles(0.0, 2.6, see);
    const byId = Object.fromEntries(snaps[snaps.length - 1][1].map(o => [o.sources[0].id, o]));
    assert.ok(!(1 in byId) || (byId[1].conf < HIDDEN && byId[1].confWhy === 'coasting'));   // no ghost carrying on at 8 m/s
    assert.ok(byId[2].conf > HIDDEN);                                                        // a parked car the radar lost in a turn
  });
});

describe('Calibration', () => {
  test('sources corrected', () => {
    const m = adasMeasurement(1.0, { id: 1, x: 20.0, y: 2.7, cls: 'car' }, MEASURED_CALIBRATION);
    assert.ok(Math.abs(m.x - (20.0 / 0.80 - 3.7)) < 1e-9 && Math.abs(m.y - 2.0) < 1e-9 && Math.abs(m.t - 0.77) < 1e-9);
    const [r] = radarMeasurements(0.0, [radarObj(1, 50.0, 0.0, { vx: -6.0 })], 0.0, MEASURED_CALIBRATION);
    assert.ok(Math.abs(r.y - 50.0 * Math.sin(0.6 * Math.PI / 180)) < 1e-6 && Math.abs(r.vx + 6.0 * 0.0625 / 0.06) < 0.01);
    const [op] = opMeasurements(0.0, { leadOne: { present: true, dRel: 30.0, yRel: 0.0, vLead: 0.0, modelProb: 0.9 } }, 0.0, MEASURED_CALIBRATION);
    assert.ok(Math.abs(op.x - 30.2) < 1e-9);
    // uncalibrated, every source is taken as it decodes
    assert.equal(adasMeasurement(1.0, { id: 1, x: 20.0, y: 2.7, cls: 'car' }).x, 20.0);
    assert.equal(radarMeasurements(0.0, [radarObj(1, 50.0, 0.0, { vx: -6.0 })], 0.0)[0].vx, -6.0);
  });

  test('switching starts tracks over', () => {
    const model = new WorldModel();
    assert.equal(model.calib, MEASURED_CALIBRATION);
    model.odo.update(0.0, 0.0, 0.0);
    model.add([adasMeasurement(0.5, { id: 4, x: 12.0, y: 0.0, cls: 'car' }, model.calib)]);
    model.step(0.5);
    assert.ok(model.step(0.5).length);
    model.setCalibration(NO_CALIBRATION);
    assert.deepEqual(model.step(0.6), []);
    assert.equal(model.calib.name, 'none');
  });
});
