// Car controls. Tap the car: a dock of categories rises at the bottom, the camera goes to a top view with
// the roof faded so the cabin shows, and the part each category is about glows under a badge. A category
// opens a sheet over the lower part of the screen (the car is framed in what's left, and the sheet has
// three heights) and puts controls on the car itself: drag controls on the windows, the sunroof and the
// liftgate, heat chips on the rear seats, tire pressures on the wheels. The look is DESIGN.md's
// (design.css, the `fo-` classes): the car shows the state, the sheet holds what the car can't show.
//
// On the car (the Android app, wired to IBUS1/IBUS2) the controls are live: their values follow what the
// car reports (carcatalog.js `live`, from carstate.js), and so does the 3D car: doors, liftgate, windows,
// sunroof, seats, lamps. Setting a control sends the head unit's own message (`tx`, through cancmd.js and
// the app) and the car's answer shows when it comes; what can't be sent is greyed with the reason (`off`).
// In a plain browser nothing is live and nothing is sent: the values live in this page (this.v).
import * as THREE from '../vendor/three.module.min.js';
import { $, $$, el, iconSvg, setClass, setText } from './util.js';
import { CATEGORIES, DRIVE_MODES, SEAT_LIMITS, SEAT_MEMORY, MSG, defaults, liveControls, liveExtras } from './carcatalog.js';
import { ZONES, ANCHORS } from './cutaway.js';
import { ApaMock, APA_SIGNALS } from './apamock.js';

const OVERVIEW = { at: [0, 0.6, 2.4], az: 180, el: 90, fit: [2.3, 5.1] };   // top down, nose up...
const OVERVIEW_WIDE = { at: [0, 0.6, 2.4], az: 90, el: 90, fit: [5.1, 2.3] };   // ...or right, on a short screen
const SHORT_PX = 420;     // free height below which the overview turns the car on its side
const MOCK_OFF = 'Mockup: nothing on the car for this';   // carcatalog.js MOCK: off in the browser too
const LIVE_SYNC_S = 0.2;   // how often the controls take the car's values
const SEAT_HEAT = 0xff6a2a;
const CARD_GAP = 56;      // px between a card and the point it's about
const CARDS_MIN_W = 840;  // px of free width that fits two cards beside the car (landscape only; portrait puts them in the sheet)
const CHIP_GAP = 46;      // px a chip sits out from its point, away from the car's center
const SEATS_FOR_STAGE = { all: ['FL', 'FR', 'RL', 'RR'], driver: ['FL'], passenger: ['FR'], front: ['FL', 'FR'], rear: ['RL', 'RR'] };
const WINDOWS = ['FL', 'FR', 'RL', 'RR', 'QL', 'QR', 'rear'];   // cutaway.js WINDOWS; the sunroof is apart
const DOORS = ['Door_Front_L', 'Door_Front_R', 'Door_Rear_L', 'Door_Rear_R', 'Tailgate'];   // cutaway.js DOORS
const SEAT_STEP = { slide: 0.01, front: 0.004, rear: 0.004, recline: 0.025 };   // per press, and every 90 ms held
const RANGE_MI = 330;     // EPA range at 100%, for the mock range readout
const DETENTS = ['peek', 'half', 'full'];   // the sheet's heights in portrait (DESIGN.md): 448, 848, 1360 frame px
const SHEET_REM = { peek: 28, half: 53, full: 85, hvac: 22 };   // hvac: Climate's three fixed rows
const DRAG_PX = 160;      // px of drag on a window control for the whole travel
const DRAG_TAP = 8;       // px under which a drag is a tap

