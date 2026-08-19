// The game: owns the renderer, the world, the local player, remote players,
// and the match state machine that drives them.

import * as THREE from 'three';
import { FIXED_DT, MATCH, PLAYER, TEAM_INFO, VIEW } from '/shared/constants.js';
import { buildWorld } from '/shared/collision.js';
import { eyePosition } from '/shared/controller.js';
import { getMap, MAP_INFO } from '/shared/maps/index.js';
import { MODES, getMode } from '/shared/modes.js';
import { resolveWeapon, getWeapon, SCOPES } from '/shared/weapons.js';
import { levelFromXp } from '/shared/cosmetics.js';

import { Renderer } from '../engine/renderer.js';
import { TextureLab } from '../engine/textures.js';
import { WorldView } from '../engine/world.js';
import { Effects } from '../engine/effects.js';
import { Input } from './input.js';
import { LocalPlayer } from './localplayer.js';
import { RemoteManager } from './remote.js';
import { ViewModel } from './viewmodel.js';
import { ScopeRenderer } from './scope.js';
import { TrainingMode } from './training.js';
import { GrenadeView } from './grenades.js';
import { DroneView, MarkView } from './drone.js';
import { CashView } from './cashview.js';
import { IntroCamera } from './introcam.js';
import { DRONE } from '/shared/drone.js';
import { GRENADE_IDS, GRENADE_COOLDOWN, getGrenade } from '/shared/grenades.js';
import { saveProfile } from '../ui/menu.js';

const PHASE = { NONE: 'none', INTRO: 'intro', WARMUP: 'warmup', LIVE: 'live', OUTRO: 'outro' };

export class Game {
  constructor({ canvas, profile, audio, net, hud, menu }) {
    this.canvas = canvas;
    this.profile = profile;
    this.audio = audio;
    this.net = net;
    this.hud = hud;
    this.menu = menu;

    this.renderer = new Renderer(canvas, profile.settings.quality);
    this.lab = new TextureLab(this.renderer.gl, { size: this.renderer.preset.textureSize });

    this.camera = new THREE.PerspectiveCamera(VIEW.baseFov, innerWidth / innerHeight, VIEW.near, VIEW.far);
    this.vmCamera = new THREE.PerspectiveCamera(VIEW.viewmodelFov, innerWidth / innerHeight, 0.008, 12);
    this.renderer.buildComposer(this.camera, this.vmCamera);

    // The view-model camera lives in the view-model scene so the weapon and the
    // scope optic can hang off it and be posed in camera space.
    this.renderer.vmScene.add(this.vmCamera);

    this.effects = new Effects(this.renderer.scene, this.renderer.vmScene);
    this.viewmodel = new ViewModel(this.vmCamera);
    this.scope = new ScopeRenderer(this.renderer, this.renderer.scene, this.vmCamera);
    this.remotes = new RemoteManager(this.renderer.scene);
    this.grenadeView = new GrenadeView(this.renderer.scene, this.effects, this.audio);
    this.cashView = new CashView(this.renderer.scene, this.lab);
    this.introCam = new IntroCamera();
    this.droneView = new DroneView(this.renderer.scene);
    this.markView = new MarkView(this.renderer.scene);

    this.grenadeKind = 'frag';
    this.grenadeStock = { frag: 1, flash: 1, smoke: 1 };
    this.grenadeCooldown = 0;
    this.blindUntil = 0;
    this.round = 0;
    this.aliveCounts = [0, 0];
    this.spectateId = null;
    // Piloting: the drone's id while we are driving it, plus what the
    // server says we own. `droneUsed` gates the once-a-round deploy.
    this.pilotId = null;
    this.myDroneId = null;
    this.droneUsed = false;
    this.droneScanReady = 0;
    this.marks = [];

    this.input = new Input(canvas, profile.settings);
    this.input.onLockChange = (locked) => this.onLockChange(locked);

    this.world = null;
    this.worldView = null;
    this.mapId = null;
    this.local = null;
    this.training = null;

    this.phase = PHASE.NONE;
    this.phaseRemaining = 0;
    this.matchTimeLeft = 0;
    this.match = null;
    this.roster = new Map();
    this.scores = [0, 0];
    this.objectives = [];
    this.serverTime = 0;
    this.lastSnapshotAt = 0;
    this.inMatch = false;
    this.paused = false;
    this.scoreboardOpen = false;
    this.hurtLevel = 0;
    this.pendingInputs = [];
    this.lastCountdownBeep = -1;

    this._v = new THREE.Vector3();
    this.bindNet();
    this.bindUi();

    addEventListener('resize', () => this.resize());
    this.resize();
  }

  resize() {
    this.renderer.resize();
  }

  // ---------------------------------------------------------------- world
  async setMap(mapId) {
    if (this.mapId === mapId && this.worldView) return;
    if (this.worldView) this.worldView.dispose();
    this.mapId = mapId;
    this.mapData = getMap(mapId);
    this.world = buildWorld(this.mapData);
    this.renderer.applyEnvironment(this.mapData);
    this.worldView = new WorldView(this.renderer.scene, this.lab, this.mapData, {
      quality: this.renderer.quality,
    });
    this.worldView.build();
  }

