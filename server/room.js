// A single match: authoritative simulation, lag-compensated hitscan, mode rules.

import {
  FIXED_DT, INTERP_DELAY, MATCH, MAX_ROLLBACK, PLAYER, SNAPSHOT_DT,
  BTN, HIT_MULTIPLIER, TEAM_INFO,
} from '../shared/constants.js';
import { buildWorld, raycastWorld, rayPlayer, hasLineOfSight } from '../shared/collision.js';
import { createPlayerState, stepPlayer, eyePosition } from '../shared/controller.js';
import { getMap } from '../shared/maps/index.js';
import { zoneAt } from '../shared/maps/builder.js';
import { getMode } from '../shared/modes.js';
import {
  resolveWeapon, currentSpread, damageAt, GUNGAME_LADDER, getWeapon, sanitizeLoadout,
} from '../shared/weapons.js';
import { clamp, dirFromAngles, hashString, makeRng, vdist } from '../shared/mathx.js';
import { buildNavGraph } from './nav.js';
import { Bot, BOT_NAMES } from './bots.js';

const HISTORY_TICKS = 48;      // ~0.8s of rewind material
const MELEE_RANGE = 2.4;
const MELEE_DAMAGE = 55;

export class GameRoom {
  constructor(hub, { id, mode, mapId, isPrivate, botCount }) {
    this.hub = hub;
    this.id = id;
    this.mode = getMode(mode);
    this.mapId = mapId || 'oldquarter';
    this.mapData = getMap(this.mapId);
    this.world = buildWorld(this.mapData);
    this.nav = buildNavGraph(this.world, this.mapData);
    this.isPrivate = !!isPrivate;
    this.botCount = botCount || 0;
    this.seed = (Math.random() * 0xffffffff) >>> 0;

    this.players = new Map();
    this.history = [];
    this.tickNo = 0;
    this.time = 0;
    this.phase = 'lobby';
    this.phaseEnds = 0;
    this.scores = [0, 0];
    this.teamCounts = [0, 0];
    this.snapAccum = 0;
    this.objectiveState = this.initObjectives();
    this.pendingEvents = [];
    this.disposed = false;
    this.emptySince = 0;
  }

  // ------------------------------------------------------------ lifecycle
  begin() {
    this.fillBots();
    this.phase = 'intro';
    this.phaseEnds = MATCH.introDuration;
    this.assignSpawns();

    const roster = this.roster();
    this.broadcast({
      t: 'match.start',
      room: this.id,
      mode: this.mode.id,
      map: this.mapId,
      seed: this.seed,
      teams: this.mode.teams ? TEAM_INFO : null,
      scoreLimit: this.mode.scoreLimit ?? null,
      timeLimit: this.mode.timeLimit,
      intro: MATCH.introDuration,
      players: roster,
    });
    this.pushPhase();

    this.last = process.hrtime.bigint();
    this.accum = 0;
    this.timer = setInterval(() => this.pump(), 1000 / 120);
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    clearInterval(this.timer);
    for (const p of this.players.values()) {
      if (p.client) { p.client.room = null; }
    }
    this.players.clear();
  }

  pump() {
    const now = process.hrtime.bigint();
    let dt = Number(now - this.last) / 1e9;
    this.last = now;
    if (dt > 0.25) dt = 0.25;          // a stall must not fast-forward the match
    this.accum += dt;
    let guard = 0;
    while (this.accum >= FIXED_DT && guard++ < 12) {
      this.accum -= FIXED_DT;
      this.tick(FIXED_DT);
    }
    this.snapAccum += dt;
    if (this.snapAccum >= SNAPSHOT_DT) {
      this.snapAccum = 0;
      this.sendSnapshots();
    }
  }

  // -------------------------------------------------------------- players
  nextPartyTeam() {
    return this.teamCounts[0] <= this.teamCounts[1] ? 0 : 1;
  }

  addClient(client, forcedTeam) {
    if (client.room) client.room.removeClient(client, 'switched');
    const team = this.mode.teams
      ? (forcedTeam ?? (this.teamCounts[0] <= this.teamCounts[1] ? 0 : 1))
      : -1;
    const p = this.makePlayer({
      id: client.id,
      name: client.name,
      banner: client.banner,
      fanfare: client.fanfare,
      level: client.level,
      loadout: client.loadout,
      team,
      client,
    });
    client.room = this;
    this.players.set(p.id, p);
    if (team >= 0) this.teamCounts[team]++;

    if (this.phase !== 'lobby') {
      // Late join: hand them the match immediately.
      this.send(client, {
        t: 'match.start',
        room: this.id, mode: this.mode.id, map: this.mapId, seed: this.seed,
        teams: this.mode.teams ? TEAM_INFO : null,
        scoreLimit: this.mode.scoreLimit ?? null,
        timeLimit: this.mode.timeLimit,
        intro: 0,
        players: this.roster(),
        joinInProgress: true,
      });
      this.respawn(p, true);
      this.send(client, this.phaseMessage());
      this.broadcast({ t: 'roster', players: this.roster() });
    }
    return p;
  }

  removeClient(client, reason) {
    const p = this.players.get(client.id);
    client.room = null;
    if (!p) return;
    if (p.team >= 0) this.teamCounts[p.team]--;
    this.players.delete(p.id);
    this.broadcast({ t: 'playerleft', id: p.id, name: p.name, reason });
    this.broadcast({ t: 'roster', players: this.roster() });

    if (![...this.players.values()].some((q) => q.client)) {
      this.hub.destroyRoom(this);
    }
  }

  onProfileChanged(client) {
    const p = this.players.get(client.id);
    if (!p) return;
    p.name = client.name;
    p.banner = client.banner;
    p.fanfare = client.fanfare;
    p.pendingLoadout = sanitizeLoadout(client.loadout);
    this.broadcast({ t: 'roster', players: this.roster() });
  }

