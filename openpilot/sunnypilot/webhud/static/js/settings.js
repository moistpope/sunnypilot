// Settings sheet: CAN overrides (opendbc/car/fisker/values.py), driving params, display, playback,
// a live CAN signal browser and connection info.
import { $, $$, el, api, fmtBytes, fmtTime, prettyLabel, prettySignal, iconSvg } from './util.js';

export class Settings {
  constructor(app) {
    this.app = app;
    this.sheet = $('#settings');
    this.body = $('#tab-body');
    this.tab = 'overrides';
    $('#btn-settings').innerHTML = iconSvg('gear');
    $('#settings-close').innerHTML = iconSvg('close');
    $('#btn-settings').addEventListener('click', () => this.open());
    $('#settings-close').addEventListener('click', () => this.close());
    $$('#tabs button').forEach(b => b.addEventListener('click', () => this.show(b.dataset.tab)));
    this.overrides = null;
    this.edits = {};
    this.dbc = null;
    this.expanded = new Set();
    this.rawData = {};
  }

  get isOpen() { return !this.sheet.classList.contains('hidden'); }

  open(tab) {
    this.sheet.classList.remove('hidden');
    this.sheet.setAttribute('aria-hidden', 'false');
    this.show(tab || this.tab);
  }

  close() {
    this.sheet.classList.add('hidden');
    this.sheet.setAttribute('aria-hidden', 'true');
    this.app.subscribeRaw([]);
  }

  show(tab) {
    this.tab = tab;
    $$('#tabs button').forEach(b => b.classList.toggle('on', b.dataset.tab === tab));
    this.body.innerHTML = '';
    this.body.scrollTop = 0;
    if (tab !== 'signals') this.app.subscribeRaw([]);
    const render = {
      overrides: () => this.renderOverrides(), driving: () => this.renderDriving(), display: () => this.renderDisplay(),
      playback: () => this.renderPlayback(), signals: () => this.renderSignals(), about: () => this.renderAbout(),
    }[tab];
    render && render();
  }

  // ---- CAN overrides --------------------------------------------------------------------------

  async renderOverrides(reload = true) {
    const body = this.body;
    if (reload || !this.overrides) {
      body.append(el('p.desc', 'Loading…'));
      try {
        this.overrides = await api('/api/overrides');
      } catch (e) {
        body.innerHTML = '';
        body.append(el('div.banner.bad', `Couldn't load overrides: ${e.message}`));
        return;
      }
      this.edits = {};
    }
    if (this.tab !== 'overrides') return;
    body.innerHTML = '';
    const data = this.overrides;
    if (!data.supported) {
      body.append(el('div.banner', 'This car has no editable CAN overrides.'));
      return;
    }
    body.append(el('p.desc', 'Signals openpilot replaces when it relays these ICC frames to the ADAS module ' +
      '(defaults from opendbc/car/fisker/values.py). Changes apply within a fraction of a second, no restart needed.'));
    if (!data.editable) body.append(el('div.banner.warn', 'Changes are locked while the car is moving.'));
    const showAll = !!this.showAllSignals;

    for (const table of data.tables) {
      const edits = this.edits[table.message] || {};
      const sec = el('div.section');
      sec.append(el('h3', prettySignal(table.message).replace(/^0x/, 'ICC 0x'), el('code', table.message),
        table.customized ? el('span.badge', 'customized') : el('span.badge.gray', 'code defaults')));
      sec.append(el('p.desc', table.description));
      const rows = el('div.rows');
      const signals = table.signals.filter(s => showAll || s.override != null || s.default != null || (s.name in edits));
      for (const sig of signals) rows.append(this.overrideRow(table, sig, edits, data.editable));
      if (!signals.length) rows.append(el('div.row', el('div.lbl', el('small', 'No overrides — the ICC frame passes through unchanged.'))));
      sec.append(rows);
      const dirty = Object.keys(edits).length > 0;
      sec.append(el('div.btns',
        el('button.btn.primary', { disabled: !dirty || !data.editable, onclick: () => this.saveOverrides(table) }, 'Save'),
        el('button.btn', { disabled: !dirty, onclick: () => { delete this.edits[table.message]; this.renderOverrides(false); } }, 'Revert'),
        el('button.btn.danger', { disabled: !table.customized || !data.editable, onclick: () => this.resetOverrides(table) }, 'Reset to code defaults'),
      ));
      body.append(sec);
    }
    body.append(el('div.row', el('div.lbl', el('b', 'Show every signal'), el('small', 'Add overrides for signals the code leaves alone.')),
      this.app.switch(showAll, v => { this.showAllSignals = v; this.renderOverrides(false); })));
  }

