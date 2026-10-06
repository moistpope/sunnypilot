// Which road the car is on, and the road ahead: the pose estimator's position and heading matched onto the
// OSM ways around it (mapdata.js), with some memory so the match doesn't flicker between a road and the one
// crossing it, and a *horizon*: the centerline ahead for ~500 m, followed from way to way along the most
// likely continuation (same ref or name, then the smallest turn), with the roads branching off it. Runs in
// the worker once per snapshot.
//
// The match is meant for a HUD, not for navigation: GPS and OSM centerlines are both meter-level, so it says
// which road and roughly where along it, never which lane (the camera's lane model keeps that job).
// Coordinates are the pose estimator's frame: x east, y north in meters, heading counter-clockwise from east.

const DEG = Math.PI / 180;
const SEARCH_M = 40;              // candidate segments this close to the car
const SIGMA_D = 5.0;              // m: how far the car may be from a centerline (multi-lane one-way roads are wide)
const SIGMA_H = 20 * DEG;         // heading agreement, moving
const SIGMA_H_SLOW = 45 * DEG;    // ...below SLOW_V, where the heading is less certain
const SLOW_V = 3.0;               // m/s
const MAX_DH = 70 * DEG;          // candidates turned further than this from the car's heading are out
const PRIOR = 2.0;                // score bonus for staying on the current way (or moving onto one it leads to)
const SWITCH_TICKS = 16;          // a better way must win this many snapshots in a row to take over...
const SWITCH_MARGIN = 0.5;        // ...by at least this much
const END_M = 6.0;                // ...unless the current way ends within this: then the way it leads into takes over at once
const COAST_S = 3.0;              // keep the match this long when no road is near (a slow sharp turn, a parking lot's edge)
const BRANCH_M = 60;              // m of each branching road's geometry carried along
const BRANCH_POINTS = 8;
const HORIZON_M = 500;            // ahead
const BEHIND_M = 60;
const MAX_HOPS = 8;
const MAX_POINTS = 80;
const UTURN = 150 * DEG;          // a continuation turning this much is not one
const CONTINUE_MAX = 55 * DEG;    // at a junction, a way turning more than this is a branch, never the continuation: the
                                  // horizon ends there rather than guess a turn (the nav's turn-by-turn may decide later)...
const BEND_MAX = 110 * DEG;       // ...unless it is the only way on (a bend of the road, which OSM may split into two ways)
                                  // or carries the same name or ref (the road itself turning a corner): then any turn short of a U-turn
const SAME_NAME_BONUS = 35;       // deg-equivalents off a continuation's cost for keeping the ref or name
const CLASS_DROP_COST = 12;       // ...and on, per class level the road drops (trunk -> residential is not a continuation)
const LOOP_WINDOW_M = 200, LOOP_TURN = 135 * DEG;   // the horizon stops where the road has turned this much within the window
// The road behind the car is the path it drove (a trail of matched points), so after a turn it runs back round the
// corner rather than along the new way's own geometry (which may not exist behind the junction)
const TRAIL_STEP_M = 3, TRAIL_M = 80;
const TOUCH_M = 60;               // a switch onto a way sharing a node this near is a turn, and keeps the trail
// The car turning at the first junction ahead: its indicator, else its yaw rate, says onto which branch, and the
// horizon bends onto it before the matcher has moved there -- so the road doesn't end at the node mid-turn
const TURN_M = 45;                // the junction must be within this
const TURN_W = 0.12;              // rad/s of yaw that counts as turning
const TURN_LOOKAHEAD_S = 1.5;     // the heading the car will have this much later picks the branch
const TURN_MATCH = 55 * DEG;      // ...if one lies within this of it
const TURN_MIN = 25 * DEG;        // a branch turning less than this isn't a turn
const TURN_HOLD_S = 2.0;          // a choice made is kept this long (the indicator cancels, the yaw eases)
const INDICATE_MAX_V = 15.0;      // m/s: above this an indicator alone (no yaw yet) means a lane change, not a turn
const END_TURN_MIN = 30 * DEG;    // a continuation turning more than this at our road's end gets its corner rounded like an arm's

