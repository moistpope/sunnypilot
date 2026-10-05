#!/usr/bin/env node
// Runs the page's pipeline over a recorded tick stream (as tools/replay_ticks.mjs does) and reports how the
// pose estimator (static/js/world/pose.js) did against the GPS fixes and heading in it: the distance between each
// fix and the pose predicted for the fix's time (its innovation, before the fix corrects it), the heading
// innovations, and the wheel-speed scale, gyro bias and GPS lag it settled on.
//
//   node tools/pose_eval.mjs ticks.jsonl            # plain ticks, or a reference run's lines ({now, fed, snap})
//   node tools/pose_eval.mjs --warm 10 ticks.jsonl  # seconds skipped before the statistics start (default 5)
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const { DBC } = await import(path.join(here, '../static/js/world/dbc.js'));
const { StateBuilder, wireFrames } = await import(path.join(here, '../static/js/world/state.js'));

const THIRD_PARTY = path.join(here, '../../../third_party/webhud');
const WORLD_DBC = path.join(THIRD_PARTY, 'dbc/fisker_ocean_adas_world.dbc');
const RADAR_DBC = path.join(here, '../../../../opendbc_repo/opendbc/dbc/fisker_ocean_mrr.dbc');

const args = process.argv.slice(2);
let warm = 5.0;
if (args[0] === '--warm') { warm = parseFloat(args[1]); args.splice(0, 2); }
const file = args[0];
if (!file) { console.error('usage: pose_eval.mjs [--warm S] <ticks.jsonl>'); process.exit(2); }

const builder = new StateBuilder(new DBC(fs.readFileSync(WORLD_DBC, 'latin1')),
  fs.existsSync(RADAR_DBC) ? new DBC(fs.readFileSync(RADAR_DBC, 'latin1')) : null);
const pose = builder.pose;

const innov = [], hdgInnov = [], samples = [];
let fixes = 0, headings = -1, t0 = null, ticks = 0, lastState = null, lastLag = null;
const lagTrace = [];
const DEG = Math.PI / 180;
const pct = (arr, q) => { const s = [...arr].sort((a, b) => a - b); return s.length ? s[Math.min(s.length - 1, Math.floor(q * s.length))] : null; };
const f2 = (v) => (v == null ? '-' : v.toFixed(2));

const rl = readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity });
for await (const line of rl) {
  if (!line.trim()) continue;
  const rec = JSON.parse(line);
  const tick = rec.fed ? { now: rec.now, reset: rec.fed.reset > 0, brand: rec.brand, can: rec.fed.can, op: rec.fed.op } : rec;
  if (tick.reset) builder.reset();
  if (tick.brand !== undefined) builder.setBrand(tick.brand);
  for (const [t, frames] of tick.can || []) {
    builder.feedCan(wireFrames(frames), t);
    if (t0 === null) t0 = t;
    if (pose.fixes !== fixes) { fixes = pose.fixes; if (t - t0 > warm && pose.lastInnov != null) innov.push(pose.lastInnov); }
    if (pose.lastHeadingT !== headings) { headings = pose.lastHeadingT; if (t - t0 > warm && pose.lastHeadingInnov != null) hdgInnov.push(Math.abs(pose.lastHeadingInnov) / DEG); }
  }
  for (const [which, t, data] of tick.op || []) builder.feedService(which, data, t);
  const snap = builder.snapshot(tick.now);
  lastState = snap.pose;
  if (pose.lagMeasured !== lastLag) { lastLag = pose.lagMeasured; lagTrace.push(`${(tick.now - t0).toFixed(0)}s:${lastLag.toFixed(3)}`); }
  if (++ticks % 200 === 0 && snap.pose) samples.push(`  t=${snap.t} x=${snap.pose.x} y=${snap.pose.y} h=${(snap.pose.h / DEG).toFixed(1)}deg lat=${snap.pose.lat} lon=${snap.pose.lon} v=${snap.pose.v} gpsAge=${snap.pose.gpsAge} q=${snap.pose.quality}`);
}

console.log(`${ticks} ticks, ${fixes} fixes accepted, ${innov.length} after warm-up (${warm} s)`);
console.log(`fix innovation (m): median ${f2(pct(innov, 0.5))}, p90 ${f2(pct(innov, 0.9))}, max ${f2(innov.length ? Math.max(...innov) : null)}`);
console.log(`heading innovation (deg): median ${f2(pct(hdgInnov, 0.5))}, p90 ${f2(pct(hdgInnov, 0.9))}  (${hdgInnov.length} observations)`);
console.log(`speed scale ${pose.scale.toFixed(4)} (fix displacement alone: ${pose.scaleTrack == null ? '-' : pose.scaleTrack.toFixed(4)}), gyro bias ${(pose.bias / DEG).toFixed(3)} deg/s, GPS lag ${pose.lag.toFixed(3)} s (measured ${pose.lagMeasured == null ? '-' : pose.lagMeasured.toFixed(2)}), sigma ${Math.sqrt(pose.p).toFixed(2)} m`);
console.log(`lag measurements: ${lagTrace.join(' ') || '-'}`);
console.log('samples:'); for (const s of samples) console.log(s);
if (lastState) console.log('last:', JSON.stringify(lastState));
