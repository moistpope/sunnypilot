// Car controls. Tap the car: a ribbon of categories slides up, the camera goes to a top view with the
// roof faded so the cabin shows, and the part each category is about glows under a badge. A category
// either opens a half-screen panel (the car moves into the other half) or puts its settings on cards
// beside the car.
//
// On the car (the Android app, wired to IBUS1/IBUS2) the controls are live: their values follow what the
// car reports (carcatalog.js `live`, from carstate.js), and so does the 3D car: doors, liftgate, windows,
// sunroof, seats, lamps. Setting a control sends the head unit's own message (`tx`, through cancmd.js and
// the app) and the car's answer shows when it comes; what can't be sent is greyed with the reason (`off`).
// In a plain browser nothing is live and nothing is sent: the values live in this page (this.v).
import * as THREE from '../vendor/three.module.min.js';
import { $, $$, el, iconSvg, setClass, setText } from './util.js';
import { CATEGORIES, DRIVE_MODES, SEAT_LIMITS, SEAT_MEMORY, LIVE, MSG, defaults, liveControls, liveExtras } from './carcatalog.js';
import { ZONES, ANCHORS } from './cutaway.js';
import { ApaMock, APA_SIGNALS } from './apamock.js';

const OVERVIEW = { at: [0, 0.6, 2.4], az: 180, el: 90, fit: [2.3, 5.1] };   // top down, nose up...
const OVERVIEW_WIDE = { at: [0, 0.6, 2.4], az: 90, el: 90, fit: [5.1, 2.3] };   // ...or right, on a short screen
const SHORT_PX = 420;     // free height below which the overview turns the car on its side
const MOCK_NOTE = 'Mockup: nothing here changes the car';
const MOCK_OFF = 'Mockup: nothing on the car for this';   // carcatalog.js MOCK: off in the browser too
const CAR_NOTE = 'On the car: a change sends the head unit\'s message, and the car\'s answer shows here';
const LIVE_SYNC_S = 0.2;   // how often the controls take the car's values
const SEAT_HEAT = 0xff6a2a;
const CARD_GAP = 56;      // px between a card and the point it's about
const CARDS_MIN_W = 840;  // px of free width that fits two cards beside the car; narrower, they go in the panel
const CHIP_GAP = 46;      // px a chip sits out from its point, away from the car's center
const SEATS_FOR_STAGE = { all: ['FL', 'FR', 'RL', 'RR'], driver: ['FL'], passenger: ['FR'], front: ['FL', 'FR'], rear: ['RL', 'RR'] };
const WINDOWS = ['FL', 'FR', 'RL', 'RR', 'QL', 'QR', 'rear'];   // cutaway.js WINDOWS; the sunroof is apart
const DOORS = ['Door_Front_L', 'Door_Front_R', 'Door_Rear_L', 'Door_Rear_R', 'Tailgate'];   // cutaway.js DOORS
const SEAT_STEP = { slide: 0.01, front: 0.004, rear: 0.004, recline: 0.025 };   // per press, and every 90 ms held
const RANGE_MI = 330;     // EPA range at 100%, for the mock range readout

export class CarControls {
  constructor(app) {
    this.app = app;
    this.scene = app.scene;
    this.ribbon = $('#carribbon');
    this.panel = $('#carpanel');
    this.layer = $('#caranchors');
    this.svg = $('#carlines');
    this.isOpen = false;
    this.cat = null;
    this.v = defaults();
    this.defs = new Map();      // control id -> its definition (live, tx, off)
    for (const cat of CATEGORIES) {
      for (const card of cat.cards || []) for (const c of card.controls) if (c.id) this.defs.set(c.id, c);
      for (const sec of cat.sections || []) for (const c of sec.controls) if (c.id) this.defs.set(c.id, c);
      for (const chip of cat.chips || []) if (chip.id) this.defs.set(chip.id, chip);
    }
    this.liveList = liveControls();
    this.liveIds = new Set();   // the controls the car reports right now: their values are the car's, not ours
    this._syncT = 0;
    this.pins = [];
    this.watchers = [];
    this.flash = null;   // lamps shown for a moment (lighting preview), { until, lamps }
    this.memory = Object.fromEntries(Object.entries(SEAT_MEMORY).map(([k, p]) => [k, { ...p }]));   // the driver's saved positions
    this.apa = null;     // the mock automated parking, while it runs (apamock.js)
    this._p = new THREE.Vector3();
    this._c = new THREE.Vector3();
    this.buildRibbon();
  }

  get cut() { return this.scene.cutaway; }
  get cmd() { return this.app.cmd; }
  /** Whether a change goes to the car (the app's CAN link is up). */
  get sending() { return !!(this.cmd && this.cmd.available); }
  get inApp() { return !!window.WebHudApp; }
  get category() { return this.find(this.cat); }
  find(id) { return CATEGORIES.find(c => c.id === id) || (this.apa && id === 'apa' ? this.apa.category : null); }

  // ---- open / close ----------------------------------------------------------------------------------

  enter() {
    if (this.isOpen) return;
    this.isOpen = true;
    document.documentElement.classList.add('carmode');
    this.ribbon.setAttribute('aria-hidden', 'false');
    this.scene.enterStudio();
    this.select(null);
  }

  // back to the HUD: the car as it was, the user's own view
  exit() {
    if (!this.isOpen) return;
    this.isOpen = false;
    this.cat = null;
    document.documentElement.classList.remove('carmode');
    this.ribbon.setAttribute('aria-hidden', 'true');
    this.stopApa();
    this.showPanel(null);
    this.clearPins();
    // the car as it was: the mockup's doors shut, windows up, sunroof shut, the screen back to portrait;
    // what the car reports stays as reported
    this.closeAll();
    this.v['display.hollywood'] = false;
    if (!this.liveIds.has('energy.port')) this.v['energy.port'] = false;
    this.apply();
    this.cut.setRoof(false);
    this.cut.setGhost(false);
    this.cut.setZones([]);
    this.scene.lampOverride = null;
    this.scene.exitStudio();
    this.app.setView(this.app.settings.view);
  }

  // a category, or null for the overview
  select(id) {
    if (id !== 'apa') this.stopApa();
    const c = this.find(id);
    this.cat = c && c.id;
    $$('.cat', this.ribbon).forEach(b => {
      setClass(b, 'on', b.dataset.cat === this.cat);
      // into view along the ribbon only: scrollIntoView would also scroll #app to a ribbon still sliding
      // in, shifting the whole HUD up
      if (b.dataset.cat === this.cat) {
        const cats = b.parentElement, l = b.offsetLeft - cats.offsetLeft, r = l + b.offsetWidth;
        if (l < cats.scrollLeft) cats.scrollLeft = l;
        else if (r > cats.scrollLeft + cats.clientWidth) cats.scrollLeft = r - cats.clientWidth;
      }
    });
    if (!this.liveIds.has('energy.port')) this.v['energy.port'] = !!c && c.id === 'energy';   // the mockup's port opens to show it
    this.cardsShown = !!(c && c.cards) && this.roomForCards();
    this.showPanel(c && (c.sections || !this.cardsShown) ? c : null);
    this.buildPins(c);
    this.cut.setRoof(!c || c.roof !== false);
    this.cut.setGhost(!!(c && c.ghost), (c && c.ghost) || []);
    this.cut.setZones(c ? (c.zone ? [c.zone] : []) : Object.keys(ZONES), !c);
    this.apply();
    this.layout();
  }

