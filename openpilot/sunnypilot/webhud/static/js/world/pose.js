// Where the car is: the rear axle's pose in a local east/north frame, from the car's own odometry
// (wheel speed and the yaw-rate gyro at CAN rate) corrected by GPS fixes and heading observations.
//
// The odometry is quick but drifts (the wheel speed reads ~3% low, the gyro has a small bias); the
// GPS is accurate but late. Measured on the Fisker (2026-10-05): the telematics box's fixes
// (TBOX_0x526, 10 Hz) and the comma's (gpsLocationExternal) both arrive ~0.2 s after the motion they
// describe, while the TBOX's fused heading (TBOX_0x179) lags the gyro by only 40 ms with a 0.15 deg
// scatter. So each fix is compared with the pose the odometry had 0.2 s ago (kept in a short
// history), and the difference nudges the whole recent track; the heading observations keep the
// gyro's integration from wandering and estimate its bias; the fixes calibrate the wheel speed
// (displacement over a second against distance driven, or a speed the source reports) and, over a
// longer window, the GPS lag itself.
//
// Frame: x east, y north, meters from the origin (the first fix); heading h in radians counter-
// clockwise from east, so the car frame (x forward, y left) keeps its handedness. A compass bearing
// b (clockwise from north) is h = pi/2 - b. Without any fix the pose is plain odometry from (0, 0, 0).

const DEG = Math.PI / 180;
const EARTH_R = 6378137.0;

export const GPS_LAG_S = 0.2;         // how late a fix is, until the estimator has measured it
export const HEADING_LAG_S = 0.04;    // the TBOX heading's (and its velocity's) lag behind the gyro
const HISTORY_S = 2.5;                // poses kept for delayed observations
const GAP_S = 0.5;                    // an odometry gap longer than this restarts the integration in place
const Q_DIST = 0.02;                  // position variance gained per meter driven (m^2/m: ~1.4 m sigma after 100 m)
const Q_YAW = 0.2 * DEG;              // heading noise: gyro noise per sqrt(s)
const Q_BIAS = 0.01 * DEG;            // gyro bias random walk per sqrt(s)
const P_BIAS0 = (0.5 * DEG) ** 2;     // what we assume about the bias before any heading observation
const PH_MIN = (0.05 * DEG) ** 2, PB_MIN = (0.005 * DEG) ** 2;
const R_GPS_DEFAULT = 1.0;            // m, a fix's 1-sigma error when the source doesn't say
const K_MIN = 0.02;                   // a fix always moves the pose a little, so slow biases get tracked
const JUMP_M = 15.0;                  // innovations beyond this are outliers...
const JUMP_COUNT = 3;                 // ...unless this many in a row agree: then the pose restarts there
const SCALE_ALPHA = 0.02;             // wheel-speed scale: per observation, with the car above SCALE_MIN_V
const SCALE_MIN_V = 5.0;              // m/s
const SCALE_RANGE = [0.9, 1.1];
const WINDOW_S = 1.0;                 // displacement window for the scale and the course from the fixes
const WINDOW_TURN = 5.0 * DEG;        // ...only while the heading changed less than this over it
const BIAS_MAX = 1.0 * DEG;           // rad/s
const COURSE_MIN_V = 3.0;             // m/s: GPS course is a heading observation only when moving
const HEADING_SRC_S = 1.0;            // GPS course/bearing stands in once no heading observation came for this long
const COURSE_EVERY_S = 0.5;           // ...at most this often
// The lag is only weakly observable: the fixes' speed (from their spacing) is noisy, so the match against the
// wheel speed is flat within a few percent over +-0.05 s even on a varied drive (measured 2026-10-05: 0.14-0.20 s
// on 30-50 s windows of the same city drive). Hence a long window, an acceptance test on how peaked the match
// is, and slow blending; the nominal 0.2 s is right to within that on both the TBOX and the comma.
const LAG_WINDOW_S = 60.0;            // speed histories kept for the lag estimate
const LAG_EVERY_S = 10.0;             // how often the lag is re-estimated
const LAG_MIN_STD = 1.5;              // m/s of speed variation needed for a usable estimate
const LAG_MIN_PEAK = 1.08;            // worst/best match over the search range: below this the window says nothing
const LAG_RANGE = [0.0, 0.7];
const LAG_STEP = 0.01;
const LAG_ALPHA = 0.15;
const LAG_DEADBAND = 0.02;            // s: a measurement this close to the current lag leaves it alone
const REBASE_M = 20000.0;             // move the origin when the car is this far from it
const EXTRAPOLATE_MAX_S = 0.5;

