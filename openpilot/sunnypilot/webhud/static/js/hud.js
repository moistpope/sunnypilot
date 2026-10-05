// DOM overlay: speed, gear, steering assist (MADS), ACC set speed + gap, speed limit, telltales, alerts.
import { $, $$, el, icon, iconSvg, setClass, setText, prettyLabel, MS_TO_KPH, MS_TO_MPH } from './util.js';

const GEAR_LETTER = {
  park: 'P', reverse: 'R', neutral: 'N', drive: 'D', eco: 'D', sport: 'D', low: 'D', brake: 'D', manumatic: 'D',
  gear_P: 'P', gear_N: 'N', R_gear: 'R', D_gear: 'D', gear_D: 'D', gear_E: 'D', gear_S: 'D',
};
const PERSONALITY_BARS = { aggressive: 1, standard: 2, relaxed: 3 };

export class Hud {
  constructor() {
    this.speed = $('#speed');
    this.unit = $('#speed-unit');
    this.latIcon = $('#lat-icon');
    this.latIcon.innerHTML = iconSvg('wheel');
    this.setspeed = $('#setspeed');
    this.setspeedVal = $('#setspeed-val');
    this.gap = $('#gap');
    this.limit = $('#limit');
    this.assistText = $('#assist-text');
    this.alerts = $('#alerts');
    this.telltales = $('#telltales');
    this.roadinfo = $('#roadinfo');
    this.roadname = $('#roadname');
    this.roadnameName = $('#roadname-name');
    this.roadnameRef = $('#roadname-ref');
    this.lastRoadName = { key: '', at: 0 };
    this.blinkL = $('#blink-l');
    this.blinkR = $('#blink-r');
    this.gears = $$('#gear span');
    this.tt = {};
    for (const name of ['beam', 'belt', 'door', 'hands', 'eye', 'bsd', 'aeb', 'warn']) {
      this.tt[name] = icon(name);
      this.tt[name].classList.add('hidden');
      this.telltales.append(this.tt[name]);
    }
    this.lastAlertKey = '';
    this.lastRoadKey = '';
    this.isMetric = null;
  }

  unitFor(settings, f) {
    if (settings.units === 'mph' || settings.units === 'kmh') return settings.units;
    const icc = f && f.vehicle && f.vehicle.displayUnit;
    if (icc) return icc;
    return this.isMetric ? 'kmh' : 'mph';
  }

  update(state, settings, vehicle) {
    const op = state.op || {};
    const f = state.fisker;
    const cs = op.carState;
    const unit = this.unitFor(settings, f);
    const conv = unit === 'kmh' ? MS_TO_KPH : MS_TO_MPH;

    // speed: what the cluster shows (ICC display speed via carState.vEgoCluster), else Fisker CAN
    let v = null;
    if (cs) v = (cs.vEgoCluster != null && cs.vEgoCluster > 0 ? cs.vEgoCluster : cs.vEgo) * conv;
    else if (f && f.vehicle && f.vehicle.displaySpeed != null && f.vehicle.displayUnit === unit) v = f.vehicle.displaySpeed;
    else if (f && f.vehicle && f.vehicle.speedKph != null) v = f.vehicle.speedKph / 3.6 * conv;
    setText(this.speed, v == null ? '--' : String(Math.max(0, Math.round(v))));
    setText(this.unit, unit === 'kmh' ? 'km/h' : 'mph');

    // gear
    const g = GEAR_LETTER[(cs && cs.gear) || ''] || GEAR_LETTER[(f && f.vehicle && f.vehicle.gear) || ''] || '';
    this.gears.forEach(s => setClass(s, 'on', s.dataset.g === g));

    // blinkers mirror the car's flashing lamp outputs (see vehicle.js)
    const lights = (f && f.vehicle && f.vehicle.lights) || {};
    setClass(this.blinkL, 'on', vehicle.lamps.left);
    setClass(this.blinkR, 'on', vehicle.lamps.right);

    this._assist(op, f, unit, conv);
    this._limit(op, f, unit, conv, v);
    this._telltales(op, f, cs, lights);
    this._alerts(state, op, f);
    this._roadinfo(f, unit);
    this._roadname(state);
  }