  makePlayer({ id, name, banner, fanfare, level, loadout, team, client, bot }) {
    const lo = sanitizeLoadout(loadout);
    const p = {
      id, name, banner, fanfare, level: level || 1, team,
      client: client || null,
      bot: bot || null,
      loadout: lo,
      pendingLoadout: null,
      state: createPlayerState({ p: [0, 4, 0], yaw: 0 }),
      cmd: { seq: -1, btn: 0, yaw: 0, pitch: 0 },
      prevBtn: 0,
      inputQueue: [],
      lastSeq: -1,
      ackSeq: -1,
      alive: false,
      health: PLAYER.maxHealth,
      lastDamageAt: -99,
      respawnAt: 0,
      spawnProtectUntil: 0,
      kills: 0, deaths: 0, assists: 0, score: 0, damage: 0, headshots: 0,
      streak: 0, bestStreak: 0,
      slot: 'primary',
      weapons: {},
      reloadEnd: 0,
      pendingReload: null,
      lastFireTime: -99,
      shotCounter: 0,
      burstLeft: 0,
      switchEnd: 0,
      damagedBy: new Map(),
      ggIndex: 0,
      hasFlag: null,
      zone: '',
      joinedAt: this.time,
    };
    this.equipLoadout(p);
    return p;
  }

  equipLoadout(p) {
    const build = (cfg) => {
      const rw = resolveWeapon(cfg);
      return { cfg, rw, mag: rw.mag, reserve: rw.reserve };
    };
    if (this.mode.ladder) {
      const id = GUNGAME_LADDER[Math.min(p.ggIndex, GUNGAME_LADDER.length - 1)];
      const def = getWeapon(id);
      const cfg = { id, scope: def.defaultScope, muzzle: 'none', grip: 'none', laser: 'none' };
      p.weapons = { primary: build(cfg), secondary: build({ id: 'p226', scope: 'iron' }) };
      p.slot = 'primary';
    } else if (this.mode.oneShot) {
      p.weapons = {
        primary: build({ id: 'deagle', scope: 'iron', muzzle: 'none' }),
        secondary: build({ id: 'p226', scope: 'iron' }),
      };
      // One round in the chamber, and it always kills. Land it and the shot is
      // refunded; miss and the knife is all that is left.
      p.weapons.primary.rw.damage = 250;
      p.weapons.primary.rw.falloff = { start: 200, end: 400, minMul: 1 };
      p.weapons.primary.rw.spread = { ...p.weapons.primary.rw.spread, ads: 0.02, hip: 2.2 };
      p.weapons.primary.mag = 1;
      p.weapons.primary.reserve = 0;
      p.weapons.secondary.mag = 0;
      p.weapons.secondary.reserve = 0;
      p.slot = 'primary';
    } else {
      p.weapons = { primary: build(p.loadout.primary), secondary: build(p.loadout.secondary) };
      p.slot = 'primary';
    }
  }

  fillBots() {
    const want = this.botCount;
    const used = new Set([...this.players.values()].map((p) => p.name));
    for (let i = 0; i < want; i++) {
      const name = BOT_NAMES.find((n) => !used.has(n)) || `Bot${i}`;
      used.add(name);
      const team = this.mode.teams ? (this.teamCounts[0] <= this.teamCounts[1] ? 0 : 1) : -1;
      const bot = new Bot(this, name);
      const p = this.makePlayer({
        id: `bot_${this.id}_${i}`,
        name,
        banner: bot.banner,
        fanfare: bot.fanfare,
        level: bot.level,
        loadout: bot.loadout,
        team,
        bot,
      });
      bot.player = p;
      this.players.set(p.id, p);
      if (team >= 0) this.teamCounts[team]++;
    }
  }

  roster() {
    return [...this.players.values()].map((p) => ({
      id: p.id, name: p.name, banner: p.banner, level: p.level, team: p.team,
      bot: !!p.bot, kills: p.kills, deaths: p.deaths, assists: p.assists, score: p.score,
      weapon: p.weapons[p.slot]?.rw.id,
    }));
  }

  // ---------------------------------------------------------------- phase
  pushPhase() { this.broadcast(this.phaseMessage()); }

  phaseMessage() {
    return {
      t: 'phase',
      phase: this.phase,
      remaining: Math.max(0, this.phaseEnds - this.time),
      scores: this.scores,
      matchTime: this.mode.timeLimit - this.time,
    };
  }

  setPhase(phase, duration) {
    this.phase = phase;
    this.phaseEnds = this.time + duration;
    this.pushPhase();
  }

  // ----------------------------------------------------------------- tick
  tick(dt) {
    this.time += dt;
    this.tickNo++;

    switch (this.phase) {
      case 'intro':
        if (this.time >= this.phaseEnds) {
          for (const p of this.players.values()) this.respawn(p, true);
          this.setPhase('warmup', MATCH.warmupDuration);
        }
        break;
      case 'warmup':
        if (this.time >= this.phaseEnds) {
          this.matchStartTime = this.time;
          this.setPhase('live', this.mode.timeLimit);
        }
        break;
      case 'live':
        if (this.time >= this.phaseEnds) this.endMatch(this.timeoutWinner());
        break;
      case 'outro':
        if (this.time >= this.phaseEnds) {
          this.broadcast({ t: 'match.over' });
          this.hub.destroyRoom(this);
          return;
        }
        break;
      default: break;
    }

    const live = this.phase === 'live';
    const frozen = this.phase === 'intro' || this.phase === 'warmup' || this.phase === 'outro';

    for (const p of this.players.values()) {
      if (p.bot) p.bot.think(dt, live);

      if (!p.alive) {
        if (live && p.respawnAt > 0 && this.time >= p.respawnAt) this.respawn(p);
        continue;
      }

      const cmd = this.nextCommand(p, frozen);
      stepPlayer(p.state, cmd, this.world, FIXED_DT);

      if (p.state.fallDamage > 0 && live) {
        this.applyDamage(p, null, p.state.fallDamage, 'fall', 'limb', 0);
      }

      this.stepWeapon(p, cmd, dt, live);
      this.stepHealth(p, dt);

      const z = zoneAt(this.mapData, p.state.pos);
      if (z !== p.zone) p.zone = z;
    }

    this.recordHistory();
    if (live) this.stepMode(dt);

    if (!this.players.size) {
      if (!this.emptySince) this.emptySince = this.time;
      else if (this.time - this.emptySince > 5) this.hub.destroyRoom(this);
    } else {
      this.emptySince = 0;
    }
  }