  // ------------------------------------------------------------------ net
  bindNet() {
    const net = this.net;

    net.on('match.start', (msg) => this.startMatch(msg));
    net.on('phase', (msg) => this.setPhase(msg));
    net.on('snap', (msg) => this.onSnapshot(msg));
    net.on('spawn', (msg) => this.onSpawn(msg));
    net.on('kill', (msg) => this.onKill(msg));
    net.on('hurt', (msg) => this.onHurt(msg));
    net.on('hitmark', (msg) => {
      this.hud.hit(msg.zone, msg.killed);
      this.audio.hitmarker(msg.killed, msg.zone);
    });
    net.on('roster', (msg) => this.updateRoster(msg.players));
    net.on('playerleft', (msg) => this.remotes.remove(msg.id));
    net.on('reloading', (msg) => {
      this.viewmodel.startReload(msg.duration, msg.empty);
      this.audio.reloadSequence(msg.duration, msg.empty);
    });
    net.on('dryfire', () => this.audio.click('dry'));
    net.on('streak', (msg) => {
      if (msg.id === net.id) this.hud.streak(`${msg.count} ELIMINATION STREAK`);
    });
    net.on('round.start', (msg) => {
      this.round = msg.round;
      this.scores = msg.scores;
      this.grenadeView.clear();
      this.droneUsed = false;
      this.pilotId = null;
      this.myDroneId = null;
      this.hud.hideDeath();
      this.hud.roundBanner(`ROUND ${msg.round}`, this.roundSubtitle(msg.scores), 2200);
      this.audio.countdownBeep(false);
    });
    net.on('round.live', () => {
      this.hud.toast('GO', 800);
      this.audio.countdownBeep(true);
    });
    net.on('round.end', (msg) => {
      this.scores = msg.scores;
      const mine = msg.winner === this.myTeam;
      const title = msg.winner < 0 ? 'ROUND DRAW' : (mine ? 'ROUND WON' : 'ROUND LOST');
      this.hud.roundBanner(title, this.roundSubtitle(msg.scores), 4000);
    });

    net.on('grenade.throw', (msg) => {
      if (msg.by !== net.id) this.grenadeView.spawn(msg);
      this.audio.click('reload');
    });
    net.on('grenade.pop', (msg) => this.grenadeView.pop(msg));
    net.on('grenade.used', (msg) => {
      this.grenadeCooldown = msg.cooldown;
    });
    net.on('flashed', (msg) => {
      this.blindUntil = performance.now() / 1000 + msg.duration;
      this.audio.tinnitus(msg.duration);
    });
    // Cashout callouts. The mode turns on a handful of moments — the box
    // appearing, someone starting a bank, someone taking it off them — and
    // none of them are visible from wherever you happen to be standing.
    net.on('cash.box', (msg) => {
      this.cashBox = msg.box;
      if (msg.event === 'pickup' && msg.box?.carrier === net.id) {
        this.hud.toast('CASHBOX SECURED — F AT A TERMINAL', 2400);
      } else if (msg.event === 'spawn') {
        this.hud.toast('A CASHBOX HAS APPEARED', 2000);
      }
      this.audio.click(msg.event === 'drop' ? 'error' : 'ui');
    });
    net.on('cash.deposit', (msg) => {
      const name = this.match?.teams?.[msg.team]?.name || 'A CREW';
      this.hud.roundBanner(
        msg.team === this.myTeam ? 'CASHING OUT' : name + ' IS CASHING OUT',
        'HOLD THE TERMINAL', 2600);
    });
    net.on('cash.steal', (msg) => {
      const name = this.match?.teams?.[msg.team]?.name || 'A CREW';
      const mine = msg.team === this.myTeam;
      this.hud.roundBanner(mine ? 'TERMINAL TAKEN' : name + ' TOOK THE TERMINAL', '', 2200);
      this.audio.click(mine ? 'ui' : 'error');
    });
    net.on('cash.banked', (msg) => {
      this.cash = msg.cash;
      const name = this.match?.teams?.[msg.team]?.name || 'A CREW';
      const mine = msg.team === this.myTeam;
      const amount = '$' + (msg.total || 0).toLocaleString();
      this.hud.roundBanner(mine ? 'CASHED OUT' : name + ' CASHED OUT', amount, 3200);
    });
    net.on('respawned', () => this.hud.hideDeath());
    net.on('drone.start', (msg) => {
      this.pilotId = msg.id;
      this._droneYaw = Number.isFinite(msg.yaw) ? msg.yaw : (this.local?.yaw ?? 0);
      this._dronePitch = Number.isFinite(msg.pitch) ? msg.pitch : 0;
      this.droneUsed = true;
      this.droneScanReady = 0;
      this.unequipGrenade();
      this.hud.toast('Z TO STEP OUT — THE DRONE STAYS PUT', 2200);
      this.audio.click('reload');
    });
    net.on('drone.end', (msg) => {
      this.pilotId = null;
      this.hud.toast(msg?.parked ? 'DRONE PARKED — Z TO RETURN' : 'DRONE DESTROYED', 1800);
      this.audio.click(msg?.parked ? 'ui' : 'error');
    });
    net.on('drone.spawn', () => this.audio.click('ui'));
    net.on('drone.down', (msg) => {
      const at = { x: msg.p[0], y: msg.p[1], z: msg.p[2] };
      if (!msg.recalled) {
        this.effects.impact(at, { x: 0, y: 1, z: 0 }, 'metal');
        this.audio.impact('metal', at);
      }
      this.droneView.remove(msg.id);
    });
    net.on('drone.scan', (msg) => {
      this.droneScanReady = DRONE.scanCooldown;
      this.audio.click(msg.hit ? 'ui' : 'dry');
    });
    net.on('drone.mark', (msg) => this.hud.streak(`${msg.name} MARKED`));
    net.on('match.end', (msg) => this.endMatch(msg));
    net.on('match.over', () => this.leaveMatch());
    // The host put a fresh match together — drop back to the waiting room.
    net.on('rematch', () => this.leaveMatch());
    net.on('chat', (msg) => this.menu.toast(`${msg.name}: ${msg.text}`));
    net.on('err', (msg) => this.menu.toast(msg.msg, true));

    // A dropped connection means the server has already torn the match down;
    // sitting in a dead session would leave the player shooting at ghosts.
    net.on('close', () => {
      if (this.inMatch) {
        this.leaveMatch();
        this.menu.toast('Disconnected from the match.', true);
      }
    });
    net.on('match.left', () => this.leaveMatch());
  }

  bindUi() {
    document.getElementById('pause-resume').addEventListener('click', () => this.resume());
    document.getElementById('pause-leave').addEventListener('click', () => {
      this.net.send({ t: 'leave' });
      this.leaveMatch();
    });
    // Settings opens over the pause screen. It used to drop the player back
    // to the main menu, which reads as having left the match.
    document.getElementById('pause-settings').addEventListener('click', () => {
      this.menu.openSettings(() => {
        document.getElementById('pause').classList.remove('hidden');
      });
      document.getElementById('pause').classList.add('hidden');
    });
  }

