import { buildEstate } from './estate.js';
import { buildTraining } from './training.js';

const BUILDERS = {
  estate: buildEstate,
  training: buildTraining,
};

const cache = new Map();

/** Maps are deterministic, so build once and share the data everywhere. */
export function getMap(id) {
  if (!cache.has(id)) {
    const build = BUILDERS[id] || BUILDERS.estate;
    cache.set(id, build());
  }
  return cache.get(id);
}

export const MAP_IDS = Object.keys(BUILDERS);
export const COMBAT_MAPS = ['estate'];
export const DEFAULT_MAP = 'estate';

export const MAP_INFO = {
  estate: {
    id: 'estate',
    name: 'Blackmoor Estate',
    blurb: 'A walled country estate. Three routes from the gate to the gardens, a manor that overlooks all of them, and a cellar that cuts underneath.',
    size: '176 × 176 m',
  },
  training: {
    id: 'training',
    name: 'Training Ground',
    blurb: 'Live range, shoot house and movement course. Every weapon, every optic, no timer.',
    size: 'Offline',
  },
};