  nextCommand(p, frozen) {
    if (p.bot) {
      // Bots author a fresh command every tick, so there is nothing to queue.
      return frozen ? { seq: 0, btn: 0, yaw: p.cmd.yaw, pitch: p.cmd.pitch } : p.cmd;
    }
    const q = p.inputQueue;
    if (q.length) {
      // Never let a client bank inputs to move faster than real time.
      if (q.length > 10) q.splice(0, q.length - 10);
      p.cmd = q.shift();
      p.ackSeq = p.cmd.seq;
    } else if (p.cmd) {
      // Missing packet: hold the look angles, drop the movement.
      p.cmd = { ...p.cmd, btn: p.cmd.btn & (BTN.ADS | BTN.CROUCH) };
    }
    if (frozen) {
      return { seq: p.cmd.seq, btn: 0, yaw: p.cmd.yaw, pitch: p.cmd.pitch };
    }
    return p.cmd;
  }

  stepHealth(p, dt) {
    if (p.health >= PLAYER.maxHealth) return;
    if (this.time - p.lastDamageAt < PLAYER.regenDelay) return;
    p.health = Math.min(PLAYER.maxHealth, p.health + PLAYER.regenRate * dt);
  }

  recordHistory() {
    const frame = { time: this.time, players: [] };
    for (const p of this.players.values()) {
      if (!p.alive) continue;
      frame.players.push({
        id: p.id, team: p.team,
        pos: { x: p.state.pos.x, y: p.state.pos.y, z: p.state.pos.z },
        yaw: p.state.yaw, height: p.state.height,
      });
    }
    this.history.push(frame);
    if (this.history.length > HISTORY_TICKS) this.history.shift();
  }

  historyAt(targetTime) {
    if (!this.history.length) return null;
    for (let i = this.history.length - 1; i >= 0; i--) {
      if (this.history[i].time <= targetTime) {
        const a = this.history[i];
        const b = this.history[i + 1];
        if (!b) return a;
        const span = b.time - a.time;
        const f = span > 1e-6 ? clamp((targetTime - a.time) / span, 0, 1) : 0;
        return {
          time: targetTime,
          players: a.players.map((pa) => {
            const pb = b.players.find((q) => q.id === pa.id);
            if (!pb) return pa;
            return {
              id: pa.id, team: pa.team, yaw: pa.yaw,
              height: pa.height + (pb.height - pa.height) * f,
              pos: {
                x: pa.pos.x + (pb.pos.x - pa.pos.x) * f,
                y: pa.pos.y + (pb.pos.y - pa.pos.y) * f,
                z: pa.pos.z + (pb.pos.z - pa.pos.z) * f,
              },
            };
          }),
        };
      }
    }
    return this.history[0];
  }

  // -------------------------------------------------------------- weapons
  stepWeapon(p, cmd, dt, live) {
    const slot = p.weapons[p.slot];
    if (!slot) return;
    const rw = slot.rw;

    if (p.pendingReload && this.time >= p.reloadEnd) this.finishReload(p);

    if (!live) { p.prevBtn = cmd.btn; return; }
    if (this.time < p.switchEnd) { p.prevBtn = cmd.btn; return; }

    const firePressed = !!(cmd.btn & BTN.FIRE);
    const fireEdge = firePressed && !(p.prevBtn & BTN.FIRE);
    p.prevBtn = cmd.btn;

    const mode = rw.def.fireModes[0];
    let wantShot = false;
    if (mode === 'auto') wantShot = firePressed;
    else if (mode === 'burst') {
      if (fireEdge && p.burstLeft <= 0) p.burstLeft = rw.def.burstCount || 3;
      wantShot = p.burstLeft > 0;
    } else wantShot = fireEdge;              // semi / pump

    if (!wantShot) return;
    if (this.time - p.lastFireTime < rw.shotInterval - 0.004) return;

    if (slot.mag <= 0) {
      if (fireEdge) this.send(p.client, { t: 'dryfire' });
      if (slot.reserve > 0 && !p.pendingReload) this.startReload(p);
      p.burstLeft = 0;
      return;
    }
    if (p.pendingReload) {
      // Firing cancels a reload in progress, like it should.
      p.pendingReload = null;
      p.reloadEnd = 0;
    }

    slot.mag--;
    p.lastFireTime = this.time;
    if (p.burstLeft > 0) p.burstLeft--;
    this.fireShot(p, cmd, rw);
  }

