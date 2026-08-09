// Headless checks. Run with `npm run check`.
//
// Builds every map, validates the geometry a player can actually touch, then
// simulates full matches of every mode with bots to shake out server bugs.

import { getMap, MAP_IDS } from '../shared/maps/index.js';
import { buildWorld, cylinderBlocked, raycastWorld } from '../shared/collision.js';
import { createPlayerState, stepPlayer } from '../shared/controller.js';
import { FIXED_DT, PLAYER, BTN } from '../shared/constants.js';
import { MODE_IDS, MODES } from '../shared/modes.js';
import { WEAPON_LIST, resolveWeapon, recoilAt, currentSpread } from '../shared/weapons.js';
import { GameRoom } from '../server/room.js';
import { buildNavGraph } from '../server/nav.js';

let failures = 0;
const ok = (cond, label, detail = '') => {
  if (cond) console.log(`  PASS  ${label}`);
  else { failures++; console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`); }
};

// ---------------------------------------------------------------- geometry
function checkMaps() {
  console.log('\nMAPS');
  for (const id of MAP_IDS) {
    const md = getMap(id);
    const world = buildWorld(md);

    let degenerate = 0;
    for (const b of md.boxes) {
      if (b.s[0] <= 0 || b.s[1] <= 0 || b.s[2] <= 0) degenerate++;
      if (!Number.isFinite(b.p[0] + b.p[1] + b.p[2])) degenerate++;
    }
    ok(degenerate === 0, `${id}: no degenerate boxes`, `${degenerate} bad`);

    // Every spawn must settle on solid ground without being embedded.
    let settleFail = 0, stuck = 0;
    for (const sp of md.spawns) {
      const s = createPlayerState({ p: [sp.p[0], sp.p[1] + 0.4, sp.p[2]], yaw: sp.yaw });
      for (let i = 0; i < 150; i++) stepPlayer(s, { btn: 0, yaw: sp.yaw, pitch: 0 }, world, FIXED_DT);
      if (!s.onGround || Math.abs(s.pos.y - sp.p[1]) > 1.0) settleFail++;
      if (cylinderBlocked(world, s.pos, PLAYER.radius, s.height)) stuck++;
    }
    ok(settleFail === 0, `${id}: all ${md.spawns.length} spawns settle`, `${settleFail} failed`);
    ok(stuck === 0, `${id}: no spawn embedded in geometry`, `${stuck} stuck`);

    // Random walkers: nobody should fall out of the world through a seam.
    const walkers = 24;
    let escaped = 0, sunk = 0;
    for (let w = 0; w < walkers; w++) {
      const sp = md.spawns[w % md.spawns.length];
      const s = createPlayerState({ p: [sp.p[0], sp.p[1] + 0.3, sp.p[2]], yaw: sp.yaw });
      let yaw = sp.yaw;
      for (let i = 0; i < 1400; i++) {
        if (i % 40 === 0) yaw += (Math.random() - 0.5) * 2.4;
        let btn = BTN.FORWARD;
        if (i % 97 === 0) btn |= BTN.JUMP;
        if (i % 53 === 0) btn |= BTN.SPRINT;
        stepPlayer(s, { btn, yaw, pitch: 0 }, world, FIXED_DT);
        if (s.pos.y < md.bounds.min[1] + 1) { escaped++; break; }
      }
      if (s.pos.y < md.bounds.min[1] + 1) sunk++;
    }
    ok(escaped === 0, `${id}: ${walkers} random walkers stayed in the world`, `${escaped} fell out`);
    void sunk;

    // Sight lines: a ray straight down from high above must hit something.
    let missed = 0;
    for (let i = 0; i < 200; i++) {
      const x = md.bounds.min[0] + Math.random() * (md.bounds.max[0] - md.bounds.min[0]);
      const z = md.bounds.min[2] + Math.random() * (md.bounds.max[2] - md.bounds.min[2]);
      const hit = raycastWorld(world, { x, y: 60, z }, { x: 0, y: -1, z: 0 }, 120);
      if (!hit) missed++;
    }
    ok(missed === 0, `${id}: ground is closed from above`, `${missed}/200 rays escaped`);

    // Navigation must be one connected component, or bots strand themselves.
    const graph = buildNavGraph(world, md);
    const seen = new Uint8Array(graph.nodes.length);
    const comps = [];
    for (let i = 0; i < graph.nodes.length; i++) {
      if (seen[i]) continue;
      const stack = [i];
      seen[i] = 1;
      let size = 0;
      while (stack.length) {
        const n = stack.pop();
        size++;
        for (const l of graph.nodes[n].links) if (!seen[l.to]) { seen[l.to] = 1; stack.push(l.to); }
      }
      comps.push(size);
    }
    comps.sort((a, c) => c - a);
    const orphans = graph.nodes.filter((n) => !n.links.length).length;
    ok(graph.dropped.length === 0, `${id}: every nav node stands in open space`,
      `${graph.dropped.length} embedded: ${JSON.stringify(graph.dropped.slice(0, 4))}`);
    // Only maps that host bots need a traversable graph; the training facility
    // is single-player and never pathfinds.
    if (!md.offline) {
      ok(comps.length === 1, `${id}: nav graph is fully connected`,
        `${comps.length} components (largest ${comps[0]} of ${graph.nodes.length})`);
      ok(orphans === 0, `${id}: no isolated nav nodes`, `${orphans} orphans`);
    }

    console.log(`        ${md.boxes.length} boxes · ${md.spawns.length} spawns · ${md.props.length} props · ${graph.nodes.length} nav nodes`);
  }
}

// ---------------------------------------------------------------- weapons
function checkWeapons() {
  console.log('\nWEAPONS');
  let bad = 0;
  for (const w of WEAPON_LIST) {
    const rw = resolveWeapon({ id: w.id, scope: w.defaultScope, muzzle: 'compensator', grip: 'vertical' });
    if (!(rw.damage > 0) || !(rw.shotInterval > 0) || !(rw.mag > 0)) bad++;
    for (let i = 0; i < 40; i++) {
      const r = recoilAt(rw, i);
      if (!Number.isFinite(r.x) || !Number.isFinite(r.y)) bad++;
    }
    const sp = currentSpread(rw, { ads: false, speed: 5, onGround: true, crouching: false, bloom: 0 });
    if (!Number.isFinite(sp) || sp < 0) bad++;
    if (!w.scopes.includes(w.defaultScope)) bad++;
  }
  ok(bad === 0, `all ${WEAPON_LIST.length} weapons resolve with finite recoil and spread`, `${bad} problems`);

  const ttk = WEAPON_LIST.map((w) => `${w.name} ${(w.ttk * 1000).toFixed(0)}ms`).join(', ');
  console.log(`        body TTK — ${ttk}`);
}

// ------------------------------------------------------------------ match
class FakeHub {
  constructor() { this.sent = []; this.destroyed = []; }
  send(client, msg) { if (client) this.sent.push(msg); }
  destroyRoom(room) { this.destroyed.push(room.id); room.dispose(); }
}

function simulateMatch(modeId, seconds = 90) {
  const hub = new FakeHub();
  const room = new GameRoom(hub, {
    id: `test_${modeId}`, mode: modeId, mapId: 'estate', isPrivate: true, botCount: 8,
  });

  const events = {
    kills: 0, shots: 0, captures: 0, rounds: 0, grenades: 0,
    ended: null, started: null, errors: [],
  };
  room.broadcast = (msg) => {
    if (msg.t === 'kill') events.kills++;
    if (msg.t === 'round.end') events.rounds++;
    if (msg.t === 'grenade.pop') events.grenades++;
    if (msg.t === 'match.end') events.ended = msg;
    if (msg.t === 'match.start') events.started = msg;
  };
  room.sendSnapshots = () => {
    for (const e of room.pendingEvents) if (e.e === 'shot') events.shots++;
    room.pendingEvents = [];
  };

  room.fillBots();
  room.phase = 'intro';
  room.phaseEnds = 1.0;
  room.assignSpawns();

  const steps = Math.round(seconds / FIXED_DT);
  const t0 = Date.now();
  for (let i = 0; i < steps; i++) {
    try {
      room.tick(FIXED_DT);
    } catch (err) {
      events.errors.push(err);
      if (events.errors.length > 3) break;
    }
    if (room.disposed) break;
    if (i % 20 === 0) room.sendSnapshots();
  }
  const wall = Date.now() - t0;

  // Nobody should be *trapped* in the level. A single frame of overlap while
  // stepping onto a stair riser is normal and resolves itself, so give the
  // simulation a moment and only count players still embedded after it.
  const suspects = [...room.players.values()].filter(
    (p) => p.alive && cylinderBlocked(room.world, p.state.pos, PLAYER.radius, p.state.height)
  );
  if (suspects.length && !room.disposed) {
    for (let i = 0; i < 30; i++) {
      try { room.tick(FIXED_DT); } catch { break; }
      if (room.disposed) break;
    }
  }
  const embedded = suspects.filter(
    (p) => p.alive && cylinderBlocked(room.world, p.state.pos, PLAYER.radius, p.state.height)
  ).length;

  // Force the match to a conclusion so the end-of-match payload is exercised:
  // the victory screen, the fanfare and the XP award all read from it.
  if (!events.ended && !room.disposed) {
    try {
      room.endMatch(room.matchResult());
    } catch (err) {
      events.errors.push(err);
    }
  }

  room.dispose();
  return { events, embedded, wall, seconds };
}

function checkMatches() {
  const SECONDS = 180;
  console.log(`\nMATCH SIMULATION (8 bots, ${SECONDS}s of game time each)`);
  for (const modeId of MODE_IDS) {
    const r = simulateMatch(modeId, SECONDS);
    ok(r.events.errors.length === 0, `${modeId}: no exceptions`,
      r.events.errors[0] ? r.events.errors[0].stack?.split('\n')[0] : '');
    // One in the Chamber gives each player a single round, so shot volume is
    // an order of magnitude lower by design.
    const minShots = MODES[modeId].oneShot ? 8 : 40;
    ok(r.events.shots >= minShots, `${modeId}: bots engaged`, `${r.events.shots} shots`);
    ok(r.events.kills > 0, `${modeId}: eliminations registered`, `${r.events.kills} kills`);
    ok(r.embedded === 0, `${modeId}: no player stuck in geometry`, `${r.embedded} embedded`);

    ok(r.events.rounds > 0, `${modeId}: rounds resolved`, `${r.events.rounds} rounds`);
    ok(r.events.grenades > 0, `${modeId}: grenades thrown and detonated`, `${r.events.grenades} pops`);

    const e = r.events.ended;
    const boardOk = e && Array.isArray(e.board) && e.board.length === 8 &&
      e.board.every((p) => Number.isFinite(p.xp) && Number.isFinite(p.score) && p.name && p.banner);
    const winnerOk = e && (e.result === 'draw' ||
      (e.result === 'team' ? e.winnerTeam != null : !!e.winner)) &&
      (e.result === 'draw' || (!!e.winnerBanner && !!e.fanfare));
    ok(boardOk, `${modeId}: end-of-match scoreboard is complete`,
      e ? `board ${e.board?.length}` : 'no match.end');
    ok(winnerOk, `${modeId}: winner has a banner and a fanfare`,
      e ? `result=${e.result} banner=${e.winnerBanner} fanfare=${e.fanfare}` : 'no match.end');

    const rt = (r.wall / (r.seconds * 1000)) * 100;
    console.log(`        ${r.events.kills} kills · ${r.events.shots} shots · ${r.events.captures} objectives · ${rt.toFixed(1)}% of realtime CPU`);
  }
}

console.log('BREACH — self test');
checkMaps();
checkWeapons();
checkMatches();

console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}\n`);
process.exit(failures === 0 ? 0 : 1);
