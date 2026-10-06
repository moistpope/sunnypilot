import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { GPS_LAG_S, HEADING_LAG_S, PoseEstimator } from '../pose.js';
import { rng } from './helpers.js';

const DEG = Math.PI / 180;
const R = 6378137.0;
const LAT0 = 33.97, LON0 = -83.40;
const wrap = (a) => (((a + Math.PI) % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI) - Math.PI;
const pct = (arr, q) => { const s = [...arr].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(q * s.length))]; };

/** A drive with straights, left and right turns, speeding up and slowing down: speed (m/s) and yaw rate (rad/s) at t. */
function profile(t) {
  const v = 12 + 8 * Math.sin(t * 0.4);
  const u = t % 20;
  const w = u < 6 ? 0 : u < 10 ? 0.25 : u < 15 ? -0.15 : 0;
  return [v, w];
}

const toGeo = (x, y) => [LAT0 + y / (DEG * R), LON0 + x / (DEG * R * Math.cos(LAT0 * DEG))];

/** Run the estimator on CAN odometry with a wheel-speed scale error and a gyro bias, GPS fixes that arrive
 *  `lag` late with noise, and (optionally) heading observations 40 ms late. Returns the errors after warm-up. */
function simulate({ T = 100, lag = GPS_LAG_S, scaleErr = 1.03, bias = 0.2 * DEG, headingObs = true, gpsNoise = 0.3, headingNoise = 0.15 * DEG,
                    warm = 30, seed = 3, estimator = null, tamper = null } = {}) {
  const rand = rng(seed);
  const gauss = () => (rand() + rand() + rand() - 1.5) * 2;   // ~N(0, 1)
  const est = estimator || new PoseEstimator({ gpsLag: GPS_LAG_S, speedScale: 1.0 });
  const dt = 0.01;
  let x = 0, y = 0, h = 0.3;
  const pending = [];   // observations waiting for their receive time
  const posErr = [], hdgErr = [];
  let nextObs = 0;
  for (let i = 0; i * dt <= T; i++) {
    const t = i * dt;
    const [v, w] = profile(t);
    // truth
    const hm = h + 0.5 * w * dt;
    x += v * Math.cos(hm) * dt; y += v * Math.sin(hm) * dt; h = wrap(h + w * dt);
    // what the car reports: the wheel speed reads low, the gyro reads low by the bias
    est.predict(t, v / scaleErr, w - bias);
    if (t >= nextObs) {
      nextObs += 0.1;
      const [lat, lon] = toGeo(x + gpsNoise * gauss(), y + gpsNoise * gauss());
      pending.push([t + lag, 'gps', lat, lon]);
      if (headingObs) pending.push([t + HEADING_LAG_S, 'hdg', 90 - (h + headingNoise * gauss()) / DEG]);
    }
    pending.sort((a, b) => a[0] - b[0]);
    while (pending.length && pending[0][0] <= t + 1e-9) {
      const o = pending.shift();
      if (o[1] === 'gps') {
        if (tamper && tamper(t, o)) continue;
        est.gps(o[0], o[2], o[3]);
      } else est.heading(o[0], o[2], 0.15);
    }
    if (t > warm && i % 10 === 0 && est.origin) {
      const [tx, ty] = est.toLocal(...toGeo(x, y));
      const [ex, ey, eh] = est.poseAt(t);
      posErr.push(Math.hypot(ex - tx, ey - ty));
      hdgErr.push(Math.abs(wrap(eh - h)) / DEG);
    }
  }
  return { est, posErr, hdgErr };
}