  // ---------------------------------------------------------------- match
  async startMatch(msg) {
    this.audio.stopMenuMusic();
    this.cash = null;
    this.cashBox = null;
    this.cashActive = null;
    this.cashGoal = msg.cashGoal || 0;
    this.cashView.setObjectives(msg.objectives || null);
    const mode = getMode(msg.mode);
    // Leaving the training ground has to take its targets and racks with it,
    // or they turn up scattered across the estate.
    this.disposeTraining();
    await this.setMap(msg.map);

    this.match = {
      mode: msg.mode,
      modeName: mode.name,
      mapName: MAP_INFO[msg.map]?.name || msg.map,
      teams: !!msg.teams,
      teamInfo: Array.isArray(msg.teams) ? msg.teams : null,
      cashoutTime: mode.cashoutTime || 75,
      scoreLimit: msg.scoreLimit,
      timeLimit: msg.timeLimit,
      players: msg.players,
    };
    // A fresh match — including one restarted under a new host — brings a new
    // roster. Merging into the old one leaves ghosts from the previous match.
    this.roster.clear();
    this.updateRoster(msg.players);
    this.myTeam = this.roster.get(this.net.id)?.team ?? -1;
    this.scores = [0, 0];
    this.inMatch = true;
    this.remotes.clear();

    this.local = new LocalPlayer(this.world, this.profile.settings);
    this.local.id = this.net.id;
    this.local.fov = this.profile.settings.fov;
    this.local.setLoadout({
      primary: { ...this.profile.loadout.primary },
      secondary: { ...this.profile.loadout.secondary },
    });
    this.equipViewmodel();

    this.menu.hide();
    this.menu.setSearching(false);
    this.menu.hideLobby();
    this.hud.show();
    this.hud.hideVictory();
    this.hud.hideDeath();

    // Spectator-style intro: watch the map while the rosters are revealed.
    if (msg.intro > 0) {
      this.phase = PHASE.INTRO;
    this.introCam.begin(this.mapData, msg.intro || MATCH.introDuration);
      this.phaseRemaining = msg.intro;
      this.hud.showIntro({ ...this.match, players: msg.players }, this.net.id);
      this.audio.startIntroBed();
      this.introAngle = 0;
    } else {
      this.phase = PHASE.LIVE;
      this.hud.hideIntro();
    }

    this.input.requestLock();
  }

  equipViewmodel() {
    if (this.grenadeEquipped) return;   // a throwable is in hand
    const rw = this.local?.rw;
    if (!rw) return;
    this.viewmodel.setWeapon(rw);
    this.scope.setWeapon(rw);
  }

  updateRoster(players) {
    for (const p of players) {
      const prev = this.roster.get(p.id) || {};
      this.roster.set(p.id, { ...prev, ...p });
    }
    if (this.match) this.match.players = [...this.roster.values()];
  }

  setPhase(msg) {
    const prev = this.phase;
    this.phase = msg.phase;
    this.phaseRemaining = msg.remaining;
    this.scores = msg.scores || this.scores;
    this.matchTimeLeft = Number.isFinite(msg.matchTime) ? msg.matchTime : this.matchTimeLeft;

    if (prev === PHASE.INTRO && this.phase !== PHASE.INTRO) {
      this.introCam.end();
      this.hud.hideIntro();
      this.audio.stopIntroBed();
    }
    if (this.phase === PHASE.LIVE && prev !== PHASE.LIVE) {
      this.hud.toast('ENGAGE', 1100);
    }
  }

  onSpawn(msg) {
    if (!this.local) return;
    this.grenadeEquipped = null;
    this.local.spawn(msg.pos, msg.yaw);
    if (msg.loadout) {
      this.local.setLoadout(msg.loadout);
      this.equipViewmodel();
    }
    this.hud.hideDeath();
    this.hurtLevel = 0;
  }

  onSnapshot(msg) {
    if (!this.local || !this.inMatch) return;
    this.serverTime = msg.tm;
    this.lastSnapshotAt = performance.now();

    this.local.reconcile(msg.you, msg.ack);
    this.local.applyStatus(msg.you);
    this.scores = msg.sc || this.scores;
    this.phaseRemaining = msg.rem ?? this.phaseRemaining;
    // Resync the round clock off the snapshot rather than trusting a local
    // countdown to hold for a two-minute round: while the round is live the
    // phase deadline *is* the round deadline.
    if (this.phase === PHASE.LIVE && msg.rem != null) this.matchTimeLeft = msg.rem;
    this.respawnIn = msg.you.respawnIn ?? 0;
    if (msg.you.zone) this.zoneName = msg.you.zone;
    if (msg.you.nades) this.grenadeStock = msg.you.nades;
    this.grenadeCooldown = msg.you.nadeCd ?? 0;
    this.spectateId = msg.you.spectate || null;
    this.aliveCounts = msg.alive || this.aliveCounts;
    this.round = msg.round ?? this.round;
    if (msg.you.blind > 0) {
      this.blindUntil = Math.max(this.blindUntil, performance.now() / 1000 + msg.you.blind);
    }

    this.grenadeView.sync(msg.gr?.g);
    this.grenadeView.syncSmokes(msg.gr?.s);

    const me = this.roster.get(this.net.id);
    if (me) {
      me.score = msg.you.score; me.kills = msg.you.kills;
      me.deaths = msg.you.deaths; me.assists = msg.you.assists;
    }

    if (msg.you.weapon && this.viewmodel.model &&
        this.viewmodel.resolved?.id !== msg.you.weapon) {
      this.equipViewmodel();
    }

    this.remotes.ingest(msg.p, msg.tm, this.net.id, this.roster,
      this.myTeam, this.match?.teams);

    // Objectives.
    if (msg.o) {
      this.objectives = msg.o.map((o) => {
        const def = this.mapData.objectives.find((d) => d.id === o[0]);
        return {
          id: o[0], owner: o[1], progress: o[2], contested: !!o[3],
          p: def?.p,
        };
      });
    }

    this.droneRows = msg.dr || [];
    this.myDroneId = msg.mine || null;
    if (msg.co) {
      this.cash = msg.co.cash;
      this.cashBox = msg.co.box;
      this.cashActive = msg.co.act;
      this.cashView.sync(msg.co, this.match?.teams);
    }
    this.marks = msg.mk || [];
    // The server is the authority on whether we are still driving: losing
    // the drone, dying, or the round ending all end it the same way.
    if (this.pilotId && msg.pilot !== this.pilotId) this.pilotId = null;
    for (const ev of msg.ev || []) this.handleWorldEvent(ev);
  }

