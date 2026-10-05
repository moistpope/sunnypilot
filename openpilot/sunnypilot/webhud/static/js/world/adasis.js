// The head unit's ADASIS v2 map horizon, rebuilt from its messages on the bus: the car's position on the
// navigation map (ICC_0x361 POSITION), the road ahead in segments (0x250 SEGMENT: class, form of way,
// lanes, speed limit), the roads leaving it (0x251 STUB: offset, turn angle, probability), short profiles
// (0x255: curvature, slope) and long ones (0x252: traffic signs), plus 0x362 META. Each message carries one
// item for one *path* (the most probable road ahead is path 8; stubs open others) at an *offset* along it;
// the position message says which path the car is on and how far along. The items for a path accumulate
// here, keyed by offset, and fall away once passed; the state is everything ahead on the current path with
// offsets re-based to the car. The head unit sends all this whether or not a route is set.
//
// Why keep it: it is the car's own answer to "what road, how far along, what's ahead", from its own map
// and position, at 10 Hz with ~150 ms age (measured 2026-10-05). The HUD's own OSM match (mapmatch.js) is
// the primary source; this is the cross-check and the fallback where no OSM tiles are loaded.
export const ADASIS_MSGS = new Set([0x361, 0x250, 0x251, 0x255, 0x252, 0x362]);

const INVALID_OFFSET = 8191;
const KEEP_BEHIND = 50;        // m of passed items kept
const PATH_TTL_S = 10.0;       // a path nothing has mentioned for this long is dropped
const STALE_S = 2.0;           // no position message for this long: no horizon
const PROFILE_INVALID = 1023;
const PROFILE_CURVATURE = 1, PROFILE_SLOPE_STEP = 3, PROFILE_SLOPE_LINEAR = 4;

/** ADASIS v2 curvature profile value (0..1022, 511 = straight, above = to the right) to 1/m, + = left.
 *  Fitted on 2026-10-05 against the car's own yaw rate / speed over two drives (k doubles about every 59 steps);
 *  the spec's own table should replace this once at hand. */
export function curvatureOf(value) {
  if (value == null || value >= PROFILE_INVALID) return null;
  const n = value - 511;
  if (n === 0) return 0.0;
  return -Math.sign(n) * 4.25e-4 * Math.exp(0.0117 * Math.abs(n));
}

const r = (v, nd = 1) => (v == null ? null : Math.round(v * 10 ** nd) / 10 ** nd);
const int = (v) => (v == null ? null : Math.trunc(v));

export class AdasisHorizon {
  constructor() { this.reset(); }

  reset() {
    this.paths = new Map();   // path index -> {t, segments: Map(offset), stubs: Map(key), profiles: Map(type -> Map(offset)), signs: Map(offset)}
    this.pos = null;
    this.posT = -1e9;
    this.meta = null;
    this.counts = { position: 0, segment: 0, stub: 0, profile: 0, sign: 0 };
  }

  _path(idx, t) {
    let p = this.paths.get(idx);
    if (!p) { p = { t, segments: new Map(), stubs: new Map(), profiles: new Map(), signs: new Map() }; this.paths.set(idx, p); }
    p.t = t;
    return p;
  }