const icon = (name) => { const s = el('span.fo-icon'); s.innerHTML = iconSvg(name); return s; };
const clamp = (x, lo = 0, hi = 100) => Math.max(lo, Math.min(hi, x));

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
    this.detent = 'half';
    this.v = defaults();
    this.defs = new Map();      // control id -> its definition (live, tx, off)
    for (const cat of CATEGORIES) {
      for (const card of cat.cards || []) for (const c of card.controls) if (c.id) this.defs.set(c.id, c);
      for (const sec of cat.sections || []) for (const c of sec.controls || []) if (c.id) this.defs.set(c.id, c);
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
  get portrait() { return window.innerWidth <= window.innerHeight; }
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
    if (c && c.id !== this.cat) this.detent = c.hvac ? 'hvac' : (c.detent || 'half');   // a long list opens at full; Climate has its own height
    this.cat = c && c.id;
    $$('.fo-dock__item', this.ribbon).forEach(b => {
      setClass(b, 'on', b.dataset.cat === this.cat);
      // into view along the dock only: scrollIntoView would also scroll #app to a dock still sliding
      // in, shifting the whole HUD up
      if (b.dataset.cat === this.cat) {
        const items = b.parentElement, l = b.offsetLeft - items.offsetLeft, r = l + b.offsetWidth;
        if (l < items.scrollLeft) items.scrollLeft = l;
        else if (r > items.scrollLeft + items.clientWidth) items.scrollLeft = r - items.clientWidth;
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

  /** The sheet's height in portrait at the current detent, px (its CSS transition is still running when layout() asks). */
  sheetH() {
    const rem = parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
    return SHEET_REM[this.detent] * rem;
  }

  // The screen area the car is framed in: right of / below the status card, above the dock, beside
  // or above the sheet.
  freeRect() {
    const W = window.innerWidth, H = window.innerHeight;
    const card = $('#drive').getBoundingClientRect();
    const dockH = this.ribbon.offsetHeight;
    const panel = this.panel.classList.contains('open');
    const back = this.backBtn ? 52 : 0;
    if (this.portrait) {
      return { left: 10, right: W - 10, top: card.bottom + 10 + back, bottom: (panel ? H - dockH - this.sheetH() : H - dockH) - 10 };
    }
    return { left: card.right + 16, right: (panel ? W - 16 - this.panel.offsetWidth : W) - 16, top: 16 + back, bottom: H - dockH - 12 };
  }

  // whether the on-car cards fit beside the car (else they're shown in the sheet): landscape only
  roomForCards() {
    const W = window.innerWidth, card = $('#drive').getBoundingClientRect();
    return !this.portrait && W - card.right - 32 >= CARDS_MIN_W;
  }

  // frame the current category in the free area (on a resize too)
  layout(instant = false) {
    if (!this.isOpen) return;
    const cat = this.category;
    if (cat && cat.cards && this.cardsShown !== this.roomForCards()) { this.select(cat.id); return; }   // cards <-> sheet
    document.documentElement.style.setProperty('--ribbon-h', `${this.ribbon.offsetHeight}px`);
    const r = this.rect = this.freeRect();
    if (this.backBtn) this.backBtn.style.left = `${(r.left + r.right) / 2}px`;
    this.scene.setFrame(r);
    const c = this.category, f = (c && c.focus) || (r.bottom - r.top < SHORT_PX && r.right - r.left > r.bottom - r.top ? OVERVIEW_WIDE : OVERVIEW);
    this.scene.focus(f.fitP && this.portrait ? { ...f, fit: f.fitP } : f, instant);
  }

  setDetent(d) {
    if (!DETENTS.includes(d) || d === this.detent || this.detent === 'hvac') return;
    this.detent = d;
    for (const k of DETENTS) setClass(this.panel, k, k === d);
    this.layout();
  }

  // ---- dock and sheet ----------------------------------------------------------------------------------

  buildRibbon() {
    const items = el('div.fo-dock__items');
    let sep = false;
    for (const c of CATEGORIES) {
      if (c.system && !sep) { items.append(el('i.fo-dock__sep')); sep = true; }
      const b = el('button.fo-dock__item', { dataset: { cat: c.id }, title: c.label, onclick: () => this.select(this.cat === c.id ? null : c.id) });
      b.append(icon(c.icon), el('span', c.short || c.label));
      items.append(b);
    }
    const done = el('button.fo-ib', { title: 'Close', 'aria-label': 'Close car controls', onclick: () => this.exit() }, icon('close'));
    this.mockTag = el('span.fo-dock__state', 'Mockup');
    this.ribbon.replaceChildren(this.mockTag, items, done);
    this.ribbon.setAttribute('aria-hidden', 'true');
  }

  showPanel(c) {
    this.watchers = this.watchers.filter(w => !w.panel);
    if (!c) {
      this.panel.classList.remove('open');
      this.panel.setAttribute('aria-hidden', 'true');
      return;
    }
    const handle = el('div.fo-sheet__handle', el('i'));
    if (!c.hvac) this.bindHandle(handle);
    const back = el('button.fo-ib', { 'aria-label': 'Back', title: 'Back', onclick: () => this.back() }, icon('back'));
    const h2 = el('h2', icon(c.icon), c.label);
    const close = el('button.fo-ib', { 'aria-label': 'Close', title: 'Close', onclick: () => this.exit() }, icon('close'));
    const body = el('div.fo-sheet__body');
    if (c.render) body.append(...c.render());
    for (const sec of c.render ? [] : c.sections || c.cards.map(card => ({ title: card.title, controls: card.controls }))) {
      const node = this.section(sec);
      if (node) body.append(node);
    }
    // keep the scroll position when the same sheet is rebuilt
    const keep = this.panelCat === c.id ? this.panel.querySelector('.fo-sheet__body')?.scrollTop : 0;
    this.panel.replaceChildren(handle, el('div.fo-sheet__head', back, h2, close), body);
    body.scrollTop = keep || 0;
    this.panelCat = c.id;
    for (const k of DETENTS) setClass(this.panel, k, k === this.detent);
    setClass(this.panel, 'hvac', this.detent === 'hvac');
    this.panel.classList.add('open');
    this.panel.setAttribute('aria-hidden', 'false');
  }

  // the handle: drag it up or down to the next height, tap it to step through
  bindHandle(handle) {
    let y0 = null;
    handle.addEventListener('pointerdown', (e) => { y0 = e.clientY; capture(handle, e); });
    const end = (e) => {
      if (y0 == null) return;
      const dy = e.clientY - y0;
      y0 = null;
      const i = DETENTS.indexOf(this.detent);
      if (dy < -40) this.setDetent(DETENTS[Math.min(2, i + 1)]);
      else if (dy > 40) this.setDetent(DETENTS[Math.max(0, i - 1)]);
      else if (Math.abs(dy) < DRAG_TAP) this.setDetent(DETENTS[(i + 1) % 3]);
    };
    handle.addEventListener('pointerup', end);
    handle.addEventListener('pointercancel', () => { y0 = null; });
  }

  // A group of the sheet: a heading, then its controls laid out by its kind (carcatalog.js).
  section(sec) {
    if (sec.kind === 'hidden') return null;
    const s = el('div.fo-group');
    if (sec.title) s.append(el('h3', sec.icon ? icon(sec.icon) : null, sec.title, sec.note ? el('small', sec.note) : null));
    else if (sec.note) s.append(el('p.fo-note', sec.note));
    if (sec.kind === 'climate') { s.append(...this.climate(sec.controls)); return s; }
    if (sec.kind === 'status') { s.append(this.energyStatus()); return s; }
    if (sec.kind === 'tiles') {
      const g = el('div.fo-tiles');
      for (const ctl of sec.controls) { const n = this.control(ctl, 'tile'); if (n) g.append(n); }
      s.append(g);
      return s;
    }
    // rows run together between hairlines; blocks (buttons, the lock) sit between them
    let rows = el('div.fo-rows');
    for (const ctl of sec.controls || []) {
      const node = this.control(ctl, 'row');
      if (!node) continue;
      if (node.classList.contains('fo-row')) { rows.append(node); continue; }
      if (rows.childElementCount) { s.append(rows); rows = el('div.fo-rows'); }
      s.append(node);
    }
    if (rows.childElementCount) s.append(rows);
    return s;
  }

  // ---- pins: badges, cards, chips and controls on the car ----------------------------------------------

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
      if (kind !== 'badge' && kind !== 'ctl') {   // a control sits on its part; a chip or card points at it
        pin.line = svg('line');
        pin.dot = svg('circle', { r: 3 });
        this.svg.append(pin.line, pin.dot);
      }
      this.pins.push(pin);
      return pin;
    };
    if (c && c.pins) { c.pins(add); return; }
    if (!c) {   // overview: a badge on each category's part
      for (const k of CATEGORIES.filter(x => x.zone)) {
        const b = el('button.fo-chip.badge', { title: k.label, 'aria-label': k.label, onclick: () => this.select(k.id) }, icon(k.icon));
        add(b, ZONES[k.zone].at, 'badge');
      }
      return;
    }
    for (const card of this.cardsShown ? c.cards : []) {
      const node = el('div.ccard', el('h4', card.title), ...card.controls.map(ctl => this.control(ctl, 'row')).filter(Boolean));
      add(node, ANCHORS[card.anchor], 'card');
    }
    for (const chip of c.chips || []) {
      const at = ANCHORS[chip.anchor];
      const ctl = chip.kind === 'winctl' || chip.kind === 'liftctl';
      add(this.chip(chip), at, ctl ? 'ctl' : 'chip', { toward: chip.toward, atFn: chip.door ? this.cut.doorPoint(chip.door, at) : null });
    }
    if (this.cardsShown) {   // on-car views get a way back at the top
      this.backBtn = el('button.carback.fo-chip', { onclick: () => this.back() }, icon('back'), 'All settings');
      this.layer.append(this.backBtn);
    }
  }

  chip(chip) {
    if (chip.kind === 'winctl' || chip.kind === 'liftctl') return this.winCtl(chip);
    const b = el('button.fo-chip');
    const ic = el('span.fo-icon');
    const label = el('span');
    b.append(ic, label);
    const show = () => {
      let text = chip.label, name = chip.kind;
      if (chip.kind === 'heat') { const l = this.v[chip.id]; text = `${chip.label} · ${l ? `heat ${l}` : 'heat off'}`; name = 'seatheat'; setClass(b, 'on', l > 0); }
      if (chip.kind === 'tire') name = 'tire';
      if (ic.dataset.icon !== name) { ic.innerHTML = iconSvg(name); ic.dataset.icon = name; }
      setText(label, text);
    };
    b.addEventListener('click', () => {
      if (chip.kind === 'heat') this.set(chip.id, (this.v[chip.id] + 1) % 4);
      else if (chip.kind === 'tire') this.app.toast('Tire pressures (mockup)');
    });
    this.watch(show);
    show();
    return b;
  }

  // A drag control on a window, the sunroof or the liftgate: a knob between two arrows. Dragging the knob
  // down opens a window (up opens the liftgate); a tap on an arrow goes all the way. The mockup's glass
  // follows the finger; on the car only "all the way" exists (the head unit's Auto_Up / Auto_Down), so the
  // direction of the drag is sent when it ends. An arrow lights while there is travel left that way.
  winCtl(chip) {
    const id = chip.id, lift = chip.kind === 'liftctl';
    const up = el('button.fo-winctl__arrow', { 'aria-label': `${chip.label}: ${lift ? 'open' : 'close'}` }, icon('chevUp'));
    const knob = el('div.fo-winctl__knob', icon(lift ? 'door' : 'window'));
    const down = el('button.fo-winctl__arrow', { 'aria-label': `${chip.label}: ${lift ? 'close' : 'open'}` }, icon('chevDown'));
    const box = el('div.fo-winctl', { role: 'group', 'aria-label': chip.label }, up, knob, down);
    const pct = () => this.v[id] || 0;
    const show = () => {
      const p = pct();
      setClass(box, 'on', p > 0);
      setClass(up, 'lit', lift ? p < 100 : p > 0);
      setClass(down, 'lit', lift ? p > 0 : p < 100);
    };
    const upTarget = lift ? 100 : 0, downTarget = lift ? 0 : 100;
    up.addEventListener('click', () => this.travel(chip, upTarget));
    down.addEventListener('click', () => this.travel(chip, downTarget));
    let active = null, y0 = 0, v0 = 0, moved = false;
    knob.addEventListener('pointerdown', (e) => { e.preventDefault(); active = e.pointerId; capture(knob, e); y0 = e.clientY; v0 = pct(); moved = false; setClass(box, 'drag', true); });
    knob.addEventListener('pointermove', (e) => {
      if (e.pointerId !== active) return;
      const dy = e.clientY - y0;
      if (Math.abs(dy) > DRAG_TAP) moved = true;
      if (moved && !this.liveIds.has(id)) {   // the mockup: the glass follows the finger
        this.v[id] = clamp(v0 + (lift ? -dy : dy) / DRAG_PX * 100);
        if (chip.sunroof && this.v['win.sunroofMode'] === 'tilt') this.v['win.sunroofMode'] = 'closed';
        this.apply();
        this.notify();
      }
    });
    const end = (e) => {
      if (e.pointerId !== active) return;
      active = null;
      setClass(box, 'drag', false);
      const dy = e.clientY - y0;
      if (!moved) this.travel(chip, pct() > 0 ? 0 : 100);   // a tap: the other way, all the way
      else if (this.liveIds.has(id)) this.travel(chip, (lift ? -dy : dy) > 0 ? 100 : 0);   // the car: the drag's direction
      else this.set(id, this.v[id]);
    };
    knob.addEventListener('pointerup', end);
    knob.addEventListener('pointercancel', end);
    this.watch(show);
    show();
    return box;
  }

  // a window, the sunroof or the liftgate all the way to target (0 shut, 100 open)
  travel(chip, target) {
    const id = chip.id;
    if (chip.kind === 'liftctl') {
      if (this.sending) { this.cmd.pulse(MSG.LIFTGATE, { ICC_TrActnCmd: target > 0 ? 1 : 2 }); return; }
      if (this.liveIds.has(id)) { this.app.toast('The liftgate needs the car\'s CAN link'); return; }
      this.set(id, target);
      return;
    }
    if (chip.sunroof) {
      if (this.sending) { this.cmd.request(MSG.BODY, { ICC_SunroofPercCtrlCmdReq: target, ICC_SunroofshadePercCtrlCmdReq: 0 }); return; }
      if (this.liveIds.has(id)) { this.app.toast('The sunroof needs the car\'s CAN link'); return; }
      this.set('win.sunroofMode', target > 0 ? 'open' : 'closed');
      return;
    }
    if (chip.winSig && this.sending) this.cmd.request(MSG.BODY, { [chip.winSig]: target > 0 ? 6 : 5 });   // Auto_Down / Auto_Up
    else if (!this.liveIds.has(id)) this.set(id, target);
    else this.app.toast('The head unit has no message for this window');
  }

  // ---- per frame ---------------------------------------------------------------------------------------

  // place the pins next to their points (after the scene has rendered, so the camera is this frame's)
  frame(dt) {
    this._syncT += dt;
    if (this._syncT > LIVE_SYNC_S) { this._syncT = 0; this.syncLive(); }
    if (!this.isOpen) return;
    this._tick(dt);
    // refresh the sheet's live read-outs (Energy's status line) as CAN data arrives (~5 Hz)
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
      if (p.kind === 'badge' || p.kind === 'ctl') {   // on its point
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
      if (this.mockTag.textContent !== text) { setText(this.mockTag, text); setClass(this.mockTag, 'ok', this.sending); setClass(this.mockTag, 'warn', this.inApp && !this.sending); }
    }
  }

  // the body as the car reports it: doors, liftgate, windows, sunroof (the lamps follow through the HUD's own lamp state)
  applyBody() {
    const v = this.v, cut = this.cut;
    if (!cut) return;
    for (const n of DOORS) cut.setDoor(n, n === 'Tailgate' ? v['doors.liftgate'] / 100 : v['doors.open'].includes(n));
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

  // the sheet's buttons that do something rather than set something
  act(action) {
    const v = this.v;
    if (action === 'california') {
      for (const k of WINDOWS) if (!this.liveIds.has('win.' + k)) v['win.' + k] = 100;
      if (!this.liveIds.has('win.sunroof')) Object.assign(v, { 'win.sunroof': 100, 'win.sunroofMode': 'open' });
      this.app.toast('California Mode: all eight open');
    } else if (action === 'closeAll') {
      this.closeAll(false);
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

  // every window and the sunroof shut, and the doors and liftgate too: sent to the car for what it can do
  // (the four door windows and the sunroof), and the mockup's values for the rest
  closeAll(doors = true) {
    if (this.sending) {
      for (const sig of ['ICC_LeFrntWinCtrl', 'ICC_RiFrntWinCtrl', 'ICC_LeReWinCtrl', 'ICC_RiReWinCtrl']) this.cmd.request(MSG.BODY, { [sig]: 5 });
      this.cmd.request(MSG.BODY, { ICC_SunroofPercCtrlCmdReq: 0, ICC_SunroofshadePercCtrlCmdReq: 0 });
    }
    for (const k of WINDOWS) if (!this.liveIds.has('win.' + k)) this.v['win.' + k] = 0;
    if (!this.liveIds.has('win.sunroof')) Object.assign(this.v, { 'win.sunroof': 0, 'win.sunroofMode': 'closed' });
    if (doors && !this.liveIds.has('doors.open')) this.v['doors.open'] = [];
    if (doors && !this.liveIds.has('doors.liftgate')) this.v['doors.liftgate'] = 0;
  }

  toggleDoor(name) {
    if (name === 'Tailgate') { this.travel({ kind: 'liftctl', id: 'doors.liftgate' }, this.v['doors.liftgate'] > 0 ? 0 : 100); return; }
    const open = this.v['doors.open'];
    if (this.liveIds.has('doors.open')) { this.app.toast('The doors are manual'); return; }
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
    const flow = { 1: 'face', 2: 'both', 3: 'feet', 4: 'feet', 5: 'windshield' }[v['climate.flow']] || 'face';
    cut.setAirflow(c === 'climate' && v['climate.on'], v['climate.fan'], v['climate.tempL'], v['climate.tempR'], flow);
    const mode = DRIVE_MODES.find(m => m[0] === v['drive.mode']);
    cut.setPowertrain(c === 'driving', mode && mode[3]);
    cut.setBattery(c === 'energy', v['energy.soc'] / 100, !!v['energy.charging']);
    cut.setPort(!!v['energy.port'], !!v['energy.charging']);
    cut.setMirrors?.(v['doors.mirrors'] === true);
    cut.setAmp(c === 'audio');
    cut.setSound(c === 'audio' ? SEATS_FOR_STAGE[v['audio.stage']] || [] : []);
    const kinds = ['camera'];
    if (v['icc.acc'] || v['icc.facm']) kinds.push('radar');
    if (v['icc.bsd'] || v['icc.bacm'] || v['icc.fcta']) kinds.push('corner');
    if (v['icc.chime'] || v['icc.apa']) kinds.push('ultrasonic');
    cut.setSensors(c === 'assist' && v['icc.global'], kinds);
    for (const n of DOORS) cut.setDoor(n, n === 'Tailgate' ? v['doors.liftgate'] / 100 : v['doors.open'].includes(n));
    for (const k of WINDOWS) cut.setWindow(k, v['win.' + k] / 100);
    cut.setSunroof(v['win.sunroof'] / 100, v['win.sunroofMode'] === 'tilt');
    const theme = v['display.theme'], dark = document.documentElement.dataset.theme === 'dark';
    cut.setScreen(!!v['display.hollywood'], v['display.bright'] / 100, theme === 'light' || (theme === 'auto' && !dark));
  }

  // ---- controls ----------------------------------------------------------------------------------------

  // A control as a row of the sheet (or of an on-car card), or as a tile. One the car can't take is shown
  // greyed, and says why when tapped.
  control(c, as) {
    const node = as === 'tile' ? this.tile(c) : this._control(c);
    if (node && c.off && (this.inApp || c.off === MOCK_OFF)) {
      node.classList.add('off');
      node.title = c.off;
      if (node.classList.contains('fo-row')) {
        const ctl = node.lastElementChild;
        node.insertBefore(icon('lock'), ctl);
      }
      for (const i of node.querySelectorAll('input, button, select')) i.disabled = true;
      if (node.tagName === 'BUTTON') node.disabled = true;
    }
    return node;
  }

  // A toggle or an action as a cell: its glyph goes blue when on
  tile(c) {
    if (c.type === 'toggle') {
      const b = el('button.fo-tile', { onclick: () => this.set(c.id, !this.v[c.id]) }, icon(c.icon || 'check'), c.label);
      if (c.heat) b.classList.add('heat');
      this.watch(() => setClass(b, 'on', !!this.v[c.id]), true);
      setClass(b, 'on', !!this.v[c.id]);
      return b;
    }
    if (c.type === 'action') {
      const b = el('button.fo-tile', { title: c.sub || '', onclick: () => this.act(c.action) }, icon(c.icon || 'check'), c.label);
      if (c.style === 'primary') b.classList.add('primary');
      return b;
    }
    if (c.type === 'button') return el('button.fo-tile', { onclick: () => this.app.toast(c.toast || MOCK_OFF) }, icon(c.icon || 'check'), c.label);
    return this._control(c);
  }

  _control(c) {
    const lbl = () => el('div.fo-row__lbl', el('b', c.label), c.sub ? el('small.fo-row__sub', c.sub) : null);
    const row = (...kids) => el('div.fo-row', ...kids);
    const stack = (...kids) => el('div.fo-row.stack', ...kids);
    switch (c.type) {
      case 'hidden': return null;
      case 'toggle': {
        if (c.as === 'button') {   // Start / Stop charging: the one filled button
          const b = el('button.fo-btn.block', { onclick: () => this.set(c.id, !this.v[c.id]) });
          const paint = () => { const on = !!this.v[c.id]; setText(b, c.labels[on ? 1 : 0]); setClass(b, 'primary', !on); };
          this.watch(paint, true);
          paint();
          return b;
        }
        const input = el('input', { type: 'checkbox', checked: !!this.v[c.id], onchange: e => this.set(c.id, e.target.checked) });
        this.watch(() => { input.checked = !!this.v[c.id]; }, true);
        return row(lbl(), el('label.fo-switch', input, el('span')));
      }
      case 'seg': return this.segRow(c, c.options, lbl, row, stack);
      case 'select': {   // a value that steps through its options on a tap
        const val = el('span.fo-row__val');
        const paint = () => setText(val, (c.options.find(o => String(o[0]) === String(this.v[c.id])) || [0, '—'])[1]);
        this.watch(paint, true);
        paint();
        const r = el('div.fo-row.tap', { onclick: () => { const i = c.options.findIndex(o => String(o[0]) === String(this.v[c.id])); this.set(c.id, c.options[(i + 1) % c.options.length][0]); } }, lbl(), val, icon('chevron'));
        return r;
      }
      case 'slider': {
        const steps = Math.round((c.max - c.min) / c.step);
        if (c.stepper || steps <= 7) return this.stepsRow(c, steps, lbl, row, stack);
        return this.sliderRow(c);
      }
      case 'levels': return row(lbl(), this.heatGlyph(c, 'inline'));
      case 'seatpos': return this.seatPos(c);
      case 'memory': {
        const seg = el('div.fo-seg');
        for (const n of [1, 2, 3]) seg.append(el('button', { dataset: { v: String(n) }, onclick: () => this.set(c.id, n) }, String(n)));
        const mark = () => $$('button', seg).forEach(b => setClass(b, 'on', b.dataset.v === String(this.v[c.id])));
        this.watch(mark, true);
        mark();
        const save = el('button.fo-btn', { onclick: () => this.act('saveMemory') }, 'Save');
        if (c.noSave && this.inApp) { save.disabled = true; save.title = c.noSave; }
        return row(lbl(), seg, save);
      }
      case 'modes': {   // the drive modes: a segment each, with its color as a dot
        const seg = el('div.fo-seg');
        for (const [val, text, , color] of c.options) {
          seg.append(el('button', { dataset: { v: val }, onclick: () => this.set(c.id, val) }, el('i.dot', { style: { '--c': color } }), text));
        }
        const mark = () => $$('button', seg).forEach(b => setClass(b, 'on', b.dataset.v === this.v[c.id]));
        this.watch(mark, true);
        mark();
        return seg;
      }
      case 'checks': {   // each option a tile
        const box = el('div.fo-tiles');
        for (const [val, text] of c.options) {
          const b = el('button.fo-tile', { onclick: () => this.set(c.id, this.v[c.id].includes(val) ? this.v[c.id].filter(x => x !== val) : [...this.v[c.id], val]) }, icon('check'), text);
          this.watch(() => setClass(b, 'on', this.v[c.id].includes(val)), true);
          setClass(b, 'on', this.v[c.id].includes(val));
          box.append(b);
        }
        return el('div.fo-group', el('h3', c.label), box);
      }
      case 'button': {
        const b = el(`button.fo-btn${c.style ? '.' + c.style : ''}`, { onclick: () => this.app.toast(c.toast || MOCK_OFF) }, c.label);
        return el('div.fo-btns', b);
      }
      case 'action': {
        const b = el(`button.fo-btn${c.style ? '.' + c.style : ''}`, { title: c.sub || '', onclick: () => this.act(c.action) }, c.label);
        if (c.action === 'hollywood') this.watch(() => setText(b, this.v['display.hollywood'] ? 'Exit Hollywood Mode' : c.label), true);
        return el('div.fo-btns', b);
      }
      case 'list': return el('div.fo-rows', ...c.items.map(([t, s, ok]) => el('div.fo-row', el('div.fo-row__lbl', el('b', t), el(`small.fo-row__sub${ok ? '.ok' : ''}`, s)))));
      case 'info': return el('div.fo-rows', ...c.items.map(([k, val]) => el('div.fo-row', el('div.fo-row__lbl', el('b', k)), el('span.fo-row__val', val))));
      case 'note': return el('p.fo-note', c.text);
      case 'temps': return this.temps();
      case 'lock': return this.lockHero();
      default: return null;
    }
  }

  // one choice from a few: a segmented control, under the label when it's wide, with icons when the options carry them
  segRow(c, options, lbl, row, stack) {
    const seg = el('div.fo-seg');
    const icons = options.some(o => o[2]);
    if (icons) seg.classList.add('stack');
    for (const [val, text, ic] of options) {
      seg.append(el('button', { dataset: { v: String(val) }, onclick: () => this.set(c.id, val) }, ic ? icon(ic) : null, el('span', text)));
    }
    const mark = () => $$('button', seg).forEach(b => setClass(b, 'on', b.dataset.v === String(this.v[c.id])));
    this.watch(mark, true);
    mark();
    const long = icons || options.length > 3 || options.some(o => String(o[1]).length > 10);
    return long ? stack(lbl(), seg) : row(lbl(), seg);
  }

  // a few discrete values: a segmented track (the fan), or a stepper for a number (the charge current)
  stepsRow(c, steps, lbl, row, stack) {
    const fmt = (x) => `${x}${c.unit ? (c.unit.startsWith('%') ? c.unit : ' ' + c.unit) : ''}`;
    if (c.stepper) {
      const val = el('b');
      const step = (d) => this.set(c.id, clamp(this.v[c.id] + d * c.step, c.min, c.max));
      const minus = el('button.fo-ib', { 'aria-label': `${c.label} down`, onclick: () => step(-1) }, icon('minus'));
      const plus = el('button.fo-ib', { 'aria-label': `${c.label} up`, onclick: () => step(1) }, icon('plus'));
      this.watch(() => setText(val, fmt(this.v[c.id])), true);
      setText(val, fmt(this.v[c.id]));
      return row(lbl(), el('div.fo-stepper', minus, val, plus));
    }
    const box = el('div.fo-steps');
    for (let n = 0; n <= steps; n++) {
      const x = c.min + n * c.step;
      box.append(el('button', { dataset: { v: String(x) }, onclick: () => this.set(c.id, x) }, String(x)));
    }
    const mark = () => $$('button', box).forEach(b => setClass(b, 'on', Number(b.dataset.v) === this.v[c.id]));
    this.watch(mark, true);
    mark();
    return stack(lbl(), box);
  }

  // a range: a hairline track and a pill thumb that carries the value (design.css .fo-slider)
  sliderRow(c) {
    const fmt = (x) => `${c.min < 0 && x > 0 ? '+' : ''}${x}${c.unit ? (c.unit.startsWith('%') ? c.unit : ' ' + c.unit) : ''}`;
    const thumb = el('div.fo-slider__thumb');
    const input = el('input', { type: 'range', min: c.min, max: c.max, step: c.step, value: this.v[c.id] });
    const track = el('div.fo-slider__track', thumb, input);
    const paint = () => {
      const x = Number(input.value);
      setText(thumb, fmt(x));
      track.style.setProperty('--p', `${(x - c.min) / (c.max - c.min) * 100}%`);
    };
    input.addEventListener('input', () => { this.v[c.id] = Number(input.value); paint(); this.apply(); });
    input.addEventListener('change', () => this.set(c.id, Number(input.value)));
    this.watch(() => { if (document.activeElement !== input) { input.value = this.v[c.id]; paint(); } }, true);
    paint();
    const box = el(`div.fo-slider${c.fill ? '.' + c.fill : ''}`, el('div.fo-slider__head', c.icon ? icon(c.icon) : null, c.label, c.sub ? el('small', c.sub) : null), el('div.fo-slider__rail', track));
    return box;
  }

  // The seat heat as Tesla's symbol: a seat with three waves that go red with the level; a tap cycles it.
  // 'bar' for the climate bar (icon only), 'inline' at the end of a row (with the level).
  heatGlyph(c, variant) {
    const b = el(`button.fo-heat.${variant}`, { 'aria-label': c.label, title: c.label, onclick: () => this.set(c.id, (this.v[c.id] + 1) % 4) });
    b.innerHTML = iconSvg('seatheat');
    const level = el('em');
    if (variant === 'inline') b.append(level);
    const paint = () => { const l = this.v[c.id] || 0; b.className = `fo-heat ${variant} l${l}`; setText(level, l ? String(l) : 'Off'); };
    this.watch(paint, true);
    paint();
    return b;
  }

  // ---- climate: Tesla's climate screen ---------------------------------------------------------------
  // Three rows of borderless buttons on a 12-column grid, so each keeps its place whatever is on (Tesla's
  // numbered layout in its manual). Row 1: power, Auto, A/C; the three vents with Front / Rear under them;
  // Schedule. Row 2: the heated wheel, the defrosters; the fan between its arrows; recirculation, the
  // purifier. Row 3: the set temperatures between their arrows, as the taskbar shows them, Sync between.
  // (The seat heaters stay under Seats; the Ocean has no keep-climate or pet mode.) A { ref } names a
  // control defined elsewhere.
  climate(controls) {
    const by = {};
    for (const c of controls) { const d = c.ref ? this.defs.get(c.ref) : c; if (d && d.id) by[d.id] = d; }
    const at = (node, col) => { if (node) node.style.gridColumn = col; return node; };
    const toggle = (id, word) => by[id] ? this.offMark(this.iconToggle(by[id], true, false, word), by[id]) : null;
    const row1 = el('div.fo-hvac',
      at(toggle('climate.on'), '1'), at(toggle('climate.auto', 'Auto'), '2'), at(toggle('climate.ac', 'A/C'), '3'),
      at(this.vents(by['climate.flow'], by['climate.rear']), '5 / 9'),
      at(toggle('climate.precond', 'Schedule'), '12'));
    const row2 = el('div.fo-hvac',
      at(toggle('climate.wheel'), '1'), at(toggle('climate.defrostF'), '2'), at(toggle('climate.defrostR'), '3'),
      at(this.fan(by['climate.fan']), '5 / 9'),
      at(this.offMark(this.iconToggle(by['climate.recirc'], 0, 1), by['climate.recirc']), '11'), at(toggle('climate.purify'), '12'));
    return [row1, row2, this.temps()];
  }

  // a control the car can't take: greyed, and it says why on tap (set() shows the toast)
  offMark(node, c) {
    if (node && c && c.off && (this.inApp || c.off === MOCK_OFF)) { node.classList.add('off'); node.title = c.off; node.style.pointerEvents = 'auto'; }
    return node;
  }

  // a borderless icon button: blue when its value is `onVal`; a tap sets the other value. With a word under the glyph.
  iconToggle(c, onVal, offVal, word) {
    const b = el('button.fo-cbtn', { title: c.label, 'aria-label': c.label, onclick: () => this.set(c.id, this.v[c.id] === onVal ? offVal : onVal) }, icon(c.icon || 'check'));
    if (c.heat) b.classList.add('heat');
    if (word) { b.classList.add('worded'); b.append(el('span', word)); }
    const paint = () => setClass(b, 'on', this.v[c.id] === onVal);
    this.watch(paint, true);
    paint();
    return b;
  }

  // Off / Keep / Pet (and the like): plain words, the chosen one dark
  words(c, small = false) {
    const box = el(`div.fo-words${small ? '.small' : ''}`);
    for (const [val, text] of c.options) box.append(el('button', { dataset: { v: String(val) }, onclick: () => this.set(c.id, val) }, text));
    const paint = () => $$('button', box).forEach(b => setClass(b, 'on', b.dataset.v === String(this.v[c.id])));
    this.watch(paint, true);
    paint();
    return this.offMark(box, c);
  }

  // The vents as Tesla has them: windshield, face and feet as three toggles ("choose one or more"), Front /
  // Rear under them. The car knows five front patterns and four rear ones, so a choice maps to the nearest.
  vents(front, rear) {
    const FRONT = { 1: 'face', 2: 'face,feet', 3: 'feet', 4: 'feet,shield', 5: 'shield' };
    const FRONT_PICK = { face: 1, 'face,feet': 2, feet: 3, 'feet,shield': 4, shield: 5, 'face,shield': 5, 'face,feet,shield': 4 };
    const REAR = { 0: 'face', 1: 'face,feet', 2: 'feet', 3: '' };
    const REAR_PICK = { face: 0, 'face,feet': 1, feet: 2, '': 3, 'face,shield': 0, 'feet,shield': 2, 'face,feet,shield': 1, shield: 3 };
    let side = 'front';
    const current = () => new Set(((side === 'front' ? FRONT[this.v[front.id]] : REAR[this.v[rear.id]]) || '').split(',').filter(Boolean));
    const buttons = el('div');
    for (const [key, ic, label] of [['shield', 'flowShield', 'Windshield'], ['face', 'flowFace', 'Face'], ['feet', 'flowFeet', 'Feet']]) {
      const b = el('button.fo-cbtn', { title: label, 'aria-label': label, dataset: { key }, onclick: () => {
        const set = current();
        if (set.has(key)) set.delete(key); else set.add(key);
        const k = ['face', 'feet', 'shield'].filter(x => set.has(x)).join(',');
        if (side === 'front') { if (k) this.set(front.id, FRONT_PICK[k]); }
        else this.set(rear.id, REAR_PICK[k]);
      } }, icon(ic));
      buttons.append(b);
    }
    const tabs = el('div.fo-words.small');
    for (const [key, text] of [['front', 'Front'], ['rear', 'Rear']]) tabs.append(el('button', { dataset: { v: key }, onclick: () => { side = key; paint(); } }, text));
    const paint = () => {
      const set = current();
      $$('button', buttons).forEach(b => setClass(b, 'on', set.has(b.dataset.key)));
      $$('button', tabs).forEach(b => setClass(b, 'on', b.dataset.v === side));
    };
    this.watch(paint, true);
    paint();
    return el('div.fo-vents', buttons, tabs);
  }

  // the fan between its arrows: LO, 2 to 6, HI
  fan(c) {
    const val = el('b');
    const step = (d) => this.set(c.id, clamp(this.v[c.id] + d, c.min, c.max));
    const box = el('div.fo-fan', el('button.fo-ib', { 'aria-label': 'Fan down', onclick: () => step(-1) }, icon('back')), icon('fan'), val,
      el('button.fo-ib', { 'aria-label': 'Fan up', onclick: () => step(1) }, icon('chevron')));
    const paint = () => { const f = this.v[c.id]; setText(val, f <= c.min ? 'LO' : f >= c.max ? 'HI' : String(f)); setClass(box, 'on', !!this.v['climate.on']); };
    this.watch(paint, true);
    paint();
    return this.offMark(box, c);
  }

  // driver and passenger set temperatures between their arrows, Sync between them, in the units General asks for
  temps() {
    const row = el('div.fo-hvac.temps');
    const f = () => this.v['general.temp'] === 'f';
    const fmt = (t) => (f() ? `${Math.round(t * 9 / 5 + 32)}` : `${t.toFixed(1)}`);
    const sides = [];
    for (const [key, label] of [['climate.tempL', 'Driver'], ['climate.tempR', 'Passenger']]) {
      const val = el('b');
      const step = (d) => this.set(key, Math.max(16, Math.min(28, Math.round((this.v[key] + d) * 2) / 2)));
      const minus = el('button.fo-ib', { 'aria-label': `${label} cooler`, onclick: () => step(f() ? -5 / 9 : -0.5) }, icon('minus'));
      const plus = el('button.fo-ib', { 'aria-label': `${label} warmer`, onclick: () => step(f() ? 5 / 9 : 0.5) }, icon('plus'));
      const side = el('div.fo-temp', { title: label }, el('div.fo-temp__ctl', minus, val, plus));
      sides.push(side);
      this.watch(() => { val.innerHTML = `${fmt(this.v[key])}<sup>°</sup>`; }, true);
    }
    const sync = el('button.fo-cbtn.worded', { title: 'Passenger follows the driver', onclick: () => this.set('climate.sync', !this.v['climate.sync']) }, icon('sync'), el('span', 'Sync'));
    this.watch(() => { setClass(sync, 'on', !!this.v['climate.sync']); setClass(sides[1], 'synced', !!this.v['climate.sync']); }, true);
    sides[0].style.gridColumn = '1 / 6';
    sync.style.gridColumn = '6 / 8';
    sides[1].style.gridColumn = '8 / 13';
    row.append(sides[0], sync, sides[1]);
    this.notify();
    return row;
  }

  // Energy's one line: what the car (or the mockup) says about charging, with the range. The charge itself
  // shows as the pack filling on the car.
  energyStatus() {
    const p = el('p.fo-status-line');
    const show = () => {
      const soc = this.v['energy.soc'], lim = this.v['energy.limit'];
      const range = Math.round(RANGE_MI * soc / 100);
      const cs = this.app.carState, live = this.liveIds.has('energy.soc');
      let status;
      if (live) {
        const kw = this.v['energy.power'] || 0, gun = cs.rawOf('VCU_ACChrgDchaGunCnctnSts'), left = cs.rawOf('VCU_ACRmngChrgTi');
        const leftText = left !== undefined && left < 0xFFFF ? ` · ${left >= 60 ? `${Math.floor(left / 60)} h ${left % 60} min` : `${left} min`} left` : '';
        status = kw > 0.3 ? `Charging · ${kw.toFixed(1)} kW${leftText}` : gun === 2 ? 'Plugged in, not charging' : kw < -0.3 ? `Using ${(-kw).toFixed(1)} kW` : 'Not plugged in';
      } else {
        status = this.v['energy.charging']
          ? (soc >= lim ? `Charged to your ${lim}% limit` : `Charging · 7.4 kW · ${Math.ceil((lim - soc) * 0.12 * 10) / 10} h to ${lim}%`)
          : 'Not plugged in';
      }
      p.replaceChildren(el('b', `${range} mi`), ` · ${status}`);
      setClass(p, 'ok', status.startsWith('Charging'));
    };
    this.watch(show, true);
    show();
    return p;
  }

  // the lock: its state in one line, with the one button
  lockHero() {
    const ic = el('span.fo-icon'), text = el('div.fo-hero__meta'), btn = el('button.fo-btn.primary', { onclick: () => this.set('doors.locked', !this.v['doors.locked']) });
    if (!this.sending && this.inApp) btn.disabled = true;
    const show = () => {
      const locked = this.v['doors.locked'];
      ic.innerHTML = iconSvg(locked ? 'lock' : 'unlock');
      text.replaceChildren(el('b', locked ? 'Locked' : 'Unlocked'), el('span', locked ? 'All doors and the liftgate' : 'Walk away to lock'));
      setText(btn, locked ? 'Unlock' : 'Lock');
    };
    this.watch(show, true);
    show();
    return el('div.fo-hero.inline', ic, text, btn);
  }

  // A seat's adjusters, laid out like the switch on the seat's side: the cushion slides, its front and
  // rear edges go up and down, the back reclines. Beside them, the seat seen from the side (facing left,
  // the way the car goes), drawn in the position set (movements exaggerated so they read). Held, a button
  // keeps going.
  seatPos(c) {
    const id = c.id;
    const pic = el('div.fo-seatpic');
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
      this.v[id] = q;
      this.apply();
      this.notify();
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
    const pair = (name, key, a, b) => el('div.fo-jog', el('small', name),
      hold(`${name} ${a[0]}`, a[1], key, a[2]), hold(`${name} ${b[0]}`, b[1], key, b[2]));
    // on the car the cushion tilts (its front edge) and rises as a whole (height); the mockup moves each edge
    const car = !!(c.moves && this.inApp);
    const grid = el('div.fo-jogs',
      pair('Slide', 'slide', ['forward', '◀', 1], ['back', '▶', -1]),
      pair('Back', 'recline', ['up', '↶', -1], ['down', '↷', 1]),
      pair(car ? 'Tilt' : 'Front', 'front', ['up', '▲', 1], ['down', '▼', -1]),
      pair(car ? 'Height' : 'Rear', 'rear', ['up', '▲', 1], ['down', '▼', -1]));
    this.watch(draw, true);
    draw();
    return el('div.fo-seatpos', pic, grid);
  }

  // The mock parking's sheet: where it's at, the spaces it found, start and cancel, and the CAN signals
  // both sides would have sent, with a log of each change.
  apaPanel(apa) {
    const title = el('b'), sub = el('span'), bar = el('div.fo-hero__bar', el('i'));
    const hero = el('div.fo-hero.inline.apa', el('div.pmark', 'P'), el('div.fo-hero__meta', title, sub), bar);
    const spaces = el('div.fo-tiles');
    const dir = el('div.fo-seg', ...[[true, 'Back in'], [false, 'Nose in']].map(([back, text]) =>
      el('button', { dataset: { v: String(back) }, onclick: () => apa.setDirection(back) }, text)));
    const start = el('button.fo-btn.primary', { onclick: () => apa.start() }, 'Start parking');
    const cancel = el('button.fo-btn.danger', { onclick: () => apa.cancel() }, 'Cancel');
    const done = el('button.fo-btn', { onclick: () => this.select('assist') }, 'Done');
    const sigs = el('div.cansig'), log = el('div.canlog');
    const show = () => {
      const [t, s] = apa.status();
      setText(title, t);
      setText(sub, s);
      const driving = apa.phase === 'park' || apa.phase === 'done';
      bar.style.display = driving ? '' : 'none';
      bar.firstChild.style.width = `${(apa.progress() * 100).toFixed(1)}%`;
      if (spaces.childElementCount !== apa.found.length) {
        spaces.replaceChildren(...apa.found.map(q => el('button.fo-tile', { dataset: { id: String(q.id) }, onclick: () => apa.choose(q.id) }, `P${q.id}`)));
      }
      if (!apa.found.length) spaces.replaceChildren(el('p.fo-note', 'None yet: the car reports spaces once it has passed them.'));
      $$('button.fo-tile', spaces).forEach(b => { setClass(b, 'on', Number(b.dataset.id) === apa.selected); b.disabled = driving; });
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
    const group = (name, ...kids) => el('div.fo-group', name ? el('h3', name) : null, ...kids);
    return [
      hero,
      group('Spaces', spaces, el('div.fo-rows', el('div.fo-row', el('div.fo-row__lbl', el('b', 'Park'), el('small.fo-row__sub', 'ICC_APAParkInDirSetting')), dir))),
      el('div.fo-btns', start, cancel, done),
      group('On CAN', el('p.fo-note', 'Signal names and values from fisker_ocean_adas_world.dbc. The order they come in is our reading of the DBC, not a recorded drive.'), sigs),
      group('Messages', log),
    ];
  }
}

// pointer capture, where the browser grants it (a pointer that's gone, or a synthetic one, has none to give)
function capture(node, e) {
  try { node.setPointerCapture(e.pointerId); } catch { /* the events still reach the node while the pointer is over it */ }
}

function svg(tag, a = {}) {
  const n = document.createElementNS('http://www.w3.org/2000/svg', tag);
  return attrs(n, a);
}

function attrs(n, a) {
  for (const [k, v] of Object.entries(a)) n.setAttribute(k, v);
  return n;
}
