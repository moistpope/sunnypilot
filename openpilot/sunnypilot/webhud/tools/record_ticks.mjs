#!/usr/bin/env node
// Records the bridge's tick stream from a running server (live, replay or demo) as JSON lines, one tick
// per line, for tools/replay_ticks.mjs and tools/pose_eval.mjs. Stops after --seconds (default: until ^C).
//
//   node tools/record_ticks.mjs http://sunnypilot.local:8088 ticks.jsonl --seconds 120
//
// Needs Node 22 (its global WebSocket).
import fs from 'node:fs';

const args = process.argv.slice(2);
let seconds = Infinity;
const i = args.indexOf('--seconds');
if (i >= 0) { seconds = parseFloat(args[i + 1]); args.splice(i, 2); }
const [base, file] = args;
if (!base || !file) { console.error('usage: record_ticks.mjs <http://host:port> <out.jsonl> [--seconds N]'); process.exit(2); }

const url = base.replace(/^http/, 'ws').replace(/\/$/, '') + '/ws';
const out = fs.createWriteStream(file, { flags: 'a' });
const ws = new WebSocket(url);
let n = 0, t0 = null;
const stop = () => { ws.close(); out.end(() => { console.error(`${n} ticks -> ${file}`); process.exit(0); }); };
ws.onopen = () => console.error(`recording ${url}`);
ws.onerror = (e) => { console.error('websocket error', e.message || e); process.exit(1); };
ws.onclose = () => stop();
ws.onmessage = (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.type !== 'tick') return;
  out.write(JSON.stringify(msg.data) + '\n');
  n++;
  if (t0 === null) t0 = Date.now();
  if ((Date.now() - t0) / 1000 >= seconds) stop();
};
process.on('SIGINT', stop);
