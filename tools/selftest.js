// Headless checks. Run with `npm run check`.
//
// Builds every map, validates the geometry a player can actually touch, then
// simulates full matches of every mode with bots to shake out server bugs.

import { getMap, MAP_IDS, COMBAT_MAPS, MAP_INFO } from '../shared/maps/index.js';
import { buildWorld, cylinderBlocked, raycastWorld, groundUnder, hasLineOfSight } from '../shared/collision.js';
import { createPlayerState, stepPlayer } from '../shared/controller.js';
import { FIXED_DT, PLAYER, BTN, MOVE } from '../shared/constants.js';
import { MODE_IDS, MODES } from '../shared/modes.js';
import { WEAPON_LIST, resolveWeapon, recoilAt, currentSpread } from '../shared/weapons.js';
import { GameRoom } from '../shared/sim/room.js';
import { DRONE } from '../shared/drone.js';
import { buildNavGraph } from '../shared/sim/nav.js';
import { MATCH } from '../shared/constants.js';
import { readFileSync, existsSync } from 'node:fs';
import { propParts } from '../public/src/engine/props.js';
import { hashString } from '../shared/mathx.js';

let failures = 0;
const ok = (cond, label, detail = '') => {
  if (cond) console.log(`  PASS  ${label}`);
  else { failures++; console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`); }
};

/**
 * Walk every flight of stairs in the map, up and down, driving the real
 * controller. A flight that a player cannot climb — a riser above the step
 * height, a landing that catches you, a nose that stops you dead — is the
 * kind of fault that only shows up when someone tries to use it under fire.
 *
 * @returns {string[]} one line per broken flight
 */
function checkStairs(md, world) {
  const bad = [];
  for (const f of md.flights || []) {
    const fx = -Math.sin(f.yaw), fz = -Math.cos(f.yaw);
    const len = f.steps * f.run;
    const top = { x: f.x + fx * (len + 1.0), y: f.y + f.steps * f.rise, z: f.z + fz * (len + 1.0) };
    const bottom = { x: f.x - fx * 1.0, y: f.y, z: f.z - fz * 1.0 };

    for (const [from, to, dir] of [[bottom, top, 'up'], [top, bottom, 'down']]) {
      const s = createPlayerState({ p: [from.x, from.y + 0.6, from.z], yaw: 0 });
      let best = Infinity;
      let arrived = false;
      // Generous budget: a flight is short, but the controller has to
      // accelerate, and stairs are climbed at a walk.
      const budget = Math.ceil(((len + 3) / MOVE.walkSpeed / FIXED_DT) * 3) + 240;
      for (let i = 0; i < budget; i++) {
        const dx = to.x - s.pos.x, dz = to.z - s.pos.z;
        const flat = Math.hypot(dx, dz);
        best = Math.min(best, flat);
        if (flat < 1.6 && Math.abs(s.pos.y - to.y) < 1.4) { arrived = true; break; }
        const yaw = Math.atan2(-dx, -dz);
        stepPlayer(s, { btn: BTN.FORWARD, yaw, pitch: 0 }, world, FIXED_DT);
      }
      if (!arrived) {
        bad.push(`${dir} at (${f.x.toFixed(0)}, ${f.y.toFixed(1)}, ${f.z.toFixed(0)}) ` +
          `rise ${f.rise.toFixed(2)} — stalled ${best.toFixed(1)}m short`);
      }
    }
  }
  return bad;
}

/**
 * Pairs of boxes whose faces land on the same plane where a player can see
 * them. The depth buffer cannot choose between two surfaces it cannot tell
 * apart, so the pair flickers as the camera moves — the "flashing floors and
 * windows" class of bug.
 *
 * Faces inside a floor slab are skipped, since they never render. Faces
 * *below* ground used not to be checked at all, on the same reasoning — which
 * was wrong the moment a map put a metro concourse down there. Seven hundred
 * square metres of ceiling flickered under the city and this test said the map
 * was clean.
 *
 * Only reports patches big enough to notice; hairline seams between abutting
 * trim are not worth chasing.
 */
const MIN_VISIBLE_AREA = 1.0;   // m²

/**
 * A quarter turn leaves a box axis-aligned — only its description rotated —
 * so it can be normalised and tested like any other. Every wall running along
 * X is built that way, which means they were all invisible to this test until
 * now. Anything turned to some other angle is genuinely unaligned and rarely
 * lands on another surface's plane, so it is left out.
 */
function squared(b) {
  const r = ((b.r || 0) % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2);
  const q = Math.round(r / (Math.PI / 2));
  if (Math.abs(r - q * (Math.PI / 2)) > 1e-6) return null;
  return q % 2 === 1 ? { m: b.m, p: b.p, s: [b.s[2], b.s[1], b.s[0]] } : b;
}

function coincidentFaces(md) {
  const boxes = md.boxes.map(squared).filter(Boolean);
  const lo = (b, a) => b.p[a] - b.s[a] / 2;
  const hi = (b, a) => b.p[a] + b.s[a] / 2;
  const name = (b) => `${b.m} [${b.s.map((v) => v.toFixed(1)).join('x')}]`;
  const hits = [];

  for (let i = 0; i < boxes.length; i++) {
    const A = boxes[i];
    for (let j = i + 1; j < boxes.length; j++) {
      const B = boxes[j];
      const ov = [];
      let overlaps = true;
      for (let a = 0; a < 3; a++) {
        const o = Math.min(hi(A, a), hi(B, a)) - Math.max(lo(A, a), lo(B, a));
        ov.push(o);
        if (o <= 0.001) overlaps = false;
      }
      if (!overlaps) continue;

      // One box wholly inside another is wasteful but does not flicker.
      const holds = (P, Q) => [0, 1, 2].every((a) => lo(P, a) <= lo(Q, a) + 1e-4 && hi(P, a) >= hi(Q, a) - 1e-4);
      if (holds(A, B) || holds(B, A)) continue;

      for (let a = 0; a < 3; a++) {
        const [p, q] = [0, 1, 2].filter((k) => k !== a);
        const area = ov[p] * ov[q];
        if (area < MIN_VISIBLE_AREA) continue;
        // (nothing skipped for being underground: maps have rooms there)

        for (const face of [[hi(A, a), hi(B, a)], [lo(A, a), lo(B, a)]]) {
          if (Math.abs(face[0] - face[1]) >= 0.004) continue;
          if (a === 1 && face[0] < 0.12 && face[0] > -0.5) continue;   // inside a floor slab
          hits.push({ axis: 'xyz'[a], plane: face[0], area, a: name(A), b: name(B) });
        }
      }
    }
  }
  return hits.sort((x, y) => y.area - x.area);
}

/**
 * A conservative sphere round each primitive of a prop, transformed the way
 * the world builder transforms it. Exact enough to catch a tree growing
 * through a floor, which is what it is for.
 */
function propSpheres(prop) {
  const parts = propParts(prop, hashString(`${prop.type}:${prop.p.join(',')}`));
  if (!parts) return [];
  const scale = prop.scale || 1;
  const cos = Math.cos(prop.yaw || 0), sin = Math.sin(prop.yaw || 0);
  return parts.map((part) => {
    let r;
    if (part.k === 'box') r = Math.hypot(part.s[0], part.s[1], part.s[2]) / 2;
    else if (part.k === 'cyl') r = Math.hypot(Math.max(part.s[0], part.s[1]), part.s[2] / 2);
    else if (part.k === 'cone') r = Math.hypot(part.s[0], part.s[1] / 2);
    else r = part.s;
    const lx = part.p[0] * scale, ly = part.p[1] * scale, lz = part.p[2] * scale;
    return {
      x: prop.p[0] + lx * cos + lz * sin,
      y: prop.p[1] + ly,
      z: prop.p[2] - lx * sin + lz * cos,
      r: r * scale,
    };
  });
}

/** How far a sphere reaches inside a yaw-rotated box. Zero if it is outside. */
function spherePenetration(s, b) {
  const cos = Math.cos(b.r || 0), sin = Math.sin(b.r || 0);
  const dx = s.x - b.p[0], dz = s.z - b.p[2];
  const lx = dx * cos + dz * sin;
  const lz = -dx * sin + dz * cos;
  const ly = s.y - b.p[1];
  const cl = (v, h) => (v < -h ? -h : v > h ? h : v);
  const nx = lx - cl(lx, b.s[0] / 2);
  const ny = ly - cl(ly, b.s[1] / 2);
  const nz = lz - cl(lz, b.s[2] / 2);
  return Math.max(0, s.r - Math.hypot(nx, ny, nz));
}

/**
 * Props growing through the building they stand in.
 *
 * A tree is authored as a position and a scale, and neither says anything
 * about the room around it — so a canopy sized for a courtyard goes straight
 * through the gallery deck when the same call is made indoors. Whatever the
 * prop is standing on is not a fault, so anything within half a metre of its
 * base, and anything whose top face is below it, is ignored.
 */
function propsInGeometry(md) {
  const solids = md.boxes.filter((b) => b.solid !== false && b.m !== 'bark' && b.m !== 'foliage');
  const bad = [];
  for (const prop of md.props) {
    const base = prop.p[1];
    let worst = 0, where = null;
    for (const s of propSpheres(prop)) {
      if (s.y - s.r < base + 0.5) continue;
      for (const b of solids) {
        if (b.p[1] + b.s[1] / 2 < base + 0.6) continue;
        const pen = spherePenetration(s, b);
        if (pen > worst) { worst = pen; where = b; }
      }
    }
    if (worst > 0.3) {
      bad.push(`${prop.type} at (${prop.p.map((v) => v.toFixed(0)).join(', ')}) `
        + `reaches ${worst.toFixed(2)}m into ${where.m}`);
    }
  }
  return bad;
}

/**
 * Where a flight of stairs ends, the floor has to carry on.
 *
 * A stair shaft is cut into the decks above it, and if the cut is longer than
 * the flight that fills it the last tread stops short of the ground with an
 * open pit in between. Every metro shaft on the city map was a metre long in
 * exactly that way.
 */
function stairHeads(md, world) {
  const bad = [];
  for (const f of md.flights || []) {
    const fx = -Math.sin(f.yaw), fz = -Math.cos(f.yaw);
    const len = f.steps * f.run;
    const top = f.y + f.steps * f.rise;
    for (let d = len; d <= len + 1.6; d += 0.25) {
      const g = groundUnder(world, f.x + fx * d, f.z + fz * d, PLAYER.radius, top + 0.3, top - 2.0);
      if (g === -Infinity || top - g > PLAYER.stepHeight) {
        bad.push(`(${f.x.toFixed(0)}, ${f.y.toFixed(1)}, ${f.z.toFixed(0)}) — `
          + `${(d - len).toFixed(2)}m past the top tread the floor `
          + (g === -Infinity ? 'is missing' : `drops ${(top - g).toFixed(2)}m`));
        break;
      }
    }
  }
  return bad;
}

/**
 * Glazing is see-through and not shoot-through.
 *
 * Both halves matter and they are decided by different flags, so it is easy
 * to change one and not the other — which is how windows ended up stopping
 * neither.
 */
function glassBehaviour(md, world) {
  const worldSize = (b) => {
    const c = Math.abs(Math.cos(b.r || 0)), sn = Math.abs(Math.sin(b.r || 0));
    return [c * b.s[0] + sn * b.s[2], b.s[1], sn * b.s[0] + c * b.s[2]];
  };
  let panes = 0, stops = 0, sees = 0;
  for (const g of md.boxes.filter((b) => b.m === 'glass')) {
    const ws = worldSize(g);
    const thin = ws.indexOf(Math.min(...ws));
    if (thin === 1) continue;                       // skylights are shot from above
    panes++;
    const dir = { x: 0, y: 0, z: 0 };
    dir['xyz'[thin]] = 1;
    const from = { x: g.p[0] - dir.x * 1.5, y: g.p[1] - dir.y * 1.5, z: g.p[2] - dir.z * 1.5 };
    const to = { x: g.p[0] + dir.x * 1.5, y: g.p[1] + dir.y * 1.5, z: g.p[2] + dir.z * 1.5 };
    const shot = raycastWorld(world, from, dir, 3, { shots: true });
    if (shot && shot.box.mat === 'glass') stops++;
    if (hasLineOfSight(world, from, to)) sees++;
  }
  return { panes, stops, sees };
}

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

    const stairFaults = checkStairs(md, world);
    ok(stairFaults.length === 0, `${id}: every flight of stairs is climbable`,
      `${stairFaults.length}/${(md.flights || []).length * 2} runs failed:\n        `
        + stairFaults.join('\n        '));

    const heads = stairHeads(md, world);
    ok(heads.length === 0, `${id}: the floor carries on past the top of every flight`,
      `${heads.length}:
        ` + heads.slice(0, 5).join(`
        `));

    const gl = glassBehaviour(md, world);
    // A pane can legitimately have something else in front of it, so this is
    // about the great majority rather than every last one.
    ok(gl.panes === 0 || gl.stops >= gl.panes * 0.95, `${id}: rounds stop at glass`,
      `${gl.stops}/${gl.panes} panes`);
    ok(gl.panes === 0 || gl.sees >= gl.panes * 0.8, `${id}: you can still see through it`,
      `${gl.sees}/${gl.panes} panes`);

    const inside = propsInGeometry(md);
    ok(inside.length === 0, `${id}: no prop grows through the building it stands in`,
      `${inside.length}:\n        ` + inside.slice(0, 6).join(`\n        `));

    const zf = coincidentFaces(md);
    ok(zf.length === 0, `${id}: no surfaces fighting for the same plane`,
      zf.length ? `${zf.length} pairs, worst ${zf[0].area.toFixed(1)}m² at ` +
        `${zf[0].axis}=${zf[0].plane.toFixed(2)} (${zf[0].a} / ${zf[0].b})` : '');

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

function simulateMatch(modeId, seconds = 90, mapId = 'estate') {
  const hub = new FakeHub();
  const room = new GameRoom(hub, {
    id: `test_${modeId}_${mapId}`, mode: modeId, mapId, isPrivate: true, botCount: 8,
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

function checkCommentary() {
  console.log('');
  console.log('COMMENTARY');
  const manifest = JSON.parse(readFileSync('public/assets/vo/manifest.json', 'utf8'));
  const clips = manifest.clips || [];
  let missing = 0;
  for (const c of clips) {
    if (!existsSync(`public/assets/vo/${c.file}`)) { missing++; console.log(`        missing ${c.file}`); }
  }
  ok(missing === 0, `all ${clips.length} clips are on disk`, `${missing} missing`);

  // A map whose opening lines run past the fly-through gets cut off mid
  // sentence, which is exactly what the pre-recorded booth was meant to fix.
  const GAP = 0.18;
  for (const id of COMBAT_MAPS) {
    const md = getMap(id);
    const window = md.introDuration ?? MATCH.introDuration;
    const lines = clips.filter((c) => c.slot === 'intro' && (c.map == null || c.map === id));
    const spoken = lines.reduce((a, c) => a + (c.seconds || 0), 0) + Math.max(0, lines.length - 1) * GAP;
    ok(lines.length > 0, `${id}: has an opening`, 'no intro clips');
    ok(spoken <= window, `${id}: the opening fits the fly-through`,
      `${spoken.toFixed(1)}s of lines in a ${window.toFixed(1)}s window`);
    const orders = lines.map((c) => c.order || 0);
    ok(new Set(orders).size === orders.length, `${id}: the opening lines are ordered`,
      `orders ${JSON.stringify(orders)}`);
    console.log(`        ${MAP_INFO[id].name}: ${lines.length} lines, ${spoken.toFixed(1)}s of ${window.toFixed(1)}s`);
  }
}

function checkMatches() {
  const SECONDS = 180;
  console.log(`\nMATCH SIMULATION (8 bots, ${SECONDS}s of game time each)`);
  // Every combat map is played, not just the first one: a map bots cannot
  // fight on is a map where rounds never end.
  const runs = [];
  for (const modeId of MODE_IDS) for (const mapId of COMBAT_MAPS) runs.push([modeId, mapId]);
  for (const [modeId, mapId] of runs) {
    const r = simulateMatch(modeId, SECONDS, mapId);
    const label = `${modeId} on ${mapId}`;
    ok(r.events.errors.length === 0, `${label}: no exceptions`,
      r.events.errors[0] ? r.events.errors[0].stack?.split('\n')[0] : '');
    // One in the Chamber gives each player a single round, so shot volume is
    // an order of magnitude lower by design.
    const minShots = MODES[modeId].oneShot ? 8 : 40;
    ok(r.events.shots >= minShots, `${label}: bots engaged`, `${r.events.shots} shots`);
    ok(r.events.kills > 0, `${label}: eliminations registered`, `${r.events.kills} kills`);
    ok(r.embedded === 0, `${label}: no player stuck in geometry`, `${r.embedded} embedded`);

    ok(r.events.rounds > 0, `${label}: rounds resolved`, `${r.events.rounds} rounds`);
    ok(r.events.grenades > 0, `${label}: grenades thrown and detonated`, `${r.events.grenades} pops`);

    const e = r.events.ended;
    const boardOk = e && Array.isArray(e.board) && e.board.length === 8 &&
      e.board.every((p) => Number.isFinite(p.xp) && Number.isFinite(p.score) && p.name && p.banner);
    const winnerOk = e && (e.result === 'draw' ||
      (e.result === 'team' ? e.winnerTeam != null : !!e.winner)) &&
      (e.result === 'draw' || (!!e.winnerBanner && !!e.fanfare));
    ok(boardOk, `${label}: end-of-match scoreboard is complete`,
      e ? `board ${e.board?.length}` : 'no match.end');
    ok(winnerOk, `${label}: winner has a banner and a fanfare`,
      e ? `result=${e.result} banner=${e.winnerBanner} fanfare=${e.fanfare}` : 'no match.end');

    const rt = (r.wall / (r.seconds * 1000)) * 100;
    console.log(`        ${r.events.kills} kills · ${r.events.shots} shots · ${r.events.captures} objectives · ${rt.toFixed(1)}% of realtime CPU`);
  }
}

console.log('BREACH — self test');

// ------------------------------------------------------------------ drone
function checkDrone() {
  console.log('\nRECON DRONE');
  const hub = { send: () => {}, destroyRoom: () => {} };
  const room = new GameRoom(hub, { id: 'D', mode: 'breach', mapId: 'estate', isPrivate: true, botCount: 4 });
  room.fillBots();
  room.startRound();
  room.phase = 'live';
  room.phaseEnds = 1e9;
  room.checkRoundEnd = () => {};

  const ps = [...room.players.values()];
  const pilot = ps[0];
  pilot.client = { id: pilot.id, ws: { readyState: 1, send: () => {} }, deliver: () => {} };
  pilot.bot.think = () => { pilot.cmd = { seq: 0, btn: 0, yaw: pilot.cmd.yaw, pitch: 0 }; };
  const step = (n) => { for (let i = 0; i < n; i++) room.tick(FIXED_DT); };

  room.onMessage(pilot.client, { t: 'drone.deploy' });
  // Let the body finish falling to its spawn before measuring: the property
  // under test is that input cannot move it, not that gravity stops.
  step(30);
  const bodyAt = { ...pilot.state.pos };
  ok(!!pilot.drone && pilot.piloting, 'drone: deploys and takes control');

  const first = pilot.drone;
  room.onMessage(pilot.client, { t: 'drone.deploy' });
  ok(pilot.drone === first, 'drone: only one per round');

  const from = { ...pilot.drone.pos };
  room.onMessage(pilot.client, { t: 'drone.input', btn: BTN.FORWARD | BTN.SPRINT, yaw: pilot.drone.yaw, pitch: 0 });
  step(90);
  const rolled = Math.hypot(pilot.drone.pos.x - from.x, pilot.drone.pos.z - from.z);
  ok(rolled > 3, 'drone: rolls under power', `${rolled.toFixed(1)}m in 0.75s`);

  const groundY = pilot.drone.pos.y;
  room.onMessage(pilot.client, { t: 'drone.input', btn: BTN.JUMP, yaw: pilot.drone.yaw, pitch: 0 });
  step(8);
  ok(pilot.drone.pos.y > groundY + 0.1, 'drone: jumps');
  step(80);

  const drift = Math.hypot(pilot.state.pos.x - bodyAt.x, pilot.state.pos.z - bodyAt.z);
  ok(drift < 0.1, 'drone: the operator stays put while piloting', `${drift.toFixed(2)}m of drift`);

  const enemy = ps.find((q) => q.team !== pilot.team && q.alive);
  // Hold the target still: this is a test of the scan, not of where a bot
  // happens to have wandered by the time it fires.
  enemy.bot.think = () => { enemy.cmd = { seq: 0, btn: 0, yaw: enemy.cmd.yaw, pitch: 0 }; };
  step(2);
  // Both stood on open lawn. Scanning whichever corner a bot happened to
  // wander into was a test of the estate's geometry, not of the scanner.
  enemy.state.pos = { x: 0, y: 0.1, z: 70 };
  pilot.drone.pos = { x: enemy.state.pos.x, y: enemy.state.pos.y + 0.1, z: enemy.state.pos.z + 4 };
  pilot.drone.yaw = Math.atan2(-(enemy.state.pos.x - pilot.drone.pos.x), -(enemy.state.pos.z - pilot.drone.pos.z));
  pilot.drone.pitch = 0.2;
  pilot.drone.scanReadyAt = 0;
  room.onMessage(pilot.client, { t: 'drone.scan' });
  ok(enemy.markedUntil > room.time, 'drone: a scan marks what it is looking at');
  ok(room.marksFor(pilot.team).includes(enemy.id) && !room.marksFor(enemy.team).includes(enemy.id),
    'drone: marks are visible to the pilot team only');

  // Stepping out parks it; stepping back in resumes from where it sat.
  const parked = { ...pilot.drone.pos };
  room.onMessage(pilot.client, { t: 'drone.exit' });
  step(60);
  ok(!!pilot.drone && pilot.drone.alive && !pilot.piloting,
    'drone: stepping out parks it rather than losing it');
  ok(Math.hypot(pilot.drone.pos.x - parked.x, pilot.drone.pos.z - parked.z) < 0.5,
    'drone: a parked drone stays where it was left');
  room.onMessage(pilot.client, { t: 'drone.enter' });
  ok(pilot.piloting, 'drone: you can step back into it');
  const sameId = pilot.drone.id;
  room.onMessage(pilot.client, { t: 'drone.deploy' });
  ok(pilot.drone.id === sameId, 'drone: deploying again does not build a second one');

  const shooter = ps.find((q) => q.team !== pilot.team && q.alive && q !== enemy) || enemy;
  const d = pilot.drone;
  // Muzzle almost on top of it, so the test is about the drone hitbox and
  // not about whatever wall happens to be three metres behind it.
  const origin = { x: d.pos.x, y: d.pos.y + DRONE.height * 0.5, z: d.pos.z + 1.2 };
  room.traceShot(shooter, origin, { x: 0, y: 0, z: -1 }, shooter.weapons.primary.rw, null);
  ok(!pilot.drone && !pilot.piloting, 'drone: one round destroys it and returns the pilot');

  room.startRound();
  ok(!pilot.droneUsed && enemy.markedUntil === 0, 'drone: a new round hands it back and clears marks');
  room.dispose();
}
checkMaps();
checkWeapons();
checkCommentary();
checkMatches();
checkDrone();

console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}\n`);
process.exit(failures === 0 ? 0 : 1);
