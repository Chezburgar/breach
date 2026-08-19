// Game modes.
//
// Breach is five versus five, one life per round, best of five: dying puts
// you into spectator until the round resolves, which is what makes every
// engagement matter.
//
// Cashout is the opposite shape — four three-player crews, respawns on, no
// rounds. The map holds one cashbox at a time and two terminals to bank it
// at, so the fight follows the money instead of the clock.

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
    teamCount: 2,
    teamSize: 5,
    icon: 'breach',
  },

  cashout: {
    id: 'cashout',
    name: 'Cashout',
    short: 'CO',
    blurb: 'Four crews, one cashbox. Crack the vault, carry it to a terminal, hold the terminal.',
    teams: true,
    respawn: true,
    cashout: true,

    matchTime: 600,        // one continuous match, no rounds
    freezeTime: 5,
    respawnDelay: 8,

    cashGoal: 20000,       // first crew to bank this wins outright
    payout: 7000,          // banked per completed cashout
    cashoutTime: 75,       // terminal countdown once a box goes in
    stealTime: 4,          // uncontested seconds needed to take a terminal
    vaultDelay: 12,        // before the next box appears
    carrySpeed: 0.72,      // movement multiplier while holding the box

    minPlayers: 2,
    maxPlayers: 12,
    teamCount: 4,
    teamSize: 3,
    icon: 'cashout',
  },
};

export const MODE_IDS = Object.keys(MODES);
export const QUICKPLAY_MODES = ['breach', 'cashout'];
export const DEFAULT_MODE = 'breach';

export function getMode(id) {
  return MODES[id] || MODES.breach;
}

/** How many squads a mode fields. Defaults to a pair. */
export function teamCountOf(mode) {
  return mode?.teams ? (mode.teamCount || 2) : 0;
}
