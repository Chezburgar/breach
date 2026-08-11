// The one game mode.
//
// Five versus five, one life per round, best of five. Dying puts you into
// spectator until the round resolves, which is what makes every engagement
// matter and gives the map's angles their weight.

export const MODES = {
  breach: {
    id: 'breach',
    name: 'Breach',
    short: 'BR',
    blurb: 'Five on five, one life a round. First squad to three rounds takes the match.',
    teams: true,
    respawn: false,

    roundsToWin: 3,        // best of five
    maxRounds: 5,
    roundTime: 145,        // seconds of live play per round
    freezeTime: 6,         // buy/settle time at round start, movement locked
    intermission: 7,       // between rounds
    switchSidesAfter: 0,   // no side swap; spawns are symmetric enough

    minPlayers: 2,
    maxPlayers: 10,
    teamSize: 5,
    icon: 'breach',
  },
};

export const MODE_IDS = Object.keys(MODES);
export const QUICKPLAY_MODES = ['breach'];
export const DEFAULT_MODE = 'breach';

export function getMode(id) {
  return MODES[id] || MODES.breach;
}
