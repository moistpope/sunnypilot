// Car controls mockup. Tap the car: a ribbon of categories slides up, the camera goes to a top view
// with the roof faded so the cabin shows, and the part each category is about glows under a badge. A
// category either opens a half-screen panel (the car moves into the other half) or puts its settings on
// cards beside the car. Look and feel only: the settings live in this page (this.v, in memory) and
// nothing is sent anywhere -- this file makes no requests, to the car, the comma or the server.
import * as THREE from '../vendor/three.module.min.js';
import { $, $$, el, iconSvg, setClass, setText } from './util.js';
import { CATEGORIES, DRIVE_MODES, defaults } from './carcatalog.js';
import { ZONES, ANCHORS } from './cutaway.js';

const OVERVIEW = { at: [0, 0.6, 2.4], az: 180, el: 90, fit: [2.3, 5.1] };   // top down, nose up...
const OVERVIEW_WIDE = { at: [0, 0.6, 2.4], az: 90, el: 90, fit: [5.1, 2.3] };   // ...or right, on a short screen
const SHORT_PX = 420;     // free height below which the overview turns the car on its side
const MOCK_NOTE = 'Mockup: nothing here changes the car';
const SEAT_HEAT = 0xff6a2a, SEAT_VENT = 0x3e9bff;
const CARD_GAP = 56;      // px between a card and the point it's about
const CARDS_MIN_W = 840;  // px of free width that fits two cards beside the car; narrower, they go in the panel
const CHIP_GAP = 46;      // px a chip sits out from its point, away from the car's center
const SEATS_FOR_STAGE = { all: ['FL', 'FR', 'RL', 'RR'], driver: ['FL'], passenger: ['FR'], front: ['FL', 'FR'], rear: ['RL', 'RR'] };
const DOOR_NODES = ['Door_Front_L', 'Door_Front_R', 'Door_Rear_L', 'Door_Rear_R', 'Tailgate'];
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
    this.pins = [];
    this.watchers = [];
    this.flash = null;   // lamps shown for a moment (lighting preview), { until, lamps }
    this._p = new THREE.Vector3();
    this._c = new THREE.Vector3();
    this.buildRibbon();
  }

  get cut() { return this.scene.cutaway; }
  get category() { return CATEGORIES.find(c => c.id === this.cat) || null; }

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
    this.showPanel(null);
    this.clearPins();
    for (const n of DOOR_NODES) this.v['door.' + n] = false;
    this.v['doors.california'] = false;
    this.v['energy.port'] = false;
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
    const c = CATEGORIES.find(x => x.id === id) || null;
    this.cat = c && c.id;
    $$('.cat', this.ribbon).forEach(b => {
      setClass(b, 'on', b.dataset.cat === this.cat);
      if (b.dataset.cat === this.cat) b.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    });
    this.v['energy.port'] = !!c && c.id === 'energy';   // the port opens to show it, and closes when you move on
    this.cardsShown = !!(c && c.cards) && this.roomForCards();
    this.showPanel(c && (c.sections || !this.cardsShown) ? c : null);
    this.buildPins(c);
    this.cut.setRoof(!c || c.roof !== false);
    this.cut.setGhost(!!(c && c.ghost), (c && c.ghost) || []);
    this.cut.setZones(c ? (c.zone ? [c.zone] : []) : Object.keys(ZONES), !c);
    this.apply();
    this.layout();
  }

  back() { this.select(null); }

  // A tap on the 3D view while open: a zone opens its category; anywhere else goes back to the
  // overview, or from there closes.
  tap(x, y) {
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
    this.ribbon.replaceChildren(el('span.mock', 'Mockup'), cats, done);
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
    for (const sec of c.sections || c.cards.map(card => ({ title: card.title, controls: card.controls }))) {
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
    this.panel.replaceChildren(el('header', back, h2, close), body, el('div.pfoot', MOCK_NOTE));
    body.scrollTop = keep || 0;
    this.panelCat = c.id;
    this.panel.classList.add('open');
    this.panel.setAttribute('aria-hidden', 'false');
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
    for (const chip of c.chips || []) add(this.chip(chip), ANCHORS[chip.anchor], 'chip', { toward: chip.toward });
    if (this.cardsShown) {   // on-car views get a way back at the top
      this.backBtn = el('button.carback', { onclick: () => this.back() });
      this.backBtn.innerHTML = iconSvg('back');
      this.backBtn.append(this.cardsShown ? 'All settings' : 'Back');
      this.layer.append(this.backBtn);
    }
  }

  chip(chip) {
    const b = el('button.callout');
    const label = el('span');
    const ic = el('span.tt');
    b.append(ic, label);
    const show = () => {
      let text = chip.label, icon = chip.kind;
      if (chip.kind === 'door') { text = `${chip.label} · ${this.v[chip.id] ? 'Close' : 'Open'}`; icon = 'door'; }
      if (chip.kind === 'port') { text = this.v[chip.id] ? 'Close charge port' : 'Open charge port'; icon = 'plug'; }
      if (chip.kind === 'heat') { const l = this.v[chip.id]; text = `${chip.label} · ${l ? `heat ${l}` : 'heat off'}`; icon = 'seat'; }
      if (ic.dataset.icon !== icon) { ic.innerHTML = iconSvg(icon); ic.dataset.icon = icon; }
      setText(label, text);
      setClass(b, 'on', chip.kind === 'heat' ? this.v[chip.id] > 0 : !!this.v[chip.id]);
    };
    b.addEventListener('click', () => {
      if (chip.kind === 'door' || chip.kind === 'port') this.set(chip.id, !this.v[chip.id]);
      else if (chip.kind === 'heat') this.set(chip.id, (this.v[chip.id] + 1) % 4);
      else if (chip.kind === 'tire') this.app.toast('Tire pressures (mockup)');
    });
    this.watch(show);
    show();
    return b;
  }

  // ---- per frame ---------------------------------------------------------------------------------------

  // place the pins next to their points (after the scene has rendered, so the camera is this frame's)
  frame(dt) {
    if (!this.isOpen) return;
    this._tick(dt);
    if (!this.pins.length) return;
    const cam = this.scene.camera, W = window.innerWidth, H = window.innerHeight;
    const r = this.rect || { left: 0, right: W, top: 0, bottom: H };
    const proj = (v) => { this._p.copy(v).project(cam); return [(this._p.x + 1) / 2 * W, (1 - this._p.y) / 2 * H, this._p.z < 1]; };
    const [cx, cy] = proj(this._c.set(0, 0.8, 2.4));
    const midX = (r.left + r.right) / 2;
    const placed = [];
    for (const p of this.pins) {
      const [sx, sy, front] = proj(p.at);
      if (!p.w) { p.w = p.el.offsetWidth; p.h = p.el.offsetHeight; }
      const show = front && sx > -50 && sx < W + 50 && sy > -50 && sy < H + 50;
      p.el.style.visibility = show ? '' : 'hidden';
      if (p.line) p.line.style.visibility = p.dot.style.visibility = show ? '' : 'hidden';
      if (!show) continue;
      let x, y;
      if (p.kind === 'badge') {
        x = sx - p.w / 2; y = sy - p.h / 2;
      } else if (p.kind === 'chip') {   // out from the point, away from the car's middle
        let dx = sx - cx, dy = sy - cy;
        const d = Math.hypot(dx, dy);
        if (d < 80) { dx = p.toward ? p.toward[0] : 0; dy = p.toward ? p.toward[1] : -1; }   // too near the middle to say
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
      p.el.style.transform = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px)`;
      if (p.line) {   // to the nearest point of the pin, just inside its rounded corners (it's drawn over the line)
        const ex = Math.max(x + 14, Math.min(x + p.w - 14, sx)), ey = Math.max(y + 14, Math.min(y + p.h - 14, sy));
        attrs(p.line, { x1: sx.toFixed(1), y1: sy.toFixed(1), x2: ex.toFixed(1), y2: ey.toFixed(1) });
        attrs(p.dot, { cx: sx.toFixed(1), cy: sy.toFixed(1) });
      }
    }
  }

  // things that change on their own: the lighting preview's flashes, the battery charging
  _tick(dt) {
    if (this.cat === 'lighting') this.scene.lampOverride = this.lamps();
    if (this.v['energy.charging'] && this.v['energy.soc'] < this.v['energy.limit']) {
      this.v['energy.soc'] = Math.min(this.v['energy.limit'], this.v['energy.soc'] + dt * 0.6);
      this.cut.setBattery(this.cat === 'energy', this.v['energy.soc'] / 100, true);
      this._socShown = this._socShown || 0;
      if (Math.floor(this.v['energy.soc']) !== this._socShown) { this._socShown = Math.floor(this.v['energy.soc']); this.notify(); }
    }
  }

  // ---- state -------------------------------------------------------------------------------------------

  set(id, value) {
    const prev = this.v[id];
    this.v[id] = value;
    if (id === 'drive.mode' && value !== prev) this.cut.pulse(DRIVE_MODES.find(m => m[0] === value)[3]);
    if ((id === 'light.ahb' || id === 'light.adb') && value) this.flash = { until: performance.now() + 1600, lamps: { high: true } };
    if (id === 'light.welcome' && value) this.flash = { until: performance.now() + 1600, lamps: { drl: true, position: true, low: true } };
    if (id === 'light.home' && value) this.flash = { until: performance.now() + 1400, lamps: { low: true, position: true } };
    if (id === 'climate.sync' && value) this.v['climate.tempR'] = this.v['climate.tempL'];
    if (id === 'climate.tempL' && this.v['climate.sync']) this.v['climate.tempR'] = value;
    if (id === 'climate.tempR' && this.v['climate.sync'] && value !== this.v['climate.tempL']) this.v['climate.sync'] = false;
    this.apply();
    this.notify();
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
    // seats: heat glows orange, ventilation blue, in every view (and not at all once closed)
    const open = this.isOpen;
    for (const s of ['FL', 'FR']) {
      const heat = v[`seat.${s}.heat`], vent = v[`seat.${s}.vent`];
      cut.tint(`Seat_${s}`, open && heat ? SEAT_HEAT : open && vent ? SEAT_VENT : null, (heat || vent) / 3 * 0.55);
    }
    const rear = Math.max(v['seat.RL.heat'], v['seat.RR.heat']);
    cut.tint('Seat_Rear', open && rear ? SEAT_HEAT : null, rear / 3 * 0.45);
    const tempC = (k) => v[k];
    cut.setAirflow(c === 'climate' && v['climate.on'], v['climate.fan'], tempC('climate.tempL'), tempC('climate.tempR'), v['climate.flow']);
    const mode = DRIVE_MODES.find(m => m[0] === v['drive.mode']);
    cut.setPowertrain(c === 'driving', mode && mode[3]);
    cut.setBattery(c === 'energy', v['energy.soc'] / 100, !!v['energy.charging']);
    cut.setPort(!!v['energy.port'], !!v['energy.charging']);
    cut.setAmp(c === 'audio');
    cut.setSound(c === 'audio' ? SEATS_FOR_STAGE[v['audio.stage']] || [] : []);
    const kinds = ['camera'];
    if (v['icc.acc'] || v['icc.facm']) kinds.push('radar');
    if (v['icc.bsd'] || v['icc.bacm'] || v['icc.fcta']) kinds.push('corner');
    if (v['icc.chime'] || v['icc.apa']) kinds.push('ultrasonic');
    cut.setSensors(c === 'assist' && v['icc.global'], kinds);
    for (const n of DOOR_NODES) cut.setDoor(n, !!v['door.' + n]);
    cut.setWindows(!!v['doors.california']);
    for (const s of ['FL', 'FR']) {
      const p = (open && v[`seat.${s}.pos`]) || [0, 0];
      cut.seatOffset(`Seat_${s}`, p[0], p[1]);
    }
  }

  // ---- controls ----------------------------------------------------------------------------------------

  // A control as a panel row (or block) or, compact, a row of an on-car card.
  control(c, compact) {
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
        const fmt = (x) => `${c.min < 0 && x > 0 ? '+' : ''}${x}${c.unit ? (c.unit === '%' ? '%' : ' ' + c.unit) : ''}`;
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
      case 'swatches': {
        const dots = el('div.dots');
        for (const [val, text, css] of c.options) {
          dots.append(el('button', { title: text, 'aria-label': text, dataset: { v: val }, style: { background: css }, onclick: () => this.set(c.id, val) }));
        }
        const mark = () => $$('button', dots).forEach(b => setClass(b, 'on', b.dataset.v === this.v[c.id]));
        this.watch(mark, !compact);
        mark();
        return compact ? el('div.crow', el('span', c.label), dots) : stack(lbl(), dots);
      }
      case 'pad': {
        const pad = el('div.pad');
        const seat = c.id.split('.')[1];
        const move = (fwd, up) => {
          const p = this.v[c.id] || [0, 0];
          this.set(c.id, [Math.max(-0.12, Math.min(0.12, p[0] + fwd)), Math.max(-0.05, Math.min(0.05, p[1] + up))]);
        };
        const btn = (area, text, label, fwd, up) => el('button', { style: { gridArea: area }, 'aria-label': label, onclick: () => move(fwd, up) }, text);
        // seen from the side: forward is left on the pad for the driver's seat, as it faces the screen
        pad.append(el('i'), btn('1 / 2', '▲', 'Up', 0, 0.02), btn('3 / 2', '▼', 'Down', 0, -0.02),
          btn('2 / 1', '◀', 'Forward', 0.03, 0), btn('2 / 3', '▶', 'Back', -0.03, 0));
        pad.dataset.seat = seat;
        return row(compact ? el('span', c.label) : lbl(), pad);
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
          box.append(el('label', input, text));
        }
        return stack(lbl(), box);
      }
      case 'button': {
        const b = el(`button.btn${c.style ? '.' + c.style : ''}`, { onclick: () => this.app.toast(c.toast || MOCK_NOTE) }, c.label);
        return el('div.btns', b);
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
      const status = this.v['energy.charging']
        ? (soc >= lim ? `Charged to your ${lim}% limit` : `Charging · 7.4 kW · ${Math.ceil((lim - soc) * 0.12 * 10) / 10} h to ${lim}%`)
        : this.v['energy.port'] ? 'Charge port open' : 'Not plugged in';
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