  overrideRow(table, sig, edits, editable) {
    const has = (k) => Object.prototype.hasOwnProperty.call(edits, k);
    const value = has(sig.name) ? edits[sig.name] : sig.override;
    const changed = has(sig.name);
    const enumEntries = Object.entries(sig.values || {});
    const label = (v) => (v == null ? '—' : (sig.values && sig.values[String(Math.round(v))] ? `${prettyLabel(sig.values[String(Math.round(v))])} (${v})` : String(v)));

    const setEdit = (v) => {
      const t = (this.edits[table.message] = this.edits[table.message] || {});
      if (v === sig.override || (v === null && sig.override == null)) delete t[sig.name];
      else t[sig.name] = v;
      if (!Object.keys(t).length) delete this.edits[table.message];
      this.renderOverrides(false);
    };

    let control;
    if (sig.locked) {
      control = el('small', 'pass-through');
    } else if (enumEntries.length && enumEntries.length <= 64) {
      control = el('select', { disabled: !editable, onchange: (e) => setEdit(e.target.value === '' ? null : Number(e.target.value)) },
        el('option', { value: '' }, 'Pass through (ICC value)'),
        enumEntries.map(([k, n]) => el('option', { value: k, selected: value != null && Number(k) === value }, `${prettyLabel(n)} (${k})`)));
      if (value == null) control.value = '';
    } else {
      const input = el('input', { type: 'number', step: sig.factor, min: sig.min, max: sig.max, value: value ?? '', placeholder: 'pass', disabled: !editable,
        onchange: (e) => setEdit(e.target.value === '' ? null : Number(e.target.value)) });
      control = input;
    }
    const meta = [];
    if (sig.default != null) meta.push(`default ${label(sig.default)}`);
    else meta.push('default pass-through');
    return el(`div.row${changed ? '.changed' : ''}${sig.locked ? '.locked' : ''}`,
      el('div.lbl', el('b', prettySignal(sig.name)),
        el('small', sig.comment || sig.name),
        el('small.cur', `ICC sends ${label(sig.current)} · ${meta.join(' · ')}`)),
      control);
  }

  async saveOverrides(table) {
    const current = {};
    for (const s of table.signals) if (s.override != null) current[s.name] = s.override;
    const edits = this.edits[table.message] || {};
    for (const [k, v] of Object.entries(edits)) {
      if (v === null) delete current[k];
      else current[k] = v;
    }
    try {
      this.overrides = await api('/api/overrides', { method: 'PUT', body: { [table.message]: current } });
      delete this.edits[table.message];
      this.app.toast(`${table.message} saved`);
    } catch (e) {
      this.app.toast(`Save failed: ${e.message}`);
    }
    this.renderOverrides(false);
  }

  async resetOverrides(table) {
    if (!confirm(`Reset ${table.message} to the defaults in values.py?`)) return;
    try {
      this.overrides = await api(`/api/overrides?message=${encodeURIComponent(table.message)}`, { method: 'DELETE' });
      delete this.edits[table.message];
      this.app.toast(`${table.message} reset to code defaults`);
    } catch (e) {
      this.app.toast(`Reset failed: ${e.message}`);
    }
    this.renderOverrides(false);
  }

  // ---- driving params ----------------------------------------------------------------------------