  handleWorldEvent(ev) {
    if (ev.e === 'shot') {
      if (ev.id === this.net.id) return;      // our own shots are predicted
      const origin = { x: ev.o[0], y: ev.o[1], z: ev.o[2] };
      for (const d of ev.d) {
        this.effects.tracer(origin, { x: d[0], y: d[1], z: d[2] }, { width: 0.016 });
      }
      this.effects.flashMuzzle(null, 1, origin);
      this.audio.gunshot(getWeapon(ev.w), origin, { suppressed: ev.silent });
    } else if (ev.e === 'impact') {
      const p = { x: ev.p[0], y: ev.p[1], z: ev.p[2] };
      const n = { x: ev.n[0], y: ev.n[1], z: ev.n[2] };
      this.effects.impact(p, n, ev.m);
      this.audio.impact(ev.m, p);
    } else if (ev.e === 'flesh') {
      const p = { x: ev.p[0], y: ev.p[1], z: ev.p[2] };
      this.audio.flesh(p, ev.z === 'head');
      this.effects.blood(p, { x: 0, y: 0.3, z: 0 }, ev.z === 'head' ? 1.6 : 1);
    } else if (ev.e === 'gbounce') {
      this.audio.bounce({ x: ev.p[0], y: ev.p[1], z: ev.p[2] }, ev.s);
    }
  }

  roundSubtitle(scores) {
    const need = this.match?.roundsToWin ?? 3;
    return `${TEAM_INFO[0].name} ${scores[0]}  —  ${scores[1]} ${TEAM_INFO[1].name}   ·   FIRST TO ${need}`;
  }

  /**
   * Throwables are not consumable — the cooldown is the whole limit — so the
   * only reason to change kind is because the player asked to.
   */
  selectNextGrenade() {}

  /** Take a throwable in hand. Returns false if there is none to take. */
  equipGrenade(kind) {
    if (!this.local?.alive || this.paused) return false;
    if (!GRENADE_IDS.includes(kind)) return false;
    if (this.grenadeCooldown > 0) {
      this.audio.click('error');
      return false;
    }
    if (this.grenadeEquipped === kind) return true;
    this.grenadeKind = kind;
    this.grenadeEquipped = kind;
    this.viewmodel.setGrenade(kind);
    this.scope.setWeapon({ scope: { mag: 1, pip: false } });
    this.audio.click('reload');
    return true;
  }

  unequipGrenade() {
    if (!this.grenadeEquipped) return;
    this.grenadeEquipped = null;
    this.equipViewmodel();
  }

  throwGrenade() {
    if (!this.local?.alive || !this.grenadeEquipped) return;
    if (this.grenadeCooldown > 0) return this.audio.click('error');
    const kind = this.grenadeEquipped;

    // The animation winds up before the grenade leaves the hand.
    const delay = this.viewmodel.startThrow();
    setTimeout(() => {
      if (this.training) {
        // Offline: fly it locally, and hand the cooldown back on a timer.
        this.training.throwGrenade(kind, this.local);
        this.grenadeCooldown = GRENADE_COOLDOWN;
        clearTimeout(this._nadeCd);
        this._nadeCd = setTimeout(() => { this.grenadeCooldown = 0; }, GRENADE_COOLDOWN * 1000);
      } else {
        this.net.send({ t: 'grenade', kind, charge: 1 });
      }
    }, delay * 1000);
    setTimeout(() => this.unequipGrenade(), 620);
  }

  onKill(msg) {
    this.hud.addKill(msg, this.net.id, this.match?.teams);
    this.scores = msg.scores || this.scores;

    if (msg.victim.id === this.net.id) {
      this.hud.showDeath(msg);
      this.audio.death();
      this.playKillerFanfare(msg.killer);
    } else if (msg.killer?.id === this.net.id) {
      this.hud.toast('ELIMINATED', 900);
    }

    const victim = this.remotes.get(msg.victim.id);
    if (victim) {
      const at = { x: victim.renderPos.x, y: victim.renderPos.y + 1.1, z: victim.renderPos.z };
      this.effects.blood(at, { x: 0, y: 0.4, z: 0 }, 2.2);
      this.audio.bodyfall(victim.renderPos);
    }
  }

  /**
   * Whoever put you down gets their fanfare played over their banner. The
   * banner comes down when the music stops — you are dead for the rest of the
   * round, and a card sitting over the middle of the screen is no way to
   * spectate.
   */
  playKillerFanfare(killer) {
    const MIN = 2.6;   // even with no fanfare, long enough to read the banner
    if (!killer?.fanfare) return this.hud.autoHideDeath(MIN);

    // A fallback in case the file never decodes; the real length replaces it.
    this.hud.autoHideDeath(8);
    const deadFor = this.deaths = (this.deaths || 0) + 1;
    setTimeout(async () => {
      const secs = await this.audio.playFanfare(killer.fanfare);
      // A round may have restarted while the file was decoding.
      if (this.deaths !== deadFor) return;
      this.hud.autoHideDeath(Math.max(MIN, secs || 0));
    }, 260);
  }

  onHurt(msg) {
    if (!this.local) return;
    this.local.health = msg.hp;
    this.hurtLevel = Math.min(1, this.hurtLevel + msg.amount / 70);
    this.audio.hurt();
    const from = { x: msg.from[0], z: msg.from[2] };
    const dx = from.x - this.local.state.pos.x;
    const dz = from.z - this.local.state.pos.z;
    const angle = Math.atan2(dx, -dz) - this.local.yaw;
    this.hud.damageFrom(angle);
  }

