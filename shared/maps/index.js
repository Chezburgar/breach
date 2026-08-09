import { buildOldQuarter } from './oldquarter.js';
import { buildTraining } from './training.js';

const BUILDERS = {
  oldquarter: buildOldQuarter,
  training: buildTraining,
};

const cache = new Map();

/** Maps are deterministic, so build once and share the data everywhere. */
export function getMap(id) {
  if (!cache.has(id)) {
    const build = BUILDERS[id] || BUILDERS.oldquarter;
    cache.set(id, build());
  }
  return cache.get(id);
}

export const MAP_IDS = Object.keys(BUILDERS);
export const COMBAT_MAPS = ['oldquarter'];

export const MAP_INFO = {
  oldquarter: {
    id: 'oldquarter',
    name: 'Old Quarter',
    blurb: 'A coastal compound of tiled plazas, shuttered souks and a consulate that owns every angle.',
    size: '150 × 150 m',
  },
  training: {
    id: 'training',
    name: 'Training Ground',
    blurb: 'Live range, shoot house and movement course. Every weapon, every optic, no timer.',
    size: 'Offline',
  },
};