  fireShot(p, cmd, rw) {
    const shotIndex = p.shotCounter++;
    const eye = eyePosition(p.state);
    const base = dirFromAngles(cmd.yaw, cmd.pitch);

    const spreadDeg = currentSpread(rw, {
      ads: !!(cmd.btn & BTN.ADS),
      speed: p.state.speed,
      onGround: p.state.onGround,
      crouching: p.state.crouching,
      bloom: 0,
    });

    const rewind = p.client
      ? clamp(p.client.rtt / 2000 + INTERP_DELAY, 0, MAX_ROLLBACK)
      : 0;
    const frame = this.historyAt(this.time - rewind);

    const pellets = rw.pellets;
    const cone = rw.spread.pelletCone || spreadDeg;
    const tracers = [];
    const victims = new Map();

    for (let i = 0; i < pellets; i++) {
      const dir = this.spreadDir(base, pellets > 1 ? cone : spreadDeg, p.id, shotIndex, i);
      const hit = this.traceShot(p, eye, dir, rw, frame);
      tracers.push(hit.end);
      if (hit.victim) {
        const prev = victims.get(hit.victim.id) || { dmg: 0, zone: 'limb', dist: hit.dist };
        prev.dmg += hit.damage;
        if (hit.zone === 'head' || (hit.zone === 'chest' && prev.zone === 'limb')) prev.zone = hit.zone;
        victims.set(hit.victim.id, prev);
      }
    }

    this.pendingEvents.push({
      e: 'shot',
      id: p.id,
      o: r3(eye),
      d: tracers.map(r3),
      w: rw.id,
      silent: rw.loud < 0.5,
      loud: rw.loud,
    });

    let anyKill = false;
    let totalDamage = 0;
    for (const [vid, info] of victims) {
      const victim = this.players.get(vid);
      if (!victim || !victim.alive) continue;
      const killed = this.applyDamage(victim, p, info.dmg, rw.id, info.zone, info.dist);
      totalDamage += info.dmg;
      anyKill = anyKill || killed;
      if (info.zone === 'head') p.headshots++;
    }

    if (victims.size) {
      this.send(p.client, {
        t: 'hitmark',
        zone: [...victims.values()].some((v) => v.zone === 'head') ? 'head' : 'body',
        damage: Math.round(totalDamage),
        killed: anyKill,
      });
    }

    // One in the Chamber: a hit refunds the round, a miss does not.
    if (this.mode.oneShot) {
      const slot = p.weapons[p.slot];
      if (anyKill) slot.mag = Math.min(1, slot.mag + 1);
    }
  }

  /** Deterministic cone sampling — the client reproduces this exactly. */
  spreadDir(base, spreadDeg, playerId, shotIndex, pellet) {
    if (spreadDeg <= 1e-4) return base;
    const rng = makeRng((hashString(playerId) ^ (shotIndex * 2654435761) ^ (pellet * 40503)) >>> 0);
    const ang = rng() * Math.PI * 2;
    const rad = Math.sqrt(rng()) * (spreadDeg * Math.PI / 180);

    // Build an orthonormal basis around the aim direction.
    const up = Math.abs(base.y) > 0.95 ? { x: 1, y: 0, z: 0 } : { x: 0, y: 1, z: 0 };
    const rx = base.y * up.z - base.z * up.y;
    const ry = base.z * up.x - base.x * up.z;
    const rz = base.x * up.y - base.y * up.x;
    const rl = Math.hypot(rx, ry, rz) || 1;
    const ux = rx / rl, uy = ry / rl, uz = rz / rl;
    const vx = uy * base.z - uz * base.y;
    const vy = uz * base.x - ux * base.z;
    const vz = ux * base.y - uy * base.x;

    const s = Math.sin(rad), c = Math.cos(rad);
    const ox = (ux * Math.cos(ang) + vx * Math.sin(ang)) * s;
    const oy = (uy * Math.cos(ang) + vy * Math.sin(ang)) * s;
    const oz = (uz * Math.cos(ang) + vz * Math.sin(ang)) * s;
    const dx = base.x * c + ox, dy = base.y * c + oy, dz = base.z * c + oz;
    const l = Math.hypot(dx, dy, dz) || 1;
    return { x: dx / l, y: dy / l, z: dz / l };
  }

  traceShot(shooter, origin, dir, rw, frame) {
    const MAX = 260;
    const wallHit = raycastWorld(this.world, origin, dir, MAX, { sightOnly: true });
    const wallT = wallHit ? wallHit.t : MAX;

    let bestT = wallT;
    let victim = null;
    let zone = null;

    const candidates = frame ? frame.players : [...this.players.values()].map((q) => ({
      id: q.id, team: q.team, pos: q.state.pos, yaw: q.state.yaw, height: q.state.height,
    }));

    for (const c of candidates) {
      if (c.id === shooter.id) continue;
      const other = this.players.get(c.id);
      if (!other || !other.alive) continue;
      if (this.mode.teams && other.team === shooter.team) continue;
      if (this.time < other.spawnProtectUntil) continue;
      const r = rayPlayer(origin, dir, c, bestT);
      if (r && r.t < bestT) { bestT = r.t; victim = other; zone = r.zone; }
    }

    const end = {
      x: origin.x + dir.x * bestT,
      y: origin.y + dir.y * bestT,
      z: origin.z + dir.z * bestT,
    };

    if (!victim) {
      if (wallHit) {
        this.pendingEvents.push({
          e: 'impact', p: r3(end), n: r3(wallHit.normal), m: wallHit.box.mat, g: !!wallHit.box.glass,
        });
      }
      return { end, victim: null, damage: 0, zone: null, dist: bestT };
    }

    const damage = damageAt(rw, bestT, HIT_MULTIPLIER[zone] || 1);
    return { end, victim, damage, zone, dist: bestT };
  }

  startReload(p) {
    const slot = p.weapons[p.slot];
    if (!slot || p.pendingReload) return;
    if (slot.mag >= slot.rw.mag || slot.reserve <= 0) return;
    const empty = slot.mag === 0;
    const dur = empty ? slot.rw.reloadEmpty : slot.rw.reload;
    p.pendingReload = { slot: p.slot, empty };
    p.reloadEnd = this.time + dur;
    p.burstLeft = 0;
    this.broadcastNear(p, { t: 'anim', id: p.id, a: 'reload', d: dur });
    this.send(p.client, { t: 'reloading', duration: dur, empty });
  }