  /** v: the message's decoded signals, received at t. */
  feed(addr, v, t) {
    if (addr === 0x361) {
      const offset = v.ICC_PosnOffset;
      if (offset == null || offset >= INVALID_OFFSET) return;
      const rehead = v.ICC_PosnRehead ?? 0;   // deg, 0 = along the path, growing to the right
      this.pos = {
        path: int(v.ICC_PosnPathldx), offset, prob: r(v.ICC_PosnPosProbb, 0), age: r((v.ICC_PosnAge ?? 0) / 1000, 3),
        speed: r(v.ICC_PosnSpd, 1), relHeading: r(-(((rehead + 180) % 360 + 360) % 360 - 180), 1),   // + = left of the path
        lane: int(v.ICC_PosnCurLane), conf: int(v.ICC_PosnPosConfdc),
      };
      this.posT = t;
      this.counts.position++;
      this._path(this.pos.path, t);
      this._purge(t);
    } else if (addr === 0x250) {
      const offset = v.ICC_SegOffset;
      if (offset == null || offset >= INVALID_OFFSET) return;
      const p = this._path(int(v.ICC_SegPathIdx), t);
      p.segments.set(offset, {
        offset, frc: int(v.ICC_SegFuncRoadClass), formOfWay: int(v.ICC_SegFormOfWay), lanes: int(v.ICC_SegNumOfLaneDrvDir), lanesOpp: int(v.ICC_SegNumOfLaneOppDir),
        divided: int(v.ICC_SegDividedRoad), bridge: int(v.ICC_SegBridge), tunnel: int(v.ICC_SegTunnel), builtUp: int(v.ICC_SegBuildUpArea),
        speedLimitClass: int(v.ICC_SegEffSpdLmt), speedLimitType: int(v.ICC_SegEffSpdLmtType), complex: int(v.ICC_SegCmplxInsct),
        onRoute: int(v.ICC_SegPartOfCalcRoute), prob: r(v.ICC_SegRelProbb, 0),
      });
      this.counts.segment++;
    } else if (addr === 0x251) {
      const offset = v.ICC_StubOffset;
      if (offset == null || offset >= INVALID_OFFSET) return;
      const p = this._path(int(v.ICC_StubPathIdx), t);
      const sub = int(v.ICC_StubStubPathIdx);
      p.stubs.set(`${offset}:${sub}:${r(v.ICC_StubTurnAngl, 0)}`, {
        offset, path: sub, turnAngle: r(v.ICC_StubTurnAngl, 1), prob: r(v.ICC_StubRelProbb, 0), frc: int(v.ICC_StubFuncRoadClass), formOfWay: int(v.ICC_StubFormOfWay),
        lanes: int(v.ICC_StubNumOfLaneDrvDir), lanesOpp: int(v.ICC_StubNumOfLaneOppDir), rightOfWay: int(v.ICC_StubRtOfWay), complex: int(v.ICC_StubCmplxInsct),
        onRoute: int(v.ICC_StubPartOfCalcRout), last: int(v.ICC_StubLastStub),
      });
      this.counts.stub++;
    } else if (addr === 0x255) {
      const offset = v.ICC_ProfShortOffset;
      if (offset == null || offset >= INVALID_OFFSET) return;
      const p = this._path(int(v.ICC_ProfShortPathIdx), t);
      const type = int(v.ICC_ProfShortProfType);
      let prof = p.profiles.get(type);
      if (!prof) { prof = new Map(); p.profiles.set(type, prof); }
      const acc = int(v.ICC_ProfShortAccurClass);
      if (v.ICC_ProfShortValue0 != null && v.ICC_ProfShortValue0 < PROFILE_INVALID) prof.set(offset, { offset, value: v.ICC_ProfShortValue0, acc });
      const d1 = v.ICC_ProfShortDist1;
      if (d1 && d1 < 1023 && v.ICC_ProfShortValue1 != null && v.ICC_ProfShortValue1 < PROFILE_INVALID) prof.set(offset + d1, { offset: offset + d1, value: v.ICC_ProfShortValue1, acc });
      this.counts.profile++;
    } else if (addr === 0x252) {
      const offset = v.ICC_ProfLongOffset;
      if (offset == null || offset >= INVALID_OFFSET) return;
      const p = this._path(int(v.ICC_ProfLongPathIdx), t);
      p.signs.set(`${offset}:${int(v.ICC_ProfLongSignType)}`, {
        offset, type: int(v.ICC_ProfLongProfType), signType: int(v.ICC_ProfLongSignType), value: int(v.ICC_ProfLongSignValue), lane: int(v.ICC_ProfLongSignLane),
        location: int(v.ICC_ProfLongSignLocation), timeSpec: int(v.ICC_ProfLongSignTimeSpec), vehSpec: int(v.ICC_ProfLongSignVehSpec), condition: int(v.ICC_ProfLongSignCondition),
      });
      this.counts.sign++;
    } else if (addr === 0x362) {
      this.meta = { country: int(v.ICC_MetaCountryCode), region: int(v.ICC_MetaRegionCode) };
    }
  }

  /** Drop what's behind the car on its path, and paths nobody mentions any more. */
  _purge(t) {
    for (const [idx, p] of this.paths) if (t - p.t > PATH_TTL_S && idx !== (this.pos && this.pos.path)) this.paths.delete(idx);
    const p = this.pos && this.paths.get(this.pos.path);
    if (!p) return;
    const cut = this.pos.offset - KEEP_BEHIND;
    for (const [k, s] of p.segments) if (s.offset < cut) p.segments.delete(k);
    for (const [k, s] of p.stubs) if (s.offset < cut) p.stubs.delete(k);
    for (const prof of p.profiles.values()) for (const [k, s] of prof) if (s.offset < cut) prof.delete(k);
    for (const [k, s] of p.signs) if (s.offset < cut) p.signs.delete(k);
  }

  /** The horizon on the current path, offsets re-based to the car (`ahead`, m), or null without a fresh position. */
  state(now) {
    if (!this.pos || now - this.posT > STALE_S) return null;
    const p = this.paths.get(this.pos.path);
    const o = this.pos.offset;
    const ahead = (items, map = (x) => x) => [...items].map(s => ({ ahead: s.offset - o, ...map(s) })).sort((a, b) => a.ahead - b.ahead);
    const strip = ({ offset, ...rest }) => rest;
    const curv = p && p.profiles.get(PROFILE_CURVATURE), slope = p && (p.profiles.get(PROFILE_SLOPE_LINEAR) || p.profiles.get(PROFILE_SLOPE_STEP));
    return {
      position: { ...this.pos, since: r(now - this.posT, 2) },
      segments: p ? ahead(p.segments.values(), strip) : [],
      stubs: p ? ahead(p.stubs.values(), strip) : [],
      curvature: curv ? ahead(curv.values(), (s) => ({ value: s.value, k: r(curvatureOf(s.value), 5) })) : [],
      slope: slope ? ahead(slope.values(), (s) => ({ value: s.value })) : [],
      signs: p ? ahead(p.signs.values(), strip) : [],
      meta: this.meta,
      counts: { ...this.counts },
    };
  }
}