  back() { this.select(this.cat === 'apa' ? 'assist' : null); }

  // A tap on the 3D view while open: a zone opens its category; anywhere else goes back to the
  // overview, or from there closes.
  tap(x, y) {
    if (this.apa) { this.apa.tap(x, y); return; }   // a parking space, or nothing
    const zone = this.scene.pickZone(x, y);
    const c = zone && CATEGORIES.find(k => k.zone === zone);
    if (c && c.id !== this.cat) this.select(c.id);
    else if (!c && this.cat) this.back();
    else if (!c) this.exit();
  }

  // ---- layout ------------------------------------------------------------------------------------------

  // The screen area the car is framed in: right of / below the status card, above the ribbon, beside
  // or above the panel.
  freeRect() {
    const W = window.innerWidth, H = window.innerHeight;
    const card = $('#drive').getBoundingClientRect();
    const ribbonTop = H - parseFloat(getComputedStyle(this.ribbon).bottom || '16') - this.ribbon.offsetHeight;
    const panel = this.panel.classList.contains('open');
    const back = this.backBtn ? 52 : 0;
    if (W <= H) {
      return { left: 10, right: W - 10, top: card.bottom + 10 + back, bottom: (panel ? H - this.panel.offsetHeight : ribbonTop) - 10 };
    }
    return { left: card.right + 16, right: (panel ? W - 16 - this.panel.offsetWidth : W) - 16, top: 16 + back, bottom: ribbonTop - 12 };
  }

  // whether the on-car cards fit beside the car (else they're shown as a panel)
  roomForCards() {
    const W = window.innerWidth, card = $('#drive').getBoundingClientRect();
    return (W <= window.innerHeight ? W - 20 : W - card.right - 32) >= CARDS_MIN_W;
  }

  // frame the current category in the free area (on a resize too)
  layout(instant = false) {
    if (!this.isOpen) return;
    const cat = this.category;
    if (cat && cat.cards && this.cardsShown !== this.roomForCards()) { this.select(cat.id); return; }   // cards <-> panel
    document.documentElement.style.setProperty('--ribbon-h', `${this.ribbon.offsetHeight}px`);
    const r = this.rect = this.freeRect();
    if (this.backBtn) this.backBtn.style.left = `${(r.left + r.right) / 2}px`;
    this.scene.setFrame(r);
    const c = this.category, f = (c && c.focus) || (r.bottom - r.top < SHORT_PX && r.right - r.left > r.bottom - r.top ? OVERVIEW_WIDE : OVERVIEW);
    this.scene.focus(f.fitP && window.innerWidth <= window.innerHeight ? { ...f, fit: f.fitP } : f, instant);
  }

  // ---- ribbon and panel --------------------------------------------------------------------------------

  buildRibbon() {
    const cats = el('div.cats');
    let sep = false;
    for (const c of CATEGORIES) {
      if (c.system && !sep) { cats.append(el('i.sep')); sep = true; }
      const b = el('button.cat', { dataset: { cat: c.id }, title: c.label, onclick: () => this.select(this.cat === c.id ? null : c.id) });
      b.innerHTML = iconSvg(c.icon);
      b.append(el('span', c.label));
      cats.append(b);
    }
    const done = el('button.done.icon', { title: 'Close', 'aria-label': 'Close car controls', onclick: () => this.exit() });
    done.innerHTML = iconSvg('close');
    this.mockTag = el('span.mock', 'Mockup');
    this.ribbon.replaceChildren(this.mockTag, cats, done);
    this.ribbon.setAttribute('aria-hidden', 'true');
  }

  showPanel(c) {
    this.watchers = this.watchers.filter(w => !w.panel);
    if (!c) {
      this.panel.classList.remove('open');
      this.panel.setAttribute('aria-hidden', 'true');
      return;
    }
    const back = el('button.back.icon', { 'aria-label': 'Back', title: 'Back', onclick: () => this.back() });
    back.innerHTML = iconSvg('back');
    const h2 = el('h2');
    h2.innerHTML = `<span class="tt">${iconSvg(c.icon)}</span>`;
    h2.append(c.label);
    const close = el('button.back.icon', { 'aria-label': 'Close', title: 'Close', onclick: () => this.exit() });
    close.innerHTML = iconSvg('close');
    const body = el('div.pbody');
    const liveBlock = this._liveSection(c);
    if (liveBlock) body.append(liveBlock);
    if (c.render) body.append(...c.render());
    for (const sec of c.render ? [] : c.sections || c.cards.map(card => ({ title: card.title, controls: card.controls }))) {
      const s = el('div.section');
      if (sec.title) s.append(el('h3', sec.title));
      if (sec.note) s.append(el('p.desc', sec.note));
      // rows run together in a box; blocks (buttons, lists, the hero) sit between the boxes
      let rows = el('div.rows');
      for (const ctl of sec.controls) {
        const node = this.control(ctl, false);
        if (!node) continue;
        if (node.classList.contains('row')) { rows.append(node); continue; }
        if (rows.childElementCount) { s.append(rows); rows = el('div.rows'); }
        s.append(node);
      }
      if (rows.childElementCount) s.append(rows);
      body.append(s);
    }
    // keep the scroll position when the same panel is rebuilt
    const keep = this.panelCat === c.id ? this.panel.querySelector('.pbody')?.scrollTop : 0;
    this.panel.replaceChildren(el('header', back, h2, close), body, el('div.pfoot', this.sending ? CAR_NOTE : this.inApp ? 'The car\'s CAN link is down: nothing can be sent' : MOCK_NOTE));
    body.scrollTop = keep || 0;
    this.panelCat = c.id;
    this.panel.classList.add('open');
    this.panel.setAttribute('aria-hidden', 'false');
  }

  // A "From the car" block at the top of a panel: the real state the car is broadcasting on CAN
  // (carstate.js), when the Android app's read-only link is up. Refreshes every panel frame.
  _liveSection(c) {
    const cs = this.app.carState, spec = LIVE[c.id];
    if (!cs || !spec) return null;
    const sec = el('div.section.live');
    const head = el('h3', el('span.livedot'), 'From the car');
    const grid = el('div.livegrid');
    sec.append(head, grid);
    const paint = () => {
      const data = spec(cs);
      setClass(sec, 'off', data.length === 0);
      if (!data.length) { grid.replaceChildren(el('div.livenone', cs.demo ? 'Demo' : 'No live data from the car')); return; }
      grid.replaceChildren(...data.flatMap(([k, v]) => [el('span.livek', k), el('span.livev', v)]));
    };
    this.watch(paint, true);
    paint();
    return sec;
  }

  // ---- pins: badges, cards and chips on the car --------------------------------------------------------

  clearPins() {
    for (const p of this.pins) p.el.remove();
    this.pins = [];
    this.watchers = this.watchers.filter(w => w.panel);
    this.svg.replaceChildren();
    if (this.backBtn) { this.backBtn.remove(); this.backBtn = null; }
  }

