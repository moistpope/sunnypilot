// sunnypilot web HUD entry point: connects to the device, renders the car view and wires the controls.
import { $, $$, el, api, fmtTime, iconSvg, setClass, setText, store, save } from './util.js';
import { CarScene } from './scene.js';
import { Hud } from './hud.js';
import { Settings } from './settings.js';
import { VehicleState } from './vehicle.js';

const SETTINGS_VERSION = 2;
const AUTO_VIEW_HOLD_MS = 30000;   // after the user picks a view or moves the camera, auto view waits this long
const DEFAULTS = {
  theme: 'auto', units: 'auto', laneSource: 'blend', egoColor: 'model', view: 'chase',
  showPath: true, showUss: true, showOpLeads: true, autoView: true, showGround: true, showRoad: true, showSigns: true,
  laneHeadingSign: 1, laneCurvatureSign: 1, objectHeadingSign: 1,
};

function loadSettings() {
  const s = store('settings', {});
  if ((s.version || 1) < 2) {
    // v2: the lane heading direction verified on the car is built in (a stored "invert" would now
    // double-invert), and the 'auto' lane source became 'blend'
    if (s.laneHeadingSign === -1) s.laneHeadingSign = 1;
    if (s.laneSource === 'auto') s.laneSource = 'blend';
  }
  return { ...DEFAULTS, ...s, version: SETTINGS_VERSION };
}

class App {
  constructor() {
    this.settings = loadSettings();
    save('settings', this.settings);
    this.state = null;
    this.ws = null;
    this.connected = false;
    this.retry = 0;
    this.rawAddrs = [];
    this.lastStateAt = 0;
    this.autoViewActive = false;
    this.manualViewAt = -1e9;

    this.scene = new CarScene($('#scene'));
    this.hud = new Hud();
    this.vehicle = new VehicleState();
    this.ui = new Settings(this);
    this.applyTheme();
    this.scene.setEgoColor(this.settings.egoColor);
    this.setView(this.settings.view, true);
    this.bindViewbar();
    this.bindReplaybar();
    this.updateLayout();
    window.addEventListener('resize', () => this.updateLayout());
    // mobile toolbars showing/hiding change the visible height without always firing window resize
    if (window.visualViewport) window.visualViewport.addEventListener('resize', () => { this.scene.resize(); this.updateLayout(); });
    matchMedia('(prefers-color-scheme: dark)').addEventListener?.('change', () => this.applyTheme());
    this.connect();
    api('/api/params').then(p => { this.hud.isMetric = !!p.IsMetric; }).catch(() => {});

    let last = performance.now();
    const loop = (now) => {
      requestAnimationFrame(loop);   // schedule first: one bad frame must not stop the HUD
      const dt = (now - last) / 1000;
      last = now;
      try { this.vehicle.update(this.state, now - this.lastStateAt, dt); } catch (e) { this.reportError(e); }
      try { this.scene.frame(dt, this.vehicle); } catch (e) { this.reportError(e); }
      try { if (this.state) this.hud.update(this.state, this.settings, this.vehicle); } catch (e) { this.reportError(e); }
    };
    requestAnimationFrame(loop);
    setInterval(() => this.watchdog(), 1000);
  }

  reportError(e) {
    // log once per distinct message so a per-frame failure doesn't flood the console
    this.errors = this.errors || new Set();
    if (!this.errors.has(String(e))) { this.errors.add(String(e)); console.error(e); }
  }

  // ---- settings -------------------------------------------------------------------------------------
  setSetting(key, value) {
    this.settings[key] = value;
    save('settings', this.settings);
    if (key === 'theme') this.applyTheme();
    if (key === 'egoColor') this.scene.setEgoColor(value);
    this.scene.update(this.state, this.settings);
    if (this.ui.isOpen && this.ui.tab === 'display') this.ui.show('display');
  }

  applyTheme() {
    const t = this.settings.theme;
    const dark = t === 'dark' || (t === 'auto' && matchMedia('(prefers-color-scheme: dark)').matches);
    document.documentElement.dataset.theme = dark ? 'dark' : 'light';
    $('meta[name=theme-color]').setAttribute('content', dark ? '#101216' : '#eceef1');
    this.scene.setTheme(dark);
  }