  endMatch(msg) {
    this.phase = PHASE.OUTRO;
    this.input.releaseLock();
    const won = this.hud.showVictory(msg, this.net.id, {
      // Only the host can put a fresh match together; guests wait for them.
      canRestart: !!this.net.isHost,
      again: () => this.net.restartMatch?.(),
      leave: () => { this.net.leave(); this.leaveMatch(); },
    });
    if (msg.fanfare) this.audio.playFanfare(msg.fanfare);

    const mine = msg.board.find((p) => p.id === this.net.id);
    if (mine) {
      this.profile.xp += mine.xp;
      this.profile.level = levelFromXp(this.profile.xp);
      saveProfile(this.profile);
      this.menu.refreshChip();
    }
    void won;
  }

  disposeTraining() {
    if (!this.training) return;
    this.training.dispose();
    this.training = null;
    this._lastStand = null;
  }

  leaveMatch() {
    this.cashView.clear();
    this.cash = null;
    this.cashBox = null;
    this.cashActive = null;
    this.inMatch = false;
    this.phase = PHASE.NONE;
    this.match = null;
    this.local = null;
    this.disposeTraining();
    this.grenadeView.clear();
    this.droneView.clear();
    this.markView.clear();
    this.pilotId = null;
    this.droneUsed = false;
    this.remotes.clear();
    this.roster.clear();
    this.hud.hide();
    this.hud.hideVictory();
    this.hud.hideDeath();
    this.hud.hideIntro();
    this.hud.setScoreboard(false);
    this.audio.stopIntroBed();
    this.input.releaseLock();
    document.getElementById('pause').classList.add('hidden');
    this.menu.show();
    this.menu.restoreLobby(this.net.id);
    this.audio.startMenuMusic();
  }

  // ------------------------------------------------------------- training
  async enterTraining() {
    this.audio.stopMenuMusic();
    await this.setMap('training');
    this.inMatch = true;
    this.match = {
      mode: 'training', modeName: 'TRAINING', mapName: 'Training Ground',
      teams: false, timeLimit: Infinity, players: [],
    };
    this.myTeam = -1;
    this.scores = [0, 0];
    this.roster.clear();
    this.remotes.clear();

    this.local = new LocalPlayer(this.world, this.profile.settings);
    this.local.id = 'local';
    this.local.fov = this.profile.settings.fov;
    this.local.setLoadout({
      primary: { ...this.profile.loadout.primary },
      secondary: { ...this.profile.loadout.secondary },
    });
    const start = this.mapData.spawns.find((s) => s.tags?.includes('start')) || this.mapData.spawns[0];
    this.local.spawn(start.p, start.yaw);
    this.equipViewmodel();

    this.local.offline = true;   // no server to finish reloads or fly grenades
    this.training = new TrainingMode(
      this.renderer.scene, this.lab, this.mapData, this.effects, this.audio, this.world
    );
    this.training.build();
    this.training.onEquip = (def) => {
      this.equipViewmodel();
      this.hud.toast(def.name, 1200);
    };

    this.phase = PHASE.LIVE;
    this.phaseRemaining = Infinity;
    this.menu.hide();
    this.menu.hideLobby();
    this.menu.setSearching(false);
    this.hud.show();
    this.hud.hideVictory();
    this.hud.hideDeath();
    this.input.requestLock();
  }

  // --------------------------------------------------------------- input
  /**
   * Losing the pointer mid-match used to put a CLICK TO PLAY card on screen.
   * There is no need to ask: arm a one-shot listener and take the pointer
   * back on the player's next click, which is a gesture the browser accepts.
   */
  onLockChange(locked) {
    if (locked) { this.cursorFree = false; return; }
    // Given up on purpose: leave it given up until the player says otherwise.
    if (this.cursorFree || !this.inMatch || this.paused || this.phase === PHASE.OUTRO) return;
    this.armRelock();
  }

  /**
   * What F would do from where the player is standing, or null. Driven off
   * the same ranges the room uses, so the prompt never offers something the
   * server will refuse.
   */
  cashPrompt() {
    if (!this.cash || !this.local?.alive || this.pilotId) return null;
    const box = this.cashBox;
    const me = this.local.state.pos;
    const near = (p, r) => {
      const dx = p[0] - me.x, dy = p[1] - me.y, dz = p[2] - me.z;
      return Math.hypot(dx, dy, dz) < r;
    };
    if (box?.carrier === this.net.id) {
      const t = this.cashView.terminalNear(me, 3.2);
      return t ? 'DEPOSIT THE CASHBOX' : 'CARRYING THE CASHBOX';
    }
    if (box && !box.carrier && !box.terminal && near(box.p, 1.9)) return 'TAKE THE CASHBOX';
    return null;
  }

  /** Free the mouse, or take it back as the crosshair. */
  toggleCursor() {
    if (this.input.locked) {
      this.cursorFree = true;
      this.input.releaseLock();
      this.hud.toast('MOUSE FREE — L TO AIM AGAIN', 1800);
    } else {
      this.cursorFree = false;
      this.input.requestLock();
    }
  }

  armRelock() {
    if (this._relockArmed) return;
    this._relockArmed = true;
    const grab = () => {
      this._relockArmed = false;
      window.removeEventListener('pointerdown', grab, true);
      if (this.inMatch && !this.paused && this.phase !== PHASE.OUTRO) this.input.requestLock();
    };
    window.addEventListener('pointerdown', grab, true);
  }

  pause() {
    if (!this.inMatch || this.phase === PHASE.OUTRO) return;
    this.paused = true;
    this.input.releaseLock();
    document.getElementById('pause').classList.remove('hidden');
  }

  resume() {
    this.paused = false;
    document.getElementById('pause').classList.add('hidden');
    this.cursorFree = false;
    this.input.requestLock();
  }