  buildPins(c) {
    this.clearPins();
    const add = (node, at, kind, extra = {}) => {
      this.layer.append(node);
      const pin = { el: node, at: new THREE.Vector3(...at), kind, w: 0, h: 0, ...extra };
      if (kind !== 'badge') {
        pin.line = svg('line');
        pin.dot = svg('circle', { r: 3.5 });
        this.svg.append(pin.line, pin.dot);
      }
      this.pins.push(pin);
      return pin;
    };
    if (c && c.pins) { c.pins(add); return; }
    if (!c) {   // overview: a badge on each category's part
      for (const k of CATEGORIES.filter(x => x.zone)) {
        const b = el('button.callout.iconly', { title: k.label, 'aria-label': k.label, onclick: () => this.select(k.id) });
        b.innerHTML = `<span class="tt">${iconSvg(k.icon)}</span>`;
        b.append(el('span', k.label));
        add(b, ZONES[k.zone].at, 'badge');
      }
      return;
    }
    for (const card of this.cardsShown ? c.cards : []) {
      const node = el('div.ccard', el('h4', card.title), ...card.controls.map(ctl => this.control(ctl, true)));
      add(node, ANCHORS[card.anchor], 'card');
    }
    for (const chip of c.chips || []) {
      const at = ANCHORS[chip.anchor];
      add(this.chip(chip), at, 'chip', { toward: chip.toward, atFn: chip.door ? this.cut.doorPoint(chip.door, at) : null });
    }
    if (this.cardsShown) {   // on-car views get a way back at the top
      this.backBtn = el('button.carback', { onclick: () => this.back() });
      this.backBtn.innerHTML = iconSvg('back');
      this.backBtn.append(this.cardsShown ? 'All settings' : 'Back');
      this.layer.append(this.backBtn);
    }
  }

  chip(chip) {
    if (chip.kind === 'pair') return this.pairChip(chip);
    const b = el('button.callout');
    const label = el('span');
    const ic = el('span.tt');
    b.append(ic, label);
    const show = () => {
      let text = chip.label, icon = chip.kind;
      if (chip.kind === 'window') {
        const pct = this.v[chip.id];
        const tilted = chip.id === 'win.sunroof' && this.v['win.sunroofMode'] === 'tilt';
        text = `${chip.label} · ${tilted ? 'tilted' : pct <= 0 ? 'closed' : pct >= 100 ? 'open' : `${pct}%`}`;
      }
      if (chip.kind === 'port') { text = this.v[chip.id] ? 'Close charge port' : 'Open charge port'; icon = 'plug'; }
      if (chip.kind === 'heat') { const l = this.v[chip.id]; text = `${chip.label} · ${l ? `heat ${l}` : 'heat off'}`; icon = 'seat'; }
      if (ic.dataset.icon !== icon) { ic.innerHTML = iconSvg(icon); ic.dataset.icon = icon; }
      setText(label, text);
      setClass(b, 'on', chip.kind === 'heat' ? this.v[chip.id] > 0 : chip.kind === 'window' ? this.v[chip.id] > 0 || text.endsWith('tilted') : !!this.v[chip.id]);
    };
    b.addEventListener('click', () => {
      if (chip.id === 'win.sunroof') this.set('win.sunroofMode', this.v['win.sunroofMode'] === 'closed' ? 'open' : 'closed');
      else if (chip.kind === 'window') this.set(chip.id, this.v[chip.id] > 0 ? 0 : 100);   // one touch: all the way
      else if (chip.kind === 'port') { if (this.liveIds.has(chip.id)) this.app.toast(chip.off || 'The car has no message for the charge port door'); else this.set(chip.id, !this.v[chip.id]); }
      else if (chip.kind === 'heat') this.set(chip.id, (this.v[chip.id] + 1) % 4);
      else if (chip.kind === 'tire') this.app.toast('Tire pressures (mockup)');
    });
    this.watch(show);
    show();
    return b;
  }

  // A door's chip: the liftgate's has a button that opens or closes it (the doors are manual: theirs only
  // shows whether the door is open), and one that winds its window all the way down or up through the head
  // unit (the quarter windows and the rear window have no message: theirs only shows where they are). Icons
  // only, so eight fit beside the panel; the leader line says which door.
  pairChip(chip) {
    const liftgate = chip.door === 'Tailgate', glass = liftgate ? 'rear window' : 'window';
    const door = chip.door && el('button.cbtn', { onclick: () => this.toggleDoor(chip.door) });
    const win = el('button.cbtn', { onclick: () => this.windowTouch(chip) });
    if (door) door.innerHTML = iconSvg('door');
    win.innerHTML = iconSvg('window');
    const b = el('div.callout.pair', { role: 'group', 'aria-label': chip.label }, door, win);
    const show = () => {
      const open = chip.door && this.v['doors.open'].includes(chip.door), pct = this.v[chip.win];
      if (door) {
        setClass(door, 'on', open);
        door.title = liftgate ? `Liftgate: ${open ? 'close it' : 'open it'}` : `${chip.label} door: ${open ? 'open' : 'closed'} (it's manual)`;
        if (!liftgate && this.liveIds.has('doors.open')) door.disabled = true;
      }
      setClass(win, 'on', pct > 0);
      const can = chip.winSig || !this.liveIds.has(chip.win);
      win.disabled = !can;
      win.title = `${chip.label} ${glass}: ${pct <= 0 ? 'closed' : pct >= 100 ? 'open' : `${pct}% open`}${can ? '' : ' (the head unit has no message for it)'}`;
    };
    this.watch(show);
    show();
    return b;
  }

  // a window chip or the sunroof's: all the way the other way
  windowTouch(chip) {
    const pct = this.v[chip.win];
    if (chip.winSig && this.sending) this.cmd.request(MSG.BODY, { [chip.winSig]: pct > 0 ? 5 : 6 });   // Auto_Up / Auto_Down
    else if (!this.liveIds.has(chip.win)) this.set(chip.win, pct > 0 ? 0 : 100);
    else this.app.toast('The head unit has no message for this window');
  }

  // ---- per frame ---------------------------------------------------------------------------------------