  finishReload(p) {
    const info = p.pendingReload;
    p.pendingReload = null;
    if (!info) return;
    const slot = p.weapons[info.slot];
    if (!slot) return;
    if (slot.rw.shellReload) {
      // Shotguns top up one shell at a time; keep going until full or dry.
      const need = 1;
      const take = Math.min(need, slot.reserve, slot.rw.mag - slot.mag);
      slot.mag += take;
      slot.reserve -= take;
      if (slot.mag < slot.rw.mag && slot.reserve > 0 && (p.cmd.btn & BTN.FIRE) === 0) {
        this.startReload(p);
      }
    } else {
      const take = Math.min(slot.rw.mag - slot.mag, slot.reserve);
      slot.mag += take;
      slot.reserve -= take;
    }
  }

  switchSlot(p, slot) {
    if (slot !== 'primary' && slot !== 'secondary') return;
    if (slot === p.slot || this.time < p.switchEnd) return;
    p.slot = slot;
    p.pendingReload = null;
    p.burstLeft = 0;
    p.switchEnd = this.time + 0.45;
    this.broadcastNear(p, { t: 'anim', id: p.id, a: 'swap', d: 0.45 });
  }

  melee(p, cmd) {
    if (!p.alive || this.phase !== 'live') return;
    if (this.time < p.switchEnd) return;
    p.switchEnd = this.time + 0.6;
    const eye = eyePosition(p.state);
    const dir = dirFromAngles(cmd.yaw, cmd.pitch);
    this.broadcastNear(p, { t: 'anim', id: p.id, a: 'melee', d: 0.6 });

    let best = null, bestT = MELEE_RANGE;
    for (const other of this.players.values()) {
      if (other === p || !other.alive) continue;
      if (this.mode.teams && other.team === p.team) continue;
      const r = rayPlayer(eye, dir, {
        pos: other.state.pos, yaw: other.state.yaw, height: other.state.height,
      }, bestT);
      if (r && r.t < bestT) { bestT = r.t; best = other; }
    }
    if (best) {
      const back = this.isBehind(p, best);
      const killed = this.applyDamage(best, p, back ? 200 : MELEE_DAMAGE, 'melee', 'chest', bestT);
      this.send(p.client, { t: 'hitmark', zone: 'body', damage: back ? 200 : MELEE_DAMAGE, killed });
    }
  }

  isBehind(attacker, victim) {
    const vf = dirFromAngles(victim.state.yaw, 0);
    const dx = attacker.state.pos.x - victim.state.pos.x;
    const dz = attacker.state.pos.z - victim.state.pos.z;
    const l = Math.hypot(dx, dz) || 1;
    return (vf.x * dx + vf.z * dz) / l < -0.35;
  }

  // --------------------------------------------------------------- damage
  applyDamage(victim, attacker, amount, weaponId, zone, distance) {
    if (!victim.alive) return false;
    if (this.time < victim.spawnProtectUntil && attacker) return false;
    if (this.phase !== 'live') return false;

    const dmg = Math.max(0, amount);
    victim.health -= dmg;
    victim.lastDamageAt = this.time;

    if (attacker && attacker !== victim) {
      attacker.damage += Math.min(dmg, victim.health + dmg);
      const rec = victim.damagedBy.get(attacker.id) || { amount: 0, at: 0 };
      rec.amount += dmg;
      rec.at = this.time;
      victim.damagedBy.set(attacker.id, rec);
    }

    if (victim.client) {
      const from = attacker ? attacker.state.pos : victim.state.pos;
      this.send(victim.client, {
        t: 'hurt',
        hp: Math.max(0, Math.round(victim.health)),
        amount: Math.round(dmg),
        from: r3(from),
        by: attacker ? attacker.id : null,
        zone,
      });
    }

    if (victim.health <= 0) {
      this.killPlayer(victim, attacker, weaponId, zone, distance);
      return true;
    }
    return false;
  }

  killPlayer(victim, attacker, weaponId, zone, distance) {
    victim.alive = false;
    victim.health = 0;
    victim.deaths++;
    victim.streak = 0;
    victim.respawnAt = this.time + MATCH.respawnDelay;
    victim.pendingReload = null;

    const assists = [];
    for (const [id, rec] of victim.damagedBy) {
      if (attacker && id === attacker.id) continue;
      if (this.time - rec.at > 8) continue;
      const a = this.players.get(id);
      if (a) { a.assists++; a.score += 1; assists.push({ id: a.id, name: a.name, banner: a.banner }); }
    }
    victim.damagedBy.clear();

    if (this.mode.flags) this.dropFlag(victim);

    let promoted = false;
    if (attacker && attacker !== victim) {
      attacker.kills++;
      attacker.streak++;
      attacker.bestStreak = Math.max(attacker.bestStreak, attacker.streak);
      attacker.score += this.mode.ladder ? 1 : (zone === 'head' ? 2 : 1);
      if (this.mode.ladder) {
        attacker.ggIndex++;
        if (attacker.ggIndex >= GUNGAME_LADDER.length) {
          this.addScore(attacker, 0);
          this.endMatch({ kind: 'player', player: attacker });
          return;
        }
        this.equipLoadout(attacker);
        promoted = true;
        this.send(attacker.client, { t: 'promote', index: attacker.ggIndex, weapon: GUNGAME_LADDER[attacker.ggIndex] });
      }
      this.addScore(attacker, 1);
    } else {
      // Suicide or fall damage.
      if (this.mode.teams && victim.team >= 0) {
        this.scores[victim.team] = Math.max(0, this.scores[victim.team]);
      }
      victim.score = Math.max(0, victim.score - 1);
    }

    const payload = {
      t: 'kill',
      killer: attacker && attacker !== victim ? this.brief(attacker) : null,
      victim: this.brief(victim),
      weapon: weaponId,
      zone,
      headshot: zone === 'head',
      distance: Math.round(distance || 0),
      streak: attacker ? attacker.streak : 0,
      assists,
      promoted,
      wallbang: false,
      scores: this.scores,
    };
    this.broadcast(payload);

    if (attacker && attacker !== victim && attacker.streak >= 3) {
      this.broadcast({ t: 'streak', id: attacker.id, name: attacker.name, banner: attacker.banner, count: attacker.streak });
    }

    this.checkWin();
  }

