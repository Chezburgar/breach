// A single match: authoritative simulation, lag-compensated hitscan, mode rules.

import {
  FIXED_DT, INTERP_DELAY, MATCH, MAX_ROLLBACK, PLAYER, SNAPSHOT_DT,
  BTN, HIT_MULTIPLIER, TEAM_INFO,
} from '../constants.js';
import { buildWorld, raycastWorld, rayPlayer, raySphere, hasLineOfSight } from '../collision.js';
import { createPlayerState, stepPlayer, eyePosition } from '../controller.js';
import { getMap } from '../maps/index.js';
import { zoneAt } from '../maps/builder.js';
import {
  createCashoutState, stepCashout, tryPickup, tryDeposit, cashResult, CASH,
} from './cashout.js';
import { getMode } from '../modes.js';
import {
  resolveWeapon, currentSpread, damageAt, getWeapon, sanitizeLoadout,
} from '../weapons.js';
import {
  GRENADE_COOLDOWN, GRENADE_GRAVITY, getGrenade, fragDamage, flashBlind,
} from '../grenades.js';
import { clamp, dirFromAngles, hashString, makeRng, vdist, vnorm, vsub } from '../mathx.js';
import { DRONE, createDrone, stepDrone, droneEye, scanTarget } from '../drone.js';
import { buildNavGraph } from './nav.js';
import { Bot, BOT_NAMES } from './bots.js';

// Monotonic seconds. performance.now() exists in both Node and the browser,
// which is what lets this simulation run on either side.
const now = () => performance.now() / 1000;

const HISTORY_TICKS = 48;      // ~0.8s of rewind material
const MELEE_RANGE = 2.4;
const MELEE_DAMAGE = 55;

