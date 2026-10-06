// sunnypilot web HUD entry point: connects to the device, renders the car view and wires the controls.
import { $, $$, el, api, fmtTime, iconSvg, setClass, setText, store, save } from './util.js';
import { CarScene } from './scene.js';
import { CarControls } from './carcontrols.js';
import { OCEAN_PAINT_DEFAULT, OCEAN_WHEELS_DEFAULT } from './models.js';
import { LANE_CONF_THRESHOLD } from './road.js';
import { Hud } from './hud.js';
import { FrameMeter } from './perf.js';
import { Infotainment } from './infotainment.js';
import { CarState } from './carstate.js';
import { CarCommands } from './cancmd.js';
import { Settings } from './settings.js';
import { VehicleState } from './vehicle.js';

const SETTINGS_VERSION = 3;
const AUTO_VIEW_HOLD_MS = 10000;   // a parking maneuver starting this soon after the user picked a view keeps it
const TAP_PX = 8, TAP_MS = 300;    // a tap moves less and is shorter than this; two within TAP_MS are a double tap
const STALE_MS = 6000;             // the server streams at 20 Hz: this long without a message means the link is dead
const OFFLINE_MS = 3000;           // without the comma this long, the car's own buses take over, or the driving data comes off
const LOCAL_MS = 2500;             // the car's own view (10 Hz) counts as live this long after its last snapshot
const DEFAULTS = {
  theme: 'auto', units: 'auto', laneSource: 'blend', egoPaint: OCEAN_PAINT_DEFAULT, egoWheels: OCEAN_WHEELS_DEFAULT, view: 'chase',
  showPath: true, showUss: true, showOpLeads: true, autoView: true, showGround: true, showRoad: true, showSigns: true,
  showTracks: true, showRadar: false, radarAllTracks: false, showLowConf: false, showObjectStats: false, objectMode: 'world',
  laneHeadingSign: 1, laneCurvatureSign: 1, objectHeadingSign: 1, laneConfThreshold: LANE_CONF_THRESHOLD,
  showFps: true, renderScale: 'auto', showMusic: true, showNav: true, demoInfotainment: false, demoCarState: false,
  calibration: true, mapPrefetchKm: 25,
};