  updateLayout() {
    // landscape: center the car in the area right of the status card
    const portrait = window.innerWidth <= window.innerHeight;
    const card = $('#drive');
    const shift = portrait ? 0 : (card.getBoundingClientRect().right + 16) / 2 / window.innerWidth;
    this.scene.setLayoutOffset(shift);
    // portrait overlays stack below the status header
    document.documentElement.style.setProperty('--drive-h', `${Math.round(card.getBoundingClientRect().bottom)}px`);
  }

  // ---- connection -----------------------------------------------------------------------------------
  connect() {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${proto}://${location.host}/ws`);
    this.ws = ws;
    ws.onopen = () => {
      this.connected = true;
      this.retry = 0;
      this.setConn('ok', 'connected');
      if (this.rawAddrs.length) this.send({ type: 'raw', addrs: this.rawAddrs });
    };
    ws.onmessage = (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      if (msg.type === 'state') this.onState(msg.data);
      else if (msg.type === 'raw') this.ui.onRaw(msg.data);
      else if (msg.type === 'hello') this.hello = msg.data;
    };
    ws.onclose = () => {
      this.connected = false;
      this.setConn('bad', 'offline');
      const delay = Math.min(10000, 500 * 2 ** this.retry++);
      setTimeout(() => this.connect(), delay);
    };
    ws.onerror = () => ws.close();
  }

