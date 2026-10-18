import { test } from 'node:test';
import assert from 'node:assert/strict';
import { leftTraffic, cameraSignUnit, cameraSignValue } from '../../regional.js';
import { laneCenters, mapReference, freshPlacement } from '../../mapsurface.js';

test('traffic override takes priority; auto follows car, unknown retains right traffic', () => {
  const f = { road: { trafficSide: 'Left_Hand_Traffic' } };
  assert.equal(leftTraffic({}, f), true);
  assert.equal(leftTraffic({ trafficSide: 'right' }, f), false);
  assert.equal(leftTraffic({ trafficSide: 'left' }), true);
  assert.equal(leftTraffic({}), false);
});

test('UK lanes remain ordered right to left for camera and GPS lane changes', () => {
  assert.deepEqual(laneCenters(4, false, 3.6, true), [1.8, 5.4]);
  assert.deepEqual(laneCenters(3, false, 3.6, true), [3.6]);
  assert.deepEqual(laneCenters(3, true, 3.6, true), laneCenters(3, true));
});

test('switching to UK traffic puts ego on left and moves the carriageway bounds', () => {
  const map = { way: { id: 1, lanes: 2 }, horizon: [[-50, 0], [0, 0], [200, 0]], carIndex: 1 };
  const pose = { x: 0, y: 0, h: 0 }, place = freshPlacement();
  mapReference(map, pose, null, {}, undefined, place, 1);
  let ref;
  for (let i = 0; i < 200; i++) ref = mapReference(map, pose, null, { trafficSide: 'left' }, undefined, place, 0.1);
  assert.equal(ref.laneCenter, 1.8);
  assert.ok(ref.centerY0 < -1.7);
  assert.equal(ref.ourLeft, 3.6);
  assert.equal(ref.ourRight, 0);
  const four = mapReference({ ...map, way: { lanes: 4 } }, pose, null, { trafficSide: 'left' }, undefined, freshPlacement(), 0);
  assert.equal(four.laneCenter, 5.4);
});

test('UK camera number stays mph independently of display units; auto respects CAN', () => {
  const tsr = { speedLimit: 30, unit: 'kmh' };
  const settings = { cameraSignUnits: 'mph', units: 'kmh' };
  assert.equal(cameraSignUnit(settings, tsr), 'mph');
  assert.equal(cameraSignUnit({}, tsr), 'kmh');
  assert.equal(cameraSignUnit({ units: 'mph' }, tsr), 'kmh');
  assert.equal(cameraSignUnit({ cameraSignUnits: 'kmh' }, { unit: 'mph' }), 'kmh');
});

test('30 and 70 UK camera signs retain their numbers in mph; convert once to metric', () => {
  for (const speedLimit of [20, 30, 40, 50, 60, 70]) {
    const tsr = { speedLimit, unit: 'kmh' };
    assert.equal(cameraSignValue({ cameraSignUnits: 'mph' }, tsr, 'mph'), speedLimit);
    assert.equal(cameraSignValue({ cameraSignUnits: 'mph' }, tsr, 'kmh'), Math.round(speedLimit * 1.609344));
  }
  assert.equal(cameraSignValue({}, { speedLimit: 30, unit: 'kmh' }, 'mph'), 19);
});