  handleActions() {
    const input = this.input;
    if (!this.local) return;

    if (input.wasPressed('menu')) {
      if (this.paused) this.resume();
      else this.pause();
    }

    // Hand the mouse back, or take it again. Deliberately letting go is not
    // the same as losing the pointer to a stray click, so it also disarms
    // the listener that would otherwise grab it back on the next press.
    if (input.wasPressed('cursor')) this.toggleCursor();

    const wantBoard = input.isDown('scoreboard');
    if (wantBoard !== this.scoreboardOpen) {
      this.scoreboardOpen = wantBoard;
      this.hud.setScoreboard(wantBoard, {
        ...this.match, scores: this.scores,
      }, this.roster, this.net.id);
    }

    // Dead players cycle who they are watching.
    if (!this.local.alive) {
      if (input.takeMouseClick()) this.net.send({ t: 'spectate' });
      return;
    }
    if (this.paused) return;

    // Throwables are equipped like a weapon: pick one up, then throw it with
    // the fire button. `G` is a shortcut that equips and throws in one go.
    // Drone. One machine a round, but you step in and out of it as often as
    // you like — leaving the feed parks it where it is rather than picking
    // it up, so it can sit watching a door while you go and fight.
    if (input.wasPressed('drone')) {
      if (this.pilotId) this.net.send({ t: 'drone.exit' });
      else if (this.myDroneId) this.net.send({ t: 'drone.enter' });
      else if (this.droneUsed) { this.audio.click('error'); this.hud.toast('DRONE DESTROYED', 1200); }
      else this.net.send({ t: 'drone.deploy' });
    }
    // Everything below is the operator's body, which is not where we are.
    if (this.pilotId) {
      if (input.isDown('scan') && this.droneScanReady <= 0) this.net.send({ t: 'drone.scan' });
      return;
    }
    if (input.wasPressed('nade1')) this.equipGrenade('frag');
    if (input.wasPressed('nade2')) this.equipGrenade('flash');
    if (input.wasPressed('nade3')) this.equipGrenade('smoke');
    if (input.wasPressed('grenade')) {
      if (this.grenadeEquipped) this.throwGrenade();
      else if (this.equipGrenade(this.grenadeKind)) this.throwGrenade();
    }
    if (this.grenadeEquipped && input.takeMouseClick()) this.throwGrenade();

    // F is the objective key in Cashout: pick the box up, or feed it in.
    if (input.wasPressed('use') && this.cash && !this.training) {
      this.net.send({ t: 'interact' });
    }

    if (input.wasPressed('use') && this.training) {
      if (this.training.takeNearbyWeapon(this.local)) this.audio.click();
    }

    if (input.wasPressed('reload')) {
      if (this.grenadeEquipped) this.unequipGrenade();
      const r = this.local.startReload();
      if (r) {
        this.net.send({ t: 'reload' });
        this.viewmodel.startReload(r.duration, r.empty);
        this.audio.reloadSequence(r.duration, r.empty);
      }
    }
    if (input.wasPressed('primary')) {
      if (this.grenadeEquipped) this.unequipGrenade();
      if (this.local.switchSlot('primary')) {
        this.net.send({ t: 'switch', slot: 'primary' });
        this.equipViewmodel();
      }
    }
    if (input.wasPressed('secondary')) {
      if (this.grenadeEquipped) this.unequipGrenade();
      if (this.local.switchSlot('secondary')) {
        this.net.send({ t: 'switch', slot: 'secondary' });
        this.equipViewmodel();
      }
    }
    const wheel = input.takeWheel();
    if (wheel !== 0) {
      const next = this.local.slot === 'primary' ? 'secondary' : 'primary';
      if (this.local.switchSlot(next)) {
        this.net.send({ t: 'switch', slot: next });
        this.equipViewmodel();
      }
    }
    if (input.wasPressed('melee')) {
      this.net.send({ t: 'melee' });
      this.viewmodel.startMelee();
    }
    if (input.wasPressed('inspect')) this.viewmodel.startInspect();
  }

  /**
   * Drive the drone from the handset. The look input steers the drone,
   * not the operator — they are staring at a screen — and the movement keys
   * go to the server as the drone's command.
   */
  updateDroneControl(dt) {
    this._droneYaw = this._droneYaw ?? this.local.yaw;
    this._dronePitch = this._dronePitch ?? 0;

    if (this.input.locked && !this.paused) {
      const look = this.input.takeLook();
      this._droneYaw -= look.x;
      this._dronePitch = THREE.MathUtils.clamp(this._dronePitch - look.y, -0.9, 0.9);
      const i = this.input;
      let btn = 0;
      if (i.isDown('forward')) btn |= 1;
      if (i.isDown('back')) btn |= 2;
      if (i.isDown('left')) btn |= 4;
      if (i.isDown('right')) btn |= 8;
      if (i.isDown('jump')) btn |= 16;
      if (i.isDown('sprint')) btn |= 64;
      this.net.send({ t: 'drone.input', btn, yaw: this._droneYaw, pitch: this._dronePitch });
    }

  }

  /** The feed fills the screen: the main camera simply becomes the drone. */
  updateDroneCamera() {
    const d = this.droneView.get(this.pilotId);
    const at = d ? d.pos : this.local.state.pos;
    this.camera.position.set(at.x, at.y + DRONE.eye, at.z);
    this.camera.rotation.order = 'YXZ';
    this.camera.rotation.set(this._dronePitch || 0, this._droneYaw || 0, 0);
    // Wide and cheap, the way a camera bolted to a robot would be.
    if (Math.abs(this.camera.fov - 100) > 0.01) {
      this.camera.fov = 100;
      this.camera.updateProjectionMatrix();
    }
    this.vmCamera.position.copy(this.camera.position);
    this.vmCamera.quaternion.copy(this.camera.quaternion);
  }