export class GameRoom {
  constructor(hub, { id, mode, mapId, isPrivate, botCount }) {
    this.hub = hub;
    this.id = id;
    this.mode = getMode(mode);
    this.mapId = mapId || 'estate';
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
    // Sized by the mode: Breach is a pair, Cashout is four crews.
    this.teamCount = this.mode.teams ? (this.mode.teamCount || 2) : 0;
    this.scores = new Array(Math.max(2, this.teamCount)).fill(0);
    this.teamCounts = new Array(Math.max(2, this.teamCount)).fill(0);
    this.cash = this.mode.cashout ? createCashoutState(this.mode, this.mapData) : null;
    this.snapAccum = 0;
    this.pendingEvents = [];
    this.disposed = false;
    this.emptySince = 0;

    // Round state. `scores` holds rounds won, not eliminations.
    this.roundNo = 0;
    this.roundEndsAt = 0;
    this.lastRoundWinner = -1;
    this.roundLog = [];

    this.projectiles = [];
    this.smokes = [];
    this.projectileSeq = 0;
    this.droneSeq = 0;
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
      roundsToWin: this.mode.roundsToWin,
      maxRounds: this.mode.maxRounds,
      roundTime: this.mode.roundTime,
      cashGoal: this.mode.cashGoal || 0,
      objectives: this.mode.cashout ? this.mapData.objectives : null,
      intro: MATCH.introDuration,
      players: roster,
    });
    this.pushPhase();

    this.last = now();
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
    const t = now();
    let dt = t - this.last;
    this.last = t;
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
  /**
   * Change mode before the match starts, rebuilding everything that was sized
   * from the old one. Team count, score arrays and the objective state are all
   * mode-shaped, and the lobby picks the mode long after the room exists.
   */
  setMode(id) {
    const next = getMode(id);
    if (next === this.mode) return;
    this.mode = next;
    this.teamCount = next.teams ? (next.teamCount || 2) : 0;
    const width = Math.max(2, this.teamCount);
    this.scores = new Array(width).fill(0);
    this.teamCounts = new Array(width).fill(0);
    this.cash = next.cashout ? createCashoutState(next, this.mapData) : null;
    // Re-seat everyone: a four-crew mode cannot run with people still holding
    // team ids handed out when there were only two.
    const list = [...this.players.values()];
    for (const p of list) p.team = -1;
    for (const p of list) {
      p.team = next.teams ? this.nextPartyTeam() : -1;
      if (p.team >= 0) this.teamCounts[p.team]++;
    }
  }

  /** The emptiest crew — the only sane way to place someone across four. */
  nextPartyTeam() {
    let best = 0;
    for (let t = 1; t < this.teamCount; t++) {
      if (this.teamCounts[t] < this.teamCounts[best]) best = t;
    }
    return best;
  }

  /** How many bots to add so every crew is full. */
  fillTarget() {
    return this.mode.teams ? this.teamCount * this.mode.teamSize : this.mode.maxPlayers;
  }

  addClient(client, forcedTeam) {
    if (client.room) client.room.removeClient(client, 'switched');
    const team = this.mode.teams ? (forcedTeam ?? this.nextPartyTeam()) : -1;
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
        roundsToWin: this.mode.roundsToWin,
        maxRounds: this.mode.maxRounds,
        roundTime: this.mode.roundTime,
        intro: 0,
        players: this.roster(),
        joinInProgress: true,
      });
      // Late arrivals sit out the round in progress and deploy with the next.
      p.alive = false;
      p.spectating = true;
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
      spectating: false,
      spectateTarget: null,
      grenades: { frag: 1, flash: 1, smoke: 1 },
      grenadeCooldown: 0,
      drone: null,          // the machine, while it is alive
      droneUsed: false,     // one per operator per round
      piloting: false,      // driving it, body left standing
      markedUntil: 0,       // painted by an enemy scan until this time
      markedBy: -1,         // which team can see the mark
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
    p.weapons = { primary: build(p.loadout.primary), secondary: build(p.loadout.secondary) };
    p.slot = 'primary';
    p.grenades = { frag: 1, flash: 1, smoke: 1 };
    p.grenadeCooldown = 0;
  }

  fillBots() {
    const want = this.botCount;
    const used = new Set([...this.players.values()].map((p) => p.name));
    for (let i = 0; i < want; i++) {
      const name = BOT_NAMES.find((n) => !used.has(n)) || `Bot${i}`;
      used.add(name);
      const team = this.mode.teams ? this.nextPartyTeam() : -1;
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
    const left = Math.max(0, this.phaseEnds - this.time);
    return {
      t: 'phase',
      phase: this.phase,
      remaining: left,
      // The round clock. Never sent before, so the HUD read it as undefined
      // and showed --:-- for the whole round. While the round is live it is
      // the same countdown as the phase; before it starts it is the length
      // of the round about to be played.
      matchTime: this.phase === 'live' ? left : this.mode.roundTime,
      scores: this.scores,
      round: this.roundNo,
      alive: this.aliveByTeam(),
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
          if (this.mode.cashout) this.startCashout();
          else this.startRound();
        }
        break;
      case 'freeze':
        // Everyone is alive and placed; movement is locked until the buzzer.
        if (this.time >= this.phaseEnds) {
          this.setPhase('live', this.mode.cashout ? this.mode.matchTime : this.mode.roundTime);
          this.broadcast({ t: 'round.live', round: this.roundNo });
        }
        break;
      case 'live':
        if (this.mode.cashout) {
          // No rounds: the match runs until the clock or the cash goal.
          if (this.time >= this.phaseEnds) this.endMatch(this.matchResult());
        } else if (this.time >= this.phaseEnds) {
          this.finishRound(this.roundTimeoutWinner(), 'time');
        }
        break;
      case 'roundend':
        if (this.time >= this.phaseEnds) {
          if (this.matchDecided()) this.endMatch(this.matchResult());
          else this.startRound();
        }
        break;
      case 'outro':
        // The match rests here while everyone decides whether to play again.
        // Tearing the room down on a timer would yank the victory screen away
        // mid-decision; the host's session rebuilds or disposes it instead.
        break;
      default: break;
    }

    const live = this.phase === 'live';
    const frozen = this.phase !== 'live';

    for (const p of this.players.values()) {
      if (p.bot) p.bot.think(dt, live);
      if (!p.alive) continue;   // no respawns inside a round — you spectate

      // Driving the drone leaves the body standing still and defenceless;
      // the operator cannot be in two places at once.
      const cmd = p.piloting
        ? { seq: p.cmd.seq, btn: 0, yaw: p.cmd.yaw, pitch: p.cmd.pitch }
        : this.nextCommand(p, frozen);
      stepPlayer(p.state, cmd, this.world, FIXED_DT);

      if (p.state.fallDamage > 0 && live) {
        this.applyDamage(p, null, p.state.fallDamage, 'fall', 'limb', 0);
      }

      this.stepWeapon(p, cmd, dt, live);
      this.stepHealth(p, dt);

      const z = zoneAt(this.mapData, p.state.pos);
      if (z !== p.zone) p.zone = z;
    }

    this.stepDrones(dt, live);
    if (live && this.mode.cashout) this.stepCashoutRound(dt);
    if (live) this.stepProjectiles(dt);
    if (this.smokes.length) {
      this.smokes = this.smokes.filter((s) => this.time < s.until);
    }

    this.recordHistory();
    if (live && !this.mode.cashout) this.checkRoundEnd();

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

    // A drone in the way eats the round before anything else does.
    if (this.hitDrone(shooter, origin, dir, bestT)) {
      return { end: origin, victim: null, damage: 0, zone: null, dist: 0 };
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

    // Everyone near the hit sees and hears it, not just the shooter — a round
    // going into someone is the loudest thing in a fight and it had no world
    // event at all.
    this.pendingEvents.push({ e: 'flesh', p: r3(end), z: zone });

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
    // Cashout puts you back in; Breach does not, and that difference is the
    // whole reason the two modes feel nothing alike.
    victim.respawnAt = this.mode.respawn ? this.time + this.mode.respawnDelay : 0;
    victim.pendingReload = null;
    victim.spectating = true;
    // Spectate whoever on your side is still up.
    const mate = [...this.players.values()].find(
      (q) => q.alive && q.team === victim.team && q !== victim
    );
    victim.spectateTarget = mate ? mate.id : null;

    const assists = [];
    for (const [id, rec] of victim.damagedBy) {
      if (attacker && id === attacker.id) continue;
      if (this.time - rec.at > 8) continue;
      const a = this.players.get(id);
      if (a) { a.assists++; a.score += 1; assists.push({ id: a.id, name: a.name, banner: a.banner }); }
    }
    victim.damagedBy.clear();

    if (attacker && attacker !== victim) {
      attacker.kills++;
      attacker.streak++;
      attacker.bestStreak = Math.max(attacker.bestStreak, attacker.streak);
      attacker.score += zone === 'head' ? 2 : 1;
    } else {
      victim.score = Math.max(0, victim.score - 1);
    }

    // Anyone now spectating the person who just died follows someone else.
    for (const q of this.players.values()) {
      if (q.spectateTarget === victim.id) q.spectateTarget = this.pickSpectateTarget(q);
    }

    this.broadcast({
      t: 'kill',
      killer: attacker && attacker !== victim ? this.brief(attacker) : null,
      victim: this.brief(victim),
      weapon: weaponId,
      zone,
      headshot: zone === 'head',
      distance: Math.round(distance || 0),
      streak: attacker ? attacker.streak : 0,
      assists,
      scores: this.scores,
      alive: this.aliveByTeam(),
    });

    if (attacker && attacker !== victim && attacker.streak >= 3) {
      this.broadcast({ t: 'streak', id: attacker.id, name: attacker.name, banner: attacker.banner, count: attacker.streak });
    }
  }

  brief(p) {
    return {
      id: p.id, name: p.name, banner: p.banner, fanfare: p.fanfare,
      level: p.level, team: p.team, bot: !!p.bot,
    };
  }


  // ---------------------------------------------------------------- drones
  /**
   * Put the drone on the ground in front of the operator and hand them the
   * controls. Their body stays exactly where it is and stays shootable —
   * that is the whole cost of using it.
   */
  deployDrone(p) {
    if (!p.alive || this.phase !== 'live') return;
    if (p.droneUsed || p.drone) return;

    const eye = eyePosition(p.state);
    const dir = dirFromAngles(p.cmd.yaw, 0);
    const at = {
      x: eye.x + dir.x * DRONE.deployRange,
      y: p.state.pos.y + 0.4,
      z: eye.z + dir.z * DRONE.deployRange,
    };
    // Do not push it into a wall; drop it at the operator's feet instead.
    const clear = raycastWorld(this.world, { x: eye.x, y: at.y, z: eye.z },
      { x: dir.x, y: 0, z: dir.z }, DRONE.deployRange + DRONE.radius);
    if (clear) { at.x = p.state.pos.x; at.z = p.state.pos.z; }

    p.drone = createDrone(`d${++this.droneSeq}`, p, at, p.cmd.yaw);
    p.droneUsed = true;
    p.piloting = true;
    this.send(p.client, {
      t: 'drone.start', id: p.drone.id, scanCooldown: DRONE.scanCooldown,
      yaw: p.drone.yaw, pitch: 0,
    });
    this.broadcast({ t: 'drone.spawn', id: p.drone.id, owner: p.id, team: p.team });
  }

  /**
   * Step back into a drone that is already out there. It stays wherever it
   * rolled to, which is the whole point of leaving it somewhere useful.
   */
  enterDrone(p) {
    if (!p.alive || this.phase !== 'live') return;
    const d = p.drone;
    if (!d || !d.alive || p.piloting) return;
    p.piloting = true;
    d.cmd = { btn: 0, yaw: d.yaw, pitch: d.pitch };
    this.send(p.client, {
      t: 'drone.start', id: d.id, scanCooldown: DRONE.scanCooldown,
      yaw: d.yaw, pitch: d.pitch,
    });
  }

  /** Put the controller down. The drone stays parked where it is. */
  exitDrone(p) {
    if (!p.piloting) return;
    p.piloting = false;
    if (p.drone) p.drone.cmd = { btn: 0, yaw: p.drone.yaw, pitch: p.drone.pitch };
    this.send(p.client, { t: 'drone.end', parked: true });
  }

  /** Destroy it. There is no recall — only a bullet takes it off the board. */
  killDrone(p, byOwner) {
    const d = p.drone;
    p.piloting = false;
    if (!d) return;
    p.drone = null;
    d.alive = false;
    this.broadcast({
      t: 'drone.down', id: d.id, owner: p.id,
      p: [round2(d.pos.x), round2(d.pos.y), round2(d.pos.z)],
      recalled: !!byOwner,
    });
    if (p.client) this.send(p.client, { t: 'drone.end', recalled: !!byOwner });
  }

  stepDrones(dt, live) {
    for (const p of this.players.values()) {
      const d = p.drone;
      if (!d || !d.alive) continue;

      // Nobody driving — because the pilot stepped out, or died, or the
      // round is not live — parks it. It stays exactly where it stopped and
      // waits to be picked up again.
      if (!p.alive || !live || !p.piloting) {
        if (!p.alive || !live) p.piloting = false;
        d.cmd = { btn: 0, yaw: d.yaw, pitch: d.pitch };
      }
      stepDrone(d, d.cmd, this.world, dt);
    }
  }

  /**
   * Paint whatever the drone is looking at. The mark is a team asset: it goes
   * to everyone on the pilot's side, through walls, and expires on its own.
   */
  droneScan(p) {
    const d = p.drone;
    if (!d || !d.alive || !p.piloting || this.phase !== 'live') return;
    if (this.time < d.scanReadyAt) return;
    d.scanReadyAt = this.time + DRONE.scanCooldown;

    const target = scanTarget(d, this.players.values(), this.world);
    this.broadcast({
      t: 'drone.scan', id: d.id, hit: !!target,
      p: [round2(d.pos.x), round2(d.pos.y), round2(d.pos.z)],
    });
    if (!target) return;

    target.markedUntil = this.time + DRONE.markDuration;
    target.markedBy = p.team;
    this.send(p.client, { t: 'drone.mark', id: target.id, name: target.name, duration: DRONE.markDuration });
  }

  /** Marks visible to a team, for the snapshot. */
  marksFor(team) {
    const out = [];
    for (const q of this.players.values()) {
      if (!q.alive || q.markedUntil <= this.time || q.markedBy !== team) continue;
      out.push(q.id);
    }
    return out;
  }

  /** Drones as snapshot entities. */
  droneSnapshot() {
    const out = [];
    for (const p of this.players.values()) {
      const d = p.drone;
      if (!d || !d.alive) continue;
      out.push([
        d.id, p.id, d.team,
        round2(d.pos.x), round2(d.pos.y), round2(d.pos.z),
        round3(d.yaw), round3(d.pitch),
      ]);
    }
    return out;
  }

  /**
   * A drone in the path of a shot. One round ends it, whatever hit it —
   * it is a camera on wheels, not a vehicle.
   * @returns {boolean} true if the shot was stopped by a drone
   */
  hitDrone(shooter, origin, dir, maxT) {
    let best = null, bestT = maxT;
    for (const p of this.players.values()) {
      const d = p.drone;
      if (!d || !d.alive) continue;
      if (this.mode.teams && d.team === shooter.team && p.id !== shooter.id) continue;
      const t = raySphere(
        origin.x, origin.y, origin.z, dir.x, dir.y, dir.z,
        d.pos.x, d.pos.y + DRONE.height * 0.5, d.pos.z, DRONE.radius * 1.35
      );
      if (t != null && t >= 0 && t < bestT) { bestT = t; best = p; }
    }
    if (!best) return false;
    this.pendingEvents.push({
      e: 'impact',
      p: [round2(origin.x + dir.x * bestT), round2(origin.y + dir.y * bestT), round2(origin.z + dir.z * bestT)],
      n: [-dir.x, -dir.y, -dir.z], m: 'metal', g: false,
    });
    this.killDrone(best, false);
    return true;
  }

  // ------------------------------------------------------------- grenades
  throwGrenade(p, kind, charge = 1) {
    if (!p.alive || this.phase !== 'live') return;
    if (this.time < p.grenadeCooldown) return;
    const def = getGrenade(kind);

    // Throwables are not consumable. The cooldown is the entire limit, so a
    // round never ends with somebody holding a flash they were saving.
    p.grenadeCooldown = this.time + GRENADE_COOLDOWN;

    const eye = eyePosition(p.state);
    const dir = dirFromAngles(p.cmd.yaw, p.cmd.pitch);
    const power = def.throwSpeed * clamp(charge, 0.35, 1);

    const proj = {
      id: `g${this.projectileSeq = (this.projectileSeq || 0) + 1}`,
      kind: def.id,
      owner: p.id,
      team: p.team,
      pos: { x: eye.x + dir.x * 0.4, y: eye.y + dir.y * 0.4, z: eye.z + dir.z * 0.4 },
      // Inherit a little of the thrower's momentum, plus a slight upward arc.
      vel: {
        x: dir.x * power + p.state.vel.x * 0.35,
        y: dir.y * power + 2.2 + p.state.vel.y * 0.2,
        z: dir.z * power + p.state.vel.z * 0.35,
      },
      fuse: def.fuse,
      rest: 0,
    };
    this.projectiles.push(proj);

    this.broadcast({
      t: 'grenade.throw', id: proj.id, kind: def.id, by: p.id, team: p.team,
      p: r3(proj.pos), v: r3(proj.vel), fuse: def.fuse,
    });
    this.send(p.client, { t: 'grenade.used', kind: def.id, cooldown: GRENADE_COOLDOWN });
  }

  stepProjectiles(dt) {
    if (!this.projectiles.length) return;
    for (let i = this.projectiles.length - 1; i >= 0; i--) {
      const g = this.projectiles[i];
      const def = getGrenade(g.kind);

      g.vel.y -= GRENADE_GRAVITY * dt;

      // Sweep so a fast grenade cannot tunnel through a wall.
      let remaining = dt;
      let guard = 0;
      while (remaining > 1e-4 && guard++ < 4) {
        const step = { x: g.vel.x * remaining, y: g.vel.y * remaining, z: g.vel.z * remaining };
        const dist = Math.hypot(step.x, step.y, step.z);
        if (dist < 1e-5) break;
        const dir = { x: step.x / dist, y: step.y / dist, z: step.z / dist };
        const hit = raycastWorld(this.world, g.pos, dir, dist + 0.07, { sightOnly: true });

        if (!hit) {
          g.pos.x += step.x; g.pos.y += step.y; g.pos.z += step.z;
          break;
        }

        // Advance to just short of the surface, then reflect.
        const travel = Math.max(0, hit.t - 0.07);
        g.pos.x += dir.x * travel; g.pos.y += dir.y * travel; g.pos.z += dir.z * travel;
        const n = hit.normal;
        const vn = g.vel.x * n.x + g.vel.y * n.y + g.vel.z * n.z;
        g.vel.x = (g.vel.x - 2 * vn * n.x) * def.bounce;
        g.vel.y = (g.vel.y - 2 * vn * n.y) * def.bounce;
        g.vel.z = (g.vel.z - 2 * vn * n.z) * def.bounce;
        // Tangential friction so grenades settle instead of skating forever.
        g.vel.x *= def.friction; g.vel.z *= def.friction;

        const speed = Math.hypot(g.vel.x, g.vel.y, g.vel.z);
        this.pendingEvents.push({ e: 'gbounce', p: r3(g.pos), k: g.kind, s: round2(speed) });
        if (speed < 1.2) { g.vel.x = g.vel.y = g.vel.z = 0; g.rest += remaining; }
        remaining -= Math.max(1e-3, travel / Math.max(0.001, dist) * remaining);
      }

      g.fuse -= dt;
      if (g.fuse <= 0) {
        this.projectiles.splice(i, 1);
        this.detonate(g, def);
      }
    }
  }

  detonate(g, def) {
    this.broadcast({ t: 'grenade.pop', id: g.id, kind: g.kind, p: r3(g.pos), by: g.owner });

    if (g.kind === 'smoke') {
      this.smokes.push({
        id: g.id, p: { ...g.pos }, radius: def.radius,
        until: this.time + def.duration, born: this.time,
      });
      return;
    }

    const owner = this.players.get(g.owner);
    for (const victim of this.players.values()) {
      if (!victim.alive) continue;
      const centre = { x: victim.state.pos.x, y: victim.state.pos.y + victim.state.height * 0.55, z: victim.state.pos.z };
      const d = vdist(g.pos, centre);
      if (d > def.radius) continue;
      // Walls stop blast and light alike.
      if (!hasLineOfSight(this.world, g.pos, centre)) continue;

      if (g.kind === 'frag') {
        const dmg = fragDamage(def, d);
        if (dmg > 0) this.applyDamage(victim, owner || null, dmg, 'frag', 'chest', d);
      } else if (g.kind === 'flash') {
        const eye = eyePosition(victim.state);
        const look = dirFromAngles(victim.state.yaw, victim.state.pitch);
        const toward = vnorm(vsub(g.pos, eye));
        const dot = look.x * toward.x + look.y * toward.y + look.z * toward.z;
        const blind = flashBlind(def, vdist(g.pos, eye), dot);
        if (blind > 0) {
          victim.blindUntil = this.time + blind;
          this.send(victim.client, { t: 'flashed', duration: round2(blind) });
          if (victim.bot) victim.bot.onFlashed(blind);
        }
      }
    }
  }

  /** Smoke blocks sight for bots as well as for players. */
  smokeBlocks(a, b) {
    for (const s of this.smokes) {
      const grow = Math.min(1, (this.time - s.born) / 1.4);
      const r = s.radius * grow;
      // Distance from the smoke centre to the segment a->b.
      const dx = b.x - a.x, dy = b.y - a.y, dz = b.z - a.z;
      const len2 = dx * dx + dy * dy + dz * dz;
      if (len2 < 1e-6) continue;
      let t = ((s.p.x - a.x) * dx + (s.p.y - a.y) * dy + (s.p.z - a.z) * dz) / len2;
      t = clamp(t, 0, 1);
      const cx = a.x + dx * t, cy = a.y + dy * t, cz = a.z + dz * t;
      if (Math.hypot(s.p.x - cx, s.p.y - cy, s.p.z - cz) < r) return true;
    }
    return false;
  }

  grenadeSnapshot() {
    if (!this.projectiles.length && !this.smokes.length) return null;
    return {
      g: this.projectiles.map((p) => [p.id, p.kind, round2(p.pos.x), round2(p.pos.y), round2(p.pos.z), round2(p.fuse)]),
      s: this.smokes.map((s) => [s.id, round2(s.p.x), round2(s.p.y), round2(s.p.z), round2(s.until - this.time)]),
    };
  }

  /** Next living teammate to spectate, falling back to anyone still up. */
  pickSpectateTarget(p, after = null) {
    const mates = [...this.players.values()].filter((q) => q.alive && q.team === p.team);
    const pool = mates.length ? mates : [...this.players.values()].filter((q) => q.alive);
    if (!pool.length) return null;
    if (!after) return pool[0].id;
    const i = pool.findIndex((q) => q.id === after);
    return pool[(i + 1) % pool.length].id;
  }

  // -------------------------------------------------------------- respawn
  assignSpawns() {
    for (const team of [0, 1]) {
      const squad = [...this.players.values()].filter((p) => p.team === team);
      const anchors = this.spawnCluster(team, squad.length);
      squad.forEach((p, i) => {
        const sp = anchors[i % anchors.length];
        p.state = createPlayerState(sp);
        p.introSpawn = sp;
      });
    }
  }

  /**
   * A contiguous group of spawn points for one team, so a squad deploys
   * together instead of being scattered across the estate.
   */
  spawnCluster(team, count) {
    const pool = this.mapData.spawns.filter((s) => s.team === team);
    if (!pool.length) return this.mapData.spawns.slice(0, Math.max(1, count));

    // Anchor on a random spawn, then take its nearest neighbours.
    const anchor = pool[Math.floor(Math.random() * pool.length)];
    const sorted = [...pool].sort((a, b) => {
      const da = (a.p[0] - anchor.p[0]) ** 2 + (a.p[2] - anchor.p[2]) ** 2;
      const db = (b.p[0] - anchor.p[0]) ** 2 + (b.p[2] - anchor.p[2]) ** 2;
      return da - db;
    });
    return sorted.slice(0, Math.max(1, count));
  }

  /** Put a player into the world at a specific spawn and give them a full kit. */
  respawnAt(p, spawn) {
    if (p.pendingLoadout) { p.loadout = p.pendingLoadout; p.pendingLoadout = null; }
    p.state = createPlayerState(spawn);
    p.alive = true;
    p.spectating = false;
    p.spectateTarget = null;
    p.health = PLAYER.maxHealth;
    p.respawnAt = 0;
    // The freeze period is the protection — nobody can shoot during it anyway.
    p.spawnProtectUntil = this.time + this.mode.freezeTime;
    p.damagedBy.clear();
    p.pendingReload = null;
    p.burstLeft = 0;
    p.lastFireTime = -99;
    p.switchEnd = 0;
    p.streak = 0;
    this.equipLoadout(p);
    if (p.bot) p.bot.onSpawn();
    this.send(p.client, {
      t: 'spawn',
      pos: r3(p.state.pos),
      yaw: p.state.yaw,
      protectedFor: p.spawnProtectUntil - this.time,
      round: this.roundNo,
      loadout: {
        primary: { ...p.weapons.primary.cfg, mag: p.weapons.primary.mag, reserve: p.weapons.primary.reserve },
        secondary: { ...p.weapons.secondary.cfg, mag: p.weapons.secondary.mag, reserve: p.weapons.secondary.reserve },
      },
      grenades: p.grenades,
    });
  }

  // ---------------------------------------------------------------- rounds
  /** How many are still up, per crew. */
  aliveByTeam() {
    const out = [];
    for (let t = 0; t < Math.max(2, this.teamCount); t++) out.push(this.aliveCount(t));
    return out;
  }

  aliveCount(team) {
    let n = 0;
    for (const p of this.players.values()) if (p.alive && p.team === team) n++;
    return n;
  }

  startRound() {
    this.roundNo++;
    this.lastRoundWinner = -1;
    // A drone is a once-a-round asset, so the round is what gives it back.
    for (const p of this.players.values()) {
      this.killDrone(p, false);
      p.droneUsed = false;
      p.markedUntil = 0;
    }

    // Everyone comes back, as a squad, at their team's spawn cluster.
    for (const team of [0, 1]) {
      const squad = [...this.players.values()].filter((p) => p.team === team);
      const anchors = this.spawnCluster(team, squad.length);
      squad.forEach((p, i) => this.respawnAt(p, anchors[i % anchors.length]));
    }

    this.setPhase('freeze', this.mode.freezeTime);
    this.broadcast({
      t: 'round.start',
      round: this.roundNo,
      scores: this.scores,
      freeze: this.mode.freezeTime,
      roundTime: this.mode.roundTime,
      alive: this.aliveByTeam(),
    });
  }

  // ------------------------------------------------------------- cashout
  /** Cashout has no rounds: everyone deploys once and the clock starts. */
  startCashout() {
    this.roundNo = 1;
    for (let t = 0; t < this.teamCount; t++) {
      const squad = [...this.players.values()].filter((q) => q.team === t);
      if (!squad.length) continue;
      const anchors = this.spawnCluster(t, squad.length);
      squad.forEach((q, i) => this.respawnAt(q, anchors[i % anchors.length]));
    }
    this.cash.nextSpawnAt = this.time + 1;
    this.setPhase('freeze', this.mode.freezeTime);
    this.broadcast({
      t: 'round.start', round: 1, scores: this.scores,
      freeze: this.mode.freezeTime, roundTime: this.mode.matchTime,
      alive: this.aliveByTeam(),
    });
  }

  /** Respawn the dead, run the objective, and check for an outright win. */
  stepCashoutRound(dt) {
    for (const q of this.players.values()) {
      if (q.alive || !q.respawnAt || this.time < q.respawnAt) continue;
      const anchors = this.spawnCluster(q.team, 1);
      this.respawnAt(q, anchors[0]);
      this.send(q.client, { t: 'respawned' });
    }

    stepCashout(this.cash, this.mode, this.players.values(), this.time, dt, {
      onBoxSpawn: (box) => this.broadcast({ t: 'cash.box', box: this.boxBrief(box), event: 'spawn' }),
      onBoxDropped: (box) => this.broadcast({ t: 'cash.box', box: this.boxBrief(box), event: 'drop' }),
      onSteal: (to, from) => this.broadcast({ t: 'cash.steal', team: to, from }),
      onBanked: (team, terminal, total) => this.broadcast({
        t: 'cash.banked', team, terminal: terminal.id, total, cash: this.cash.cash,
      }),
    });

    this.scores = this.cash.cash;
    if (cashResult(this.cash, this.mode).won) this.endMatch(this.matchResult());
  }

  boxBrief(box) {
    if (!box) return null;
    return {
      id: box.id,
      p: [round2(box.pos.x), round2(box.pos.y), round2(box.pos.z)],
      carrier: box.carrier || null,
      terminal: box.inTerminal || null,
    };
  }

  /** F on the cashbox, or on a terminal while carrying it. */
  cashInteract(p) {
    if (!this.cash || this.phase !== 'live' || !p.alive) return;
    const box = this.cash.box;
    if (box && box.carrier === p.id) {
      const t = tryDeposit(this.cash, this.mode, p, this.time);
      if (t) {
        this.broadcast({
          t: 'cash.deposit', team: p.team, by: p.id, terminal: t.id,
          seconds: round2(this.mode.cashoutTime),
        });
      }
      return;
    }
    if (tryPickup(this.cash, p, this.time)) {
      this.broadcast({ t: 'cash.box', box: this.boxBrief(this.cash.box), event: 'pickup' });
    }
  }

  /** Round is over the moment one side has nobody left standing. */
  checkRoundEnd() {
    const a = this.aliveCount(0);
    const b = this.aliveCount(1);
    if (a > 0 && b > 0) return;
    // Both sides wiped in the same tick (a trade) counts for neither.
    if (a === 0 && b === 0) return this.finishRound(-1, 'trade');
    this.finishRound(a > 0 ? 0 : 1, 'elimination');
  }

  /** On the round clock running out, whoever has more operators alive wins. */
  roundTimeoutWinner() {
    const a = this.aliveCount(0);
    const b = this.aliveCount(1);
    if (a === b) return -1;
    return a > b ? 0 : 1;
  }

  finishRound(winner, reason) {
    if (this.phase === 'roundend' || this.phase === 'outro') return;
    if (winner >= 0) this.scores[winner]++;
    this.lastRoundWinner = winner;
    this.roundLog.push({ round: this.roundNo, winner, reason });

    // Everyone left standing is frozen for the replay beat.
    for (const p of this.players.values()) p.pendingReload = null;

    this.broadcast({
      t: 'round.end',
      round: this.roundNo,
      winner,
      reason,
      scores: this.scores,
      decided: this.matchDecided(),
      intermission: this.mode.intermission,
    });
    this.setPhase('roundend', this.mode.intermission);
  }

  matchDecided() {
    if (this.mode.cashout) return cashResult(this.cash, this.mode).won;
    return this.scores[0] >= this.mode.roundsToWin
      || this.scores[1] >= this.mode.roundsToWin
      || this.roundNo >= this.mode.maxRounds;
  }

  matchResult() {
    if (this.mode.cashout) {
      const res = cashResult(this.cash, this.mode);
      const top = this.cash.cash[res.leader];
      if (!top || this.cash.cash.filter((c) => c === top).length > 1) return { kind: 'draw' };
      return { kind: 'team', team: res.leader };
    }
    if (this.scores[0] === this.scores[1]) return { kind: 'draw' };
    return { kind: 'team', team: this.scores[0] > this.scores[1] ? 0 : 1 };
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

    for (const p of this.players.values()) p.alive = false;
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

    const grenadeState = this.grenadeSnapshot();
    const drones = this.droneSnapshot();

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
          spectating: p.spectating,
          spectate: p.spectateTarget,
          nades: p.grenades,
          nadeCd: Math.max(0, round2(p.grenadeCooldown - this.time)),
          blind: Math.max(0, round2((p.blindUntil || 0) - this.time)),
        },
        p: entities,
        ev: events,
        gr: grenadeState,
        dr: drones,
        // The objective, compact enough to ride every snapshot: where the
        // box is, which terminal is running, and how the crews stand.
        co: this.cash ? {
          box: this.boxBrief(this.cash.box),
          act: this.cash.active ? {
            t: this.cash.active.terminal.id,
            team: this.cash.active.team,
            left: round2(Math.max(0, this.cash.active.endsAt - this.time)),
            by: this.cash.active.contestedBy,
            steal: round2(this.cash.active.contestFor),
          } : null,
          cash: this.cash.cash,
          next: this.cash.nextSpawnAt ? round2(Math.max(0, this.cash.nextSpawnAt - this.time)) : 0,
        } : null,
        mk: this.marksFor(p.team),
        pilot: p.piloting ? (p.drone?.id || null) : null,
        mine: p.drone?.id || null,
        sc: this.scores,
        alive: this.aliveByTeam(),
        round: this.roundNo,
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
      case 'interact': this.cashInteract(p); break;
      case 'reload': this.startReload(p); break;
      case 'switch': this.switchSlot(p, msg.slot); break;
      case 'melee': this.melee(p, p.cmd); break;
      case 'grenade': this.throwGrenade(p, msg.kind, msg.charge); break;
      case 'drone.deploy': this.deployDrone(p); break;
      case 'drone.enter': this.enterDrone(p); break;
      case 'drone.exit': this.exitDrone(p); break;
      case 'drone.scan': this.droneScan(p); break;
      case 'drone.input': {
        const d = p.drone;
        if (!d || !d.alive || !p.piloting) break;
        d.cmd = {
          btn: msg.btn | 0,
          yaw: Number.isFinite(msg.yaw) ? msg.yaw : d.yaw,
          pitch: Number.isFinite(msg.pitch) ? msg.pitch : d.pitch,
        };
        break;
      }
      case 'spectate': {
        if (!p.alive) p.spectateTarget = this.pickSpectateTarget(p, p.spectateTarget);
        break;
      }
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