  // place the pins next to their points (after the scene has rendered, so the camera is this frame's)
  frame(dt) {
    this._syncT += dt;
    if (this._syncT > LIVE_SYNC_S) { this._syncT = 0; this.syncLive(); }
    if (!this.isOpen) return;
    this._tick(dt);
    // refresh the panel's live "From the car" read-out as CAN data arrives (~5 Hz)
    if (this.app.carState && this.panel.classList.contains('open')) {
      this._liveT = (this._liveT || 0) + dt;
      if (this._liveT > 0.2) { this._liveT = 0; for (const w of this.watchers) if (w.panel) w.fn(); }
    }
    if (!this.pins.length) return;
    const cam = this.scene.camera, W = window.innerWidth, H = window.innerHeight;
    const r = this.rect || { left: 0, right: W, top: 0, bottom: H };
    const proj = (v) => { this._p.copy(v).project(cam); return [(this._p.x + 1) / 2 * W, (1 - this._p.y) / 2 * H, this._p.z < 1]; };
    const midX = (r.left + r.right) / 2;
    const placed = [];
    for (const p of this.pins) {
      const [sx, sy, front] = proj(p.atFn ? p.atFn() : p.at);
      let gone = false;
      if (p.slot && this.apa) {   // a parking space's badge: lit when chosen, and only that one once it parks
        setClass(p.el, 'on', p.slot === this.apa.selected);
        gone = ['park', 'done'].includes(this.apa.phase) && p.slot !== this.apa.selected;
      }
      if (!p.w) { p.w = p.el.offsetWidth; p.h = p.el.offsetHeight; }
      const show = !gone && front && sx > -50 && sx < W + 50 && sy > -50 && sy < H + 50;
      if (show !== p.shown) {   // the DOM only when something changed: the leader lines are one screen-sized SVG to repaint
        p.shown = show;
        p.el.style.visibility = show ? '' : 'hidden';
        if (p.line) p.line.style.visibility = p.dot.style.visibility = show ? '' : 'hidden';
      }
      if (!show) continue;
      let x, y;
      if (p.kind === 'badge') {
        x = sx - p.w / 2; y = sy - p.h / 2;
      } else if (p.kind === 'chip') {   // out from the point, away from the car's middle: its side, or its end
        const at = p.atFn ? p.atFn() : p.at;
        const [mx, my] = Math.abs(at.x) > 0.3 ? proj(this._c.set(0, at.y, at.z)) : proj(this._c.set(0, at.y, 2.4));
        let dx = sx - mx, dy = sy - my;
        const d = Math.hypot(dx, dy);
        if (d < 12) { dx = p.toward ? p.toward[0] : 0; dy = p.toward ? p.toward[1] : -1; }   // facing us: no way out to see
        else { dx /= d; dy /= d; }
        const lo = r.right - r.left >= p.w ? r.left : 8, hi = r.right - r.left >= p.w ? r.right : W - 8;
        x = Math.max(lo, Math.min(hi - p.w, sx + dx * (CHIP_GAP + p.w / 2) - p.w / 2));
        y = Math.max(8, Math.min(r.bottom - p.h, sy + dy * CHIP_GAP - p.h / 2));
        // off the cards and the chips placed already: below or above whatever it lands on
        for (let n = 0; n < 6; n++) {
          const q = placed.find(o => x < o.x + o.w + 6 && x + p.w + 6 > o.x && y < o.y + o.h + 6 && y + p.h + 6 > o.y);
          if (!q) break;
          y = sy > q.y + q.h / 2 && q.y + q.h + 6 + p.h < r.bottom ? q.y + q.h + 6 : q.y - p.h - 6;
        }
        placed.push({ x, y, w: p.w, h: p.h });
      } else {   // card: beside its point, outward, in the free area; else above or below it
        const left = sx < midX;
        const lo = r.right - r.left >= p.w ? r.left : 8, hi = r.right - r.left >= p.w ? r.right : W - 8;
        x = left ? sx - CARD_GAP - p.w : sx + CARD_GAP;
        y = Math.max(r.top, Math.min(r.bottom - p.h, sy - p.h / 2));
        if (left ? x < lo : x + p.w > hi) {
          x = Math.max(lo, Math.min(hi - p.w, sx - p.w / 2));
          y = sy + CARD_GAP + p.h < r.bottom ? sy + CARD_GAP : Math.max(r.top, sy - CARD_GAP - p.h);
        }
        // clear of the cards placed already
        for (const q of placed) {
          if (x < q.x + q.w + 8 && x + p.w + 8 > q.x && y < q.y + q.h + 8 && y + p.h + 8 > q.y) {
            y = y + p.h / 2 > q.y + q.h / 2 ? q.y + q.h + 8 : q.y - p.h - 8;
          }
        }
        placed.push({ x, y, w: p.w, h: p.h });
      }
      const key = `${x.toFixed(1)} ${y.toFixed(1)} ${sx.toFixed(1)} ${sy.toFixed(1)}`;
      if (key === p.key) continue;
      p.key = key;
      p.el.style.transform = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px)`;
      if (p.line) {   // to the nearest point of the pin, just inside its rounded corners (it's drawn over the line)
        const ex = Math.max(x + 14, Math.min(x + p.w - 14, sx)), ey = Math.max(y + 14, Math.min(y + p.h - 14, sy));
        attrs(p.line, { x1: sx.toFixed(1), y1: sy.toFixed(1), x2: ex.toFixed(1), y2: ey.toFixed(1) });
        attrs(p.dot, { cx: sx.toFixed(1), cy: sy.toFixed(1) });
      }
    }
  }

  // Before the HUD takes this frame's data: the mock parking drive moves first, and while it runs its state
  // stands in for the live one (main.js).
  beforeFrame(dt) {
    const a = this.apa;
    if (!a) return;
    a.tick(dt);
    this._apaRefresh = (this._apaRefresh || 0) + dt;
    if (a.changed || (a.phase === 'park' && this._apaRefresh > 0.2)) { a.changed = false; this._apaRefresh = 0; this.notify(); }
  }

  startApa() {
    this.stopApa();
    this.apa = new ApaMock(this);
    this.select('apa');
  }

  stopApa() {
    if (!this.apa) return;
    if (!['done', 'canceled'].includes(this.apa.phase)) this.apa.cancel();
    this.apa.dispose();
    this.apa = null;
    this.scene.update(this.app.state || {}, this.app.settings);   // the live data again
  }

  // The car's values into the controls (and onto the car model), as it reports them. A control the car reports
  // is the car's: a change sends a request and waits for the car's answer instead of pretending.
  syncLive() {
    const cs = this.app.carState;
    if (!cs || !cs.connected) {
      if (this.liveIds.size) { this.liveIds.clear(); this.notify(); }
      return;
    }
    let changed = false;
    const mode = this.liveIds.has('drive.mode') ? this.v['drive.mode'] : null;   // the mode the car reported last
    const take = (id, v) => {
      this.liveIds.add(id);
      const prev = this.v[id];
      const same = typeof v === 'object' && v !== null ? JSON.stringify(prev) === JSON.stringify(v) : prev === v;
      if (!same) { this.v[id] = v; changed = true; }
    };
    for (const [id, live] of this.liveList) {
      const v = live(cs);
      if (v !== undefined) take(id, v);
      else this.liveIds.delete(id);
    }
    for (const [id, v] of Object.entries(liveExtras(cs))) take(id, v);
    // the car changed its drive mode (its own button): the same ring out from the car as a change here, in
    // any view; not on its first report, which is only the mode it was already in
    if (mode && this.liveIds.has('drive.mode') && this.v['drive.mode'] !== mode) this.pulseMode();
    // what the car says follows on the model whether or not the controls are open
    if (changed) {
      if (this.isOpen) { this.apply(); this.notify(); }
      else this.applyBody();
    }
    if (this.mockTag) {
      const text = this.sending ? 'On the car' : this.inApp ? 'Car link down' : 'Mockup';
      if (this.mockTag.textContent !== text) { setText(this.mockTag, text); setClass(this.mockTag, 'sent', this.sending); }
    }
  }

  // the body as the car reports it: doors, liftgate, windows, sunroof (the lamps follow through the HUD's own lamp state)
  applyBody() {
    const v = this.v, cut = this.cut;
    if (!cut) return;
    for (const n of DOORS) cut.setDoor(n, n === 'Tailgate' && this.liveIds.has('doors.liftgate') ? v['doors.liftgate'] / 100 : v['doors.open'].includes(n));
    for (const k of WINDOWS) cut.setWindow(k, v['win.' + k] / 100);
    cut.setSunroof(v['win.sunroof'] / 100, v['win.sunroofMode'] === 'tilt');
    if (this.liveIds.has('seat.FL.pos')) cut.seatPose('FL', v['seat.FL.pos']);
  }

  // things that change on their own: the lighting preview's flashes, the mockup's battery charging
  _tick(dt) {
    if (this.cat === 'lighting') this.scene.lampOverride = this.lamps();
    if (!this.liveIds.has('energy.soc') && this.v['energy.charging'] && this.v['energy.soc'] < this.v['energy.limit']) {
      this.v['energy.soc'] = Math.min(this.v['energy.limit'], this.v['energy.soc'] + dt * 0.6);
      this.cut.setBattery(this.cat === 'energy', this.v['energy.soc'] / 100, true);
      this._socShown = this._socShown || 0;
      if (Math.floor(this.v['energy.soc']) !== this._socShown) { this._socShown = Math.floor(this.v['energy.soc']); this.notify(); }
    }
  }

  // ---- state -------------------------------------------------------------------------------------------

  set(id, value) {
    const def = this.defs.get(id);
    if (def && def.off && (this.inApp || def.off === MOCK_OFF)) { this.app.toast(def.off); return; }
    if (def && def.tx && this.inApp) {
      if (!this.sending) { this.app.toast(this.cmd.why || 'Not connected to the car'); return; }
      def.tx(this.cmd, value, this.app.carState);
      if (this.liveIds.has(id)) { this.notify(); return; }   // the car reports it: its answer is the new value
    }
    const prev = this.v[id];
    this.v[id] = value;
    if (id === 'drive.mode' && value !== prev) this.pulseMode();
    if ((id === 'light.ahb' || id === 'light.adb') && value) this.flash = { until: performance.now() + 1600, lamps: { high: true } };
    if (id === 'light.welcome' && value) this.flash = { until: performance.now() + 1600, lamps: { drl: true, position: true, low: true } };
    if (id === 'light.home' && value) this.flash = { until: performance.now() + 1400, lamps: { low: true, position: true } };
    if (id === 'climate.sync' && value) this.v['climate.tempR'] = this.v['climate.tempL'];
    if (id === 'climate.tempL' && this.v['climate.sync']) this.v['climate.tempR'] = value;
    if (id === 'climate.tempR' && this.v['climate.sync'] && value !== this.v['climate.tempL']) this.v['climate.sync'] = false;
    // the sunroof's mode and opening follow each other
    if (id === 'win.sunroofMode') this.v['win.sunroof'] = value === 'open' ? (this.v['win.sunroof'] || 100) : 0;
    if (id === 'win.sunroof') this.v['win.sunroofMode'] = value > 0 ? 'open' : this.v['win.sunroofMode'] === 'tilt' ? 'tilt' : 'closed';
    if (id === 'seat.memory') this.v['seat.FL.pos'] = { ...this.memory[value] };
    if (id === 'doors.locked' && value && this.v['doors.closeWin']) this.closeAll(false);   // BCM_ArmedClsWinSetSts
    this.apply();
    this.notify();
  }

  // a ring of particles out from the car in the drive mode's color
  pulseMode() {
    const mode = DRIVE_MODES.find(m => m[0] === this.v['drive.mode']);
    if (mode && this.cut) this.cut.pulse(mode[3]);
  }

  // the panels' buttons that do something rather than set something
  act(action) {
    const v = this.v;
    if (action === 'california') {
      for (const k of WINDOWS) v['win.' + k] = 100;
      Object.assign(v, { 'win.sunroof': 100, 'win.sunroofMode': 'open' });
      this.app.toast('California Mode: all eight open');
    } else if (action === 'closeAll') {
      this.closeAll();
      if (this.sending) this.app.toast('Closing the windows and the sunroof');
    } else if (action === 'hollywood') {
      v['display.hollywood'] = !v['display.hollywood'];
    } else if (action === 'saveMemory') {
      this.memory[v['seat.memory']] = { ...v['seat.FL.pos'] };
      this.app.toast(`Seat saved to memory ${v['seat.memory']} (mockup)`);
    } else if (action === 'apa') {
      this.startApa();
      return;
    }
    this.apply();
    this.notify();
  }

  // every window and the sunroof shut, and the doors too: sent to the car for what it can do (the four door
  // windows and the sunroof), and the mockup's values for the rest
  closeAll(doors = true) {
    if (this.sending) {
      for (const sig of ['ICC_LeFrntWinCtrl', 'ICC_RiFrntWinCtrl', 'ICC_LeReWinCtrl', 'ICC_RiReWinCtrl']) this.cmd.request(MSG.BODY, { [sig]: 5 });
      this.cmd.request(MSG.BODY, { ICC_SunroofPercCtrlCmdReq: 0, ICC_SunroofshadePercCtrlCmdReq: 0 });
    }
    for (const k of WINDOWS) if (!this.liveIds.has('win.' + k)) this.v['win.' + k] = 0;
    if (!this.liveIds.has('win.sunroof')) Object.assign(this.v, { 'win.sunroof': 0, 'win.sunroofMode': 'closed' });
    if (doors && !this.liveIds.has('doors.open')) this.v['doors.open'] = [];
  }

  toggleDoor(name) {
    const open = this.v['doors.open'];
    if (name === 'Tailgate' && this.sending) { this.cmd.pulse(MSG.LIFTGATE, { ICC_TrActnCmd: open.includes(name) ? 2 : 1 }); return; }
    if (this.liveIds.has('doors.open')) { this.app.toast(name === 'Tailgate' ? 'The liftgate needs the car\'s CAN link' : 'The doors are manual'); return; }
    this.set('doors.open', open.includes(name) ? open.filter(n => n !== name) : [...open, name]);
  }

  watch(fn, panel = false) { this.watchers.push({ fn, panel }); }
  notify() { for (const w of this.watchers) w.fn(); }

  // what the lighting preview shows on the car's own lamps
  lamps() {
    const v = this.v, mode = v['light.mode'];
    const L = { left: false, right: false, leftActive: false, rightActive: false, brake: false, reverse: false,
      drl: true, position: mode >= 1, low: mode === 1 || mode === 3, high: false };
    if (this.flash && performance.now() < this.flash.until) Object.assign(L, this.flash.lamps);
    return L;
  }

  // the settings, drawn on the car
  apply() {
    const v = this.v, cut = this.cut, c = this.cat;
    if (!cut) return;
    if (c !== 'lighting') this.scene.lampOverride = null;
    // seats: heat glows orange, in every view (and not at all once closed)
    const open = this.isOpen;
    for (const s of ['FL', 'FR']) {
      const heat = v[`seat.${s}.heat`];
      cut.tint(`Seat_${s}`, open && heat ? SEAT_HEAT : null, heat / 3 * 0.55);
      cut.seatPose(s, open ? v[`seat.${s}.pos`] : SEAT_MEMORY[1]);
    }
    const rear = Math.max(v['seat.RL.heat'], v['seat.RR.heat']);
    cut.tint('Seat_Rear', open && rear ? SEAT_HEAT : null, rear / 3 * 0.45);
    const tempC = (k) => v[k];
    cut.setAirflow(c === 'climate' && v['climate.on'], v['climate.fan'], tempC('climate.tempL'), tempC('climate.tempR'), v['climate.flow']);
    const mode = DRIVE_MODES.find(m => m[0] === v['drive.mode']);
    cut.setPowertrain(c === 'driving', mode && mode[3]);
    cut.setBattery(c === 'energy', v['energy.soc'] / 100, !!v['energy.charging']);
    cut.setPort(!!v['energy.port'], !!v['energy.charging']);
    cut.setMirrors?.(v['doors.mirrors'] === 'folded');
    cut.setAmp(c === 'audio');
    cut.setSound(c === 'audio' ? SEATS_FOR_STAGE[v['audio.stage']] || [] : []);
    const kinds = ['camera'];
    if (v['icc.acc'] || v['icc.facm']) kinds.push('radar');
    if (v['icc.bsd'] || v['icc.bacm'] || v['icc.fcta']) kinds.push('corner');
    if (v['icc.chime'] || v['icc.apa']) kinds.push('ultrasonic');
    cut.setSensors(c === 'assist' && v['icc.global'], kinds);
    for (const n of DOORS) cut.setDoor(n, n === 'Tailgate' && this.liveIds.has('doors.liftgate') ? v['doors.liftgate'] / 100 : v['doors.open'].includes(n));
    for (const k of WINDOWS) cut.setWindow(k, v['win.' + k] / 100);
    cut.setSunroof(v['win.sunroof'] / 100, v['win.sunroofMode'] === 'tilt');
    const theme = v['display.theme'], dark = document.documentElement.dataset.theme === 'dark';
    cut.setScreen(!!v['display.hollywood'], v['display.bright'] / 100, theme === 'light' || (theme === 'auto' && !dark));
  }

  // ---- controls ----------------------------------------------------------------------------------------

  // A control as a panel row (or block) or, compact, a row of an on-car card. One the car can't take is
  // shown greyed, with why.
  control(c, compact) {
    const node = this._control(c, compact);
    if (node && c.off && (this.inApp || c.off === MOCK_OFF)) {
      node.classList.add('off');
      node.title = c.off;
      const lbl = node.querySelector('.lbl') || node;
      if (!lbl.querySelector('.offwhy')) lbl.append(el('small.offwhy', c.off));
      for (const i of node.querySelectorAll('input, button, select')) i.disabled = true;
    }
    return node;
  }

  _control(c, compact) {
    const lbl = () => el('div.lbl', el('b', c.label), c.sub ? el('small', c.sub) : null);
    const row = (...kids) => el(compact ? 'div.crow' : 'div.row', ...kids);
    const stack = (...kids) => el(compact ? 'div.crow.stack' : 'div.row.stack', ...kids);
    switch (c.type) {
      case 'toggle': {
        const input = el('input', { type: 'checkbox', checked: !!this.v[c.id], onchange: e => this.set(c.id, e.target.checked) });
        this.watch(() => { input.checked = !!this.v[c.id]; }, !compact);
        return row(compact ? el('span', c.label) : lbl(), el('label.switch', input, el('span')));
      }
      case 'seg': {
        const seg = el('div.seg');
        for (const [val, text] of c.options) {
          seg.append(el('button', { dataset: { v: String(val) }, onclick: () => this.set(c.id, val) }, text));
        }
        const mark = () => $$('button', seg).forEach(b => setClass(b, 'on', b.dataset.v === String(this.v[c.id])));
        this.watch(mark, !compact);
        mark();
        const long = c.options.length > 3 || c.options.some(o => String(o[1]).length > 10);
        return long || compact && c.options.length > 2 ? stack(compact ? el('span', c.label) : lbl(), seg) : row(compact ? el('span', c.label) : lbl(), seg);
      }
      case 'slider': {
        const out = el('em');
        const fmt = (x) => `${c.min < 0 && x > 0 ? '+' : ''}${x}${c.unit ? (c.unit.startsWith('%') ? c.unit : ' ' + c.unit) : ''}`;
        const input = el('input', { type: 'range', min: c.min, max: c.max, step: c.step, value: this.v[c.id] });
        const paint = () => {
          const x = Number(input.value);
          setText(out, fmt(x));
          input.style.setProperty('--p', `${(x - c.min) / (c.max - c.min) * 100}%`);
        };
        input.addEventListener('input', () => { this.v[c.id] = Number(input.value); paint(); this.apply(); });
        input.addEventListener('change', () => this.set(c.id, Number(input.value)));
        this.watch(() => { if (document.activeElement !== input) { input.value = this.v[c.id]; paint(); } }, !compact);
        paint();
        const head = el('div.lbl', el(compact ? 'span' : 'b', c.label), out);
        return el(compact ? 'div.crow.stack.slider' : 'div.row.slider', head, input);
      }
      case 'select': {
        const sel = el('select', { onchange: e => this.set(c.id, c.options.find(o => String(o[0]) === e.target.value)[0]) },
          ...c.options.map(([val, text]) => el('option', { value: String(val) }, text)));
        sel.value = String(this.v[c.id]);
        return row(lbl(), sel);
      }
      case 'levels': {
        const box = el(`div.levels.${c.kind}`);
        const off = el('button.off', { onclick: () => this.set(c.id, 0) }, 'Off');
        box.append(off);
        for (let n = 1; n <= c.max; n++) {
          const b = el('button', { 'aria-label': `${c.label} ${n}`, onclick: () => this.set(c.id, n) });
          for (let i = 0; i < 3; i++) b.append(el('i', { style: { opacity: i < n ? '' : '0.15' } }));
          box.append(b);
        }
        const mark = () => $$('button', box).forEach((b, i) => setClass(b, 'on', i > 0 && i === this.v[c.id]));
        this.watch(mark, !compact);
        mark();
        return row(compact ? el('span', c.label) : lbl(), box);
      }
      case 'seatpos': return this.seatPos(c, compact);
      case 'hold': return this.holdControl(c, compact);
      case 'charging': return this.chargingInfo();
      case 'memory': {
        const seg = el('div.seg');
        for (const n of [1, 2, 3]) seg.append(el('button', { dataset: { v: String(n) }, onclick: () => this.set(c.id, n) }, String(n)));
        const mark = () => $$('button', seg).forEach(b => setClass(b, 'on', b.dataset.v === String(this.v[c.id])));
        this.watch(mark, !compact);
        mark();
        const save = el('button.btn.small', { onclick: () => this.act('saveMemory') }, 'Save');
        if (c.noSave && this.inApp) { save.disabled = true; save.title = c.noSave; }
        return row(compact ? el('span', c.label) : lbl(), el('div.memory', seg, save));
      }
      case 'modes': {
        const box = el('div.modes');
        for (const [val, text, sub, color] of c.options) {
          box.append(el('button', { dataset: { v: val }, style: { '--mode': color }, onclick: () => this.set(c.id, val) }, el('b', text), el('small', sub)));
        }
        const mark = () => $$('button', box).forEach(b => setClass(b, 'on', b.dataset.v === this.v[c.id]));
        this.watch(mark, true);
        mark();
        return box;
      }
      case 'checks': {
        const box = el('div.checks');
        for (const [val, text] of c.options) {
          const input = el('input', { type: 'checkbox', checked: this.v[c.id].includes(val),
            onchange: e => this.set(c.id, e.target.checked ? [...this.v[c.id], val] : this.v[c.id].filter(x => x !== val)) });
          this.watch(() => { input.checked = this.v[c.id].includes(val); }, !compact);
          box.append(el('label', input, text));
        }
        return stack(lbl(), box);
      }
      case 'button': {
        const b = el(`button.btn${c.style ? '.' + c.style : ''}`, { onclick: () => this.app.toast(c.toast || MOCK_NOTE) }, c.label);
        return el('div.btns', b);
      }
      case 'action': {
        const b = el(`button.btn${c.style ? '.' + c.style : ''}`, { title: c.sub || '', onclick: () => this.act(c.action) }, c.label);
        if (c.action === 'hollywood') this.watch(() => setText(b, this.v['display.hollywood'] ? 'Exit Hollywood Mode' : c.label), !compact);
        return el('div.btns', b, c.sub ? el('small.btnsub', c.sub) : null);
      }
      case 'list': return el('div.rows.plist', ...c.items.map(([t, s, ok]) => el('div.row', el('div.lbl', el('b', t), el(ok ? 'small.ok' : 'small', s)))));
      case 'info': return el('div.kv.info', ...c.items.flatMap(([k, val]) => [el('span', k), el('span', val)]));
      case 'note': return el('p.desc', c.text);
      case 'temps': return this.temps();
      case 'hero': return this.energyHero();
      case 'lock': return this.lockHero();
      default: return null;
    }
  }

  // A seat's adjusters, laid out like the switch on the seat's side: the cushion slides, its front and
  // rear edges go up and down, the back reclines. Beside them, the seat seen from the side (facing left,
  // the way the car goes), drawn in the position set (movements exaggerated so they read). Held, a button
  // keeps going.
  seatPos(c, compact) {
    const id = c.id;
    const pic = el('div.seatpic');
    pic.innerHTML = `<svg viewBox="0 0 150 104" aria-hidden="true">
      <rect class="rail" x="38" y="92" width="74" height="4" rx="2"/>
      <g class="seat"><g class="cushion"><rect x="36" y="64" width="70" height="15" rx="7"/></g>
      <g class="back"><rect x="94" y="14" width="15" height="60" rx="7"/><rect x="96" y="1" width="12" height="15" rx="5"/></g></g></svg>`;
    const seat = pic.querySelector('.seat'), cushion = pic.querySelector('.cushion'), backrest = pic.querySelector('.back');
    const draw = () => {
      const q = this.v[id];
      seat.setAttribute('transform', `translate(${(-q.slide * 180).toFixed(1)} ${(-(q.front + q.rear) / 2 * 260).toFixed(1)})`);
      cushion.setAttribute('transform', `rotate(${(-Math.atan2(q.front - q.rear, 0.5) / Math.PI * 180 * 2.5).toFixed(1)} 71 71)`);
      backrest.setAttribute('transform', `rotate(${(q.recline / Math.PI * 180).toFixed(1)} 101 72)`);
    };
    const nudge = (key, sign) => {
      if (this.liveIds.has(id)) return;   // the car's seat moves by the car's request below, and reports where it is
      const q = { ...this.v[id] }, [lo, hi] = SEAT_LIMITS[key];
      q[key] = Math.max(lo, Math.min(hi, q[key] + sign * SEAT_STEP[key]));
      const prev = this.v[id];
      this.v[id] = q;
      this.apply();
      this.notify();
      if (prev === q) this.set(id, q);
    };
    // held: the head unit's manual-move request every 100 ms (ICC_0x533: 1 = forward / up, 2 = back / down),
    // then "Off"; without the car's link, the mockup's seat moves instead
    const hold = (label, text, key, sign) => {
      const b = el('button', { 'aria-label': label, title: label }, text);
      let timer = 0, holding = false;
      const sig = c.moves && c.moves[key];
      const start = () => {
        if (sig && this.inApp) {
          if (!this.sending) { this.app.toast(this.cmd.why || 'Not connected to the car'); return; }
          holding = this.cmd.hold(MSG.SEATMOVE, { [sig]: sign > 0 ? 1 : 2 });
          setClass(b, 'held', holding);
          return;
        }
        if (sig === undefined && c.moves && this.inApp) { this.app.toast('The head unit has no message for this adjuster'); return; }
        nudge(key, sign); clearInterval(timer); timer = setInterval(() => nudge(key, sign), 90);
      };
      const stop = () => { clearInterval(timer); if (holding) { holding = false; setClass(b, 'held', false); this.cmd.release(MSG.SEATMOVE); } };
      b.addEventListener('pointerdown', (e) => { e.preventDefault(); start(); });
      for (const ev of ['pointerup', 'pointerleave', 'pointercancel']) b.addEventListener(ev, stop);
      b.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); if (!sig || !this.inApp) nudge(key, sign); } });
      return b;
    };
    const pair = (name, key, a, b) => el('div.adj', el('small', name),
      hold(`${name} ${a[0]}`, a[1], key, a[2]), hold(`${name} ${b[0]}`, b[1], key, b[2]));
    // on the car the cushion tilts (its front edge) and rises as a whole (height); the mockup moves each edge
    const car = !!(c.moves && this.inApp);
    const grid = el('div.adjs',
      pair('Slide', 'slide', ['forward', '◀', 1], ['back', '▶', -1]),
      pair('Back', 'recline', ['up', '↶', -1], ['down', '↷', 1]),
      pair(car ? 'Tilt' : 'Front', 'front', ['up', '▲', 1], ['down', '▼', -1]),
      pair(car ? 'Height' : 'Rear', 'rear', ['up', '▲', 1], ['down', '▼', -1]));
    this.watch(draw, !compact);
    draw();
    const box = el('div.seatpos', pic, grid);
    return compact ? el('div.crow.stack', el('span', c.label), box) : el('div.row.stack', el('div.lbl', el('b', c.label)), box);
  }

  // Buttons held (or tapped) that ask the car for a motion: the windows (the head unit's all-the-way up or
  // down; a second press while it moves should stop it, so a release after a long press sends it again) and
  // the liftgate (open, stop, close). Beside them, where the car says it is.
  holdControl(c, compact) {
    const out = el('em');
    const box = el('div.holdbtns');
    for (const b of c.buttons || []) {
      const btn = el('button', { 'aria-label': `${c.label} ${b.label}` }, b.label);
      let downAt = 0;
      const go = () => {
        if (!this.inApp) { this.set(c.id, b.label === 'Up' || b.label === 'Close' ? 0 : 100); return; }   // the mockup
        if (!this.sending) { this.app.toast(this.cmd.why || 'Not connected to the car'); return; }
        b.down(this.cmd);
      };
      btn.addEventListener('pointerdown', (e) => { e.preventDefault(); downAt = performance.now(); setClass(btn, 'held', true); go(); });
      const up = () => {
        if (!downAt) return;
        const held = performance.now() - downAt;
        downAt = 0;
        setClass(btn, 'held', false);
        if (b.again && held > 350 && this.sending) b.down(this.cmd);   // let go mid-way: the same request again, to stop
      };
      for (const ev of ['pointerup', 'pointercancel', 'pointerleave']) btn.addEventListener(ev, up);
      btn.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go(); } });
      box.append(btn);
    }
    box.append(out);
    const show = () => {
      const v = this.v[c.id];
      setText(out, v == null ? '—' : c.unit ? `${v}${c.unit.startsWith('%') ? c.unit : ' ' + c.unit}` : String(v));
    };
    this.watch(show, !compact);
    show();
    const head = el('div.lbl', el('b', c.label), c.sub ? el('small', c.sub) : null);
    return el(compact ? 'div.crow.stack' : 'div.row.stack', head, box);
  }

  // Energy: what the car reports about charging, as a block (the hero above has the battery itself)
  chargingInfo() {
    const box = el('div.charging');
    const show = () => {
      const cs = this.app.carState;
      const items = cs ? LIVE.energy(cs).filter(([k]) => k !== 'Battery') : [];
      box.replaceChildren();
      if (!items.length) { box.append(el('span.k', cs && cs.demo ? 'Demo' : this.inApp ? 'No charging data from the car' : 'Charging data comes from the car\'s own buses (the app on the car)')); return; }
      const power = items.find(([k]) => k === 'Battery power');
      if (power) box.append(el('div.big', `${power[1]}`));
      for (const [k, v] of items) if (k !== 'Battery power') box.append(el('span.k', k), el('span', v));
    };
    this.watch(show, true);
    show();
    return box;
  }

  // The mock parking's panel: where it's at, the spaces it found, start and cancel, and the CAN signals
  // both sides would have sent, with a log of each change.
  apaPanel(apa) {
    const title = el('b'), sub = el('span'), bar = el('div.bar', el('i'));
    const hero = el('div.hero.apa', el('div.pmark', 'P'), el('div.meta', title, sub, bar));
    const spaces = el('div.spaces');
    const dir = el('div.seg', ...[[true, 'Back in'], [false, 'Nose in']].map(([back, text]) =>
      el('button', { dataset: { v: String(back) }, onclick: () => apa.setDirection(back) }, text)));
    const start = el('button.btn.primary', { onclick: () => apa.start() }, 'Start parking');
    const cancel = el('button.btn.danger', { onclick: () => apa.cancel() }, 'Cancel');
    const done = el('button.btn', { onclick: () => this.select('assist') }, 'Done');
    const sigs = el('div.cansig'), log = el('div.canlog');
    const show = () => {
      const [t, s] = apa.status();
      setText(title, t);
      setText(sub, s);
      const driving = apa.phase === 'park' || apa.phase === 'done';
      bar.style.display = driving ? '' : 'none';
      bar.firstChild.style.width = `${(apa.progress() * 100).toFixed(1)}%`;
      if (spaces.childElementCount !== apa.found.length) {
        spaces.replaceChildren(...apa.found.map(q => el('button.space', { dataset: { id: String(q.id) }, onclick: () => apa.choose(q.id) },
          el('b', `P${q.id}`), el('small', 'Perpendicular · right'))));
      }
      if (!apa.found.length) spaces.replaceChildren(el('p.desc', 'None yet: the car reports spaces once it has passed them.'));
      $$('button.space', spaces).forEach(b => { setClass(b, 'on', Number(b.dataset.id) === apa.selected); b.disabled = driving; });
      $$('button', dir).forEach(b => { setClass(b, 'on', b.dataset.v === String(apa.dirBack)); b.disabled = driving; });
      start.disabled = apa.phase !== 'ready';
      const over = apa.phase === 'done' || apa.phase === 'canceled';
      cancel.style.display = over ? 'none' : '';
      done.style.display = over ? '' : 'none';
      sigs.replaceChildren(...Object.entries(APA_SIGNALS).flatMap(([key, [way, msg, name, table]]) => {
        const val = apa.sig[key];
        return [el('code', name), el('span', val == null ? '–' : table ? table[val] ?? String(val) : String(val)),
          el(`small.${way}`, `${way === 'to' ? 'head unit →' : 'ADAS →'} ${msg}`)];
      }));
      log.replaceChildren(...apa.log.slice(0, 16).map(e => el(`div.${e.dir}`, el('small', `+${e.t.toFixed(1)} s`),
        el('b', `${e.dir === 'to' ? '→' : '←'} ${e.msg}`), el('span', e.text))));
    };
    this.watch(show, true);
    show();
    const section = (name, ...kids) => el('div.section', name ? el('h3', name) : null, ...kids);
    return [
      hero,
      section('Spaces', spaces, el('div.rows', el('div.row', el('div.lbl', el('b', 'Park'), el('small', 'ICC_APAParkInDirSetting')), dir))),
      el('div.btns', start, cancel, done),
      section('On CAN', el('p.desc', 'Signal names and values from fisker_ocean_adas_world.dbc. The order they come in is our reading of the DBC, not a recorded drive.'), sigs),
      section('Messages', log),
    ];
  }

  // climate: driver and passenger set temperatures, in the units General asks for
  temps() {
    const box = el('div.temps');
    const f = () => this.v['general.temp'] === 'f';
    const fmt = (t) => (f() ? `${Math.round(t * 9 / 5 + 32)}°` : `${t.toFixed(1)}°`);
    for (const [key, label] of [['climate.tempL', 'Driver'], ['climate.tempR', 'Passenger']]) {
      const val = el('b');
      const step = (d) => this.set(key, Math.max(16, Math.min(28, Math.round((this.v[key] + d) * 2) / 2)));
      const minus = el('button', { 'aria-label': `${label} cooler`, onclick: () => step(f() ? -5 / 9 : -0.5) }, '−');
      const plus = el('button', { 'aria-label': `${label} warmer`, onclick: () => step(f() ? 5 / 9 : 0.5) }, '+');
      box.append(el('div.temp', el('small', label), el('div.stepper', minus, val, plus)));
      this.watch(() => setText(val, fmt(this.v[key])), true);
    }
    const sync = el('input', { type: 'checkbox', onchange: e => this.set('climate.sync', e.target.checked) });
    this.watch(() => { sync.checked = this.v['climate.sync']; }, true);
    box.append(el('label.sync', sync, 'Sync'));
    this.notify();
    return box;
  }

  energyHero() {
    const big = el('div.big'), meta = el('div.meta'), bar = el('div.bar', el('i'), el('em'));
    const show = () => {
      const soc = this.v['energy.soc'], lim = this.v['energy.limit'];
      big.replaceChildren(String(Math.floor(soc)), el('small', '%'));
      const range = Math.round(RANGE_MI * soc / 100);
      const cs = this.app.carState, live = this.liveIds.has('energy.soc');
      let status;
      if (live) {
        const kw = this.v['energy.power'] || 0, gun = cs.rawOf('VCU_ACChrgDchaGunCnctnSts'), left = cs.rawOf('VCU_ACRmngChrgTi');
        const leftText = left !== undefined && left < 0xFFFF ? ` · ${left >= 60 ? `${Math.floor(left / 60)} h ${left % 60} min` : `${left} min`} left` : '';
        status = kw > 0.3 ? `Charging · ${kw.toFixed(1)} kW${leftText}` : gun === 2 ? 'Plugged in, not charging' : this.v['energy.port'] ? 'Charge port open' : kw < -0.3 ? `Using ${(-kw).toFixed(1)} kW` : 'Not plugged in';
      } else {
        status = this.v['energy.charging']
          ? (soc >= lim ? `Charged to your ${lim}% limit` : `Charging · 7.4 kW · ${Math.ceil((lim - soc) * 0.12 * 10) / 10} h to ${lim}%`)
          : this.v['energy.port'] ? 'Charge port open' : 'Not plugged in';
      }
      meta.replaceChildren(el('b', `${range} mi range`), status);
      bar.firstChild.style.width = `${soc}%`;
      bar.lastChild.style.left = `${lim}%`;
    };
    this.watch(show, true);
    show();
    return el('div.hero', big, el('div', { style: { flex: '1', minWidth: '0' } }, meta, bar));
  }

  lockHero() {
    const icon = el('span.tt'), text = el('div.meta'), btn = el('button.btn.primary', { onclick: () => this.set('doors.locked', !this.v['doors.locked']) });
    if (!this.sending && this.inApp) btn.disabled = true;
    const show = () => {
      const locked = this.v['doors.locked'];
      icon.innerHTML = iconSvg(locked ? 'lock' : 'unlock');
      text.replaceChildren(el('b', locked ? 'Locked' : 'Unlocked'), locked ? 'All doors and the liftgate' : 'Walk away to lock');
      setText(btn, locked ? 'Unlock' : 'Lock');
    };
    this.watch(show, true);
    show();
    return el('div.hero.lock', icon, text, btn);
  }
}

function svg(tag, a = {}) {
  const n = document.createElementNS('http://www.w3.org/2000/svg', tag);
  return attrs(n, a);
}

function attrs(n, a) {
  for (const [k, v] of Object.entries(a)) n.setAttribute(k, v);
  return n;
}