  // ---------------------------------------------------------------- frame
  update(dt) {
    if (!this.inMatch || !this.local) return;

    this.handleActions();
    // Before anything else touches the mouse: while the feed is up the look
    // input belongs to the drone, not to the operator.
    if (this.pilotId) this.updateDroneControl(dt);

    const frozen = this.paused || this.phase === PHASE.INTRO ||
      this.phase === PHASE.WARMUP || this.phase === PHASE.OUTRO;

    // Look. While piloting this is the drone's, taken in updateDroneCamera.
    if (this.input.locked && !this.paused && this.phase !== PHASE.OUTRO && !this.pilotId) {
      const look = this.input.takeLook();
      if (this.phase !== PHASE.INTRO) {
        const adsScale = this.local.adsBlend > 0.1
          ? this.profile.settings.adsSensitivity : 1;
        this.local.applyLook({ x: look.x * adsScale, y: look.y * adsScale }, this.local.adsBlend);
      }
    } else {
      this.input.takeLook();
    }

    // Simulate and send. A throwable in hand suppresses the trigger and the
    // sights — the fire button throws instead.
    let buttons = (this.input.locked && !this.paused && !this.pilotId) ? this.input.buttons() : 0;
    if (this.grenadeEquipped) buttons &= ~(1 << 8 | 1 << 7);
    const cmds = this.local.step(dt, buttons, { frozen });
    if (cmds.length && this.net.connected) {
      // Resend a few recent commands for loss tolerance.
      const redundant = this.local.history.slice(-Math.min(this.local.history.length, 6));
      this.net.sendInputs(redundant);
    }

    // ADS blend drives the viewmodel, the FOV and the scope.
    const wantAds = !!(buttons & 128) && this.local.alive && !frozen;
    const rw = this.local.rw;
    const adsTime = rw ? rw.adsTime : 0.25;
    this.local.ads = wantAds;
    this.local.adsBlend = THREE.MathUtils.clamp(
      this.local.adsBlend + (wantAds ? dt / adsTime : -dt / (adsTime * 0.75)), 0, 1
    );

    this.viewmodel.update(dt, {
      ads: wantAds,
      adsTime,
      sprinting: this.local.state.sprinting,
      speed: this.local.state.speed,
      onGround: this.local.state.onGround,
      lookDelta: this.local.lookDelta,
      lean: this.local.state.lean,
      landDip: this.local.landDip,
    });

    if (this.phase === PHASE.INTRO && this.introCam.active) {
      // The fly-through owns the camera until it lands on the player's eye.
      const eye = this.local ? eyePosition(this.local.state) : null;
      const settle = eye ? {
        position: this._v.set(eye.x, eye.y, eye.z),
        yaw: this.local.yaw,
        pitch: this.local.pitch,
      } : null;
      if (!this.introCam.update(dt, this.camera, settle)) this.introCam.end();
      this.vmCamera.position.copy(this.camera.position);
      this.vmCamera.quaternion.copy(this.camera.quaternion);
    } else if (this.pilotId) {
      this.updateDroneCamera();
    } else if (this.local.alive || this.phase === PHASE.INTRO) {
      this.local.updateCamera(this.camera, this.vmCamera, dt, this.scope);
    } else {
      this.updateSpectatorCamera(dt);
    }
    this.scope.update(this.local.alive ? this.local.adsBlend : 0, this.camera, this.vmCamera, this.local.fov);
    this.viewmodel.holder.visible = this.local.alive && !this.pilotId;
    if (this.pilotId) this.droneView.setHidden(this.pilotId, true);
    this.grenadeView.update(dt);
    this.droneScanReady = Math.max(0, this.droneScanReady - dt);

    this.droneView.sync(this.droneRows, dt);
    // Our own drone is hidden from us — we are sitting in its camera head.
    this.markView.sync(this.marks, (id) => this.remotes.get(id)?.renderPos || null);

    this.processLocalEvents();

    // Remote entities render on a delay so interpolation always has two
    // snapshots to work with.
    const renderTime = this.serverTime + (performance.now() - this.lastSnapshotAt) / 1000;
    this.remotes.update(dt, renderTime, this.camera);
    for (const p of this.remotes.players.values()) {
      p.setNameplateVisible(
        this.profile.settings.showNameplates && this.match?.teams && p.info.team === this.myTeam
      );
    }

    if (this.training) {
      this.training.update(dt, this.local, this.camera);
      // Offline: the grenades are flown here rather than by a host.
      this.training.stepProjectiles(
        dt,
        (g) => this.grenadeView.sync([[g.id, g.kind, g.pos.x, g.pos.y, g.pos.z, g.fuse]]),
        (g) => this.grenadeView.pop({ id: g.id, kind: g.kind, p: [g.pos.x, g.pos.y, g.pos.z] })
      );
      const stand = this.training.nearStand;
      if (stand !== this._lastStand) {
        this._lastStand = stand;
        if (stand) this.hud.toast(`F — TAKE ${getWeapon(stand.weapon).name}`, 2500);
      }
    }

    // World, effects, listener.
    this.worldView?.update(dt, this.camera.position);
    this.effects.update(dt, this.camera);
    this.renderer.updateShadow(this.camera.position);

    const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(this.camera.quaternion);
    const right = new THREE.Vector3(1, 0, 0).applyQuaternion(this.camera.quaternion);
    this.audio.setListener(this.camera.position, fwd, right);

    this.hurtLevel = Math.max(0, this.hurtLevel - dt * 0.85);
    this.renderer.hurt = this.hurtLevel * 0.55;

    this.updatePhaseTimers(dt);
    this.updateHud(dt);

    this.input.endFrame();
  }

  updatePhaseTimers(dt) {
    if (this.phaseRemaining > 0 && this.phaseRemaining !== Infinity) {
      this.phaseRemaining = Math.max(0, this.phaseRemaining - dt);
    }
    if (this.matchTimeLeft > 0 && this.matchTimeLeft !== Infinity) {
      this.matchTimeLeft = Math.max(0, this.matchTimeLeft - dt);
    }

    if (this.phase === PHASE.INTRO) {
      this.hud.updateIntroCount(this.phaseRemaining);
      this.introCamera(dt);
    } else if (this.phase === PHASE.WARMUP) {
      const secs = Math.ceil(this.phaseRemaining);
      if (secs !== this.lastCountdownBeep && secs <= 5 && secs > 0) {
        this.lastCountdownBeep = secs;
        this.audio.countdownBeep(secs === 1);
        this.hud.toast(String(secs), 700);
      }
    }

  }