  async renderDriving() {
    const body = this.body;
    let p;
    try { p = await api('/api/params'); } catch (e) { body.append(el('div.banner.bad', e.message)); return; }
    if (this.tab !== 'driving') return;
    const put = async (obj) => {
      try { await api('/api/params', { method: 'PUT', body: obj }); this.app.toast('Saved'); this.renderDrivingSoon(); } catch (e) { this.app.toast(e.message); }
    };
    body.append(el('div.section',
      el('h3', 'Following distance'),
      el('p.desc', 'openpilot driving personality (used with openpilot longitudinal control). The Fisker ADAS time gap is set with the steering wheel buttons.'),
      this.app.segmented([['0', 'Aggressive'], ['1', 'Standard'], ['2', 'Relaxed']], String(p.LongitudinalPersonality ?? 1), v => put({ LongitudinalPersonality: Number(v) })),
    ));
    body.append(el('div.section', el('div.rows',
      el('div.row', el('div.lbl', el('b', 'Experimental mode'), el('small', 'End-to-end longitudinal from the driving model.')),
        this.app.switch(!!p.ExperimentalMode, v => put({ ExperimentalMode: v }))),
      el('div.row', el('div.lbl', el('b', 'Use metric units'), el('small', 'Device-wide setting; the HUD follows the cluster unit when available.')),
        this.app.switch(!!p.IsMetric, v => put({ IsMetric: v }))),
    )));
  }

  renderDrivingSoon() { setTimeout(() => { if (this.tab === 'driving') this.show('driving'); }, 150); }

  // ---- display (stored in this browser) ------------------------------------------------------------

  renderDisplay() {
    const s = this.app.settings;
    const set = (k, v) => this.app.setSetting(k, v);
    const body = this.body;
    body.append(el('div.section', el('h3', 'Theme'),
      this.app.segmented([['auto', 'Auto'], ['light', 'Day'], ['dark', 'Night']], s.theme, v => set('theme', v))));
    body.append(el('div.section', el('h3', 'Speed units'),
      this.app.segmented([['auto', 'Follow cluster'], ['mph', 'mph'], ['kmh', 'km/h']], s.units, v => set('units', v))));
    body.append(el('div.section', el('h3', 'Lane lines'),
      el('p.desc', 'Blended: the Fisker ADAS lanes, refined with openpilot\'s where they agree and filled in where only openpilot sees a line. ' +
        'Or either source alone, or both drawn separately (openpilot faint).'),
      this.app.segmented([['blend', 'Blended'], ['fisker', 'Fisker ADAS'], ['model', 'openpilot'], ['both', 'Both']], s.laneSource, v => set('laneSource', v))));
    body.append(el('div.section', el('h3', 'Car color'),
      this.app.segmented([['model', 'Original'], ['#1d1f24', 'Black'], ['#e8e9eb', 'White'], ['#6e7781', 'Gray'], ['#3a5a8c', 'Blue'], ['#7d2b2b', 'Red'], ['#5f6b4e', 'Green']],
        s.egoColor, v => set('egoColor', v))));
    const toggles = [
      ['showGround', 'Ground texture', 'Fine textured ground that moves under the car with its speed and steering.'],
      ['showRoad', 'Inferred road', 'Fill in the road and lanes the cameras don\'t report, following the last known lanes and your path.'],
      ['showSigns', 'Traffic lights & signs', 'Lights, signs and stop lines the car\'s camera reports, placed where they most likely are.'],
      ['showTracks', 'Power trails', 'Tire tracks colored by how hard the motors pull (blue light, through the spectrum to red at full power), longer the faster you go, with light motes off the tires.'],
      ['showPath', 'Planned path', 'Blue band along openpilot\'s path while steering is engaged.'],
      ['showUss', 'Parking sensors', 'Ultrasonic zone arcs around the car at low speed.'],
      ['showOpLeads', 'openpilot leads', 'Show radarState leads the ADAS object list doesn\'t already cover.'],
      ['autoView', 'Auto view', 'Switch to the top view while parking and back when driving.'],
    ];
    body.append(el('div.section', el('div.rows', toggles.map(([k, t, d]) =>
      el('div.row', el('div.lbl', el('b', t), el('small', d)), this.app.switch(s[k] !== false, v => set(k, v)))))));
    body.append(el('div.section', el('h3', 'Geometry calibration'),
      el('p.desc', 'The ADAS lane heading direction is verified on the car; lane curvature and object heading signs aren\'t documented. ' +
        'Flip these if lines bend or cars point the wrong way compared to the openpilot lanes.'),
      el('div.rows',
        el('div.row', el('div.lbl', el('b', 'Invert lane heading')), this.app.switch(s.laneHeadingSign === -1, v => set('laneHeadingSign', v ? -1 : 1))),
        el('div.row', el('div.lbl', el('b', 'Invert lane curvature')), this.app.switch(s.laneCurvatureSign === -1, v => set('laneCurvatureSign', v ? -1 : 1))),
        el('div.row', el('div.lbl', el('b', 'Invert object heading')), this.app.switch(s.objectHeadingSign === -1, v => set('objectHeadingSign', v ? -1 : 1))),
      )));
  }