  // The road we're on, bottom center: the map match's name and ref (mapmatch.js), else the road name
  // sunnypilot's mapd reports; the last one stays, dimmed, for a while when neither has one.
  _roadname(state) {
    const m = state.map, way = m && m.way;
    const mapd = state.op && state.op.liveMapDataSP && state.op.liveMapDataSP.roadName;
    let name = '', ref = '', stale = false;
    const pretty = (r) => (r || '').split(';').map(x => x.trim()).filter(Boolean).join(' · ');
    if (way && (way.name || way.ref)) { name = way.name || pretty(way.ref); ref = way.name ? pretty(way.ref) : ''; }
    else if (mapd) { name = pretty(mapd); }
    const now = performance.now();
    if (name) this.lastRoadName = { key: name + '|' + ref, name, ref, at: now };
    else if (now - this.lastRoadName.at < 8000 && this.lastRoadName.name) { name = this.lastRoadName.name; ref = this.lastRoadName.ref; stale = true; }
    setClass(this.roadname, 'hidden', !name);
    setClass(this.roadname, 'stale', stale);
    setClass(this.roadname, 'lifted', state.mode === 'replay');
    if (!name) return;
    const key = name + '|' + ref;
    if (this.roadname.dataset.key !== key) {
      this.roadname.dataset.key = key;
      setText(this.roadnameName, name);
      setText(this.roadnameRef, ref);
    }
  }

  _assist(op, f, unit, conv) {
    const mads = op.selfdriveStateSP && op.selfdriveStateSP.mads;
    const cc = op.carControl;
    const ss = op.selfdriveState;
    const tja = f && f.assist && f.assist.tja;
    let latCls = '';
    let latText = '';
    if (cc && cc.latActive) { latCls = 'active'; latText = mads && mads.enabled && !(ss && ss.enabled) ? 'MADS steering' : 'Steering'; }
    else if (mads && mads.state === 'softDisabling') { latCls = 'warn'; latText = 'Take over'; }
    else if (mads && mads.enabled) { latCls = 'override'; latText = mads.state === 'overriding' ? 'Driver steering' : 'Steering paused'; }
    else if (tja && (tja.v === 3 || tja.v === 4)) { latCls = 'active'; latText = 'Fisker autosteer'; }
    else if (!cc && f && f.vehicle && f.vehicle.epsLatCtrl && f.vehicle.epsLatCtrl.v === 2) { latCls = 'active'; latText = 'Steering'; }   // the car's own buses: the EPS is being steered
    else if ((mads && mads.available) || (ss && ss.engageable) || (!cc && f && f.vehicle && f.vehicle.epsLatCtrl && f.vehicle.epsLatCtrl.v === 1)) latCls = 'available';
    this.latIcon.className = 'assist-icon ' + latCls;

    // ACC set speed: Fisker ADAS (cluster unit) first, then openpilot's cruise state
    const acc = f && f.acc;
    const cs = op.carState;
    let set = null, engaged = false, available = false;
    if (acc && acc.state) {
      engaged = !!acc.engaged;
      available = ![0, 1, 9, 10].includes(acc.state.v);
      if (acc.setSpeed != null) {
        const iccUnit = f.vehicle && f.vehicle.displayUnit;
        set = iccUnit && iccUnit !== unit ? acc.setSpeed * (unit === 'kmh' ? 1.609344 : 1 / 1.609344) : acc.setSpeed;
      }
    }
    if (cs && cs.cruise) {
      engaged = engaged || cs.cruise.enabled;
      available = available || cs.cruise.available;
      if (set == null && cs.cruise.speedCluster > 0) set = cs.cruise.speedCluster * conv;
    }
    if (op.selfdriveState && op.selfdriveState.enabled && cs && cs.vCruiseCluster > 0 && cs.vCruiseCluster < 255) {
      set = cs.vCruiseCluster / 3.6 * conv;
      engaged = true;
    }
    setText(this.setspeedVal, set == null ? '--' : String(Math.round(set)));
    this.setspeed.className = 'setspeed ' + (engaged ? 'engaged' : available ? 'available' : 'off');

    // following distance: Fisker time gap (1-4) or openpilot personality (1-3)
    let bars = 0, maxBars = 4;
    if (acc && acc.timeGap >= 1 && acc.timeGap <= 4) bars = acc.timeGap;
    else if (cc && cc.hud && cc.hud.leadDistanceBars) { bars = cc.hud.leadDistanceBars; maxBars = 3; }
    else if (op.selfdriveState && PERSONALITY_BARS[op.selfdriveState.personality]) { bars = PERSONALITY_BARS[op.selfdriveState.personality]; maxBars = 3; }
    $$('i', this.gap).forEach((b, i) => { setClass(b, 'on', i < bars); b.style.display = i < maxBars ? '' : 'none'; });
    setClass(this.gap, 'engaged', engaged);

    // status line
    const md = op.modelV2;
    let text = '';
    if (md && md.laneChangeState && md.laneChangeState !== 'off') {
      text = `Changing lanes ${md.laneChangeDirection === 'left' ? '←' : '→'}`;
    } else if (latText || engaged) {
      const parts = [];
      if (latText) parts.push(latText);
      if (engaged) parts.push(set != null ? `ACC ${Math.round(set)}` : 'ACC');
      text = parts.join(' · ');
    } else if (op.selfdriveState && op.selfdriveState.experimentalMode) text = 'Experimental mode';
    this.assistText.innerHTML = '';
    if (text) this.assistText.append(latCls === 'active' || engaged ? el('b', text) : text);
  }

