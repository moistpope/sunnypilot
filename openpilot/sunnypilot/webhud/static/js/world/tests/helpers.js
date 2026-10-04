// Shared bits for the world-model tests (node --test static/js/world/tests).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DBC } from '../dbc.js';

const here = path.dirname(fileURLToPath(import.meta.url));
export const WORLD_DBC_PATH = path.join(here, '../../../../../../third_party/webhud/dbc/fisker_ocean_adas_world.dbc');
export const RADAR_DBC_PATH = path.join(here, '../../../../../../../opendbc_repo/opendbc/dbc/fisker_ocean_mrr.dbc');

let world = null, radar = null;
export function worldDbc() { return world || (world = new DBC(fs.readFileSync(WORLD_DBC_PATH, 'latin1'))); }
export function radarDbc() { return radar || (radar = new DBC(fs.readFileSync(RADAR_DBC_PATH, 'latin1'))); }

/** A small deterministic PRNG (Park-Miller), for random frames that are the same every run. */
export function rng(seed = 1) {
  let s = seed % 2147483647 || 1;
  return () => (s = (s * 16807) % 2147483647) / 2147483647;
}

export const close = (a, b, tol = 1e-9) => Math.abs(a - b) <= tol;
