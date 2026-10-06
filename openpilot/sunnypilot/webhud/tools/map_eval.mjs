#!/usr/bin/env node
// Runs the page's pipeline over a recorded tick stream with the OSM tiles from disk and reports how the map
// matcher (static/js/world/mapmatch.js) did: how often it had a road, how often that road agrees with the road
// name sunnypilot's mapd reported in the same recording (liveMapDataSP.roadName), how far the horizon reached,
// how often the matched way changed, and the lateral offsets it saw.
//
//   node tools/map_eval.mjs --tiles ~/.comma/media/0/osm/offline ticks.jsonl
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const { DBC } = await import(path.join(here, '../static/js/world/dbc.js'));
const { StateBuilder, wireFrames } = await import(path.join(here, '../static/js/world/state.js'));
const { MapData } = await import(path.join(here, '../static/js/world/mapdata.js'));

const THIRD_PARTY = path.join(here, '../../../third_party/webhud');
const WORLD_DBC = path.join(THIRD_PARTY, 'dbc/fisker_ocean_adas_world.dbc');

const args = process.argv.slice(2);
let tiles = path.join(process.env.HOME || '', '.comma/media/0/osm/offline');
const ti = args.indexOf('--tiles');
if (ti >= 0) { tiles = args[ti + 1]; args.splice(ti, 2); }
const file = args[0];
if (!file) { console.error('usage: map_eval.mjs [--tiles <offline dir>] <ticks.jsonl>'); process.exit(2); }

const fetched = [];
const md = new MapData(async (cell, name) => {
  const p = path.join(tiles, cell, name);
  fetched.push(`${cell}/${name}${fs.existsSync(p) ? '' : ' (missing)'}`);
  return fs.existsSync(p) ? new Uint8Array(fs.readFileSync(p)) : null;
});
const builder = new StateBuilder(new DBC(fs.readFileSync(WORLD_DBC, 'latin1')), null, { mapData: md });

const f1 = (v) => (v == null ? '-' : v.toFixed(1));
const pct = (arr, q) => { const s = [...arr].sort((a, b) => a - b); return s.length ? s[Math.min(s.length - 1, Math.floor(q * s.length))] : null; };
const norm = (s) => (s || '').toLowerCase();

let ticks = 0, withPose = 0, loading = 0, matched = 0, agree = 0, compared = 0, switches = 0, lastWay = null, adasis = 0, adasisCurv = 0;
const lengths = [], laterals = [], confs = [], branchCounts = [], disagreements = new Map(), ways = new Map();
const trailLeft = [], trailAlong = [], trailH = [];   // how far the shown pose trails the estimate (pose.js SHOW_*)
let snaps = 0, features = 0, featureKinds = new Map();
let roadName = null, roadNameT = -1e9;

const rl = readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity });
for await (const line of rl) {
  if (!line.trim()) continue;
  const rec = JSON.parse(line);
  const tick = rec.fed ? { now: rec.now, reset: rec.fed.reset > 0, brand: rec.brand, can: rec.fed.can, op: rec.fed.op } : rec;
  if (tick.reset) builder.reset();
  if (tick.brand !== undefined) builder.setBrand(tick.brand);
  for (const [t, frames] of tick.can || []) builder.feedCan(wireFrames(frames), t);
  for (const [which, t, data] of tick.op || []) {
    builder.feedService(which, data, t);
    if (which === 'liveMapDataSP') { roadName = data.roadName || null; roadNameT = t; }
  }
  let snap = builder.snapshot(tick.now);
  if (snap.map && snap.map.loading) { await md.settle(); snap = builder.snapshot(tick.now); }   // offline: wait for the tile, as a car would
  ticks++;
  if (snap.pose && snap.pose.origin) {
    withPose++;
    trailLeft.push(Math.abs(snap.pose.offset.left)); trailAlong.push(Math.abs(snap.pose.offset.along)); trailH.push(Math.abs(snap.pose.offset.h));
    snaps = snap.pose.snaps;
  }
  if (snap.map && snap.map.roads) { features = snap.map.roads.features.length; for (const f of snap.map.roads.features) featureKinds.set(f.kind, (featureKinds.get(f.kind) || 0) + 1); }
  const hz = snap.fisker && snap.fisker.horizon;
  if (hz) { adasis++; adasisCurv += hz.curvature.filter(c => c.ahead > 0).length; }
  const m = snap.map;
  if (!m || m.loading) { if (m) loading++; continue; }
  if (!m.way) continue;
  matched++;
  const label = m.way.ref || m.way.name;
  ways.set(label, (ways.get(label) || 0) + 1);
  if (lastWay !== null && lastWay !== m.way.id) switches++;
  lastWay = m.way.id;
  lengths.push(m.horizonLength); laterals.push(Math.abs(m.lateral)); confs.push(m.conf); branchCounts.push(m.branches.length);
  if (roadName && tick.now - roadNameT < 2.0) {
    compared++;
    const ours = norm(m.way.ref) + '|' + norm(m.way.name), theirs = norm(roadName);
    const ok = theirs.split(';').some(part => part && ours.includes(part.trim())) || (norm(m.way.name) && theirs.includes(norm(m.way.name)));
    if (ok) agree++;
    else { const k = `${roadName}  vs  ${m.way.ref || ''} / ${m.way.name || ''}`; disagreements.set(k, (disagreements.get(k) || 0) + 1); }
  }
}
console.log(`${ticks} ticks, ${withPose} with a pose, ${loading} waiting for tiles, ${matched} matched (${(100 * matched / Math.max(1, withPose)).toFixed(0)}% of those with a pose)`);
console.log(`road name agreement with mapd: ${agree}/${compared} (${(100 * agree / Math.max(1, compared)).toFixed(0)}%), way changes: ${switches}`);
console.log(`horizon length m: median ${f1(pct(lengths, 0.5))}, p10 ${f1(pct(lengths, 0.1))}; |lateral| m: median ${f1(pct(laterals, 0.5))}, p90 ${f1(pct(laterals, 0.9))}; conf median ${f1(pct(confs, 0.5))}; branches median ${pct(branchCounts, 0.5)}`);
console.log(`shown pose trails the estimate: left p50 ${f1(pct(trailLeft, 0.5))} p95 ${f1(pct(trailLeft, 0.95))} max ${f1(pct(trailLeft, 1))} m, along p95 ${f1(pct(trailAlong, 0.95))} m, heading p95 ${f1(pct(trailH, 0.95))} deg; snaps ${snaps}`);
if (featureKinds.size) console.log(`map features in the last layer: ${features} (${[...featureKinds].map(([k, n]) => `${k} ${n}`).join(', ')} over all layers)`);
console.log(`head unit's ADASIS horizon present in ${adasis} ticks (${(100 * adasis / Math.max(1, ticks)).toFixed(0)}%), ${(adasisCurv / Math.max(1, adasis)).toFixed(1)} curvature points ahead on average`);
console.log('ways:', [...ways].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([k, n]) => `${k} (${n})`).join(', '));
if (disagreements.size) { console.log('disagreements:'); for (const [k, n] of [...disagreements].sort((a, b) => b[1] - a[1]).slice(0, 8)) console.log(`  ${String(n).padStart(5)}  ${k}`); }
console.log('tiles:', fetched.join(', '));