describe('PoseEstimator', () => {
  test('tracks a laggy GPS with heading observations: position, heading, speed scale, gyro bias and lag', () => {
    const { est, posErr, hdgErr } = simulate({});
    assert.ok(pct(posErr, 0.9) < 0.6, `position p90 ${pct(posErr, 0.9)}`);
    assert.ok(pct(hdgErr, 0.9) < 0.5, `heading p90 ${pct(hdgErr, 0.9)}`);
    assert.ok(Math.abs(est.scale - 1.03) < 0.006, `scale ${est.scale}`);
    assert.ok(Math.abs(est.bias - 0.2 * DEG) < 0.06 * DEG, `bias ${est.bias / DEG} deg/s`);
    assert.ok(est.lagMeasured !== null && Math.abs(est.lagMeasured - GPS_LAG_S) <= 0.04, `lag ${est.lagMeasured}`);
  });

  test('finds the lag when it differs from the assumed one', () => {
    const { est, posErr } = simulate({ lag: 0.32, T: 150, warm: 90 });
    assert.ok(Math.abs(est.lag - 0.32) < 0.06, `lag ${est.lag}`);
    assert.ok(pct(posErr, 0.9) < 1.2, `position p90 ${pct(posErr, 0.9)}`);
  });

  test('without a heading source the GPS course steers the heading (meter-level, not lane-level)', () => {
    const { est, posErr, hdgErr } = simulate({ headingObs: false });
    assert.ok(pct(posErr, 0.9) < 2.0, `position p90 ${pct(posErr, 0.9)}`);
    assert.ok(pct(hdgErr, 0.9) < 3.0, `heading p90 ${pct(hdgErr, 0.9)}`);
    assert.ok(Math.abs(est.bias - 0.2 * DEG) < 0.1 * DEG, `bias ${est.bias / DEG} deg/s`);
  });

  test('a lone fix far off is ignored; three in a row move the pose', () => {
    let far = 0;
    const tamper = (t, o) => {
      if (t > 50.05 && t < 50.25) { o[2] += 100 / (DEG * R); far++; }   // 100 m north, two fixes
      return false;
    };
    const { posErr } = simulate({ tamper, warm: 30, T: 60 });
    assert.equal(far, 2);
    assert.ok(pct(posErr, 0.99) < 1.0, `position p99 ${pct(posErr, 0.99)}`);

    const est = new PoseEstimator();
    for (let i = 0; i <= 500; i++) est.predict(i * 0.01, 10, 0);
    for (let i = 0; i < 5; i++) est.gps(5 + i * 0.1, LAT0, LON0 + (i * 1.0) / (DEG * R * Math.cos(LAT0 * DEG)));
    const before = est.poseAt(5.5);
    for (let i = 0; i < 3; i++) est.gps(5.6 + i * 0.1, LAT0 + 200 / (DEG * R), LON0);
    const after = est.poseAt(5.9);
    assert.ok(Math.hypot(after[0] - before[0], after[1] - before[1]) > 150, 'restarted at the new fixes');
  });

  test('state: no fix is plain odometry, then east/north with lat/lon round trip', () => {
    const est = new PoseEstimator({ speedScale: 1.0 });
    assert.equal(est.state(), null);
    for (let i = 0; i <= 100; i++) est.predict(i * 0.01, 10, 0);
    let s = est.state(1.0);
    assert.equal(s.quality, 'none');
    assert.equal(s.lat, null);
    assert.ok(Math.abs(s.x - 10) < 0.01 && Math.abs(s.y) < 0.01);
    est.gps(1.0, LAT0, LON0);   // describes t = 0.8: the car was 8 m along then
    s = est.state(1.0);
    assert.equal(s.quality, 'gps');
    assert.equal(s.origin.seq, 1);
    assert.ok(Math.abs(s.x - 2.0) < 0.05 && Math.abs(s.y) < 0.05, `${s.x}, ${s.y}`);   // 2 m past the fix
    const [e, n] = est.toLocal(s.lat, s.lon);
    assert.ok(Math.abs(e - s.x) < 0.02 && Math.abs(n - s.y) < 0.02);
    assert.equal(s.gpsLag, GPS_LAG_S);
  });

  test('heading observations are compass bearings: north is +y', () => {
    const est = new PoseEstimator({ speedScale: 1.0 });
    est.predict(0, 0, 0);
    est.heading(0.1, 0.0, 0.1);   // facing north
    est.gps(0.2, LAT0, LON0);   // describes t = 0: the origin is where the car stood
    for (let i = 1; i <= 100; i++) est.predict(0.2 + i * 0.01, 10, 0);   // 10 m/s from t = 0 (the first step spans 0..0.21)
    const s = est.state(1.2);
    assert.ok(Math.abs(s.x) < 0.05 && Math.abs(s.y - 12) < 0.05, `${s.x}, ${s.y}`);
    assert.ok(Math.abs(s.h - Math.PI / 2) < 1e-3);
  });
});

describe('the shown pose', () => {
  /** Straight east at 10 m/s on odometry, GPS fixes 0.2 s late; from `shiftAt` on, the fixes sit `dy` m north of the odometry. */
  function run(T, shiftAt, dy, onStep) {
    const est = new PoseEstimator({ gpsLag: GPS_LAG_S, speedScale: 1.0 });
    const dt = 0.01;
    for (let i = 0; i * dt <= T + 1e-9; i++) {
      const t = i * dt;
      est.predict(t, 10, 0);
      if (i % 10 === 0 && t >= 0.2) {
        const tFix = t - 0.2, [lat, lon] = toGeo(10 * tFix, tFix >= shiftAt ? dy : 0);
        est.gps(t, lat, lon);
        est.heading(t, 90, 0.2);
      }
      if (onStep) onStep(t, { ...est.state(t), raw: est.shownAt(t) });
    }
    return est;
  }

  test('the first fix and heading place it outright; afterwards it follows the estimate slowly and never steps', () => {
    let prev = null, maxStep = 0, snapsAfter = 0;
    const est = run(60, 20, 2.0, (t, st) => {
      if (prev && t > 1) {
        // the shown pose's sideways move per step (the car drives straight east: all of it is correction)
        const dx = st.raw[0] - prev.raw[0], dy = st.raw[1] - prev.raw[1];
        const lateral = Math.abs(-Math.sin(st.raw[2]) * dx + Math.cos(st.raw[2]) * dy);
        maxStep = Math.max(maxStep, lateral);
        if (st.snaps !== prev.snaps) snapsAfter++;
      }
      prev = st;
    });
    assert.equal(snapsAfter, 0, 'no snaps once running');
    assert.ok(est.snaps >= 1 && est.snaps <= 3, String(est.snaps));
    // per 10 ms step at 10 m/s the sideways move stays under the rate (0.05 + 0.02 * 10 = 0.25 m/s)
    assert.ok(maxStep < 0.25 * 0.01 * 1.05, String(maxStep));   // (a hair over the cap: the heading correction's share)
    // the estimate took the 2 m, and the shown pose got there too, by the end
    const st = est.state(60);
    assert.ok(Math.abs(st.est.y - 2.0) < 0.3, String(st.est.y));
    assert.ok(Math.abs(st.y - 2.0) < 0.3, String(st.y));
    assert.ok(Math.abs(st.offset.left) < 0.3);
  });

  test('right after the fixes move, the shown pose trails the estimate; the trail closes within seconds', () => {
    const trail = [];
    run(40, 20, 2.0, (t, st) => { if (Math.abs(t - 21) < 0.006 || Math.abs(t - 35) < 0.006) trail.push([t, st.offset.left, st.est.y - st.y]); });
    assert.ok(Math.abs(trail[0][2]) > 0.02, `trails right after: ${trail[0]}`);
    assert.ok(Math.abs(trail[1][2]) < Math.abs(trail[0][2]) / 2, `closes: ${trail[1]} vs ${trail[0]}`);
  });
});
