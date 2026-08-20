// Navigation graph for bots.
//
// Waypoints come from the map data. Links are not derived from line of sight —
// that gets stairs and doorways wrong — but by actually walking a simulated
// player from one node to the other with the same controller the game uses. If
// a real player could make the trip, the link exists.
//
// The result is cached per map, since it is deterministic and costs a few
// tens of milliseconds to build.

import { PLAYER, BTN, FIXED_DT, MOVE } from '../constants.js';
import { cylinderBlocked, groundUnder, hasLineOfSight } from '../collision.js';
import { createPlayerState, stepPlayer } from '../controller.js';

const LINK_RANGE = 20;      // metres of horizontal separation worth testing
const MAX_CLIMB = 7.0;      // a link may gain at most this much height
const ARRIVE = 1.4;
// Enough ways out of any waypoint for a route to exist without paying for
// the long redundant links that a router would never choose anyway.
const MAX_LINKS = 10;
// How far a link is allowed to reach when it also climbs. A stair is short;
// nothing legitimately gains height over a longer run than this.
const CLIMB_RANGE = 14;
// A link only counts as climbing once it gains more than a step's worth.
const STEP_UP = 1.2;

// Finished graphs, and the part-built ones still being chipped away at. A
// builder started while the player was still in the menu is the same builder
// the match picks up, so no progress is ever thrown away.
const cache = new Map();
const builders = new Map();

/** Build the whole graph now. The map is deterministic, so this is cached. */
export function buildNavGraph(world, mapData) {
  return navGraphBuilder(world, mapData).finish();
}

/**
 * The same build, in slices.
 *
 * Linking a waypoint means simulating a walk to each of its neighbours, and
 * on a map with seven buildings that adds up to tens of seconds — spent, if
 * it is done in one go, with the host's tab frozen while the player watches
 * a stopped matchmaking screen. Handing back a builder lets the room chip
 * away at it during the pre-game fly-through, which is dead time anyway, and
 * fall back to finishing the job outright if the bots need it first.
 */
export function navGraphBuilder(world, mapData) {
  const cached = cache.get(mapData.id);
  if (cached) {
    return { graph: cached, done: true, advance: () => true, finish: () => cached };
  }
  const started = builders.get(mapData.id);
  if (started) return started;

  const nodes = [];
  const dropped = [];
  const stairs = stairZones(mapData);

  for (const raw of mapData.nav) {
    const p = { x: raw.p[0], y: raw.p[1], z: raw.p[2] };
    const fixed = settle(world, p);
    if (!fixed) { dropped.push(raw.p); continue; }
    nodes.push({
      id: nodes.length, p: fixed, tags: raw.tags || [], links: [],
      // Standing at a flight means the cheap sight test below cannot be
      // trusted about this node — see the note there.
      onStair: stairs.some((f) => nearFlight(fixed, f)),
    });
  }

  // Nearest neighbours first, and stop once a node has enough of them.
  //
  // Every candidate pair costs a simulated walk, so testing all of them is
  // quadratic in the *expensive* term rather than the cheap one: the estate
  // spent six seconds here and a denser map spent nearly two minutes, all of
  // it on the host's main thread while the player waited. Working outwards
  // means the links a node keeps are the short ones it would actually use,
  // and the long redundant ones — a bot never picks a twenty metre hop when
  // there are three waypoints along the way — are never tested at all.
  const graph = { nodes, dropped };
  const tested = new Set();

  const linkFrom = (i) => {
    const a = nodes[i];
    const cands = [];
    for (let j = 0; j < nodes.length; j++) {
      if (j === i) continue;
      const b = nodes[j];
      const flat = Math.hypot(a.p.x - b.p.x, a.p.z - b.p.z);
      const climb = Math.abs(a.p.y - b.p.y);
      if (flat > LINK_RANGE || climb > MAX_CLIMB) continue;
      // Anything that gains real height is a stair or a step up, and both are
      // short. Without this, every waypoint in a tower tests a walk to the
      // one directly above it on the next floor — a doomed climb through a
      // concrete deck, and on a vertical map that is most of the work.
      if (climb > STEP_UP && flat > CLIMB_RANGE) continue;
      cands.push({ j, flat, climb });
    }
    cands.sort((p, q) => p.flat - q.flat);

    for (const cnd of cands) {
      if (a.links.length >= MAX_LINKS) break;
      const b = nodes[cnd.j];
      const key = i < cnd.j ? i * nodes.length + cnd.j : cnd.j * nodes.length + i;
      if (tested.has(key)) continue;
      tested.add(key);

      // Cheap rejection before the expensive one, and only for pairs that
      // change floor.
      //
      // A failed walk costs ninety simulated frames before it gives up, and
      // in a tower every waypoint has one directly above it on the next
      // storey — a doomed climb through a concrete deck, tested hundreds of
      // times. A single waist-height ray settles those: the only honest way
      // to gain height here is a stair, and a stair leaves its two ends
      // looking at each other over the treads.
      //
      // Level pairs are never filtered this way. A route round a corner or
      // through a hedge maze has no line of sight and is perfectly walkable,
      // and rejecting those cut the estate's graph into thirteen pieces.
      //
      // Nor is anything standing at a flight of stairs. A stairwell is a
      // lined shaft, and a waypoint out in the room it serves looks straight
      // into that lining rather than at the treads — which is how the estate
      // lost its cellar, reachable in play and unreachable on the graph.
      if (cnd.climb > STEP_UP && !a.onStair && !b.onStair
        && !hasLineOfSight(world, { x: a.p.x, y: a.p.y + 0.9, z: a.p.z },
          { x: b.p.x, y: b.p.y + 0.9, z: b.p.z })) continue;

      const forward = walkable(world, a.p, b.p);
      const backward = forward ? true : walkable(world, b.p, a.p);
      if (!forward && !backward) continue;

      const cost = Math.hypot(cnd.flat, cnd.climb * 1.5) + (cnd.climb > 1 ? 2 : 0);
      a.links.push({ to: cnd.j, cost });
      b.links.push({ to: i, cost });
    }
  };

  let next = 0;
  const builder = {
    graph,
    done: false,
    /** Link waypoints for up to ms milliseconds. True once finished. */
    advance(ms = 5) {
      if (builder.done) return true;
      const until = Date.now() + ms;
      while (next < nodes.length) {
        linkFrom(next++);
        if (Date.now() >= until) return false;
      }
      builder.done = true;
      cache.set(mapData.id, graph);
      builders.delete(mapData.id);
      return true;
    },
    /** Finish now, whatever is left. */
    finish() {
      while (!builder.done) builder.advance(1e9);
      return graph;
    },
  };
  builders.set(mapData.id, builder);
  return builder;
}

