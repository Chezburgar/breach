// Cashout.
//
// Four crews, one cashbox, two terminals. The box spawns in a vault; whoever
// carries it to a terminal starts a countdown, and whoever is *standing on the
// terminal when it finishes* takes the money — not whoever put it in. That one
// rule is what makes the mode: depositing is an announcement, and the fight
// that follows is the game.
//
// Everything here is a pure function of the state plus the players, so the
// whole mode can be driven headlessly by the harness without a room, a socket
// or a clock.

import { vdist } from '../mathx.js';

export const CASH = {
  boxPickupRange: 1.9,
  terminalRange: 3.2,
  vaultRange: 2.6,
  carryDropHeight: 0.4,
};

/** Fresh objective state for a match. `map` supplies vault/terminal points. */
export function createCashoutState(mode, mapData, rng = Math.random) {
  const vaults = (mapData.objectives || []).filter((o) => o.kind === 'vault');
  const terminals = (mapData.objectives || []).filter((o) => o.kind === 'terminal');
  return {
    cash: new Array(mode.teamCount || 4).fill(0),
    vaults,
    terminals,
    // The live box: in a vault, on the floor, on someone's back, or banked.
    box: null,
    nextSpawnAt: 0,
    active: null,      // { terminal, team, endsAt, contestedBy, contestFor }
    banked: 0,
    rng,
  };
}

/** Put a box back on the board at a vault nobody is standing in, if possible. */
export function spawnBox(st, time, players) {
  if (!st.vaults.length) return null;
  const clear = st.vaults.filter((v) => ![...players].some(
    (p) => p.alive && vdist(p.state.pos, { x: v.p[0], y: v.p[1], z: v.p[2] }) < CASH.vaultRange * 1.5
  ));
  const pool = clear.length ? clear : st.vaults;
  const v = pool[Math.floor(st.rng() * pool.length) % pool.length];
  st.box = {
    id: `box${++st.banked}_${Math.floor(time * 10)}`,
    pos: { x: v.p[0], y: v.p[1], z: v.p[2] },
    carrier: null,
    vault: v.id,
    droppedAt: 0,
  };
  st.nextSpawnAt = 0;
  return st.box;
}

/** Nearest terminal to a point, or null. */
export function terminalNear(st, pos, range = CASH.terminalRange) {
  let best = null, bestD = range;
  for (const t of st.terminals) {
    const d = vdist(pos, { x: t.p[0], y: t.p[1], z: t.p[2] });
    if (d < bestD) { bestD = d; best = t; }
  }
  return best;
}

/** Who is standing on a terminal, by team. */
export function presenceAt(terminal, players, teamCount) {
  const counts = new Array(teamCount).fill(0);
  const at = { x: terminal.p[0], y: terminal.p[1], z: terminal.p[2] };
  for (const p of players) {
    if (!p.alive || p.team < 0) continue;
    if (vdist(p.state.pos, at) > CASH.terminalRange) continue;
    counts[p.team]++;
  }
  return counts;
}

/**
 * Advance the mode by `dt`.
 *
 * `hooks` reports what happened so the room can broadcast it — the state
 * machine itself never talks to the network.
 */
export function stepCashout(st, mode, players, time, dt, hooks = {}) {
  const teamCount = mode.teamCount || 4;
  const list = [...players];

  // --- the box ------------------------------------------------------------
  if (!st.box && !st.active && st.nextSpawnAt && time >= st.nextSpawnAt) {
    const box = spawnBox(st, time, list);
    if (box) hooks.onBoxSpawn?.(box);
  }

  if (st.box?.carrier) {
    const holder = list.find((p) => p.id === st.box.carrier);
    if (!holder || !holder.alive) {
      // Dropped where they fell. Anyone can pick it up, including the crew
      // that just lost it — a kill near the terminal is not a guaranteed steal.
      st.box.carrier = null;
      st.box.droppedAt = time;
      if (holder) st.box.pos = { ...holder.state.pos, y: holder.state.pos.y + CASH.carryDropHeight };
      hooks.onBoxDropped?.(st.box);
    } else {
      st.box.pos = { x: holder.state.pos.x, y: holder.state.pos.y + 1.1, z: holder.state.pos.z };
    }
  }

  // --- a running cashout --------------------------------------------------
  if (!st.active) return;

  const counts = presenceAt(st.active.terminal, list, teamCount);
  const holders = counts[st.active.team] || 0;
  let challenger = -1, challengerCount = 0;
  for (let t = 0; t < teamCount; t++) {
    if (t === st.active.team) continue;
    if (counts[t] > challengerCount) { challengerCount = counts[t]; challenger = t; }
  }

  // Owning crew away, exactly one other crew present: they take it over.
  if (holders === 0 && challenger >= 0) {
    if (st.active.contestedBy !== challenger) {
      st.active.contestedBy = challenger;
      st.active.contestFor = 0;
    }
    st.active.contestFor += dt;
    if (st.active.contestFor >= mode.stealTime) {
      const from = st.active.team;
      st.active.team = challenger;
      st.active.contestedBy = -1;
      st.active.contestFor = 0;
      hooks.onSteal?.(challenger, from);
    }
  } else if (st.active.contestedBy !== -1) {
    // Owners back on it, or two crews fighting over it — the clock on the
    // steal resets rather than pausing, so a contest has to actually be won.
    st.active.contestedBy = -1;
    st.active.contestFor = 0;
  }

  if (time >= st.active.endsAt) {
    const team = st.active.team;
    st.cash[team] = (st.cash[team] || 0) + mode.payout;
    const done = st.active;
    st.active = null;
    st.box = null;
    st.nextSpawnAt = time + mode.vaultDelay;
    hooks.onBanked?.(team, done.terminal, st.cash[team]);
  }
}

/** Try to pick the box up. Returns true if it moved onto their back. */
export function tryPickup(st, p, time) {
  const box = st.box;
  if (!box || box.carrier || !p.alive) return false;
  if (vdist(p.state.pos, box.pos) > CASH.boxPickupRange) return false;
  // A moment on the floor before anyone can scoop it, so a body falling on
  // the terminal does not instantly hand it back.
  if (box.droppedAt && time - box.droppedAt < 0.6) return false;
  box.carrier = p.id;
  return true;
}

/** Try to feed the box into a terminal. Returns the terminal, or null. */
export function tryDeposit(st, mode, p, time) {
  const box = st.box;
  if (!box || box.carrier !== p.id || st.active) return null;
  const t = terminalNear(st, p.state.pos);
  if (!t) return null;
  st.box = { ...box, carrier: null, pos: { x: t.p[0], y: t.p[1], z: t.p[2] }, inTerminal: t.id };
  st.active = {
    terminal: t,
    team: p.team,
    endsAt: time + mode.cashoutTime,
    contestedBy: -1,
    contestFor: 0,
  };
  return t;
}

/** Which crew is winning, and whether anybody has taken it outright. */
export function cashResult(st, mode) {
  let best = 0;
  for (let t = 1; t < st.cash.length; t++) if (st.cash[t] > st.cash[best]) best = t;
  const tied = st.cash.filter((c) => c === st.cash[best]).length > 1;
  return {
    leader: best,
    won: st.cash[best] >= mode.cashGoal,
    tied: tied && st.cash[best] > 0 ? true : tied,
  };
}
