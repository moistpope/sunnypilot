// Object stats (Display -> Object stats): a debug tag over every object the view draws, saying where
// it came from (the ADAS camera's object list, openpilot's leads, the radar, or the world model that
// fuses them) and what that source reports. Tags are HTML laid over the canvas, placed each frame by projecting the top of each
// object; their text refreshes a few times a second so the numbers stay readable. Units: m, m/s,
// deg; L/R = left/right of the car's center line.
import * as THREE from '../vendor/three.module.min.js';
import { el } from './util.js';

const TEXT_PERIOD_S = 0.2;
const FAR_M = 60;      // past this, a tag shrinks to one line
const GAP_PX = 6;      // between a tag and its object, and between stacked tags
const MAX_LIFT_PX = 220;   // a tag pushed farther than this from its object to clear nearer ones is hidden
const CYCLE_S = 0.065;     // radar cycle

const f1 = (v) => (v == null ? '–' : v.toFixed(1));
const rel = (v) => (v == null ? '–' : (v > 0.05 ? '+' : v < -0.05 ? '−' : '') + Math.abs(v).toFixed(1));
const side = (v) => (v == null ? '–' : Math.abs(v) < 0.05 ? '0.0' : `${Math.abs(v).toFixed(1)} ${v > 0 ? 'L' : 'R'}`);
const ang = (d) => (d == null ? null : Math.abs(d) < 0.5 ? '0°' : `${Math.abs(d).toFixed(0)}° ${d > 0 ? 'L' : 'R'}`);
const size = (w, l) => (w && l ? `${w.toFixed(1)}×${l.toFixed(1)} m` : null);
const join = (...parts) => parts.filter(Boolean).join(' · ');

const SRC_ABBR = { radar: 'R', adas: 'A', op: 'O' };
const FLAG_NAMES = { accPrimary: 'ACC target', accSecondary: 'ACC 2nd', leading: 'leading', bsd: 'BSD', dow: 'DOW', aeb: 'AEB', raeb: 'rear AEB', bacm: 'BACM', elka: 'ELKA' };

// [tag, title, lines...] for one object. `d` is what the source reported plus, for tracks the view
// filters, its estimate of relative velocity (vx/vy); egoV is the car's signed speed.
function describe(d, egoV, far) {
  const ground = (vx, vy) => (vx == null ? null : Math.hypot(egoV + vx, vy || 0));
  if (d.src === 'world') {
    // which sources feed it (R radar track #id, A ADAS object #id, O openpilot lead n)
    const srcs = d.sources.map(x => `${SRC_ABBR[x.src]}${x.src === 'op' ? x.id + 1 : '#' + x.id}`).join(' ');
    const head = join(`#${d.id} ${d.cls}`, srcs || 'no source', d.stale > 0.3 && `coasting ${d.stale.toFixed(1)} s`);
    if (far) return ['WORLD', join(head, `${f1(d.x)} m`)];
    const lines = ['WORLD', head,
      join(`x ${f1(d.x)} m`, `y ${side(d.y)}`, `hdg ${ang(d.heading)}${d.headingSrc ? ' ' + d.headingSrc : ''}`),
      join(`v ${f1(d.speed)} m/s`, `rel ${rel(d.vx - egoV)}`, `σ ${d.std[0].toFixed(1)}/${d.std[1].toFixed(1)} m`, size(d.w, d.l))];
    // each source's latest reading minus the fused estimate (x/y, m): how far it disagrees
    if (d.sources.length) lines.push('Δ ' + d.sources.map(x => `${SRC_ABBR[x.src]} ${rel(x.dx)}/${rel(x.dy)}`).join(' · '));
    return lines;
  }
  if (d.src === 'radar') {
    const head = join(`#${d.id} ${d.cls}`, `dyn ${d.dyn}`, `${(d.age * CYCLE_S).toFixed(1)} s`, `st ${d.state} q ${d.quality}`);
    if (far) return ['RADAR', join(head, `${f1(d.x)} m`)];
    return ['RADAR', head,
      join(`x ${f1(d.x)} m`, `y ${side(d.y)}`, d.heading != null && `hdg ${ang(d.heading)}`),
      join(`v ${f1(ground(d.vx, d.vy))} m/s`, `rel ${rel(d.vx)}`, `lat ${rel(d.vy)}`, `a ${rel(d.ax)}`, size(d.w, d.l))];
  }
  if (d.src === 'op') {
    const head = join(`lead ${d.i + 1}`, d.radar ? 'radar' : 'vision', d.modelProb != null && `p ${d.modelProb.toFixed(2)}`);
    if (far) return ['OP', join(head, `${f1(d.dRel)} m`)];
    return ['OP', head,
      join(`d ${f1(d.dRel)} m`, `y ${side(d.yRel)}`),
      join(`v ${f1(d.vLead)} m/s`, `rel ${rel(d.vRel)}`, d.aLead != null && `a ${rel(d.aLead)}`)];
  }
  // ADAS: positions and class come from the camera's list; it reports no velocity, so the speeds
  // are this view's tracking estimate
  const flags = (d.flags || []).map(f => FLAG_NAMES[f] || f).join(', ');
  const head = join(`#${d.id} ${d.cls}`, flags);
  if (far) return ['ADAS', join(head, `${f1(d.x)} m`)];
  const lines = ['ADAS', head,
    join(`x ${f1(d.x)} m`, `y ${side(d.y)}`, d.heading != null && `hdg ${ang(d.heading)}`),
    join(`v ${f1(ground(d.vx, d.vy))} m/s`, `rel ${rel(d.vx)} est`, size(d.w, d.l), d.classConf != null && `cls ${Math.round(d.classConf * 100)}%`)];
  // an openpilot lead the view merged into this car (it isn't drawn separately)
  for (const o of d.leads || []) {
    lines.push(join(`OP lead ${o.i + 1}: d ${f1(o.dRel)} m`, `y ${side(o.yRel)}`, `v ${f1(o.vLead)}`, `rel ${rel(o.vRel)}`));
  }
  return lines;
}