  // ---- playback ---------------------------------------------------------------------------------------

  async renderPlayback() {
    const body = this.body;
    const state = this.app.state;
    if (state && state.mode === 'replay' && state.replay) {
      const r = state.replay;
      body.append(el('div.banner', `Playing ${r.route} · ${fmtTime(r.t)} / ${fmtTime(r.duration)}`, ' ',
        el('button.btn', { onclick: () => { this.app.replay('live'); this.close(); } }, 'Back to live')));
    }
    const input = el('input', { type: 'file', accept: '.zst,.bz2,.rlog,.qlog,*/*', style: { display: 'none' }, onchange: e => this.upload(e.target.files[0]) });
    const dz = el('div.dropzone', { onclick: () => input.click() }, 'Drop an rlog / qlog file here, or tap to choose one', input);
    dz.addEventListener('dragover', e => { e.preventDefault(); dz.classList.add('over'); });
    dz.addEventListener('dragleave', () => dz.classList.remove('over'));
    dz.addEventListener('drop', e => { e.preventDefault(); dz.classList.remove('over'); if (e.dataTransfer.files[0]) this.upload(e.dataTransfer.files[0]); });
    body.append(dz);
    if (state && state.server && state.server.moving) body.append(el('div.banner.warn', 'Playback is unavailable while the car is moving.'));
    body.append(el('div.btns', { style: { marginTop: '0', marginBottom: '16px' } },
      el('button.btn', { onclick: () => { this.app.replay('demo'); this.close(); } }, 'Play demo drive')));

    const list = el('div.routes', el('p.desc', 'Loading routes…'));
    body.append(el('div.section', el('h3', 'Routes on this device'), list));
    let data;
    try { data = await api('/api/routes'); } catch (e) { list.innerHTML = ''; list.append(el('div.banner.bad', e.message)); return; }
    if (this.tab !== 'playback') return;
    list.innerHTML = '';
    if (!data.routes.length) list.append(el('p.desc', 'No recorded routes found.'));
    for (const r of data.routes.slice(0, 60)) {
      const when = new Date(r.mtime * 1000);
      list.append(el('div.route',
        el('div', el('b', r.name), el('small', `${when.toLocaleDateString()} ${when.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} · ${r.segments.length} seg · ${fmtBytes(r.size)}`)),
        el('div.segs',
          el('button', { onclick: () => this.play(r.name, null) }, '▶ Play'),
          r.segments.map(sg => el('button', { title: sg.kind, onclick: () => this.play(r.name, sg.n) }, String(sg.n))))));
    }
  }

  play(route, segment) {
    this.app.replay('load', { route, segment });
    this.close();
  }

  async upload(file) {
    if (!file) return;
    this.app.toast(`Uploading ${file.name} (${fmtBytes(file.size)})…`, 60000);
    try {
      await api(`/api/upload?name=${encodeURIComponent(file.name)}`, { method: 'PUT', body: file });
      this.app.toast('Uploaded — starting playback');
      this.close();
    } catch (e) {
      this.app.toast(`Upload failed: ${e.message}`);
    }
  }

  // ---- signal browser ---------------------------------------------------------------------------------