  brief(p) {
    return { id: p.id, name: p.name, banner: p.banner, level: p.level, team: p.team, bot: !!p.bot };
  }

  addScore(p, n) {
    if (this.mode.teams && p.team >= 0) this.scores[p.team] += n;
    else if (!this.mode.teams) this.scores[0] = Math.max(this.scores[0], p.score);
  }

  // -------------------------------------------------------------- respawn
  assignSpawns() {
    for (const p of this.players.values()) {
      const sp = this.pickSpawn(p);
      p.state = createPlayerState(sp);
      p.introSpawn = sp;
    }
  }

  pickSpawn(p) {
    const all = this.mapData.spawns;
    const teamSpawns = this.mode.teams && p.team >= 0
      ? all.filter((s) => s.team === p.team)
      : all.filter((s) => s.team === -1);
    const pool = teamSpawns.length ? teamSpawns : all;

    // Prefer the spawn furthest from the nearest visible enemy.
    let best = pool[0], bestScore = -Infinity;
    for (const s of pool) {
      const sp = { x: s.p[0], y: s.p[1] + 1.2, z: s.p[2] };
      let score = Math.random() * 6;
      for (const q of this.players.values()) {
        if (q === p || !q.alive) continue;
        const hostile = !this.mode.teams || q.team !== p.team;
        const d = vdist(sp, q.state.pos);
        if (!hostile) { score += clamp(24 - d, 0, 10) * 0.15; continue; }
        score += Math.min(d, 60) * 0.5;
        if (d < 18 && hasLineOfSight(this.world, sp, eyePosition(q.state))) score -= 220;
        else if (d < 10) score -= 90;
      }
      if (score > bestScore) { bestScore = score; best = s; }
    }
    return best;
  }

  respawn(p, initial = false) {
    if (p.pendingLoadout) { p.loadout = p.pendingLoadout; p.pendingLoadout = null; }
    const sp = this.pickSpawn(p);
    p.state = createPlayerState(sp);
    p.alive = true;
    p.health = PLAYER.maxHealth;
    p.respawnAt = 0;
    p.spawnProtectUntil = this.time + (initial ? MATCH.warmupDuration + PLAYER.spawnProtection : PLAYER.spawnProtection);
    p.damagedBy.clear();
    p.pendingReload = null;
    p.burstLeft = 0;
    p.lastFireTime = -99;
    p.switchEnd = 0;
    this.equipLoadout(p);
    if (p.bot) p.bot.onSpawn();
    this.send(p.client, {
      t: 'spawn',
      pos: r3(p.state.pos),
      yaw: p.state.yaw,
      protectedFor: p.spawnProtectUntil - this.time,
      loadout: {
        primary: { ...p.weapons.primary.cfg, mag: p.weapons.primary.mag, reserve: p.weapons.primary.reserve },
        secondary: { ...p.weapons.secondary.cfg, mag: p.weapons.secondary.mag, reserve: p.weapons.secondary.reserve },
      },
    });
  }

  // ----------------------------------------------------------------- mode
  initObjectives() {
    const st = { points: [], flags: [] };
    for (const o of getMap(this.mapId || 'oldquarter').objectives) {
      if (o.kind === 'capture') st.points.push({ id: o.id, name: o.name, p: o.p, radius: o.radius, owner: -1, progress: 0, contested: false });
      if (o.kind === 'flag') st.flags.push({ id: o.id, team: o.team, home: o.p, p: [...o.p], carrier: null, dropped: 0 });
    }
    return st;
  }

  stepMode(dt) {
    if (this.mode.capture) this.stepDomination(dt);
    if (this.mode.flags) this.stepCTF(dt);
  }

  stepDomination(dt) {
    let owned = [0, 0];
    for (const pt of this.objectiveState.points) {
      const centre = { x: pt.p[0], y: pt.p[1], z: pt.p[2] };
      const counts = [0, 0];
      for (const p of this.players.values()) {
        if (!p.alive || p.team < 0) continue;
        const d = Math.hypot(p.state.pos.x - centre.x, p.state.pos.z - centre.z);
        if (d <= pt.radius && Math.abs(p.state.pos.y - centre.y) < 4.0) counts[p.team]++;
      }
      pt.contested = counts[0] > 0 && counts[1] > 0;
      const lead = counts[0] > counts[1] ? 0 : counts[1] > counts[0] ? 1 : -1;

      if (lead >= 0) {
        const rate = 0.30 * Math.min(3, Math.abs(counts[0] - counts[1]));
        if (pt.owner === lead) pt.progress = Math.min(1, pt.progress + rate * dt);
        else {
          pt.progress -= rate * dt;
          if (pt.progress <= 0) { pt.owner = lead; pt.progress = 0; this.onCapture(pt, lead); }
        }
      }
      if (pt.owner >= 0) owned[pt.owner]++;
    }

    this.domAccum = (this.domAccum || 0) + dt;
    const interval = this.mode.tickInterval || 2;
    while (this.domAccum >= interval) {
      this.domAccum -= interval;
      for (const team of [0, 1]) {
        const gain = owned[team];
        if (gain > 0 && owned[team] > owned[1 - team]) this.scores[team] += gain;
        else if (gain > 0) this.scores[team] += Math.max(1, gain - 1);
      }
      this.checkWin();
    }
  }

