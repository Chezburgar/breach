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
import { cylinderBlocked, groundUnder } from '../collision.js';
import { createPlayerState, stepPlayer } from '../controller.js';

const LINK_RANGE = 20;      // metres of horizontal separation worth testing
const MAX_CLIMB = 7.0;      // a link may gain at most this much height
const ARRIVE = 1.4;

const cache = new Map();

export function buildNavGraph(world, mapData) {
  const cached = cache.get(mapData.id);
  if (cached) return cached;

  const nodes = [];
  const dropped = [];

  for (const raw of mapData.nav) {
    const p = { x: raw.p[0], y: raw.p[1], z: raw.p[2] };
    const fixed = settle(world, p);
    if (!fixed) { dropped.push(raw.p); continue; }
    nodes.push({ id: nodes.length, p: fixed, tags: raw.tags || [], links: [] });
  }

  for (let i = 0; i < nodes.length; i++) {
    for (let j = i + 1; j < nodes.length; j++) {
      const a = nodes[i], b = nodes[j];
      const flat = Math.hypot(a.p.x - b.p.x, a.p.z - b.p.z);
      const climb = Math.abs(a.p.y - b.p.y);
      if (flat > LINK_RANGE || climb > MAX_CLIMB) continue;

      const forward = walkable(world, a.p, b.p);
      const backward = forward ? true : walkable(world, b.p, a.p);
      if (!forward && !backward) continue;

      const cost = Math.hypot(flat, climb * 1.5) + (climb > 1 ? 2 : 0);
      a.links.push({ to: j, cost });
      b.links.push({ to: i, cost });
    }
  }

  const graph = { nodes, dropped };
  cache.set(mapData.id, graph);
  return graph;
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
