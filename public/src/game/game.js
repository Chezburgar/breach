// The game: owns the renderer, the world, the local player, remote players,
// and the match state machine that drives them.

import * as THREE from 'three';
import { FIXED_DT, MATCH, PLAYER, TEAM_INFO, VIEW } from '/shared/constants.js';
import { buildWorld } from '/shared/collision.js';
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
      this.audio.hitmarker(msg.killed);
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
    net.on('capture', (msg) => this.hud.toast(`${msg.name} CAPTURED`, 1600));
    net.on('flagtake', (msg) => this.hud.toast(`${msg.by.name} TOOK THE FLAG`, 1600));
    net.on('flagcap', (msg) => this.hud.toast(`${TEAM_INFO[msg.team].name} SCORED`, 1800));
    net.on('promote', (msg) => this.hud.toast(`PROMOTED — ${getWeapon(msg.weapon).name}`, 1600));
    net.on('match.end', (msg) => this.endMatch(msg));
    net.on('match.over', () => this.leaveMatch());
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
    document.getElementById('pause-settings').addEventListener('click', () => {
      this.paused = false;
      document.getElementById('pause').classList.add('hidden');
      this.menu.show();
      document.querySelector('.tab[data-tab="settings"]').click();
    });
    document.getElementById('click-to-play').addEventListener('click', () => {
      document.getElementById('click-to-play').classList.add('hidden');
      this.input.requestLock();
    });
  }

  // ---------------------------------------------------------------- match
  async startMatch(msg) {
    const mode = getMode(msg.mode);
    await this.setMap(msg.map);

    this.match = {
      mode: msg.mode,
      modeName: mode.name,
      mapName: MAP_INFO[msg.map]?.name || msg.map,
      teams: !!msg.teams,
      scoreLimit: msg.scoreLimit,
      timeLimit: msg.timeLimit,
      players: msg.players,
    };
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
    const rw = this.local.rw;
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
    this.matchTimeLeft = msg.matchTime;

    if (prev === PHASE.INTRO && this.phase !== PHASE.INTRO) {
      this.hud.hideIntro();
      this.audio.stopIntroBed();
    }
    if (this.phase === PHASE.LIVE && prev !== PHASE.LIVE) {
      this.hud.toast('ENGAGE', 1100);
    }
  }

  onSpawn(msg) {
    if (!this.local) return;
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
    this.respawnIn = msg.you.respawnIn ?? 0;
    if (msg.you.zone) this.zoneName = msg.you.zone;

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
    }
  }

  onKill(msg) {
    this.hud.addKill(msg, this.net.id, this.match?.teams);
    this.scores = msg.scores || this.scores;

    if (msg.victim.id === this.net.id) {
      this.hud.showDeath(msg);
      this.audio.hurt();
    } else if (msg.killer?.id === this.net.id) {
      this.hud.toast('ELIMINATED', 900);
    }

    const victim = this.remotes.get(msg.victim.id);
    if (victim) {
      this.effects.blood(
        { x: victim.renderPos.x, y: victim.renderPos.y + 1.1, z: victim.renderPos.z },
        { x: 0, y: 0.4, z: 0 }
      );
    }
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
    const won = this.hud.showVictory(msg, this.net.id, () => this.leaveMatch());
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

  leaveMatch() {
    this.inMatch = false;
    this.phase = PHASE.NONE;
    this.match = null;
    this.local = null;
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
    document.getElementById('click-to-play').classList.add('hidden');
    this.menu.show();
    this.menu.restoreLobby(this.net.id);
  }

  // ------------------------------------------------------------- training
  async enterTraining() {
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

    this.training = new TrainingMode(this.renderer.scene, this.lab, this.mapData, this.effects, this.audio);
    this.training.build();

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
  onLockChange(locked) {
    const hint = document.getElementById('click-to-play');
    if (!this.inMatch) { hint.classList.add('hidden'); return; }
    if (!locked && !this.paused && this.phase !== PHASE.OUTRO) {
      hint.classList.remove('hidden');
    } else {
      hint.classList.add('hidden');
    }
  }

  pause() {
    if (!this.inMatch || this.phase === PHASE.OUTRO) return;
    this.paused = true;
    this.input.releaseLock();
    document.getElementById('pause').classList.remove('hidden');
    document.getElementById('click-to-play').classList.add('hidden');
  }

  resume() {
    this.paused = false;
    document.getElementById('pause').classList.add('hidden');
    this.input.requestLock();
  }

  handleActions() {
    const input = this.input;
    if (!this.local) return;

    if (input.wasPressed('menu')) {
      if (this.paused) this.resume();
      else this.pause();
    }

    const wantBoard = input.isDown('scoreboard');
    if (wantBoard !== this.scoreboardOpen) {
      this.scoreboardOpen = wantBoard;
      this.hud.setScoreboard(wantBoard, {
        ...this.match, scores: this.scores,
      }, this.roster, this.net.id);
    }

    if (!this.local.alive || this.paused) return;

    if (input.wasPressed('reload')) {
      const r = this.local.startReload();
      if (r) {
        this.net.send({ t: 'reload' });
        this.viewmodel.startReload(r.duration, r.empty);
        this.audio.reloadSequence(r.duration, r.empty);
      }
    }
    if (input.wasPressed('primary') && this.local.switchSlot('primary')) {
      this.net.send({ t: 'switch', slot: 'primary' });
      this.equipViewmodel();
    }
    if (input.wasPressed('secondary') && this.local.switchSlot('secondary')) {
      this.net.send({ t: 'switch', slot: 'secondary' });
      this.equipViewmodel();
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

  // ---------------------------------------------------------------- frame
  update(dt) {
    if (!this.inMatch || !this.local) return;

    this.handleActions();

    const frozen = this.paused || this.phase === PHASE.INTRO ||
      this.phase === PHASE.WARMUP || this.phase === PHASE.OUTRO;

    // Look.
    if (this.input.locked && !this.paused && this.phase !== PHASE.OUTRO) {
      const look = this.input.takeLook();
      if (this.phase !== PHASE.INTRO) {
        const adsScale = this.local.adsBlend > 0.1
          ? this.profile.settings.adsSensitivity : 1;
        this.local.applyLook({ x: look.x * adsScale, y: look.y * adsScale }, this.local.adsBlend);
      }
    } else {
      this.input.takeLook();
    }

    // Simulate and send.
    const buttons = (this.input.locked && !this.paused) ? this.input.buttons() : 0;
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

    this.local.updateCamera(this.camera, this.vmCamera, dt, this.scope);
    this.scope.update(this.local.adsBlend, this.camera, this.vmCamera, this.local.fov);

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

    if (this.training) this.training.update(dt, this.local, this.camera);

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

    if (this.local && !this.local.alive && this.phase === PHASE.LIVE) {
      this.hud.updateRespawn(this.respawnIn ?? 0);
    }
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