/**
 * Where every flight of stairs in the map runs, as a segment plus the band of
 * height it covers. Used only to spare stair waypoints the sight test.
 */
function stairZones(mapData) {
  return (mapData.flights || []).map((f) => {
    const fx = -Math.sin(f.yaw), fz = -Math.cos(f.yaw);
    const len = f.steps * f.run;
    return {
      x0: f.x, z0: f.z, x1: f.x + fx * len, z1: f.z + fz * len,
      y0: f.y - 2.5, y1: f.y + f.steps * f.rise + 2.5,
      reach: f.width / 2 + 4.5,
    };
  });
}

function nearFlight(p, f) {
  if (p.y < f.y0 || p.y > f.y1) return false;
  const dx = f.x1 - f.x0, dz = f.z1 - f.z0;
  const len2 = dx * dx + dz * dz;
  let t = len2 > 1e-6 ? ((p.x - f.x0) * dx + (p.z - f.z0) * dz) / len2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const cx = f.x0 + dx * t, cz = f.z0 + dz * t;
  return Math.hypot(p.x - cx, p.z - cz) <= f.reach;
}

/** Nudge a waypoint out of geometry and onto the floor beneath it. */
function settle(world, p) {
  const R = PLAYER.radius;
  // Small lifts first. Waypoints are authored at ground level, and a floor
  // slab a few centimetres thick is enough to bury one — jumping straight to
  // 0.3 m then throws the node away when there is a stair landing overhead.
  for (const lift of [0, 0.1, 0.2, 0.3, 0.7, 1.2]) {
    const test = { x: p.x, y: p.y + lift, z: p.z };
    if (cylinderBlocked(world, test, R, PLAYER.standHeight)) continue;
    const g = groundUnder(world, test.x, test.z, R, test.y + 0.1, test.y - 2.5);
    if (g > -Infinity) return { x: test.x, y: g, z: test.z };
    return test;
  }
  return null;
}

/**
 * Can a player walk from `from` to `to`? Runs the real controller, so stairs,
 * step-ups, doorways and drops all behave exactly as they do in play.
 */