export class ObjectLabels {
  constructor(root) {
    this.root = root;
    this.items = new Map();   // key -> { node, stem, w, h, textAt, text }
    this.v = new THREE.Vector3();
  }

  clear() {
    for (const it of this.items.values()) it.node.remove();
    this.items.clear();
  }

  // entries: [{ key, pos: [X, Y, Z] scene coords of the object's top, alpha, data }]
  update(entries, camera, egoV, now) {
    const W = this.root.clientWidth, H = this.root.clientHeight;
    const live = new Set();
    const measure = [];
    for (const e of entries) {
      live.add(e.key);
      let it = this.items.get(e.key);
      if (!it) {
        const stem = el('i.stem');
        it = { node: el('div.olabel', stem), stem, w: 0, h: 0, textAt: -1, text: '' };
        this.root.append(it.node);
        this.items.set(e.key, it);
      }
      e.it = it;
      e.dist = Math.hypot(e.pos[0], e.pos[2]);
      if (now - it.textAt >= TEXT_PERIOD_S) {
        it.textAt = now;
        const [tag, title, ...rest] = describe(e.data, egoV, e.dist > FAR_M);
        const text = [tag, title, ...rest].join('\n');
        if (text !== it.text) {
          it.text = text;
          it.node.className = `olabel ${e.data.src}`;
          it.node.replaceChildren(el('div', el('b', tag), ' ', title), ...rest.map(l => el('div', l)), it.stem);
          measure.push(it);
        }
      }
    }
    for (const [key, it] of this.items) {
      if (!live.has(key)) { it.node.remove(); this.items.delete(key); }
    }
    for (const it of measure) { it.w = it.node.offsetWidth; it.h = it.node.offsetHeight; }

    // Nearest first: each keeps its spot above its object; a farther tag that would cover one already
    // placed moves up over it (on its stem), so an object seen by two sources shows both tags. With no
    // room left above (objects near the top of the screen, as in the top view), tags hang below instead.
    entries.sort((a, b) => a.dist - b.dist);
    const placed = [];
    let z = entries.length + 1;
    for (const e of entries) {
      const it = e.it;
      this.v.set(e.pos[0], e.pos[1], e.pos[2]).project(camera);
      const sx = (this.v.x + 1) / 2 * W, sy = (1 - this.v.y) / 2 * H;
      const left = sx - it.w / 2;
      const place = (below) => {
        let top = below ? sy + GAP_PX : sy - GAP_PX - it.h;
        for (let n = 0; n <= placed.length; n++) {
          const hit = placed.find(p => left < p.left + p.w && left + it.w > p.left && top < p.top + p.h + GAP_PX && top + it.h + GAP_PX > p.top);
          if (!hit) break;
          top = below ? hit.top + hit.h + GAP_PX : hit.top - it.h - GAP_PX;
        }
        return top;
      };
      let top = place(false), below = false;
      if (top < 0) {
        const under = place(true);
        if (under + it.h <= H) { top = under; below = true; }
      }
      const stem = below ? top - sy : sy - top - it.h;   // from the tag's edge to its object
      const onScreen = this.v.z < 1 && sx > -it.w / 2 && sx < W + it.w / 2 && sy > 0 && sy < H && top + it.h > 0;
      // hidden with visibility, not display, so a tag keeps a size to measure
      if (!onScreen || stem > MAX_LIFT_PX || e.alpha <= 0.02) {
        it.node.style.visibility = 'hidden';
        continue;
      }
      placed.push({ left, top, w: it.w, h: it.h });
      it.node.style.visibility = '';
      it.node.style.transform = `translate(${left.toFixed(1)}px, ${top.toFixed(1)}px)`;
      it.node.style.opacity = e.alpha.toFixed(2);
      it.node.style.zIndex = String(z--);
      it.stem.style.top = below ? '' : '100%';
      it.stem.style.bottom = below ? '100%' : '';
      it.stem.style.height = `${stem.toFixed(1)}px`;
    }
  }
}
