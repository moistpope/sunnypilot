// The world-model worker: decodes the comma bridge's ticks (raw CAN frames + openpilot service
// extracts) into the HUD's state snapshots, off the page's main thread so the 3D view keeps its
// frame budget. One tick in, one snapshot out, in the same shape the comma's server used to send.
//
// Messages in:  {type:'init', worldDbc, radarDbc}   the DBC texts (radarDbc may be null)
//               {type:'tick', data}                  a bridge tick (see server.py: now, reset, brand, can, op, mode, replay, server)
//               {type:'raw', addrs}                  which messages the signal browser watches ([] for none)
//               {type:'calibration', on}             the world model's measured sensor calibration on/off
// Messages out: {type:'state', data}                 the snapshot for the tick
//               {type:'raw', data}                   the watched messages' decoded signals, ~5 Hz
import { DBC } from './dbc.js';
import { StateBuilder, wireFrames } from './state.js';

const RAW_RATE_HZ = 5;

const EARLY_TICKS = 200;   // ticks kept while the DBCs are still loading (the first is the bridge's snapshot)

let builder = null;
let rawAddrs = [];
let rawNext = 0;
let calibrationOn = true;
let early = [];

self.onmessage = (ev) => {
  const msg = ev.data;
  try {
    if (msg.type === 'init') {
      builder = new StateBuilder(new DBC(msg.worldDbc), msg.radarDbc ? new DBC(msg.radarDbc) : null);
      builder.setCalibration(calibrationOn);
      self.postMessage({ type: 'ready', dbc: { messages: [...builder.world.dbc.messages.values()].sort((a, b) => a.address - b.address).map(m => m.toJSON()) } });
      for (const tick of early) onTick(tick);
      early = [];
    } else if (msg.type === 'tick') {
      if (builder) onTick(msg.data);
      else {
        // a reset tick (the bridge's snapshot for a new viewer) makes everything before it moot
        if (msg.data.reset) early = [];
        early.push(msg.data);
        if (early.length > EARLY_TICKS) early.shift();
      }
    } else if (msg.type === 'raw') {
      rawAddrs = (msg.addrs || []).map(a => (typeof a === 'string' ? parseInt(a, 16) : a)).slice(0, 200);
      rawNext = 0;
    } else if (msg.type === 'calibration') {
      calibrationOn = !!msg.on;
      if (builder) builder.setCalibration(calibrationOn);
    }
  } catch (e) {
    self.postMessage({ type: 'error', message: String(e && e.stack || e) });
  }
};

function onTick(tick) {
  if (tick.reset) builder.reset();
  if (tick.brand !== undefined) builder.setBrand(tick.brand);
  for (const [t, frames] of tick.can || []) builder.feedCan(wireFrames(frames), t);
  for (const [which, t, data] of tick.op || []) builder.feedService(which, data, t);
  const snap = builder.snapshot(tick.now);
  snap.mode = tick.mode;
  snap.replay = tick.replay ?? null;
  snap.server = tick.server ?? null;
  self.postMessage({ type: 'state', data: snap });
  if (rawAddrs.length) {
    const wall = Date.now();
    if (wall >= rawNext) {
      rawNext = wall + 1000 / RAW_RATE_HZ;
      self.postMessage({ type: 'raw', data: builder.world.rawMessages(rawAddrs, tick.now) });
    }
  }
}