  async renderSignals() {
    const body = this.body;
    if (!this.dbc) {
      body.append(el('p.desc', 'Loading DBC…'));
      try { this.dbc = await api('/api/dbc'); } catch (e) { body.innerHTML = ''; body.append(el('div.banner.bad', e.message)); return; }
      if (this.tab !== 'signals') return;
      body.innerHTML = '';
    }
    const filter = el('input.sig-filter', { type: 'search', placeholder: 'Filter messages or signals (e.g. Obj1, USS, 0x31C)', value: this.sigFilter || '' });
    const list = el('div');
    body.append(el('p.desc', 'Live decoded ADASBUS messages (Fisker FM29 matrix). Tap a message to watch its signals.'), filter, list);
    const draw = () => {
      const q = (this.sigFilter || '').toLowerCase();
      list.innerHTML = '';
      this.msgNodes = new Map();
      for (const m of this.dbc.messages) {
        const hex = '0x' + m.address.toString(16).toUpperCase().padStart(3, '0');
        const match = !q || m.name.toLowerCase().includes(q) || hex.toLowerCase().includes(q) ||
          m.signals.some(s => s.name.toLowerCase().includes(q) || (s.comment || '').toLowerCase().includes(q));
        if (!match) continue;
        const open = this.expanded.has(hex);
        const info = el('em', '');
        const node = el('div.msg',
          el('button', { onclick: () => { open ? this.expanded.delete(hex) : this.expanded.add(hex); draw(); this.subscribe(); } },
            el('b', hex), el('small', `${m.name}${m.comment ? ' — ' + m.comment : ''}`), info));
        let table = null;
        if (open) {
          table = el('table');
          for (const s of m.signals) {
            table.append(el('tr', { dataset: { sig: s.name } }, el('td', s.name, el('div', { style: { color: 'var(--muted)', fontFamily: 'var(--font)' } }, s.comment || '')),
              el('td.v', '—')));
          }
          node.append(table);
        }
        this.msgNodes.set(hex, { node, info, table, msg: m });
        list.append(node);
      }
      this.updateRaw();
    };
    filter.addEventListener('input', () => { this.sigFilter = filter.value; draw(); });
    draw();
    this.subscribe();
  }

  subscribe() { this.app.subscribeRaw(this.tab === 'signals' ? [...this.expanded] : []); }

  onRaw(data) {
    this.rawData = data;
    if (this.tab === 'signals' && this.isOpen) this.updateRaw();
  }

  updateRaw() {
    if (!this.msgNodes) return;
    for (const [hex, n] of this.msgNodes) {
      const d = this.rawData[hex];
      if (!d) continue;
      n.info.textContent = `bus ${d.src} · ${d.age < 1 ? 'live' : d.age + ' s ago'}`;
      if (!n.table) continue;
      for (const tr of n.table.rows) {
        const name = tr.dataset.sig;
        const v = d.signals[name];
        const sig = n.msg.signals.find(s => s.name === name);
        const lbl = sig && sig.values && v != null ? sig.values[String(Math.round((v - sig.offset) / sig.factor))] : null;
        const td = tr.cells[1];
        const text = v == null ? '—' : `${v}${sig && sig.unit ? ' ' + sig.unit : ''}`;
        td.innerHTML = '';
        td.append(text);
        if (lbl) td.append(el('small', prettyLabel(lbl)));
      }
    }
  }

  // ---- about ------------------------------------------------------------------------------------------

  async renderAbout() {
    const body = this.body;
    let st;
    try { st = await api('/api/status'); } catch (e) { body.append(el('div.banner.bad', e.message)); return; }
    if (this.tab !== 'about') return;
    body.append(el('div.section', el('h3', 'Open this HUD'), el('div.kv',
      ...st.urls.flatMap(u => [el('span', u.includes('.local') ? 'mDNS' : 'IP'), el('a', { href: u }, u)]))));
    body.append(el('div.section', el('h3', 'Status'), el('div.kv',
      el('span', 'Version'), el('span', st.version),
      el('span', 'Mode'), el('span', st.mode),
      el('span', 'Car'), el('span', st.brand || 'unknown'),
      el('span', 'mDNS'), el('span', `${st.hostname} via ${st.mdns}`),
      el('span', 'Onroad'), el('span', st.onroad ? 'yes' : 'no'),
      el('span', 'Live data'), el('span', st.liveError ? `unavailable (${st.liveError})` : 'ok'),
    )));
    body.append(el('p.desc', 'Touch: one finger rotates around the car, two fingers zoom and pan. The view recenters on the car a few seconds after you let go.'));
    body.append(el('div.section', el('h3', 'Credits'), el('p.desc',
      el('a', { href: 'https://sketchfab.com/3d-models/fisker-ocean-low-poly-f506bfe876864c04b68bdfc59070739a', target: '_blank' }, 'Fisker Ocean (low-poly)'),
      ' by ', el('a', { href: 'https://sketchfab.com/LagzDesign', target: '_blank' }, 'LagzDesign'), ', ',
      el('a', { href: 'http://creativecommons.org/licenses/by/4.0/', target: '_blank' }, 'CC BY 4.0'),
      '. 3D rendering by three.js (MIT).')));
  }
}