function walkable(world, from, to) {
  const s = createPlayerState({ p: [from.x, from.y + 0.05, from.z], yaw: 0 });
  const dist = Math.hypot(to.x - from.x, to.z - from.z);
  const budget = Math.ceil((dist / MOVE.walkSpeed / FIXED_DT) * 2.2) + 90;
  let best = dist;
  let stale = 0;

  for (let i = 0; i < budget; i++) {
    const dx = to.x - s.pos.x, dz = to.z - s.pos.z;
    const flat = Math.hypot(dx, dz);
    if (flat < ARRIVE && Math.abs(s.pos.y - to.y) < 1.6) return true;

    const yaw = Math.atan2(-dx, -dz);
    let btn = BTN.FORWARD;
    // A short hop clears the odd kerb or crate without turning every gap into
    // a link — the jump only fires when forward progress has stalled.
    if (stale > 18 && stale % 24 === 0) btn |= BTN.JUMP;
    stepPlayer(s, { btn, yaw, pitch: 0 }, world, FIXED_DT);

    if (flat < best - 0.02) { best = flat; stale = 0; } else stale++;
    if (stale > 90) return false;
    // Standing underneath the target with no way up. Waiting out the full
    // stall counter here is most of the cost of building the graph for a
    // building with floors: every waypoint has one directly above it, the
    // walker gets there in a few frames, and then mills about for ninety more
    // before admitting there are no stairs in the ceiling.
    if (s.pos.y < to.y - 12) return false;   // fell off something serious
  }
  return false;
}

export function nearestNode(graph, p, maxDist = 45) {
  let best = -1, bestD = maxDist * maxDist;
  for (const n of graph.nodes) {
    const dx = n.p.x - p.x, dy = (n.p.y - p.y) * 1.8, dz = n.p.z - p.z;
    const d = dx * dx + dy * dy + dz * dz;
    if (d < bestD) { bestD = d; best = n.id; }
  }
  return best;
}

/**
 * Nearest waypoint the agent can actually reach in a straight line.
 * Plain proximity is not enough: the closest node is often a metre away
 * through a wall, and anchoring a path there walks the bot into it forever.
 */
export function nearestReachableNode(graph, world, p, candidates = 6, maxDist = 45) {
  const ranked = graph.nodes
    .map((n) => {
      const dx = n.p.x - p.x, dy = (n.p.y - p.y) * 1.8, dz = n.p.z - p.z;
      return { id: n.id, d: dx * dx + dy * dy + dz * dz, p: n.p };
    })
    .filter((n) => n.d < maxDist * maxDist)
    .sort((a, b) => a.d - b.d)
    .slice(0, candidates);

  for (const n of ranked) {
    if (n.d < 2.25) return n.id;                 // already standing on it
    if (walkable(world, p, n.p)) return n.id;
  }
  return ranked.length ? ranked[0].id : -1;
}

/** A* over the waypoint graph. Returns an array of node ids, or null. */
export function findPath(graph, startId, goalId) {
  if (startId < 0 || goalId < 0) return null;
  if (startId === goalId) return [startId];

  const n = graph.nodes.length;
  const open = [startId];
  const came = new Int32Array(n).fill(-1);
  const gScore = new Float64Array(n).fill(Infinity);
  const fScore = new Float64Array(n).fill(Infinity);
  const closed = new Uint8Array(n);
  const inOpen = new Uint8Array(n);
  const goal = graph.nodes[goalId].p;

  const h = (id) => {
    const p = graph.nodes[id].p;
    return Math.hypot(p.x - goal.x, (p.y - goal.y) * 1.5, p.z - goal.z);
  };

  gScore[startId] = 0;
  fScore[startId] = h(startId);
  inOpen[startId] = 1;

  while (open.length) {
    let bi = 0;
    for (let i = 1; i < open.length; i++) if (fScore[open[i]] < fScore[open[bi]]) bi = i;
    const cur = open.splice(bi, 1)[0];
    inOpen[cur] = 0;

    if (cur === goalId) {
      const path = [cur];
      let c = cur;
      while (came[c] !== -1) { c = came[c]; path.push(c); }
      return path.reverse();
    }
    closed[cur] = 1;

    for (const link of graph.nodes[cur].links) {
      if (closed[link.to]) continue;
      const tentative = gScore[cur] + link.cost;
      if (tentative < gScore[link.to]) {
        came[link.to] = cur;
        gScore[link.to] = tentative;
        fScore[link.to] = tentative + h(link.to);
        if (!inOpen[link.to]) { open.push(link.to); inOpen[link.to] = 1; }
      }
    }
  }
  return null;
}