const wrap = (a) => (((a + Math.PI) % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI) - Math.PI;
const r1 = (v) => Math.round(v * 10) / 10;
// the road hierarchy: motorway/trunk 0, primary 1, secondary 2, tertiary 3, unclassified/residential/living 4; links as their road
const RANK = { motorway: 0, motorway_link: 0, trunk: 0, trunk_link: 0, primary: 1, primary_link: 1, secondary: 2, secondary_link: 2, tertiary: 3, tertiary_link: 3, unclassified: 4, residential: 4, living_street: 4 };
const rank = (way) => RANK[way.className] ?? 4;

export class MapMatcher {
  constructor(mapData) {
    this.md = mapData;
    this.reset();
  }

  reset() {
    this.cur = null;          // {tileKey, wi, dir}
    this.curT = -1e9;         // when it was last confirmed
    this.challenger = null;   // {tileKey, wi, dir, ticks}
    this.result = null;
    this.trail = [];          // [x, y] matched points driven, oldest first (TRAIL_*)
    this.ctx = { h: 0, v: 0, w: 0, turn: 0, now: 0 };
    this.turnPick = null;     // {key, until}: the branch the car was judged to be turning onto
    this.passed = new Map();  // branches seen ahead, kept while the junction is within BEHIND_M behind the car
    this.prevAhead = [];      // the horizon's first nodes ahead at the last update: passed ones go into the trail
  }

  /** pose: [x, y, h] (unrounded), v: speed m/s, now: snapshot time; opts.w: yaw rate (rad/s, + left), opts.turn: the
   *  indicator (+1 left, -1 right, 0 none). Returns the match (also kept in .result) or null. */
  update(pose, v, now, opts = {}) {
    const [x, y, h] = pose;
    const md = this.md;
    this.ctx = { h, v, w: opts.w || 0, turn: opts.turn || 0, now };
    const cands = this._candidates(x, y, h, v);
    let best = null;
    for (const c of cands) if (best === null || c.score < best.score) best = c;
    let chosen = null;
    if (best !== null) {
      const curC = this.cur ? cands.find(c => c.tileKey === this.cur.tileKey && c.wi === this.cur.wi) : undefined;
      if (curC !== undefined && best === curC) {
        chosen = best;
        this.challenger = null;
      } else if (curC === undefined) {
        chosen = best;   // the current way is out of reach: take the best at once
        this.challenger = null;
      } else if (best.connected && this._remaining(curC) < END_M) {
        chosen = best;   // the current way ends here and leads into this one: carry on
        this.challenger = null;
      } else if (curC.score - best.score < SWITCH_MARGIN) {
        chosen = curC;   // not clearly better: a fork's ramp runs beside the road for a while
        this.challenger = null;
      } else {
        // a clearly better way: only after it keeps being so
        if (this.challenger && this.challenger.tileKey === best.tileKey && this.challenger.wi === best.wi) this.challenger.ticks++;
        else this.challenger = { tileKey: best.tileKey, wi: best.wi, ticks: 1 };
        chosen = this.challenger.ticks >= SWITCH_TICKS ? best : curC;
        if (chosen === best) {
          this.challenger = null;
          // onto a road that meets ours near the car (a turn at a junction): the path driven goes on round the corner;
          // a sideways move to a parallel road would only kink it
          if (!this._touches(curC, best, x, y)) { this.trail = []; this.passed.clear(); }
        }
      }
      this.cur = { tileKey: chosen.tileKey, wi: chosen.wi, dir: chosen.dir };
      this.curT = now;
    } else if (this.cur && now - this.curT < COAST_S) {
      // nothing within reach: carry the last way (its distance will show how far off we are)
      const w = md.wayAt(this.cur.tileKey, this.cur.wi);
      if (w) chosen = this._measure(this.cur.tileKey, this.cur.wi, w, x, y, h, v, this.cur.dir);
    }
    if (chosen === null) { this.cur = null; this.result = null; return null; }
    // nodes the car has just passed go into the trail as they are (the junction geometry behind hangs off them)
    for (const q of this.prevAhead) {
      const dx = q[0] - chosen.px, dy = q[1] - chosen.py;
      if (dx * Math.cos(h) + dy * Math.sin(h) < 0 && Math.hypot(dx, dy) < 15) this._trailPush(q[0], q[1], true);
    }
    this._trailPush(chosen.px, chosen.py);
    this.result = this._describe(chosen, x, y, h, now);
    this.prevAhead = this.result.horizon.slice(this.result.carIndex + 1, this.result.carIndex + 3);
    this._carryPassed(this.result, chosen, h);
    return this.result;
  }

  /** Branches seen ahead stay in the list once passed, with their (negative) distance, while within BEHIND_M. */
  _carryPassed(result, c, h) {
    const key = (b) => `${b.x},${b.y}|${b.name}|${b.angle}`;
    const fresh = new Set();
    for (const b of result.branches) { const k = key(b); fresh.add(k); this.passed.set(k, b); }
    for (const [k, b] of this.passed) {
      if (fresh.has(k)) continue;
      const dx = b.x - c.px, dy = b.y - c.py, along = dx * Math.cos(h) + dy * Math.sin(h), dist = Math.hypot(dx, dy);
      if (along > 5 || dist > BEHIND_M) { this.passed.delete(k); continue; }   // ahead again (we turned round), or gone
      result.branches.push({ ...b, along: r1(-dist) });
    }
  }

  _trailPush(x, y, exact = false) {
    const tr = this.trail, last = tr[tr.length - 1];
    if (last && Math.hypot(x - last[0], y - last[1]) < (exact ? 0.05 : TRAIL_STEP_M)) return;
    tr.push([x, y]);
    let len = 0;
    for (let k = tr.length - 1; k > 0; k--) { len += Math.hypot(tr[k][0] - tr[k - 1][0], tr[k][1] - tr[k - 1][1]); if (len > TRAIL_M) { tr.splice(0, k); break; } }
  }

  /** The branch the car is turning onto at the junction ahead, among `fresh` (options with `ang` relative to the arriving
   *  direction), or null: the indicator's side, else the yaw rate's; the one nearest the heading the car is turning to. */
  _turning(fresh) {
    const { h, v, w, turn, now } = this.ctx;
    if (this.turnPick && now < this.turnPick.until) {
      const held = fresh.find(o => o.tileKey + ':' + o.wi + ':' + o.odir === this.turnPick.key);
      if (held) return held;
    }
    const yawing = Math.abs(w) > TURN_W && v > 1.0;
    const want = (turn && v < INDICATE_MAX_V ? turn : 0) || (yawing ? Math.sign(w) : 0);   // at speed an indicator is a lane change
    if (!want) return null;
    const hPred = h + Math.sign(w) * Math.min(Math.abs(w) * TURN_LOOKAHEAD_S, 100 * DEG);
    let best = null, cost = Infinity;
    for (const o of fresh) {
      if (Math.sign(o.ang) !== want || Math.abs(o.ang) < TURN_MIN || Math.abs(o.ang) > UTURN) continue;
      const c = yawing ? Math.abs(wrap(Math.atan2(o.dy, o.dx) - hPred)) : Math.abs(Math.abs(o.ang) - 90 * DEG);
      if (c < cost) { cost = c; best = o; }
    }
    if (!best || (yawing && cost > TURN_MATCH)) return null;
    this.turnPick = { key: best.tileKey + ':' + best.wi + ':' + best.odir, until: now + TURN_HOLD_S };
    return best;
  }

  // ---- candidates ---------------------------------------------------------------------------------

  _candidates(x, y, h, v) {
    const md = this.md;
    const byWay = new Map();   // one entry per way: its nearest segment
    for (const s of md.near(x, y, SEARCH_M)) {
      const key = s.tileKey + ':' + s.wi;
      const prev = byWay.get(key);
      if (prev === undefined || s.d < prev.d) byWay.set(key, s);
    }
    const sigmaH = v < SLOW_V ? SIGMA_H_SLOW : SIGMA_H;
    const out = [];
    for (const s of byWay.values()) {
      const hs = Math.atan2(s.by - s.ay, s.bx - s.ax);
      const dirs = s.way.oneWay ? [1] : [1, -1];
      let bestDir = null;
      for (const dir of dirs) {
        const dh = wrap(h - (dir > 0 ? hs : hs + Math.PI));
        if (bestDir === null || Math.abs(dh) < Math.abs(bestDir.dh)) bestDir = { dir, dh };
      }
      // a way turned far from our heading is out -- unless we are turning (the heading is on its way round) or slow
      if (Math.abs(bestDir.dh) > MAX_DH && v >= SLOW_V && Math.abs(this.ctx.w) < TURN_W) continue;
      let score = (s.d / SIGMA_D) ** 2 + (bestDir.dh / sigmaH) ** 2;
      const same = this.cur && this.cur.tileKey === s.tileKey && this.cur.wi === s.wi;
      const connected = !same && this._leadsTo(s.tileKey, s.wi);
      if (same || connected) score -= PRIOR;
      // lateral: + when the car is left of the centerline in its direction of travel
      const ux = (s.bx - s.ax) * bestDir.dir, uy = (s.by - s.ay) * bestDir.dir, L = Math.hypot(ux, uy) || 1;
      const lateral = (ux * (y - s.py) - uy * (x - s.px)) / L;
      out.push({ ...s, dir: bestDir.dir, dh: bestDir.dh, score, same, connected, lateral });
    }
    return out;
  }

  /** Meters of the way left ahead of the matched point, in its travel direction. */
  _remaining(c) {
    const xy = c.xy;
    let d;
    if (c.dir > 0) {
      d = (1 - c.t) * Math.hypot(c.bx - c.ax, c.by - c.ay);
      for (let i = c.si + 1; 2 * i + 3 < xy.length; i++) d += Math.hypot(xy[2 * i + 2] - xy[2 * i], xy[2 * i + 3] - xy[2 * i + 1]);
    } else {
      d = c.t * Math.hypot(c.bx - c.ax, c.by - c.ay);
      for (let i = c.si - 1; i >= 0; i--) d += Math.hypot(xy[2 * i + 2] - xy[2 * i], xy[2 * i + 3] - xy[2 * i + 1]);
    }
    return d;
  }

  /** Whether two ways share a node within TOUCH_M of (x, y). */
  _touches(a, b, x, y) {
    const ax = a.xy, bx = b.xy;
    for (let i = 0; i + 1 < ax.length; i += 2) {
      if (Math.hypot(ax[i] - x, ax[i + 1] - y) > TOUCH_M) continue;
      for (let j = 0; j + 1 < bx.length; j += 2) if (bx[j] === ax[i] && bx[j + 1] === ax[i + 1]) return true;
    }
    return false;
  }

  /** Whether the current way ends (in its travel direction) at a node the given way touches. */
  _leadsTo(tileKey, wi) {
    if (!this.cur) return false;
    const cw = this.md.wayAt(this.cur.tileKey, this.cur.wi);
    if (!cw) return false;
    const xy = cw.xy, n = xy.length;
    const ex = this.cur.dir > 0 ? xy[n - 2] : xy[0], ey = this.cur.dir > 0 ? xy[n - 1] : xy[1];
    const w = this.md.wayAt(tileKey, wi);
    if (!w) return false;
    for (let i = 0; i < w.xy.length; i += 2) if (w.xy[i] === ex && w.xy[i + 1] === ey) return true;
    return false;
  }

  /** The nearest point on a specific way (for coasting). */
  _measure(tileKey, wi, w, x, y, h, v, dir) {
    const xy = w.xy;
    let best = null;
    for (let s = 0; s + 3 < xy.length; s += 2) {
      const ax = xy[s], ay = xy[s + 1], bx = xy[s + 2], by = xy[s + 3];
      const dx = bx - ax, dy = by - ay, L2 = dx * dx + dy * dy;
      let t = L2 > 0 ? ((x - ax) * dx + (y - ay) * dy) / L2 : 0;
      t = Math.max(0, Math.min(1, t));
      const px = ax + t * dx, py = ay + t * dy, d = Math.hypot(x - px, y - py);
      if (best === null || d < best.d) best = { tileKey, wi, si: s >> 1, way: w.way, xy, ax, ay, bx, by, d, t, px, py };
    }
    if (best === null) return null;
    const hs = Math.atan2(best.by - best.ay, best.bx - best.ax);
    const dh = wrap(h - (dir > 0 ? hs : hs + Math.PI));
    const ux = (best.bx - best.ax) * dir, uy = (best.by - best.ay) * dir, L = Math.hypot(ux, uy) || 1;
    return { ...best, dir, dh, score: (best.d / SIGMA_D) ** 2 + (dh / SIGMA_H) ** 2, same: true, connected: false, lateral: (ux * (y - best.py) - uy * (x - best.px)) / L, coasting: true };
  }

  // ---- output -------------------------------------------------------------------------------------

  _describe(c, x, y, h, now) {
    const w = c.way;
    const { points, carIndex, branches, ways, ended, length } = this._horizon(c);
    // distance along the way (in node order) to the matched point
    let s = 0;
    for (let i = 0; i < c.si; i++) s += Math.hypot(c.xy[2 * i + 2] - c.xy[2 * i], c.xy[2 * i + 3] - c.xy[2 * i + 1]);
    s += c.t * Math.hypot(c.bx - c.ax, c.by - c.ay);
    return {
      way: { id: w.id, name: w.name, ref: w.ref, cls: w.cls, className: w.className, lanes: w.lanes, oneWay: w.oneWay,
             maxSpeed: w.maxSpeed || null, maxSpeedForward: w.maxSpeedForward || null, maxSpeedBackward: w.maxSpeedBackward || null },
      dir: c.dir,
      s: r1(s), lateral: r1(c.lateral), distance: r1(c.d), headingDiff: Math.round(c.dh / DEG * 10) / 10,
      conf: Math.round(Math.exp(-Math.max(0, c.score) / 2) * 100) / 100,
      coasting: !!c.coasting,
      horizon: points, carIndex, horizonLength: r1(length), ended, branches,   // horizon: world frame [x east, y north]; points[carIndex] is the matched point
      ways,   // the horizon's runs per way: [{from (point index), lanes, oneWay, className, name, ref}]
      t: now,
    };
  }

  /** The centerline from BEHIND_M behind the matched point to HORIZON_M ahead, and the roads leaving it. */
  _horizon(c) {
    const md = this.md;
    const pts = [];       // [x, y]
    const branches = [];
    const ways = [];      // runs of the horizon by way
    let length = 0;
    // behind: the path driven (the trail), else back along the current way from the matched point
    const back = [];
    {
      let bx = c.px, by = c.py, len = 0;
      const tr = this.trail;
      for (let k = tr.length - 1; k >= 0 && len < BEHIND_M; k--) {
        const [tx, ty] = tr[k], seg = Math.hypot(tx - bx, ty - by);
        if (seg < 0.5) continue;
        if (len + seg > BEHIND_M) { const f = (BEHIND_M - len) / seg; back.push([bx + (tx - bx) * f, by + (ty - by) * f]); len = BEHIND_M; break; }
        len += seg; back.push([tx, ty]); bx = tx; by = ty;
      }
      if (back.length < 2) { back.length = 0; bx = c.px; by = c.py; len = 0; }
      let i = c.dir > 0 ? c.si : c.si + 1;   // the node behind the matched point
      const walk = back.length === 0;
      while (walk && len < BEHIND_M && i >= 0 && i * 2 + 1 < c.xy.length) {
        const nx = c.xy[2 * i], ny = c.xy[2 * i + 1];
        const seg = Math.hypot(nx - bx, ny - by);
        if (len + seg > BEHIND_M) {   // stop exactly BEHIND_M back
          const f = (BEHIND_M - len) / seg;
          back.push([bx + (nx - bx) * f, by + (ny - by) * f]);
          break;
        }
        len += seg;
        back.push([nx, ny]); bx = nx; by = ny;
        i -= c.dir;
      }
    }
    for (let k = back.length - 1; k >= 0; k--) pts.push(back[k]);
    const carIndex = pts.length;
    pts.push([c.px, c.py]);
    const run = (w, from) => ways.push({ from, lanes: w.lanes, oneWay: w.oneWay, className: w.className, name: w.name, ref: w.ref });
    run(c.way, 0);
    // ahead: along the way, then onto the best continuation at each end
    let key = c.tileKey, wi = c.wi, xy = c.xy, way = c.way, dir = c.dir;
    let i = c.dir > 0 ? c.si + 1 : c.si;   // the node ahead of the matched point
    let px = c.px, py = c.py, hops = 0, ended = false;
    let prevDirX = Math.cos(0), prevDirY = 0;
    const turns = [];   // [length, heading change] along the way, for the loop guard
    const visited = new Set([key + ':' + wi]);
    // matched at the way's very end: the walk starts on the end node, so the junction there is still handled
    const lastIdx = (xy.length >> 1) - 1;
    if (dir > 0 && i > lastIdx) i = lastIdx;
    if (dir < 0 && i < 0) i = 0;
    // the direction we arrive with (for the branch angles at the first node)
    { const dx = (dir > 0 ? c.bx - c.ax : c.ax - c.bx), dy = (dir > 0 ? c.by - c.ay : c.ay - c.by), L = Math.hypot(dx, dy); if (L > 0) { prevDirX = dx / L; prevDirY = dy / L; } }
    outer: while (length < HORIZON_M && pts.length < MAX_POINTS) {
      while (i >= 0 && 2 * i + 1 < xy.length) {
        const nx = xy[2 * i], ny = xy[2 * i + 1];
        const seg = Math.hypot(nx - px, ny - py);
        if (seg > 0) {
          const dx = (nx - px) / seg, dy = (ny - py) / seg;
          if (pts.length > carIndex + 1) {
            turns.push([length, wrap(Math.atan2(dy, dx) - Math.atan2(prevDirY, prevDirX))]);
            let turned = 0;
            for (let k = turns.length - 1; k >= 0 && length - turns[k][0] < LOOP_WINDOW_M; k--) turned += turns[k][1];
            if (Math.abs(turned) > LOOP_TURN) { ended = true; break outer; }   // the road doubles back: not a horizon
          }
          prevDirX = dx; prevDirY = dy;
        }
        length += seg;
        pts.push([nx, ny]);
        px = nx; py = ny;
        const last = dir > 0 ? i === (xy.length >> 1) - 1 : i === 0;
        // roads leaving the way at this node (other than ours and, at the end, the one we continue on)
        const others = md.waysAtNode(nx, ny, key, wi);
        const options = [];
        for (const o of others) {
          for (const od of this._leaving(o)) {
            const ang = wrap(Math.atan2(od.dy, od.dx) - Math.atan2(prevDirY, prevDirX));
            options.push({ ...o, odir: od.dir, ang, dx: od.dx, dy: od.dy, arriving: !!od.arriving });
          }
        }
        // the car turning at the first junction ahead takes the horizon onto that branch, even off a way that goes on
        const nearFirst = hops === 0 && length < TURN_M;
        const fresh = options.filter(o => !o.arriving && !visited.has(o.tileKey + ':' + o.wi));
        const turning = nearFirst ? this._turning(fresh) : null;
        if (turning && !last) {
          // our own way goes straight on: it becomes a branch, the turn the continuation (which is a branch too, so the
          // view rounds its corners: `continuation` marks it as the road the horizon takes)
          const j = i + dir;
          const sx = xy[2 * j] - nx, sy = xy[2 * j + 1] - ny, L = Math.hypot(sx, sy) || 1;
          branches.push(this._branch({ tileKey: key, wi, xy, way, nodeIndex: i, odir: dir, ang: wrap(Math.atan2(sy, sx) - Math.atan2(prevDirY, prevDirX)), dx: sx / L, dy: sy / L }, length, nx, ny));
          branches.push({ ...this._branch(turning, length, nx, ny), continuation: true });
          for (const o of options) if (o !== turning && (o.arriving || Math.abs(o.ang) < UTURN)) branches.push(this._branch(o, length, nx, ny));
          visited.add(turning.tileKey + ':' + turning.wi);
          hops++;
          key = turning.tileKey; wi = turning.wi; xy = turning.xy; way = turning.way; dir = turning.odir;
          run(way, pts.length - 1);
          i = turning.nodeIndex + dir;
          continue outer;
        }
        if (last) {
          // also our own way continuing through a mid-way junction isn't a thing: the way ended
          let next = turning, nextCost = Infinity;
          for (const o of turning ? [] : fresh) {
            const sameRef = (way.ref && o.way.ref === way.ref) || (way.name && o.way.name === way.name);
            const limit = sameRef ? UTURN : fresh.length === 1 ? BEND_MAX : CONTINUE_MAX;
            if (Math.abs(o.ang) > limit) continue;
            const drop = Math.max(0, rank(o.way) - rank(way));
            const cost = Math.abs(o.ang) / DEG - (sameRef ? SAME_NAME_BONUS : 0) + drop * CLASS_DROP_COST
              + (o.way.className.endsWith('_link') && !way.className.endsWith('_link') ? 25 : 0);
            if (cost < nextCost) { next = o; nextCost = cost; }
          }
          // our road ends here: the roads leaving are arms of a T or a Y (`end`: the corner past the node is not real), and a
          // continuation that turns is a branch too, so the view rounds the corner we take
          for (const o of options) if (o !== next && (o.arriving || Math.abs(o.ang) < UTURN)) branches.push({ ...this._branch(o, length, nx, ny), end: true });
          if (next !== null && Math.abs(next.ang) > END_TURN_MIN) branches.push({ ...this._branch(next, length, nx, ny), end: true, continuation: true });
          if (next === null || ++hops > MAX_HOPS) { ended = true; break outer; }
          visited.add(next.tileKey + ':' + next.wi);
          key = next.tileKey; wi = next.wi; xy = next.xy; way = next.way; dir = next.odir;
          run(way, pts.length - 1);
          i = next.nodeIndex + dir;
          continue outer;
        }
        for (const o of options) if (o.arriving || Math.abs(o.ang) < UTURN) branches.push(this._branch(o, length, nx, ny));
        if (length >= HORIZON_M || pts.length >= MAX_POINTS) break outer;
        i += dir;
      }
      break;
    }
    return { points: pts.map(p => [r1(p[0]), r1(p[1])]), carIndex, branches, ways, ended, length };
  }

  /** The directions a way can be followed away from the node it touches: [{dir, dx, dy}] (unit vectors of the first step). */
  // (rank: how far down the road hierarchy a way is; links count as their road)
  _leaving(o) {
    const xy = o.xy, n = xy.length >> 1, ni = o.nodeIndex, out = [];
    if (ni < n - 1) out.push(this._step(xy, ni, +1));
    if (ni > 0 && !o.way.oneWay) out.push(this._step(xy, ni, -1));
    // a one-way road ending here arrives (an on-ramp, a merging lane): no way on, but a road to draw
    if (ni === n - 1 && ni > 0 && o.way.oneWay) { const st = this._step(xy, ni, -1); if (st) out.push({ ...st, arriving: true }); }
    return out.filter(Boolean);
  }

  _step(xy, ni, dir) {
    const j = ni + dir, dx = xy[2 * j] - xy[2 * ni], dy = xy[2 * j + 1] - xy[2 * ni + 1], L = Math.hypot(dx, dy);
    return L > 0 ? { dir, dx: dx / L, dy: dy / L } : null;
  }

  _branch(o, along, x, y) {
    // the first BRANCH_M of the branching road, from the junction, in its leaving direction
    const xy = o.xy, pts = [[r1(x), r1(y)]];
    let len = 0, px = x, py = y;
    for (let i = o.nodeIndex + o.odir; i >= 0 && 2 * i + 1 < xy.length && len < BRANCH_M && pts.length < BRANCH_POINTS; i += o.odir) {
      const nx = xy[2 * i], ny = xy[2 * i + 1], seg = Math.hypot(nx - px, ny - py);
      if (len + seg > BRANCH_M) { const f = (BRANCH_M - len) / seg; pts.push([r1(px + (nx - px) * f), r1(py + (ny - py) * f)]); break; }
      len += seg; pts.push([r1(nx), r1(ny)]); px = nx; py = ny;
    }
    return { x: r1(x), y: r1(y), along: r1(along), angle: Math.round(o.ang / DEG), cls: o.way.cls, className: o.way.className,
             name: o.way.name, ref: o.way.ref, oneWay: o.way.oneWay, lanes: o.way.lanes, pts, merge: !!o.arriving };
  }
}