const wrap = (a) => (((a + Math.PI) % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI) - Math.PI;
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const round = (v, nd) => (v == null ? null : Math.round(v * 10 ** nd) / 10 ** nd);

function bisectRight(a, x) { let lo = 0, hi = a.length; while (lo < hi) { const m = (lo + hi) >> 1; if (x < a[m]) hi = m; else lo = m + 1; } return lo; }

/** Interpolate a series (ts ascending) at t; clamps to the ends. `wrapAngle` interpolates the short way round. */
function interp(ts, vs, t, wrapAngle = false) {
  const n = ts.length;
  if (n === 0) return 0.0;
  if (t <= ts[0]) return vs[0];
  if (t >= ts[n - 1]) return vs[n - 1];
  const i = bisectRight(ts, t);
  const f = (t - ts[i - 1]) / (ts[i] - ts[i - 1]);
  const a = vs[i - 1], b = vs[i];
  return wrapAngle ? a + wrap(b - a) * f : a + (b - a) * f;
}

export class PoseEstimator {
  constructor({ gpsLag = GPS_LAG_S, speedScale = 1.03 } = {}) {
    this.lag0 = gpsLag;
    this.scale0 = speedScale;
    this.seq = 0;   // bumps whenever the origin moves, across resets too, so whoever projects into the frame notices
    this.reset();
  }

  reset() {
    this.t = null;
    this.x = this.y = this.h = 0.0;
    this.v = this.w = 0.0;            // last scaled speed and bias-corrected yaw rate
    this.scale = this.scale0;         // true speed / wheel speed
    this.bias = 0.0;                  // rad/s added to the gyro's reading
    this.p = 1e4;                     // position variance (m^2, isotropic)
    // heading and gyro bias covariance (a two-state Kalman filter rides along the integration)
    this.ph = (90 * DEG) ** 2;        // heading variance (rad^2)
    this.pb = P_BIAS0;                // bias variance ((rad/s)^2)
    this.phb = 0.0;                   // their covariance
    this.lag = this.lag0;
    // history of poses after each odometry step: time, position, heading, scaled speed, distance driven
    this.ts = []; this.xs = []; this.ys = []; this.hs = []; this.vs = []; this.ds = [];
    this.dist = 0.0;
    // GPS
    this.origin = null;               // {lat, lon, cosLat} of the frame's origin (this.seq counts its changes)
    this.fixes = 0;
    this.lastFixT = -1e9;             // fix time (lag removed)
    this.fixHist = [];                // [tFix, e, n] of recent fixes, for displacement over WINDOW_S
    this.outliers = 0;
    this.lastInnov = null;            // m, the last fix's distance from the predicted pose (before correction)
    this.scaleTrack = null;           // the scale the fixes' displacement alone says (diagnostic)
    // heading observations
    this.headingInit = false;
    this.lastHeadingT = -1e9;         // observation time (lag removed)
    this.lastPrimaryT = -1e9;         // ...of the last one from a real heading source
    this.lastCourseT = -1e9;
    this.lastHeadingInnov = null;     // rad
    this.lastSpeedT = -1e9;
    // speed histories for the lag estimate: [t, speed]
    this.gpsSpeeds = [];
    this.canSpeeds = [];
    this.lagNextT = null;
    this.lagMeasured = null;
  }

  // ---- odometry -----------------------------------------------------------------------------------

  /** vRaw: signed wheel speed (m/s, negative in reverse, before any scale), w: yaw rate (rad/s, + = left). */
  predict(t, vRaw, w) {
    const v = vRaw * this.scale, wc = w + this.bias;
    if (this.t !== null) {
      const dt = t - this.t;
      if (dt <= 0) return;
      if (dt < GAP_S) {
        const hm = this.h + 0.5 * wc * dt;
        const ds = v * dt;
        this.x += ds * Math.cos(hm);
        this.y += ds * Math.sin(hm);
        this.h = wrap(this.h + wc * dt);
        this.dist += Math.abs(ds);
        this.p += Q_DIST * Math.abs(ds) + ds * ds * Math.min(this.ph, 1.0);
        // heading += (gyro + bias) dt: the bias uncertainty feeds the heading's
        this.ph += 2 * dt * this.phb + dt * dt * this.pb + Q_YAW * Q_YAW * dt;
        this.phb += dt * this.pb;
        this.pb += Q_BIAS * Q_BIAS * dt;
      } else {
        this.p += 25.0;   // a gap: the car moved we don't know how far
        this.ph += (5 * DEG) ** 2;
      }
    }
    this.t = t; this.v = v; this.w = wc;
    this.ts.push(t); this.xs.push(this.x); this.ys.push(this.y); this.hs.push(this.h); this.vs.push(v); this.ds.push(this.dist);
    if (this.ts.length > 64 && t - this.ts[0] > HISTORY_S) {
      let cut = 0;
      while (cut < this.ts.length - 2 && this.ts[cut] < t - HISTORY_S) cut++;
      this.ts.splice(0, cut); this.xs.splice(0, cut); this.ys.splice(0, cut); this.hs.splice(0, cut); this.vs.splice(0, cut); this.ds.splice(0, cut);
    }
    this.canSpeeds.push([t, Math.abs(v)]);
    while (this.canSpeeds.length && t - this.canSpeeds[0][0] > LAG_WINDOW_S) this.canSpeeds.shift();
    if (this.lagNextT === null) this.lagNextT = t + LAG_EVERY_S;
    else if (t >= this.lagNextT) { this.lagNextT = t + LAG_EVERY_S; this._estimateLag(); }
  }

  /** [x, y, h] the odometry had at t (interpolated; extrapolated briefly past the last step). */
  poseAt(t) {
    const n = this.ts.length;
    if (n === 0) return [this.x, this.y, this.h];
    if (t >= this.ts[n - 1]) {
      const dt = Math.min(t - this.ts[n - 1], EXTRAPOLATE_MAX_S);
      const hm = this.h + 0.5 * this.w * dt;
      return [this.x + this.v * Math.cos(hm) * dt, this.y + this.v * Math.sin(hm) * dt, wrap(this.h + this.w * dt)];
    }
    return [interp(this.ts, this.xs, t), interp(this.ts, this.ys, t), wrap(interp(this.ts, this.hs, t, true))];
  }

  /** Scaled signed speed at t. */
  speedAt(t) { return this.ts.length ? interp(this.ts, this.vs, t) : this.v; }

  /** Scaled distance driven between t0 and t1 (within the history). */
  distanceBetween(t0, t1) { return this.ts.length ? interp(this.ts, this.ds, t1) - interp(this.ts, this.ds, t0) : 0.0; }

  // ---- GPS -----------------------------------------------------------------------------------------

  /** Convert a geodetic point to the frame (equirectangular about the origin; fine for tens of km). */
  toLocal(lat, lon) {
    const o = this.origin;
    return [(lon - o.lon) * DEG * EARTH_R * o.cosLat, (lat - o.lat) * DEG * EARTH_R];
  }

  toGeodetic(x, y) {
    const o = this.origin;
    return [o.lat + y / (DEG * EARTH_R), o.lon + x / (DEG * EARTH_R * o.cosLat)];
  }

  /** A fix received at tRx (describing the position `lag` seconds earlier).
   *  accuracy: horizontal 1-sigma in m when the source reports one; speed (m/s) and bearing (deg,
   *  clockwise from north) when it has them (the comma's); fix: false drops it. */
  gps(tRx, lat, lon, { accuracy = null, speed = null, bearing = null, fix = true, lag = null } = {}) {
    // no fix, or the receiver's placeholders (0/0, and raw 0 = -90/-180 through the TBOX signals' offsets)
    if (!fix || this.t === null || !Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 89.9 || Math.abs(lon) > 179.9
        || (Math.abs(lat) < 1e-4 && Math.abs(lon) < 1e-4)) return;
    const tFix = tRx - (lag ?? this.lag);
    if (tFix <= this.lastFixT) return;
    const r = (accuracy != null && accuracy > 0 ? accuracy : R_GPS_DEFAULT) ** 2;
    if (this.origin === null) this._setOrigin(lat, lon);
    const [e, n] = this.toLocal(lat, lon);
    const [px, py] = this.poseAt(tFix);
    const dx = e - px, dy = n - py;
    const dist = Math.hypot(dx, dy);
    this.lastInnov = dist;
    if (this.fixes > 0 && dist > JUMP_M && this.p < JUMP_M * JUMP_M) {
      if (++this.outliers < JUMP_COUNT) return;   // a glitch, unless it persists
      this.p = 1e4;                                // it did: start over at the fixes
    }
    this.outliers = 0;
    const k = this.fixes === 0 ? 1.0 : Math.max(K_MIN, this.p / (this.p + r));
    this._shift(k * dx, k * dy);
    this.p = Math.max(0.01, (1 - k) * this.p);
    this.fixes++;
    this.lastFixT = tFix;

    // the fixes' own speed (for the lag estimate): over the last three fixes, stamped at the middle one's receive time
    const nh = this.fixHist.length;
    if (nh >= 2) {
      const prev = this.fixHist[nh - 2];
      const dt = tFix - prev[0];
      if (dt > 0.1 && dt < 1.5) {
        this.gpsSpeeds.push([tRx - dt / 2, Math.hypot(e - prev[1], n - prev[2]) / dt]);
        while (this.gpsSpeeds.length && tRx - this.gpsSpeeds[0][0] > LAG_WINDOW_S) this.gpsSpeeds.shift();
      }
    }
    this.fixHist.push([tFix, e, n]);
    while (this.fixHist.length && tFix - this.fixHist[0][0] > WINDOW_S + 0.25) this.fixHist.shift();

    // the wheel-speed scale: a reported speed, else the displacement over the last second against the distance
    // driven (only on a straight stretch, where displacement is distance); the course over the same window
    // is a heading observation when nothing better reports one
    const vCan = Math.abs(this.speedAt(tFix));
    if (speed != null && speed > SCALE_MIN_V && vCan > SCALE_MIN_V) this._observeScale(speed / (vCan / this.scale));
    const first = this.fixHist.find(f => tFix - f[0] >= WINDOW_S * 0.8);
    if (first !== undefined && first[0] < tFix) {
      const d = Math.hypot(e - first[1], n - first[2]);
      const driven = this.distanceBetween(first[0], tFix);
      const turned = Math.abs(wrap(this.poseAt(tFix)[2] - this.poseAt(first[0])[2]));
      if (turned < WINDOW_TURN && driven > SCALE_MIN_V * WINDOW_S * 0.8) {
        const ratio = d / (driven / this.scale);
        this.scaleTrack = this.scaleTrack === null ? ratio : this.scaleTrack + SCALE_ALPHA * (ratio - this.scaleTrack);
        if (speed == null) this._observeScale(ratio);
        if (tFix - this.lastPrimaryT > HEADING_SRC_S && tFix - this.lastCourseT >= COURSE_EVERY_S && d / (tFix - first[0]) > COURSE_MIN_V) {
          const course = bearing != null && bearing >= 0 ? Math.PI / 2 - bearing * DEG : Math.atan2(n - first[2], e - first[1]);
          // the displacement's direction is the heading midway through the window
          this.lastCourseT = tFix;
          this._observeHeading(bearing != null ? tFix : (tFix + first[0]) / 2, course, 2.0 * DEG, false);
        }
      }
    }
    if (Math.hypot(this.x, this.y) > REBASE_M) this._rebase();
  }

  /** A speed the GPS/INS reports (m/s, forward), received at tRx: calibrates the wheel speed. */
  speedObs(tRx, speed, { lag = HEADING_LAG_S } = {}) {
    if (this.t === null || speed == null || tRx <= this.lastSpeedT) return;
    this.lastSpeedT = tRx;
    const vCan = Math.abs(this.speedAt(tRx - lag));
    if (Math.abs(speed) > SCALE_MIN_V && vCan > SCALE_MIN_V) this._observeScale(Math.abs(speed) / (vCan / this.scale));
  }

  _observeScale(ratio) {
    if (!Number.isFinite(ratio)) return;
    this.scale = clamp(this.scale + SCALE_ALPHA * (ratio - this.scale), SCALE_RANGE[0], SCALE_RANGE[1]);
  }

  /** A heading observation (deg, compass bearing clockwise from north) made at tObs, with its 1-sigma in deg. */
  heading(tObs, bearingDeg, stdDeg = 0.5, { lag = HEADING_LAG_S } = {}) {
    if (this.t === null || bearingDeg == null) return;
    this._observeHeading(tObs - lag, Math.PI / 2 - bearingDeg * DEG, Math.max(stdDeg, 0.05) * DEG, true);
  }

  /** Kalman update of (heading, gyro bias) with a heading measured at tO (innovation against the heading the
   *  track had then; the correction is applied to the whole recent track). */
  _observeHeading(tO, hObs, sigma, primary) {
    if (tO <= this.lastHeadingT) return;
    const hPred = this.poseAt(tO)[2];
    const e = wrap(hObs - hPred);
    this.lastHeadingInnov = e;
    if (!this.headingInit) {   // the first observation sets the heading outright
      this._rotate(e);
      this.ph = sigma * sigma; this.phb = 0.0;
    } else {
      const S = this.ph + sigma * sigma;
      const k0 = this.ph / S, k1 = this.phb / S;
      this._rotate(k0 * e);
      this.bias = clamp(this.bias + k1 * e, -BIAS_MAX, BIAS_MAX);
      this.pb = Math.max(PB_MIN, this.pb - k1 * this.phb);
      this.phb *= (1 - k0);
      this.ph = Math.max(PH_MIN, (1 - k0) * this.ph);
    }
    this.headingInit = true;
    this.lastHeadingT = tO;
    if (primary) this.lastPrimaryT = tO;
  }

  // ---- corrections applied to the whole recent track ---------------------------------------------

  _shift(dx, dy) {
    this.x += dx; this.y += dy;
    const xs = this.xs, ys = this.ys;
    for (let i = 0; i < xs.length; i++) { xs[i] += dx; ys[i] += dy; }
  }

  _rotate(dh) {
    this.h = wrap(this.h + dh);
    const hs = this.hs;
    for (let i = 0; i < hs.length; i++) hs[i] = wrap(hs[i] + dh);
  }

  _setOrigin(lat, lon) {
    this.origin = { lat, lon, cosLat: Math.cos(lat * DEG) };
    this.seq++;
  }

  _rebase() {
    const [lat, lon] = this.toGeodetic(this.x, this.y);
    const dx = -this.x, dy = -this.y;
    this._setOrigin(lat, lon);
    this._shift(dx, dy);
    for (const f of this.fixHist) { f[1] += dx; f[2] += dy; }
  }

  // ---- the GPS lag, from the speeds -----------------------------------------------------------------

  /** The lag that best lines the fixes' speed up with the wheel speed, over the last LAG_WINDOW_S. */
  _estimateLag() {
    const g = this.gpsSpeeds, c = this.canSpeeds;
    if (g.length < 50 || c.length < 100) return;
    const mean = g.reduce((s, x) => s + x[1], 0) / g.length;
    const std = Math.sqrt(g.reduce((s, x) => s + (x[1] - mean) ** 2, 0) / g.length);
    if (std < LAG_MIN_STD) return;
    const cts = c.map(x => x[0]), cvs = c.map(x => x[1]);
    const lags = [], costs = [];
    for (let L = LAG_RANGE[0]; L <= LAG_RANGE[1] + 1e-9; L += LAG_STEP) {
      let s = 0;
      for (const [tMid, sp] of g) { const d = sp - interp(cts, cvs, tMid - L); s += d * d; }
      lags.push(L); costs.push(s);
    }
    let i = 0, worst = 0;
    for (let j = 1; j < costs.length; j++) { if (costs[j] < costs[i]) i = j; if (costs[j] > costs[worst]) worst = j; }
    if (costs[worst] < LAG_MIN_PEAK * costs[i]) return;   // too flat to tell
    let L = lags[i];
    if (i > 0 && i < costs.length - 1) {   // the minimum of the parabola through the three lowest points
      const a = costs[i - 1], b = costs[i], c2 = costs[i + 1], den = a - 2 * b + c2;
      if (den > 0) L += LAG_STEP * 0.5 * (a - c2) / den;
    }
    this.lagMeasured = L;
    if (Math.abs(L - this.lag) > LAG_DEADBAND) this.lag += LAG_ALPHA * (L - this.lag);
  }

  // ---- output -----------------------------------------------------------------------------------------

  /** The pose at `now` (briefly extrapolated), for the snapshot. */
  state(now = null) {
    now = now == null ? this.t : now;
    if (this.t === null || now == null) return null;
    const [x, y, h] = this.poseAt(now);
    const gpsAge = this.fixes ? now - this.lastFixT : null;
    const headingAge = this.headingInit ? now - this.lastHeadingT : null;
    let geo = null;
    if (this.origin) geo = this.toGeodetic(x, y);
    return {
      x: round(x, 2), y: round(y, 2), h: round(h, 4),
      lat: geo ? round(geo[0], 7) : null, lon: geo ? round(geo[1], 7) : null,
      v: round(this.v, 2), w: round(this.w, 4),
      speedScale: round(this.scale, 4), gyroBias: round(this.bias / DEG, 3),
      gpsAge: round(gpsAge, 2), gpsLag: round(this.lag, 2), headingAge: round(headingAge, 2),
      sigma: round(Math.sqrt(this.p), 2), sigmaH: round(Math.sqrt(this.ph) / DEG, 2),
      quality: gpsAge === null ? 'none' : gpsAge < 2.0 ? 'gps' : gpsAge < 30.0 ? 'dr' : 'stale',
      origin: this.origin ? { lat: this.origin.lat, lon: this.origin.lon, seq: this.seq } : null,
    };
  }
}