  _limit(op, f, unit, conv, v) {
    let value = null, style = unit === 'kmh' ? 'eu' : 'us';
    const tsr = f && f.tsr;
    if (tsr && tsr.speedLimit) {
      value = tsr.speedLimit;
      style = tsr.unit === 'kmh' ? 'eu' : 'us';
      if (tsr.unit && tsr.unit !== unit) value = Math.round(tsr.speedLimit * (unit === 'kmh' ? 1.609344 : 1 / 1.609344));
    } else {
      const sl = op.longitudinalPlanSP && op.longitudinalPlanSP.speedLimit;
      const ms = sl && sl.valid && sl.value > 0 ? sl.value : (op.liveMapDataSP && op.liveMapDataSP.speedLimit);
      if (ms) value = Math.round(ms * conv);
    }
    setClass(this.limit, 'hidden', !value);
    if (!value) return;
    const over = v != null && v > value + 2;
    const key = `${style}${value}${over}`;
    if (this.limit.dataset.key === key) return;
    this.limit.dataset.key = key;
    this.limit.className = `limit ${style}${over ? ' over' : ''}`;
    this.limit.innerHTML = style === 'us' ? `<small>SPEED</small><small>LIMIT</small><b>${value}</b>` : `${value}`;
  }

  _telltales(op, f, cs, lights) {
    const show = (name, color) => {
      const t = this.tt[name];
      t.className = 'tt' + (color ? ' ' + color : '') + (color === false ? ' hidden' : '');
    };
    show('beam', lights.high ? 'blue' : (lights.low ? 'green' : false));
    const belt = (cs && cs.seatbeltUnlatched) || (f && f.vehicle && f.vehicle.seatbelt && f.vehicle.seatbelt.driver === 1);
    show('belt', belt ? 'red' : false);
    const doors = f && f.vehicle && f.vehicle.doors;
    const doorOpen = (cs && cs.doorOpen) || (doors && (doors.fl || doors.fr || doors.rl || doors.rr || doors.trunk || doors.hood));
    show('door', doorOpen ? 'red' : false);
    const hands = f && f.assist && ((f.assist.handsOnRequest && f.assist.handsOnRequest.v) || (f.assist.hodWarning && f.assist.hodWarning.v));
    show('hands', hands ? 'amber' : false);
    const dm = op.driverMonitoringState;
    show('eye', dm && dm.distracted ? 'amber' : false);
    const bsd = f && f.threats && f.threats.bsdState;
    show('bsd', bsd && bsd.v === 4 ? 'amber' : (bsd && bsd.v === 0 ? '' : false));
    const aeb = f && f.aeb && f.aeb.warning && f.aeb.warning.v;
    show('aeb', aeb ? 'red' : false);
    const fault = f && f.warnings && f.warnings.sysFault && f.warnings.sysFault.v;
    show('warn', fault ? (fault >= 2 ? 'red' : 'amber') : false);
  }

