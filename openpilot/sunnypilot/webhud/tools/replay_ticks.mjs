#!/usr/bin/env node
// Runs the page's world-model pipeline (static/js/world) in Node over a recorded tick stream, for
// working on the decoding and fusion without a browser or a car. Reads JSON lines, one bridge tick
// per line as the comma's server sends them ({now, reset, brand, can: [[t, [[addr, bus, hex], ...]], ...],
// op: [[service, t, extract], ...]}), and prints the snapshot of each tick as JSON lines.
//
//   node tools/replay_ticks.mjs ticks.jsonl > snapshots.jsonl
//   node tools/replay_ticks.mjs --diff reference.jsonl    # a reference run's lines carry "fed" (the tick) and
//                                                         # "snap" (the expected snapshot): report differences
//
// Record a stream from a running server with tools/record_ticks.mjs.
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
const diff = args[0] === '--diff';
const file = diff ? args[1] : args[0];
if (!file) {
  console.error('usage: replay_ticks.mjs [--diff] <ticks.jsonl>');
  process.exit(2);
}

const builder = new StateBuilder(new DBC(fs.readFileSync(WORLD_DBC, 'latin1')),
  fs.existsSync(RADAR_DBC) ? new DBC(fs.readFileSync(RADAR_DBC, 'latin1')) : null);

function feed(tick) {
  if (tick.reset) builder.reset();
  if (tick.brand !== undefined) builder.setBrand(tick.brand);
  for (const [t, frames] of tick.can || []) builder.feedCan(wireFrames(frames), t);
  for (const [which, t, data] of tick.op || []) builder.feedService(which, data, t);
  return builder.snapshot(tick.now);
}

// ---- comparison: numbers within a tolerance of the last rounded digit, everything else exact ----
const TOL_REL = 1e-6;
const IGNORE = new Set(['snap.pose', 'snap.map', 'snap.fisker.horizon']);   // added after the references were recorded (pose_eval.mjs / map_eval.mjs check them)
function compare(a, b, where, out) {
  if (IGNORE.has(where)) return;
  if (typeof a === 'number' && typeof b === 'number') {
    const tol = Math.max(TOL_REL * Math.max(Math.abs(a), Math.abs(b)), roundingTol(a, b));
    if (Math.abs(a - b) > tol) out.push([where, a, b]);
  } else if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) { out.push([where + '.length', a.length, b.length]); return; }
    a.forEach((v, i) => compare(v, b[i], `${where}[${i}]`, out));
  } else if (a && b && typeof a === 'object' && typeof b === 'object') {
    for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) compare(a[k], b[k], `${where}.${k}`, out);
  } else if (a !== b && !(a == null && b == null)) {
    out.push([where, a, b]);
  }
}
// a value rounded to n decimals may differ by one unit in the last place between two float implementations
function roundingTol(a, b) {
  const decimals = Math.max(decimalsOf(a), decimalsOf(b));
  return decimals ? 1.01 * 10 ** -decimals : 0;
}
function decimalsOf(v) {
  const s = String(v);
  const i = s.indexOf('.');
  return i < 0 || s.includes('e') ? 0 : s.length - i - 1;
}

const rl = readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity });
let n = 0;
const mismatches = new Map();   // path (ids stripped) -> [count, example]
let ticksWithDiff = 0;
for await (const line of rl) {
  if (!line.trim()) continue;
  const rec = JSON.parse(line);
  n++;
  if (!diff) {
    process.stdout.write(JSON.stringify(feed(rec)) + '\n');
    continue;
  }
  const tick = { now: rec.now, reset: rec.fed.reset > 0, brand: rec.brand, can: rec.fed.can, op: rec.fed.op };
  const got = feed(tick);
  const diffs = [];
  compare(got, rec.snap, 'snap', diffs);
  if (diffs.length) ticksWithDiff++;
  for (const [where, a, b] of diffs) {
    const key = where.replace(/\[\d+\]/g, '[]');
    const e = mismatches.get(key) || [0, null];
    e[0]++;
    if (!e[1]) e[1] = `tick ${n} (now ${rec.now}) ${where}: js=${JSON.stringify(a)} py=${JSON.stringify(b)}`;
    mismatches.set(key, e);
  }
}
if (diff) {
  console.log(`${n} ticks, ${ticksWithDiff} with differences, ${mismatches.size} distinct paths`);
  for (const [key, [count, example]] of [...mismatches].sort((a, b) => b[1][0] - a[1][0])) console.log(`${String(count).padStart(6)}  ${key}\n        ${example}`);
  process.exit(mismatches.size ? 1 : 0);
}
