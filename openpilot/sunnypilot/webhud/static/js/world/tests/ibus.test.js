// The generated IBUS tables (ibus_tables.js) and the command encoder (cancmd.js) against the generated IBUS DBC.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DBC } from '../dbc.js';
import { worldDbc, rng } from './helpers.js';
import { RX_MESSAGES, TX_MESSAGES, RX_IDS, TX_IDS } from '../../ibus_tables.js';
import { encode } from '../../cancmd.js';
import { extract, decodeFrame } from '../../carstate.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const ibus = new DBC(fs.readFileSync(path.join(here, '../../../../../../third_party/webhud/dbc/fisker_ocean_ibus.dbc'), 'latin1'));

test('the IBUS DBC agrees with the ADAS-bus DBC on every shared signal', () => {
  const world = worldDbc();
  let n = 0;
  for (const [addr, m] of ibus.messages) {
    const w = world.messages.get(addr);
    if (!w) continue;
    for (const name in m.signals) {
      const ws = w.signals[name];
      if (!ws) continue;
      const s = m.signals[name];
      assert.deepEqual([s.startBit, s.size, s.littleEndian, s.signed, s.factor, s.offset], [ws.startBit, ws.size, ws.littleEndian, ws.signed, ws.factor, ws.offset], `${m.name} ${name}`);
      n++;
    }
  }
  assert.ok(n > 800, String(n));
});

test('the read-out table decodes like the DBC', () => {
  const r = rng(3);
  let n = 0;
  for (const msg of RX_MESSAGES) {
    const m = ibus.messages.get(msg.addr);
    assert.ok(m, `0x${msg.addr.toString(16)} in the DBC`);
    for (let k = 0; k < 5; k++) {
      const data = Uint8Array.from({ length: m.size }, () => Math.floor(r() * 256));
      const want = m.decode(data), got = decodeFrame(msg.bus, msg.addr, data);
      for (const s of msg.signals) {
        assert.ok(Math.abs(got[s.name] - want[s.name]) < 1e-9, `${msg.name} ${s.name}: ${got[s.name]} vs ${want[s.name]}`);
        n++;
      }
    }
  }
  assert.ok(n > 1000);
});

test('a frame built for sending decodes to what was asked, the rest at its initial value', () => {
  for (const msg of TX_MESSAGES) {
    const m = ibus.messages.get(msg.addr);
    assert.ok(m, msg.name);
    const idle = m.decode(encode(msg.addr));
    for (const s of msg.signals) {
      const expect = s.signed && s.init >= 2 ** (s.len - 1) ? s.init - 2 ** s.len : s.init;
      assert.ok(Math.abs(idle[s.name] - (expect * s.res + s.off)) < 1e-9, `${msg.name} ${s.name} idle`);
    }
  }
  // the climate request: driver 21.5 C, fan 3, everything else untouched
  const v = ibus.messages.get(0x530).decode(encode(0x530, { ICC_DrvrTSet: 21.5, ICC_AirVolSet: 3 }));
  assert.equal(v.ICC_DrvrTSet, 21.5);
  assert.equal(v.ICC_AirVolSet, 3);
  assert.equal(v.ICC_PassTSet, 0);
  assert.equal(v.ICC_NavCtryCod, 255);   // its initial value is "invalid", not 0
  // the body request: driver's window auto down, the sunroof signal at its "invalid" default
  const b = ibus.messages.get(0x4E).decode(encode(0x4E, { ICC_LeFrntWinCtrl: 6 }));
  assert.equal(b.ICC_LeFrntWinCtrl, 6);
  assert.equal(b.ICC_RiFrntWinCtrl, 0);
  assert.equal(b.ICC_SunroofPercCtrlCmdReq, 0x7F);
  assert.throws(() => encode(0x610, {}), /not a message the HUD sends/);
  assert.throws(() => encode(0x4E, { ICC_Nope: 1 }), /no signal/);
});

test('the helper lists cover every table message and only the head unit\'s control messages are sendable', () => {
  for (const msg of RX_MESSAGES) assert.ok(RX_IDS[msg.bus].includes(msg.addr), msg.name);
  for (const msg of TX_MESSAGES) assert.ok(TX_IDS[msg.bus].includes(msg.addr), msg.name);
  for (const addr of TX_IDS.IBUS1) assert.ok(ibus.messages.get(addr).transmitter === 'ICC', `0x${addr.toString(16)} is the head unit's`);
  assert.ok(!TX_IDS.IBUS1.includes(0x610) && !TX_IDS.IBUS1.includes(0x336) && !TX_IDS.IBUS1.includes(0x529));
  assert.deepEqual(TX_IDS.IBUS2, []);
});

test('bit extraction handles signals that span bytes and signed ones', () => {
  // ESP_VehSpd: 16 bits, MSB at DBC bit 47 (byte 5 bit 7), LSB byte 6 bit 0
  const data = new Uint8Array(8);
  data[5] = 0x12; data[6] = 0x34;
  assert.equal(extract(data, { start: 47, len: 16 }), 0x1234);
  // a signed 16-bit current (0xE9 on IBUS2): -2.5 A is raw -50
  const neg = new Uint8Array(8);
  neg[5] = 0xFF; neg[6] = 0xCE;
  assert.equal(extract(neg, { start: 47, len: 16, signed: true }), -50);
});