  onCapture(pt, team) {
    this.broadcast({ t: 'capture', point: pt.id, name: pt.name, team });
    for (const p of this.players.values()) {
      if (p.team !== team || !p.alive) continue;
      const d = Math.hypot(p.state.pos.x - pt.p[0], p.state.pos.z - pt.p[2]);
      if (d <= pt.radius + 2) { p.score += 5; }
    }
  }

  stepCTF() {
    for (const flag of this.objectiveState.flags) {
      if (flag.carrier) {
        const carrier = this.players.get(flag.carrier);
        if (!carrier || !carrier.alive) { this.dropFlagObject(flag); continue; }
        flag.p = [carrier.state.pos.x, carrier.state.pos.y + 1.0, carrier.state.pos.z];

        // Scoring: bring the enemy flag to your own, which must be home.
        const own = this.objectiveState.flags.find((f) => f.team === carrier.team);
        if (own && !own.carrier && dist2(own.p, own.home) < 1.5) {
          const d = Math.hypot(flag.p[0] - own.home[0], flag.p[2] - own.home[2]);
          if (d < 2.6 && Math.abs(flag.p[1] - own.home[1]) < 3) {
            this.scores[carrier.team]++;
            carrier.score += 10;
            flag.carrier = null;
            carrier.hasFlag = null;   // without this the carrier stays "loaded" forever
            flag.p = [...flag.home];
            this.broadcast({ t: 'flagcap', team: carrier.team, by: this.brief(carrier), scores: this.scores });
            this.checkWin();
          }
        }
        continue;
      }

      for (const p of this.players.values()) {
        if (!p.alive || p.team < 0) continue;
        const d = Math.hypot(p.state.pos.x - flag.p[0], p.state.pos.z - flag.p[2]);
        if (d > 1.8 || Math.abs(p.state.pos.y - flag.p[1]) > 2.4) continue;

        if (p.team === flag.team) {
          if (dist2(flag.p, flag.home) > 1.5) {
            flag.p = [...flag.home];
            p.score += 3;
            this.broadcast({ t: 'flagreturn', team: flag.team, by: this.brief(p) });
          }
        } else if (!p.hasFlag) {
          flag.carrier = p.id;
          p.hasFlag = flag.id;
          this.broadcast({ t: 'flagtake', team: flag.team, by: this.brief(p) });
        }
        break;
      }
    }
  }

  dropFlag(p) {
    if (!p.hasFlag) return;
    const flag = this.objectiveState.flags.find((f) => f.id === p.hasFlag);
    p.hasFlag = null;
    if (flag) this.dropFlagObject(flag);
  }

  dropFlagObject(flag) {
    const carrier = flag.carrier ? this.players.get(flag.carrier) : null;
    flag.carrier = null;
    if (carrier) {
      flag.p = [carrier.state.pos.x, carrier.state.pos.y + 0.4, carrier.state.pos.z];
      carrier.hasFlag = null;
    }
    this.broadcast({ t: 'flagdrop', team: flag.team, p: flag.p });
  }

  checkWin() {
    const limit = this.mode.scoreLimit;
    if (!limit) return;
    if (this.mode.teams) {
      for (const team of [0, 1]) {
        if (this.scores[team] >= limit) return this.endMatch({ kind: 'team', team });
      }
    } else {
      let leader = null;
      for (const p of this.players.values()) {
        if (!leader || p.score > leader.score) leader = p;
      }
      if (leader && leader.score >= limit) return this.endMatch({ kind: 'player', player: leader });
    }
  }

  timeoutWinner() {
    if (this.mode.teams) {
      if (this.scores[0] === this.scores[1]) return { kind: 'draw' };
      return { kind: 'team', team: this.scores[0] > this.scores[1] ? 0 : 1 };
    }
    let leader = null;
    for (const p of this.players.values()) {
      if (!leader || p.score > leader.score || (p.score === leader.score && p.kills > leader.kills)) leader = p;
    }
    return leader ? { kind: 'player', player: leader } : { kind: 'draw' };
  }

  endMatch(result) {
    if (this.phase === 'outro') return;

    const board = [...this.players.values()]
      .sort((a, b) => b.score - a.score || b.kills - a.kills || a.deaths - b.deaths)
      .map((p) => ({
        ...this.brief(p),
        kills: p.kills, deaths: p.deaths, assists: p.assists,
        score: p.score, damage: Math.round(p.damage), headshots: p.headshots,
        streak: p.bestStreak,
        xp: this.xpFor(p, result),
      }));

    const mvp = board[0] || null;
    let winnerBanner = null, winnerName = null, fanfare = null, winnerTeam = null;

    if (result.kind === 'team') {
      winnerTeam = result.team;
      const squad = [...this.players.values()].filter((p) => p.team === result.team);
      const star = squad.sort((a, b) => b.score - a.score)[0];
      if (star) { winnerBanner = star.banner; winnerName = star.name; fanfare = star.fanfare; }
    } else if (result.kind === 'player') {
      winnerBanner = result.player.banner;
      winnerName = result.player.name;
      fanfare = result.player.fanfare;
    }

    this.broadcast({
      t: 'match.end',
      result: result.kind,
      winnerTeam,
      winner: result.kind === 'player' ? this.brief(result.player) : null,
      winnerName,
      winnerBanner,
      fanfare,
      mvp,
      scores: this.scores,
      board,
      outro: MATCH.outroDuration,
    });

    for (const p of this.players.values()) {
      p.alive = false;
      p.hasFlag = null;
    }
    this.setPhase('outro', MATCH.outroDuration);
  }