function loadSettings() {
  const s = store('settings', {});
  if ((s.version || 1) < 2) {
    // v2: the lane heading direction verified on the car is built in (a stored "invert" would now
    // double-invert), and the 'auto' lane source became 'blend'
    if (s.laneHeadingSign === -1) s.laneHeadingSign = 1;
    if (s.laneSource === 'auto') s.laneSource = 'blend';
  }
  if ((s.version || 1) < 3 && 'egoColor' in s) {
    // v3: the detailed Ocean comes in its factory paints; the nearest one to the old color choice
    const paint = { '#1d1f24': 'CBK', '#e8e9eb': 'CWH', '#6e7781': 'CGR', '#3a5a8c': 'CBE', '#7d2b2b': 'CRE', '#5f6b4e': 'CGM' }[s.egoColor];
    if (paint) s.egoPaint = paint;
    delete s.egoColor;
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
    this.source = 'none';          // where the driving data comes from: 'comma' | 'car' (its own buses, through the app) | 'none'
    this.localState = null;        // the car's own view, decoded from IBUS by the worker (the state when the comma is away)
    this.lastLocalAt = -1e9;
    this.retry = 0;
    this.retryTimer = 0;
    this.rawAddrs = [];
    this.lastStateAt = 0;
    this.lastMsgAt = 0;
    this.dbc = null;               // the ADASBUS DBC, from the worker once it has loaded it (Signals tab)
    this.autoViewActive = false;   // the view is auto view's top view (returns to the setting after)
    this.parkingStop = false;      // inside a parking stop auto view has already acted on
    this.manualViewAt = -1e9;

    this.scene = new CarScene($('#scene'));
    this.hud = new Hud();
    this.vehicle = new VehicleState();
    this.ui = new Settings(this);
    this.car = new CarControls(this);   // the car controls mockup (tap the car)
    this.applyTheme();
    this.scene.setEgoLook(this.settings.egoPaint, this.settings.egoWheels);
    this.setView(this.settings.view, true);
    this.bindViewdock();
    this.bindReplaybar();
    this.updateLayout();
    window.addEventListener('resize', () => this.updateLayout());
    if (window.ResizeObserver) new ResizeObserver(() => this.updateLayout()).observe($('#viewdock'));   // web fonts, icons
    // mobile toolbars showing/hiding change the visible height without always firing window resize
    if (window.visualViewport) window.visualViewport.addEventListener('resize', () => { this.scene.resize(); this.updateLayout(); });
    matchMedia('(prefers-color-scheme: dark)').addEventListener?.('change', () => this.applyTheme());
    // don't sit out the retry backoff once the network is back, the page is shown again, or the
    // Android app (android/) has found the device again
    window.addEventListener('online', () => this.reconnectNow());
    window.addEventListener('webhud:reconnect', () => this.reconnectNow());
    document.addEventListener('visibilitychange', () => { if (!document.hidden && !this.connected) this.reconnectNow(); });
    this.startWorker();
    this.connect();
    api('/api/params').then(p => { this.hud.isMetric = !!p.IsMetric; }).catch(() => {});

    this.meter = new FrameMeter(this);
    this.info = new Infotainment(this);
    this.carState = new CarState(this);
    this.cmd = new CarCommands(this);   // sending to the car, through the app
    // every frame the app reads on the car's buses also goes to the worker, which keeps the car's own view of the world
    window.addEventListener('webhud:can', (e) => { if (this.worker && Array.isArray(e.detail)) this.worker.postMessage({ type: 'ibus', t: Date.now() / 1000, frames: e.detail }); });
    let last = performance.now();
    const loop = (now) => {
      requestAnimationFrame(loop);   // schedule first: one bad frame must not stop the HUD
      const dt = (now - last) / 1000;
      last = now;
      const t0 = performance.now();
      // the car controls' mock parking drive stands in for the live data while it runs
      try { this.car.beforeFrame(dt); } catch (e) { this.reportError(e); }
      const mock = this.car.apa;
      const state = mock ? mock.state : this.liveState(), settings = mock ? mock.settings : this.settings;
      try { this.vehicle.update(state, mock ? 0 : now - this.lastStateAt, dt); } catch (e) { this.reportError(e); }
      try { if (mock) this.scene.update(state, settings); } catch (e) { this.reportError(e); }
      try { this.scene.frame(dt, this.vehicle); } catch (e) { this.reportError(e); }
      try { this.car.frame(dt); } catch (e) { this.reportError(e); }
      try { if (state) this.hud.update(state, settings, this.vehicle); } catch (e) { this.reportError(e); }
      try { this.info.frame(dt); } catch (e) { this.reportError(e); }
      try { this.carState.frame(); } catch (e) { this.reportError(e); }
      this.meter.tick(now, dt * 1000, performance.now() - t0);
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
    if (key === 'egoPaint' || key === 'egoWheels') this.scene.setEgoLook(this.settings.egoPaint, this.settings.egoWheels);
    if (key === 'showRadar') this.updateRadarChip();
    if (key === 'showFps' || key === 'renderScale') this.meter.apply();
    if (key === 'showMusic' || key === 'showNav' || key === 'demoInfotainment') this.info.apply();
    if (key === 'demoCarState') this.carState.apply();
    if (key === 'calibration') this.worker.postMessage({ type: 'calibration', on: value });
    if (key === 'mapPrefetchKm') this.worker.postMessage({ type: 'mapPrefetch', km: Number(value) });
    if (!this.car.apa) this.scene.update(this.state, this.settings);
    if (this.ui.isOpen && this.ui.tab === 'display') this.ui.show('display', true);
  }

  applyTheme() {
    const t = this.settings.theme;
    const dark = t === 'dark' || (t === 'auto' && matchMedia('(prefers-color-scheme: dark)').matches);
    document.documentElement.dataset.theme = dark ? 'dark' : 'light';
    $('meta[name=theme-color]').setAttribute('content', dark ? '#101216' : '#eceef1');
    this.scene.setTheme(dark);
    // the Android app starts in this theme next time (its loading screen and background), see MainActivity
    try { window.WebHudApp?.setTheme(t); } catch { /* not in the app */ }
  }

  updateLayout() {
    // landscape: center the car in the area right of the status card
    const portrait = window.innerWidth <= window.innerHeight;
    document.documentElement.style.setProperty('--viewbar-w', `${$('#viewdock').offsetWidth}px`);
    const card = $('#drive');
    const shift = portrait ? 0 : (card.getBoundingClientRect().right + 16) / 2 / window.innerWidth;
    this.scene.setLayoutOffset(shift);
    // portrait overlays stack below the status header
    document.documentElement.style.setProperty('--drive-h', `${Math.round(card.getBoundingClientRect().bottom)}px`);
    if (this.car) this.car.layout(true);   // car controls: refit the car to what's left of the screen
    if (this.info) this.info.layout();
  }

  // ---- world model worker --------------------------------------------------------------------------------
  // The comma's bridge streams what it reads: raw ADASBUS and radar frames and openpilot's services. The
  // decoding and the world model (js/world/) run in a worker, off this thread, and hand back the state
  // snapshots the view draws. The DBCs come from the same origin as the page.
  startWorker(attempt = 0) {
    const w = new Worker('/js/world/worker.js', { type: 'module' });
    this.worker = w;
    this.workerReady = false;
    w.onmessage = (ev) => {
      const msg = ev.data;
      if (msg.type === 'state') this.onState(msg.data);
      else if (msg.type === 'local') this.onLocal(msg.data);
      else if (msg.type === 'raw') this.ui.onRaw(msg.data);
      else if (msg.type === 'ready') { this.workerReady = true; this.dbc = msg.dbc; if (this.ui.isOpen && this.ui.tab === 'signals') this.ui.show('signals', true); }
      else if (msg.type === 'error') this.reportError(new Error('world model: ' + msg.message));
    };
    // a worker that failed to come up (its scripts not served in time, right after the app started) is
    // started again: without it nothing is decoded
    w.onerror = (e) => {
      this.reportError(new Error('world model worker: ' + (e.message || e.type || e)));
      if (!this.workerReady && this.worker === w && attempt < 10) { w.terminate(); setTimeout(() => this.startWorker(attempt + 1), 2000); }
    };
    w.postMessage({ type: 'calibration', on: this.settings.calibration !== false });
    w.postMessage({ type: 'mapPrefetch', km: Number(this.settings.mapPrefetchKm ?? 25) });
    const text = (path, required) => fetch(path, { cache: 'no-cache' }).then(r => { if (!r.ok) throw new Error(`${path}: ${r.status}`); return r.text(); })
      .catch(e => { if (required) throw e; return null; });
    const load = () => Promise.all([text('/dbc/fisker_ocean_adas_world.dbc', true), text('/dbc/fisker_ocean_mrr.dbc', false), text('/dbc/fisker_ocean_ibus.dbc', false)])
      .then(([worldDbc, radarDbc, ibusDbc]) => { w.postMessage({ type: 'init', worldDbc, radarDbc, ibusDbc }); this.carState.apply(); })
      .catch(e => { this.reportError(e); setTimeout(load, 3000); });   // the comma isn't there yet: try again
    load();
  }

  // ---- connection -----------------------------------------------------------------------------------
  connect() {
    clearTimeout(this.retryTimer);
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${proto}://${location.host}/ws`);
    this.ws = ws;
    // a socket replaced by reconnectNow() may still fire events; only the current one counts
    ws.onopen = () => {
      if (this.ws !== ws) return;
      this.connected = true;
      this.retry = 0;
      this.lastMsgAt = performance.now();
      this.setConn('ok', 'connected');
      if (this.rawAddrs.length) this.send({ type: 'raw', addrs: this.rawAddrs });
    };
    ws.onmessage = (ev) => {
      if (this.ws !== ws) return;
      this.lastMsgAt = performance.now();
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      if (msg.type === 'tick') this.worker.postMessage({ type: 'tick', data: msg.data });
      else if (msg.type === 'hello') this.hello = msg.data;
    };
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.connected = false;
      this.setConn('bad', 'offline');
      const delay = Math.min(10000, 500 * 2 ** this.retry++);
      this.retryTimer = setTimeout(() => this.connect(), delay);
    };
    ws.onerror = () => ws.close();
  }

  // Drop the current socket and connect again at once. A Wi-Fi drop can leave the socket half-open,
  // and closing that one waits on a handshake that never comes, so it's abandoned instead.
  reconnectNow() {
    const old = this.ws;
    this.ws = null;
    this.connected = false;
    this.retry = 0;
    if (old) { try { old.close(); } catch { /* already closed */ } }
    this.connect();
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
    this.worker.postMessage({ type: 'raw', addrs });
  }

  // The state the view draws: the comma's while its ticks come, else the car's own view from IBUS (the
  // Android app, with lanes, objects, signs and the car's state from the ADAS mirror and the body buses;
  // no openpilot and no radar), else nothing.
  liveState() {
    if (this.state && performance.now() - this.lastStateAt <= OFFLINE_MS) return this.state;
    if (this.localState && performance.now() - this.lastLocalAt <= LOCAL_MS) return this.localState;
    return null;
  }

  /** No comma: the settings that live on it have nothing to show (Settings.needsComma). */
  get offline() { return this.source !== 'comma'; }

  // Which source the driving data comes from, and what that changes on screen: the comma's ticks, the car's own
  // buses, or neither (then what was last shown is no longer true and comes off, while the car controls, music
  // and navigation carry on). Back on, the first tick or snapshot restores everything.
  updateSource() {
    const now = performance.now();
    const source = this.state && now - this.lastStateAt <= OFFLINE_MS ? 'comma' : this.localState && now - this.lastLocalAt <= LOCAL_MS ? 'car' : 'none';
    if (source === this.source) return;
    const was = this.source;
    this.source = source;
    document.documentElement.classList.toggle('offline', source === 'none');
    document.documentElement.classList.toggle('caronly', source === 'car');
    if (source === 'none') {
      this.state = null;
      this.localState = null;
      if (!this.car.apa) { this.scene.update(null, this.settings); this.scene.clearWorld(); }
    } else if (source === 'car' && was === 'comma') {
      this.state = null;   // the comma's last state is history; the car's own view takes over at once
      if (!this.car.apa) this.scene.update(this.localState, this.settings);
    }
    this.updateRadarChip();
    this.updateModeChip();
    if (this.ui.isOpen) this.ui.show(this.ui.tab, true);
  }

  updateModeChip() {
    const st = this.liveState();
    const replay = st && st.mode === 'replay' && st.replay;
    const chip = $('#chip-mode');
    chip.className = 'chip ' + (replay ? 'replay' : this.source === 'car' ? 'warn' : 'ok');
    setText(chip, replay ? 'REPLAY' : this.source === 'car' ? 'CAR' : 'LIVE');
    chip.title = this.source === 'car' ? "From the car's own buses: no openpilot and no radar until the comma is back" : '';
    setClass($('#replaybar'), 'hidden', !replay);
  }

  // The worker sends the map's roads layer (map.roads, state.js `_roadsLayer`) only in the snapshot it was rebuilt in;
  // every later one carries just its version. A snapshot the view never draws (a missed frame, a hidden tab) must
  // not lose the layer for the next 40 m, so the last one is carried forward here, per source.
  _carryRoads(state, source) {
    const m = state && state.map;
    if (!m) return;
    const kept = this.roadsLayers || (this.roadsLayers = {});
    if (m.roads) kept[source] = m.roads;
    else if (kept[source] && kept[source].version === m.roadsVersion) m.roads = kept[source];
  }

  // the car's own view from the worker (IBUS through the app): drawn whenever the comma's ticks aren't coming
  onLocal(state) {
    this._carryRoads(state, 'car');
    this.localState = state;
    this.lastLocalAt = performance.now();
    this.updateSource();
    if (this.source !== 'car') return;
    this.lastStateAt = this.lastLocalAt;
    if (!this.car.apa) this.scene.update(state, this.settings);
    this.updateRadarChip();
    this.autoView(state);
  }

  setConn(cls, text) {
    const chip = $('#chip-conn');
    chip.className = 'chip ' + cls;
    setText(chip, text);
  }

  // radar view: how many tracks the radar reports this cycle, or that its bus is silent
  updateRadarChip() {
    const chip = $('#chip-radar');
    const on = this.settings.showRadar === true;
    setClass(chip, 'hidden', !on);
    if (!on) return;
    const st = this.liveState();
    const r = st && st.radar;
    chip.className = 'chip ' + (r ? 'radar' : 'warn');
    setText(chip, r ? `radar ${r.count}` : 'no bus 1 data');
    chip.title = r ? 'Tracks the mid-range radar reports this cycle' : 'No radar frames on CAN bus 1: this log has none, or the harness doesn\'t tap the radar bus';
  }

  watchdog() {
    this.updateSource();
    if (!this.connected) { if (this.source === 'car') this.setConn('warn', 'no comma'); return; }
    if (performance.now() - this.lastMsgAt > STALE_MS) {
      this.setConn('bad', 'reconnecting');
      this.reconnectNow();
      return;
    }
    const age = (performance.now() - this.lastStateAt) / 1000;
    if (age > 2) this.setConn('warn', 'no data');
    else if (this.state && this.state.mode === 'live' && this.state.server && this.state.server.liveError) this.setConn('warn', 'no live data');
    else if (this.state && this.state.mode === 'live' && !this.state.op.carState && !(this.state.fisker && this.state.fisker.active)) this.setConn('warn', 'car off');
    else this.setConn('ok', 'connected');
  }

  onState(state) {
    const prevMode = this.state && this.state.mode;
    this._carryRoads(state, 'comma');
    this.state = state;
    this.lastStateAt = performance.now();
    this.updateSource();
    if (!this.car.apa) this.scene.update(state, this.settings);
    const replay = state.mode === 'replay' && state.replay;
    this.updateModeChip();
    if (replay) this.updateReplaybar(state.replay);
    this.updateRadarChip();
    if (this.ui.isOpen && this.ui.tab === 'display') this.ui.showLaneConf();
    if (prevMode !== state.mode && this.ui.isOpen && this.ui.tab === 'playback') this.ui.show('playback', true);
    this.autoView(state);
  }

  // Tesla-like: switch to a top view when a parking maneuver starts (slow, in reverse or with obstacles
  // close) and back once the car drives off. It acts once per stop: a view the user picks while stopped
  // stays until the car has driven away (the parking sensors keep reporting a wall behind a parked car,
  // so a level check would flip back to top forever), and a maneuver that starts right after they
  // picked a view doesn't switch at all.
  autoView(state) {
    if (this.settings.autoView === false || this.car.isOpen) return;
    const op = state.op || {};
    const f = state.fisker;
    const v = op.carState ? op.carState.vEgo : (f && f.vehicle && f.vehicle.speedKph != null ? f.vehicle.speedKph / 3.6 : null);
    const reverse = (op.carState && op.carState.gear === 'reverse') || (f && f.vehicle && f.vehicle.gear === 'R_gear');
    const uss = f && f.parking && f.parking.uss;
    const close = uss && Object.values(uss).some(arr => arr.some(z => z >= 1 && z <= 2));
    const parking = v != null && v < 2.5 && (reverse || close);
    if (parking && !this.parkingStop) {
      if (this.scene.interacting) return;   // start it once the user lets go of the camera
      this.parkingStop = true;
      if (performance.now() - this.manualViewAt > AUTO_VIEW_HOLD_MS) {
        this.autoViewActive = true;
        this.scene.setView('top');
        this.markView('top');
      }
    } else if (!parking && this.parkingStop && v != null && v > 4) {
      this.parkingStop = false;
      if (this.autoViewActive) {
        this.autoViewActive = false;
        this.setView(this.settings.view);
      }
    }
  }

  // ---- view dock -----------------------------------------------------------------------------------------
  bindViewdock() {
    // the camera views live in a menu behind the camera button
    const menu = $('#viewmenu'), cam = $('#btn-camera');
    cam.innerHTML = iconSvg('camera');
    const showMenu = (on) => {
      setClass(menu, 'hidden', !on);
      setClass(cam, 'on', on);
      cam.setAttribute('aria-expanded', String(on));
    };
    cam.addEventListener('click', () => showMenu(menu.classList.contains('hidden')));
    document.addEventListener('pointerdown', (e) => { if (!$('#viewdock').contains(e.target)) showMenu(false); });
    $$('#viewmenu button[data-view]').forEach(b => b.addEventListener('click', () => {
      showMenu(false);
      this.autoViewActive = false;
      this.manualViewAt = performance.now();
      this.setSetting('view', b.dataset.view);
      this.setView(b.dataset.view);
    }));
    // Taps on the scene (not the end of a drag or pinch): one on the car opens the car controls, a double
    // tap recenters on the car. A tap on the car waits out the double tap before it opens them. With the
    // car controls open, every tap goes to them.
    const scene = $('#scene'), down = new Map();
    let tap = null, lastTap = 0, pending = 0;
    scene.addEventListener('pointerdown', (e) => {
      down.set(e.pointerId, true);
      tap = down.size === 1 ? { x: e.clientX, y: e.clientY, t: performance.now() } : null;
    });
    const up = (e) => {
      down.delete(e.pointerId);
      const now = performance.now();
      const isTap = tap && e.type === 'pointerup' && Math.hypot(e.clientX - tap.x, e.clientY - tap.y) < TAP_PX && now - tap.t < TAP_MS;
      tap = null;
      if (!isTap) return;
      if (this.car.isOpen) { this.car.tap(e.clientX, e.clientY); return; }
      clearTimeout(pending);
      if (now - lastTap < TAP_MS) {
        this.setView(this.scene.view || this.settings.view);
        lastTap = 0;
        return;
      }
      lastTap = now;
      if (this.scene.pickEgo(e.clientX, e.clientY)) pending = setTimeout(() => this.car.enter(), TAP_MS);
    };
    scene.addEventListener('pointerup', up);
    scene.addEventListener('pointercancel', up);
  }

  setView(name, instant = false) {
    this.scene.setView(name, instant);
    this.markView(name);
  }

  markView(name) { $$('#viewmenu button[data-view]').forEach(b => setClass(b, 'on', b.dataset.view === name)); }

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