  _alerts(state, op, f) {
    const items = [];
    const ss = op.selfdriveState;
    if (ss && ss.alertSize && ss.alertSize !== 'none' && (ss.alertText1 || ss.alertText2)) {
      items.push({ cls: ss.alertStatus || 'normal', t1: ss.alertText1, t2: ss.alertText2 });
    }
    if (f && f.warnings) {
      const w = f.warnings;
      if (w.takeover && w.takeover.v >= 1 && w.takeover.v <= 3) items.push({ cls: 'critical', t1: 'Take control', t2: 'Fisker ADAS takeover request' });
      if (f.aeb && f.aeb.warning && f.aeb.warning.v >= 2) items.push({ cls: 'critical', t1: 'Collision warning', t2: prettyLabel(f.aeb.warning.n) });
      if (w.text && w.text.v) items.push({ cls: 'userPrompt', t1: prettyLabel(w.text.n), t2: 'Fisker ADAS' });
      if (w.highPriority && w.highPriority.v) items.push({ cls: 'userPrompt', t1: prettyLabel(w.highPriority.n), t2: '' });
    }
    const notice = state.server && state.server.notice;
    if (notice) items.push({ cls: 'info', t1: notice, t2: '' });
    const key = JSON.stringify(items);
    if (key === this.lastAlertKey) return;
    this.lastAlertKey = key;
    this.alerts.innerHTML = '';
    for (const a of items.slice(0, 3)) this.alerts.append(el(`div.alert.${a.cls}`, el('b', a.t1 || ''), a.t2 ? el('span', a.t2) : null));
  }

  _roadinfo(f, unit) {
    const rows = [];
    if (f) {
      const tlr = f.tlr;
      if (tlr && tlr.detected) {
        const color = (tlr.active && tlr.active.color) || tlr.color || '';
        const c = color.toLowerCase();
        const lamp = c.startsWith('red') ? 'red' : c.includes('amber') || c.includes('orange') ? 'amber' : c.includes('green') ? 'green' : '';
        const arrow = /arrow/i.test(tlr.shape || '') ? ` (${prettyLabel(tlr.shape).toLowerCase()})` : '';
        rows.push(['tl', el('div.ri', el(`i.lamp.${lamp || 'none'}`), `${prettyLabel(color || 'Traffic')} light${arrow}`,
          tlr.dist ? el('small', `${Math.round(tlr.dist)} m`) : null)]);
      }
      if (f.tsr && f.tsr.prohibited) rows.push(['ps', el('div.ri', '⛔ ', prettyLabel(f.tsr.prohibited))]);
      // closest park-distance-control reading per bumper (cm), when an obstacle is in range
      const pdc = f.parking && f.parking.pdc;
      for (const [k, name] of [['front', 'Front'], ['rear', 'Rear']]) {
        const vals = pdc ? pdc[k].filter(v => v != null) : [];
        if (vals.length) {
          const cm = Math.min(...vals);
          const txt = unit === 'kmh' ? `${cm} cm` : `${Math.round(cm / 2.54)} in`;
          rows.push([`pdc${k}`, el(`div.ri${cm < 40 ? '.bad' : ''}`, el('i.lamp.' + (cm < 40 ? 'red' : cm < 80 ? 'amber' : 'green')), name, el('small', txt))]);
        }
      }
      const road = f.road || {};
      for (const k of ['construction', 'landmark', 'laneMarking', 'hazard']) {
        const it = road[k];
        if (it && it.dist) rows.push([k, el('div.ri', prettyLabel(it.type || k), el('small', `${it.dist} m`))]);
      }
      if (f.vehicle && f.vehicle.outsideTempC != null) {
        const tc = f.vehicle.outsideTempC;
        rows.push(['temp', el('div.ri', el('small', unit === 'kmh' ? `${Math.round(tc)}°C` : `${Math.round(tc * 9 / 5 + 32)}°F`))]);
      }
    }
    const key = rows.map(r => r[0] + r[1].textContent).join('|');
    if (key === this.lastRoadKey) return;
    this.lastRoadKey = key;
    this.roadinfo.innerHTML = '';
    rows.forEach(r => this.roadinfo.append(r[1]));
  }
}
