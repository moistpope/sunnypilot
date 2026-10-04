import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DBC } from '../dbc.js';
import { worldDbc, rng, close } from './helpers.js';

const TEXT = `
BO_ 291 TEST_0x123: 8 ADAS
 SG_ BE_U8 : 7|8@0+ (1,0) [0|255] ""  GW
 SG_ BE_S12 : 11|12@0- (0.5,-10) [-1034|1013.5] "m"  GW
 SG_ LE_U4 : 32|4@1+ (1,0) [0|15] ""  GW
 SG_ LE_S16 : 40|16@1- (0.01,0) [-327.68|327.67] "deg"  GW

BO_ 2147484160 EXT_MSG: 8 GW
 SG_ X : 0|8@1+ (1,0) [0|255] ""  ADAS

CM_ BO_ 291 "a test message";
CM_ SG_ 291 BE_U8 "first byte,
spanning lines";
BA_ "GenMsgCycleTime" BO_ 291 20;
VAL_ 291 LE_U4 0 "Off" 1 "On_with_Visual" 15 "Fault" ;
`;

test('parse metadata', () => {
  const dbc = new DBC(TEXT);
  const msg = dbc.byName.TEST_0x123;
  assert.equal(msg.address, 0x123);
  assert.equal(msg.size, 8);
  assert.equal(msg.transmitter, 'ADAS');
  assert.equal(msg.comment, 'a test message');
  assert.equal(msg.cycleMs, 20);
  assert.equal(msg.signals.BE_U8.comment, 'first byte, spanning lines');
  assert.deepEqual(msg.signals.LE_U4.values, { 0: 'Off', 1: 'On_with_Visual', 15: 'Fault' });
  assert.equal(msg.signals.BE_S12.unit, 'm');
  // extended frame flag (bit 31) is stripped from the address
  assert.ok(dbc.messages.has(0x200));
});

test('decode known frame', () => {
  const msg = new DBC(TEXT).byName.TEST_0x123;
  // BE_U8 = byte0; BE_S12 = low nibble of byte1 + byte2 (msb first); LE_U4 = low nibble byte4; LE_S16 = bytes5..6 LE
  const out = msg.decode(Uint8Array.from([0xAB, 0x0F, 0xFE, 0x00, 0x05, 0x18, 0xFC, 0x00]));
  assert.equal(out.BE_U8, 0xAB);
  assert.equal(out.BE_S12, (0xFFE - 0x1000) * 0.5 - 10);   // raw -2 -> -11
  assert.equal(out.LE_U4, 5);
  assert.ok(close(out.LE_S16, (0xFC18 - 0x10000) * 0.01));   // -10.0
  assert.equal(msg.signals.LE_U4.describe(out.LE_U4), null);
  assert.equal(msg.signals.LE_U4.describe(1), 'On_with_Visual');
});

test('short frame is zero padded', () => {
  const msg = new DBC(TEXT).byName.TEST_0x123;
  assert.equal(msg.decode(Uint8Array.from([0x12])).BE_U8, 0x12);
  assert.equal(msg.decode([0x12]).BE_U8, 0x12);   // plain arrays too
});

test('encode round trip, world DBC', () => {
  const dbc = worldDbc();
  assert.ok(dbc.messages.size > 80);
  const r = rng(0);
  for (const msg of dbc.messages.values()) {
    for (let k = 0; k < 3; k++) {
      const data = Uint8Array.from({ length: msg.size }, () => Math.floor(r() * 256));
      const values = msg.decode(data);
      const again = msg.decode(msg.encode(values));
      for (const name in values) assert.ok(close(again[name], values[name], 1e-6), `${msg.name} ${name}`);
    }
  }
});

test('encode preserves unlisted bits', () => {
  const msg = new DBC(TEXT).byName.TEST_0x123;
  const base = Uint8Array.from([0xAB, 0x0F, 0xFE, 0x00, 0x05, 0x18, 0xFC, 0x77]);
  const out = msg.encode({ LE_U4: 9 }, base);
  const decoded = msg.decode(out);
  assert.equal(decoded.LE_U4, 9);
  assert.equal(decoded.BE_U8, 0xAB);
  assert.equal(out[7], 0x77);
});
