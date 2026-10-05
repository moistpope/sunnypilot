// The head unit's ADASIS horizon (adasis.js) rebuilt from encoded frames through FiskerWorld.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { AdasisHorizon, curvatureOf } from '../adasis.js';
import { FiskerWorld } from '../fisker_world.js';
import { worldDbc } from './helpers.js';

const enc = (addr, values) => worldDbc().messages.get(addr).encode(values);

describe('AdasisHorizon', () => {
  test('position, segments, stubs and profiles accumulate per path and are re-based to the car', () => {
    const w = new FiskerWorld(worldDbc());
    let t = 0;
    const feed = (addr, values) => { w.update([[addr, enc(addr, values), 0]], t); t += 0.01; };
    feed(0x361, { ICC_PosnMsgTye: 1, ICC_PosnPathldx: 8, ICC_PosnOffset: 100, ICC_PosnPosProbb: 70, ICC_PosnAge: 150, ICC_PosnSpd: 20, ICC_PosnRehead: 1.417, ICC_PosnCurLane: 3, ICC_PosnPosConfdc: 1 });
    feed(0x250, { ICC_SegMsgType: 2, ICC_SegPathIdx: 8, ICC_SegOffset: 60, ICC_SegFuncRoadClass: 2, ICC_SegFormOfWay: 1, ICC_SegNumOfLaneDrvDir: 2, ICC_SegNumOfLaneOppDir: 0, ICC_SegDividedRoad: 1, ICC_SegEffSpdLmt: 14, ICC_SegRelProbb: 100 });
    feed(0x250, { ICC_SegMsgType: 2, ICC_SegPathIdx: 8, ICC_SegOffset: 400, ICC_SegFuncRoadClass: 3, ICC_SegFormOfWay: 3, ICC_SegNumOfLaneDrvDir: 1, ICC_SegRelProbb: 100 });
    feed(0x251, { ICC_StubMsgType: 3, ICC_StubPathIdx: 8, ICC_StubOffset: 250, ICC_StubStubPathIdx: 9, ICC_StubTurnAngl: 90.7, ICC_StubRelProbb: 30, ICC_StubFuncRoadClass: 4, ICC_StubLastStub: 1 });
    feed(0x255, { ICC_ProfShortMsgType: 4, ICC_ProfShortPathIdx: 8, ICC_ProfShortOffset: 120, ICC_ProfShortProfType: 1, ICC_ProfShortAccurClass: 0, ICC_ProfShortDist1: 50, ICC_ProfShortValue0: 511, ICC_ProfShortValue1: 650 });
    feed(0x255, { ICC_ProfShortMsgType: 4, ICC_ProfShortPathIdx: 9, ICC_ProfShortOffset: 10, ICC_ProfShortProfType: 1, ICC_ProfShortDist1: 0, ICC_ProfShortValue0: 300, ICC_ProfShortValue1: 1023 });   // another path
    feed(0x362, { ICC_MetaMsgType: 6, ICC_MetaCountryCode: 840, ICC_MetaRegionCode: 13 });
    const h = w.state(t).horizon;
    assert.ok(h, 'a horizon');
    assert.equal(h.position.path, 8);
    assert.equal(h.position.offset, 100);
    assert.ok(Math.abs(h.position.relHeading - (-1.4)) < 0.1, String(h.position.relHeading));   // 1.417 deg right of the path
    assert.equal(h.position.lane, 3);
    assert.deepEqual(h.segments.map(s => [s.ahead, s.lanes, s.speedLimitClass]), [[-40, 2, 14], [300, 1, null]].map(([a, l, c]) => [a, l, c === null ? h.segments[1].speedLimitClass : c]));
    assert.deepEqual(h.stubs.map(s => [s.ahead, s.path, s.turnAngle, s.prob]), [[150, 9, 90.7, 30]]);
    assert.deepEqual(h.curvature.map(c => [c.ahead, c.value]), [[20, 511], [70, 650]]);
    assert.equal(h.curvature[0].k, 0);
    assert.ok(h.curvature[1].k < -0.002 && h.curvature[1].k > -0.006, String(h.curvature[1].k));   // a right bend, R ~ 300 m
    assert.deepEqual(h.meta, { country: 840, region: 13 });
    assert.equal(h.counts.segment, 2);
    // the car moves on: what is passed by more than 50 m falls away
    feed(0x361, { ICC_PosnMsgTye: 1, ICC_PosnPathldx: 8, ICC_PosnOffset: 200, ICC_PosnPosProbb: 70, ICC_PosnAge: 150, ICC_PosnSpd: 20 });
    const h2 = w.state(t).horizon;
    assert.deepEqual(h2.segments.map(s => s.ahead), [200]);
    assert.deepEqual(h2.curvature.map(c => c.ahead), [-30]);
    // without a position message for 2 s there is no horizon
    assert.equal(w.state(t + 3).horizon, null);
  });

  test('curvature encoding: 511 straight, above right, below left, 1023 invalid', () => {
    assert.equal(curvatureOf(511), 0);
    assert.equal(curvatureOf(1023), null);
    assert.ok(curvatureOf(650) < 0 && curvatureOf(372) > 0);
    assert.ok(Math.abs(curvatureOf(947)) > 0.05 && Math.abs(curvatureOf(947)) < 0.1);
    assert.ok(Math.abs(curvatureOf(711) - -curvatureOf(311)) < 1e-12);
  });

  test('a path nothing mentions for 10 s is dropped; the current one stays', () => {
    const h = new AdasisHorizon();
    h.feed(0x255, { ICC_ProfShortPathIdx: 9, ICC_ProfShortOffset: 10, ICC_ProfShortProfType: 1, ICC_ProfShortDist1: 0, ICC_ProfShortValue0: 300 }, 0);
    h.feed(0x361, { ICC_PosnPathldx: 8, ICC_PosnOffset: 0, ICC_PosnAge: 100 }, 0.1);
    assert.ok(h.paths.has(9));
    h.feed(0x361, { ICC_PosnPathldx: 8, ICC_PosnOffset: 300, ICC_PosnAge: 100 }, 11);
    assert.ok(!h.paths.has(9) && h.paths.has(8));
  });
});