  /**
   * Follow a living teammate from just behind and above their shoulder. Falls
   * back to a slow orbit if nobody on the team is left standing.
   */
  updateSpectatorCamera(dt) {
    const target = this.spectateId ? this.remotes.get(this.spectateId) : null;
    if (!target || target.dead) {
      this.introCamera(dt);
      return;
    }
    const p = target.renderPos;
    const yaw = target.smoothYaw;
    const back = 2.6, up = 0.9;
    const want = new THREE.Vector3(
      p.x + Math.sin(yaw) * back,
      p.y + 1.5 + up,
      p.z + Math.cos(yaw) * back
    );
    if (!this._specPos) this._specPos = want.clone();
    this._specPos.lerp(want, 1 - Math.exp(-9 * dt));
    this.camera.position.copy(this._specPos);
    this.camera.rotation.order = 'YXZ';
    this.camera.lookAt(p.x, p.y + 1.35, p.z);
    if (Math.abs(this.camera.fov - this.local.fov) > 0.1) {
      this.camera.fov = this.local.fov;
      this.camera.updateProjectionMatrix();
    }
    this.vmCamera.position.copy(this.camera.position);
    this.vmCamera.quaternion.copy(this.camera.quaternion);
  }

  /** Slow orbit over the map while the banners are shown. */
  introCamera(dt) {
    this.introAngle = (this.introAngle || 0) + dt * 0.05;
    const b = this.mapData.bounds;
    const cx = (b.min[0] + b.max[0]) / 2;
    const cz = (b.min[2] + b.max[2]) / 2;
    const r = (b.max[0] - b.min[0]) * 0.36;
    this.camera.position.set(
      cx + Math.cos(this.introAngle) * r,
      30 + Math.sin(this.introAngle * 1.6) * 8,
      cz + Math.sin(this.introAngle) * r
    );
    this.camera.lookAt(cx, 6, cz);
    this.vmCamera.position.copy(this.camera.position);
    this.vmCamera.quaternion.copy(this.camera.quaternion);
  }

  processLocalEvents() {
    for (const ev of this.local.takeEvents()) {
      if (ev.type === 'shot') {
        const rw = ev.weapon;
        this.viewmodel.applyRecoil(rw.recoil.kick);
        this.viewmodel.muzzleWorld(this._v);
        const muzzleLocal = this.viewmodel.model.muzzle.getWorldPosition(new THREE.Vector3());
        this.effects.flashMuzzle(muzzleLocal, rw.flash, this._v.clone());

        for (const shot of ev.shots) {
          this.effects.tracer(this._v, shot.end, { width: 0.014 });
          if (shot.hit) {
            this.effects.impact(shot.end, shot.hit.normal, shot.hit.box.mat);
            this.audio.impact(shot.hit.box.mat, shot.end);
          }
        }
        this.audio.gunshot(rw.def, null, { suppressed: rw.loud < 0.5, gain: 0.85 });
        this.effects.ejectCasing(
          this._v,
          new THREE.Vector3(1, 0, 0).applyQuaternion(this.camera.quaternion),
          new THREE.Vector3(0, 1, 0)
        );
        if (this.training) this.training.registerShots(ev.eye, ev.shots);
      } else if (ev.type === 'footstep') {
        this.audio.footstep(ev.surface, null, ev.running);
      } else if (ev.type === 'land') {
        this.audio.footstep('concrete', null, true);
      } else if (ev.type === 'swap') {
        this.equipViewmodel();
      }
    }
  }

  updateHud(dt) {
    const l = this.local;
    const rw = l.rw;
    const scope = rw?.scope ?? SCOPES.iron;

    this.hud.update(dt, {
      alive: l.alive,
      health: l.health,
      mag: l.weapon?.mag ?? 0,
      reserve: l.weapon?.reserve ?? 0,
      weaponId: rw?.id,
      weaponClass: rw?.cls,
      slot: l.slot,
      spreadDeg: l.currentSpreadDeg(),
      fov: l.currentFov,
      adsBlend: l.adsBlend,
      scopeId: scope.reticle,
      scopeMag: scope.mag,
      scopeTint: `#${(scope.tint ?? 0xff5540).toString(16).padStart(6, '0')}`,
      scopeReticle: scope.reticle,
      weaponVisible: this.viewmodel.model?.root.visible !== false,
      pipActive: this.scope.active,
      scopeRadius: this.scope.radiusPx,
      sprintHide: l.state.sprinting && l.adsBlend < 0.1,
      zone: this.zoneName || this.currentZone(),
      timeLeft: this.phase === PHASE.LIVE ? this.matchTimeLeft : this.phaseRemaining,
      teams: !!this.match?.teams,
      scores: this.scores,
      myScore: this.roster.get(this.net.id)?.score ?? 0,
      topScore: this.topScore(),
      modeName: this.match?.modeName,
      objectives: this.objectives,
      playerPos: l.state.pos,
      yaw: l.yaw,
      hurt: this.hurtLevel,

      round: this.round,
      roundsToWin: this.match?.roundsToWin ?? 3,
      aliveCounts: this.aliveCounts,
      myTeam: this.myTeam,
      blind: Math.max(0, this.blindUntil - performance.now() / 1000),
      grenadeKind: this.grenadeKind,
      grenadeEquipped: this.grenadeEquipped,
      grenadeStock: this.grenadeStock,
      droneUsed: this.droneUsed,
      droneParked: !!this.myDroneId && !this.pilotId,
      cash: this.cash,
      cashActive: this.cashActive,
      cashoutTime: this.match?.cashoutTime || 75,
      cashGoal: this.cashGoal,
      cashPrompt: this.cashPrompt(),
      myTeam: this.myTeam,
      teamInfo: this.match?.teamInfo || null,
      dronePiloting: !!this.pilotId,
      droneScanCooldown: this.droneScanReady,
      droneScanMax: DRONE.scanCooldown,
      grenadeCooldown: this.grenadeCooldown,
      grenadeCooldownMax: GRENADE_COOLDOWN,
      spectating: !l.alive && this.phase === PHASE.LIVE,
      spectateName: this.roster.get(this.spectateId)?.name || null,
    });
  }

  currentZone() {
    if (!this.mapData || !this.local) return '';
    for (const z of this.mapData.zones) {
      const p = this.local.state.pos;
      if (p.x >= z.x0 && p.x <= z.x1 && p.z >= z.z0 && p.z <= z.z1 && p.y >= z.y0 && p.y <= z.y1) {
        return z.name;
      }
    }
    return this.mapData.name;
  }

  topScore() {
    let top = 0;
    for (const p of this.roster.values()) top = Math.max(top, p.score || 0);
    return top;
  }

  render(dt) {
    this.scope.render();
    this.renderer.render(dt);
  }
}