  xpFor(p, result) {
    let xp = 40;
    xp += p.kills * 100 + p.assists * 40 + Math.round(p.damage * 0.5) + p.headshots * 25;
    xp += p.bestStreak * 20;
    const won = result.kind === 'team'
      ? p.team === result.team
      : result.kind === 'player' && result.player === p;
    if (won) xp = Math.round(xp * 1.5) + 250;
    return xp;
  }

  // ------------------------------------------------------------ transport
  send(client, msg) {
    if (client) this.hub.send(client, msg);
  }

  broadcast(msg) {
    const raw = JSON.stringify(msg);
    for (const p of this.players.values()) {
      if (p.client && p.client.ws.readyState === 1) {
        try { p.client.ws.send(raw); } catch { /* socket dying */ }
      }
    }
  }

  /** Same as broadcast for now; kept so audio events can be culled later. */
  broadcastNear(_p, msg) { this.broadcast(msg); }

  sendSnapshots() {
    const events = this.pendingEvents;
    this.pendingEvents = [];

    const entities = [];
    for (const p of this.players.values()) {
      const s = p.state;
      let flags = 0;
      if (p.alive) flags |= 1;
      if (s.crouching) flags |= 2;
      if (s.sprinting) flags |= 4;
      if (p.cmd.btn & BTN.ADS) flags |= 8;
      if (p.pendingReload) flags |= 16;
      if (s.sliding) flags |= 32;
      if (!s.onGround) flags |= 64;
      if (p.hasFlag) flags |= 128;
      entities.push([
        p.id,
        round2(s.pos.x), round2(s.pos.y), round2(s.pos.z),
        round3(s.yaw), round3(s.pitch),
        round2(s.height),
        flags, p.team,
        p.weapons[p.slot]?.rw.id || 'r4c',
        round2(s.lean),
      ]);
    }

    const objectives = this.mode.capture
      ? this.objectiveState.points.map((pt) => [pt.id, pt.owner, round2(pt.progress), pt.contested ? 1 : 0])
      : this.mode.flags
        ? this.objectiveState.flags.map((f) => [f.id, f.team, r3({ x: f.p[0], y: f.p[1], z: f.p[2] }), f.carrier])
        : null;

    for (const p of this.players.values()) {
      if (!p.client || p.client.ws.readyState !== 1) continue;
      const slot = p.weapons[p.slot];
      const msg = {
        t: 'snap',
        k: this.tickNo,
        tm: round3(this.time),
        ack: p.ackSeq,
        you: {
          s: {
            px: round3(p.state.pos.x), py: round3(p.state.pos.y), pz: round3(p.state.pos.z),
            vx: round3(p.state.vel.x), vy: round3(p.state.vel.y), vz: round3(p.state.vel.z),
            h: round3(p.state.height),
            g: p.state.onGround ? 1 : 0,
            sl: p.state.sliding ? 1 : 0,
          },
          hp: Math.max(0, Math.round(p.health)),
          alive: p.alive,
          respawnIn: p.alive ? 0 : Math.max(0, round2(p.respawnAt - this.time)),
          slot: p.slot,
          mag: slot?.mag ?? 0,
          reserve: slot?.reserve ?? 0,
          weapon: slot?.rw.id,
          reloading: p.pendingReload ? round2(p.reloadEnd - this.time) : 0,
          score: p.score, kills: p.kills, deaths: p.deaths, assists: p.assists,
          streak: p.streak,
          zone: p.zone,
          protectedFor: Math.max(0, round2(p.spawnProtectUntil - this.time)),
        },
        p: entities,
        ev: events,
        o: objectives,
        sc: this.scores,
        rem: Math.max(0, round2(this.phaseEnds - this.time)),
      };
      try { p.client.ws.send(JSON.stringify(msg)); } catch { /* socket dying */ }
    }
  }

  // -------------------------------------------------------------- inbound
  onMessage(client, msg) {
    const p = this.players.get(client.id);
    if (!p) return;

    switch (msg.t) {
      case 'input': {
        if (!Array.isArray(msg.i)) return;
        for (const raw of msg.i.slice(-16)) {
          if (!Array.isArray(raw) || raw.length < 4) continue;
          const [seq, btn, yaw, pitch] = raw;
          if (!Number.isFinite(seq) || seq <= p.lastSeq) continue;
          if (!Number.isFinite(yaw) || !Number.isFinite(pitch)) continue;
          p.lastSeq = seq;
          p.inputQueue.push({ seq, btn: btn | 0, yaw, pitch });
        }
        if (p.inputQueue.length > 24) p.inputQueue.splice(0, p.inputQueue.length - 24);
        break;
      }
      case 'reload': this.startReload(p); break;
      case 'switch': this.switchSlot(p, msg.slot); break;
      case 'melee': this.melee(p, p.cmd); break;
      case 'chat': {
        const text = String(msg.text || '').slice(0, 120).trim();
        if (!text) return;
        this.broadcast({ t: 'chat', from: p.id, name: p.name, banner: p.banner, team: p.team, text });
        break;
      }
      case 'loadout': {
        p.pendingLoadout = sanitizeLoadout(msg.loadout);
        this.send(client, { t: 'loadout.ok', appliesOnRespawn: p.alive });
        if (!p.alive) { p.loadout = p.pendingLoadout; p.pendingLoadout = null; }
        break;
      }
      default: break;
    }
  }
}

// --- helpers ------------------------------------------------------------
const round2 = (n) => Math.round(n * 100) / 100;
const round3 = (n) => Math.round(n * 1000) / 1000;
const r3 = (v) => [round2(v.x), round2(v.y), round2(v.z)];
const dist2 = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