  send(obj) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(obj));
      return true;
    }
    return false;
  }

  subscribeRaw(addrs) {
    this.rawAddrs = addrs;
    this.send({ type: 'raw', addrs });
  }

  setConn(cls, text) {
    const chip = $('#chip-conn');
    chip.className = 'chip ' + cls;
    setText(chip, text);
  }

  watchdog() {
    if (!this.connected) return;
    const age = (performance.now() - this.lastStateAt) / 1000;
    if (age > 2) this.setConn('warn', 'no data');
    else if (this.state && this.state.mode === 'live' && this.state.server && this.state.server.liveError) this.setConn('warn', 'no live data');
    else if (this.state && this.state.mode === 'live' && !this.state.op.carState && !(this.state.fisker && this.state.fisker.active)) this.setConn('warn', 'car off');
    else this.setConn('ok', 'connected');
  }

  onState(state) {
    const prevMode = this.state && this.state.mode;
    this.state = state;
    this.lastStateAt = performance.now();
    this.scene.update(state, this.settings);
    const replay = state.mode === 'replay' && state.replay;
    const chip = $('#chip-mode');
    chip.className = 'chip ' + (replay ? 'replay' : 'ok');
    setText(chip, replay ? 'REPLAY' : 'LIVE');
    setClass($('#replaybar'), 'hidden', !replay);
    if (replay) this.updateReplaybar(state.replay);
    if (prevMode !== state.mode && this.ui.isOpen && this.ui.tab === 'playback') this.ui.show('playback');
    this.autoView(state);
  }

  // Tesla-like: switch to a top view when parking (slow, reverse or obstacles close), back afterwards.
  // A view the user picks (or a camera they move) wins for AUTO_VIEW_HOLD_MS before auto view resumes.
  autoView(state) {
    if (this.settings.autoView === false || this.scene.interacting) return;
    if (performance.now() - Math.max(this.manualViewAt, this.scene.lastInteract) < AUTO_VIEW_HOLD_MS) return;
    const op = state.op || {};
    const f = state.fisker;
    const v = op.carState ? op.carState.vEgo : (f && f.vehicle && f.vehicle.speedKph != null ? f.vehicle.speedKph / 3.6 : null);
    const reverse = (op.carState && op.carState.gear === 'reverse') || (f && f.vehicle && f.vehicle.gear === 'R_gear');
    const uss = f && f.parking && f.parking.uss;
    const close = uss && Object.values(uss).some(arr => arr.some(z => z >= 1 && z <= 2));
    const parking = v != null && v < 2.5 && (reverse || close);
    if (parking && !this.autoViewActive) {
      this.autoViewActive = true;
      this.scene.setView('top');
      this.markView('top');
    } else if (!parking && this.autoViewActive && (v == null || v > 4)) {
      this.autoViewActive = false;
      this.setView(this.settings.view);
    }
  }

  // ---- view bar -----------------------------------------------------------------------------------------
  bindViewbar() {
    $$('#viewbar button[data-view]').forEach(b => b.addEventListener('click', () => {
      this.autoViewActive = false;
      this.manualViewAt = performance.now();
      this.setSetting('view', b.dataset.view);
      this.setView(b.dataset.view);
    }));
    // double-tap the scene to recenter on the car
    let lastTap = 0;
    $('#scene').addEventListener('pointerup', () => {
      const now = performance.now();
      if (now - lastTap < 300) this.setView(this.scene.view || this.settings.view);
      lastTap = now;
    });
  }

  setView(name, instant = false) {
    this.scene.setView(name, instant);
    this.markView(name);
  }

  markView(name) { $$('#viewbar button[data-view]').forEach(b => setClass(b, 'on', b.dataset.view === name)); }

  // ---- replay -------------------------------------------------------------------------------------------
  replay(action, extra = {}) {
    const msg = { type: 'replay', action, ...extra };
    if (!this.send(msg)) api('/api/replay', { method: 'POST', body: { action, ...extra } }).catch(e => this.toast(e.message));
  }

  bindReplaybar() {
    const play = $('#rp-play');
    play.innerHTML = iconSvg('play');
    play.addEventListener('click', () => this.replay('toggle'));
    $('#rp-back').addEventListener('click', () => this.replay('seek', { value: Math.max(0, (this.state?.replay?.t || 0) - 10) }));
    $('#rp-fwd').addEventListener('click', () => this.replay('seek', { value: (this.state?.replay?.t || 0) + 10 }));
    $('#rp-speed').addEventListener('change', e => this.replay('speed', { value: Number(e.target.value) }));
    $('#rp-live').addEventListener('click', () => this.replay('live'));
    const seek = $('#rp-seek');
    seek.addEventListener('input', () => { this.seeking = true; setText($('#rp-t'), fmtTime(Number(seek.value))); this.paintSeek(); });
    seek.addEventListener('change', () => { this.replay('seek', { value: Number(seek.value) }); setTimeout(() => { this.seeking = false; }, 400); });
    document.addEventListener('keydown', (e) => {
      if (!this.state || this.state.mode !== 'replay' || e.target.tagName === 'INPUT') return;
      if (e.code === 'Space') { e.preventDefault(); this.replay('toggle'); }
      if (e.code === 'ArrowLeft') this.replay('seek', { value: Math.max(0, this.state.replay.t - 5) });
      if (e.code === 'ArrowRight') this.replay('seek', { value: this.state.replay.t + 5 });
    });
  }

  updateReplaybar(r) {
    const play = $('#rp-play');
    const want = r.playing ? 'pause' : 'play';
    if (play.dataset.icon !== want) { play.innerHTML = iconSvg(want); play.dataset.icon = want; }
    const seek = $('#rp-seek');
    seek.max = String(Math.max(1, r.duration));
    if (!this.seeking) {
      seek.value = String(r.t);
      setText($('#rp-t'), fmtTime(r.t));
    }
    setText($('#rp-dur'), fmtTime(r.duration));
    setText($('#rp-route'), `${r.route}${r.segment != null ? ' · seg ' + r.segment : ''}${r.loading ? ' · loading…' : ''}`);
    const sp = $('#rp-speed');
    if (Number(sp.value) !== r.speed && document.activeElement !== sp) sp.value = String(r.speed);
    this.paintSeek();
  }

  paintSeek() {
    const seek = $('#rp-seek');
    seek.style.setProperty('--p', `${(Number(seek.value) / Number(seek.max || 1)) * 100}%`);
  }

  // ---- small widgets --------------------------------------------------------------------------------------
  toast(text, ms = 2600) {
    const t = $('#toast');
    t.textContent = text;
    t.classList.remove('hidden');
    clearTimeout(this.toastTimer);
    this.toastTimer = setTimeout(() => t.classList.add('hidden'), ms);
  }

  switch(checked, onChange) {
    const input = el('input', { type: 'checkbox', checked, onchange: e => onChange(e.target.checked) });
    return el('label.switch', input, el('span'));
  }

  segmented(options, value, onChange) {
    const wrap = el('div.seg');
    for (const [v, label] of options) {
      wrap.append(el('button', {
        onclick: (e) => { $$('button', wrap).forEach(b => b.classList.remove('on')); e.currentTarget.classList.add('on'); onChange(v); },
      }, label));
    }
    $$('button', wrap).forEach((b, i) => setClass(b, 'on', options[i][0] === value));
    return wrap;
  }
}

window.webhud = new App();
