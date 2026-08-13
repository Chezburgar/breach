// In-match interface: reticle, vitals, kill feed, scoreboard, the pre-game
// banner intro, the elimination screen and the victory sequence.

import { TEAM_INFO } from '/shared/constants.js';
import { getWeapon } from '/shared/weapons.js';
import { drawBanner, bannerCanvas } from './banners.js';
import { drawCrosshair, drawOpticReticle, drawScopeOverlay } from './reticles.js';

const $ = (id) => document.getElementById(id);

const GRENADE_ORDER = ['frag', 'flash', 'smoke'];
const GRENADE_LABEL = { frag: 'FRAG', flash: 'FLASH', smoke: 'SMOKE' };
const GRENADE_GLYPH = {
  frag: '<svg viewBox="0 0 24 24"><path d="M12 4a1.6 1.6 0 0 1 1.6 1.6V7h1.6l1.2-1.2 1.4 1.4-1.2 1.2v1.2A6 6 0 1 1 9 7.2V5.6A1.6 1.6 0 0 1 10.4 4z"/></svg>',
  flash: '<svg viewBox="0 0 24 24"><path d="M11 3h4l-2.2 6H17l-8 12 2-8H7z"/></svg>',
  smoke: '<svg viewBox="0 0 24 24"><path d="M6 16a4 4 0 0 1 .6-7.9A5 5 0 0 1 16 7a4 4 0 0 1 2 9z"/><rect x="8" y="17" width="9" height="2" rx="1"/></svg>',
};


const DRONE_GLYPH = '<svg viewBox="0 0 24 24"><rect x="6" y="9" width="12" height="6" rx="1.5"/><circle cx="6.5" cy="16.5" r="2.6"/><circle cx="17.5" cy="16.5" r="2.6"/><path d="M11 5h2v4h-2z"/><circle cx="12" cy="4.4" r="2"/></svg>';

export class HUD {
  constructor() {
    this.root = $('hud');
    this.reticle = $('reticle');
    this.scopeCanvas = $('scope-canvas');
    this.scopeOverlay = $('scope-overlay');
    this.compass = $('compass-canvas');
    this.hitmarker = $('hitmarker');
    this.killfeed = $('killfeed');
    this.damageVignette = $('damage-vignette');
    this.dirIndicators = $('dir-indicators');

    this.hitFlash = 0;
    this.feed = [];
    this.toastTimer = 0;
    this.streakTimer = 0;
    this.lastAmmo = -1;
    this.lastHealth = -1;
    this.lastZone = '';
  }

  show() { this.root.classList.remove('hidden'); }
  hide() { this.root.classList.add('hidden'); }

  // ------------------------------------------------------------- per frame
  update(dt, s) {
    // Reticle: hip crosshair, or the optic reticle once aiming.
    const aiming = s.adsBlend > 0.6;
    const mag = s.scopeMag || 1;
    // Irons normally need no reticle — you look over the weapon's own sights.
    // With the weapon hidden there is nothing to look over, so draw one.
    const ironsAlone = s.scopeId === 'iron' && !s.weaponVisible;
    if (aiming && mag < 2 && (s.scopeId !== 'iron' || ironsAlone)) {
      drawOpticReticle(this.reticle, s.scopeId, { tint: s.scopeTint });
    } else if (aiming) {
      // Magnified optic or visible irons: the sight is the aiming reference.
      drawCrosshair(this.reticle, { hidden: true });
    } else {
      // Cone of fire in degrees converted to pixels at the current FOV.
      const px = this.spreadToPixels(s.spreadDeg, s.fov);
      drawCrosshair(this.reticle, {
        spreadPx: px, cls: s.weaponClass, hitFlash: this.hitFlash,
        hidden: !s.alive || s.sprintHide,
      });
    }

    drawScopeOverlay(this.scopeCanvas, {
      visible: s.pipActive,
      radius: s.scopeRadius,
      blend: Math.min(1, Math.max(0, (s.adsBlend - 0.65) / 0.22)),
      reticle: s.scopeReticle,
      tint: s.scopeTint,
      offsetX: s.scopeSway?.x || 0,
      offsetY: s.scopeSway?.y || 0,
    });
    this.scopeOverlay.classList.toggle('hidden', !s.pipActive);

    if (this.hitFlash > 0) this.hitFlash = Math.max(0, this.hitFlash - dt * 2.4);

    // Vitals.
    const hp = Math.max(0, Math.round(s.health));
    if (hp !== this.lastHealth) {
      this.lastHealth = hp;
      $('health-fill').style.width = `${hp}%`;
      $('health-num').textContent = hp;
    }
    if (s.zone !== this.lastZone) {
      this.lastZone = s.zone;
      $('zone-label').textContent = s.zone || '';
    }

    // Ammo.
    const ammoKey = `${s.mag}/${s.reserve}/${s.weaponId}`;
    if (ammoKey !== this.lastAmmo) {
      this.lastAmmo = ammoKey;
      $('ammo-mag').textContent = s.mag;
      $('ammo-reserve').textContent = `/ ${s.reserve}`;
      $('weapon-name').textContent = getWeapon(s.weaponId).name;
      $('ammo-mag').style.color = s.mag === 0 ? 'var(--bad)' : '';
      for (const el of document.querySelectorAll('.weapon-slots .slot')) {
        el.classList.toggle('active', el.dataset.slot === s.slot);
      }
    }
    $('reload-hint').classList.toggle('hidden', !(s.alive && s.mag === 0 && s.reserve > 0));

    // Timer and score.
    $('match-timer').textContent = formatTime(s.timeLeft);
    this.renderScores(s);
    this.renderObjectives(s);
    this.drawCompass(s.yaw, s.objectives, s.playerPos);

    // Damage feedback decay.
    this.damageVignette.style.opacity = String(Math.max(0, s.hurt));

    this.renderFlash(s.blind);
    this.renderGrenades(s);
    this.renderDrone(s);
    this.renderDroneFeed(s);
    this.renderSpectate(s);
  }

  /** Flashbang white-out: instant, then fading back over the blind duration. */
  renderFlash(blind) {
    const el = $('flash-blind');
    if (!blind || blind <= 0) {
      if (this.flashPeak) { this.flashPeak = 0; el.style.opacity = '0'; }
      return;
    }
    this.flashPeak = Math.max(this.flashPeak || 0, blind);
    // Hold near-full white for the first third, then ease off.
    const t = blind / this.flashPeak;
    const a = t > 0.66 ? 0.97 : Math.pow(t / 0.66, 0.8) * 0.97;
    el.style.opacity = String(a);
  }

  renderGrenades(s) {
    const bar = $('grenade-bar');
    const cd = s.grenadeCooldown || 0;
    // Nothing is spent any more — the cooldown is shared across all three,
    // so they are either all ready or all counting down together.
    const key = `${s.grenadeEquipped}|${Math.ceil(cd)}`;
    if (bar.dataset.key !== key) {
      bar.dataset.key = key;
      bar.innerHTML = GRENADE_ORDER.map((k, i) => {
        const have = cd <= 0;
        const active = k === s.grenadeEquipped;
        const pct = cd > 0 ? (cd / (s.grenadeCooldownMax || 15)) * 100 : 0;
        return `<div class="gnd ${active ? 'active' : ''} ${have ? '' : 'spent'}">
            ${GRENADE_GLYPH[k]}
            <span>${GRENADE_LABEL[k]}</span>
            <b>${i + 3}</b>
            <i style="height:${pct}%"></i>
          </div>`;
      }).join('');
    }
  }


  /**
   * The drone chip. One asset, one key, three states — a player should not
   * have to be told in a toast that Z exists.
   */
  renderDrone(s) {
    const el = $('drone-chip');
    const state = s.dronePiloting ? 'flying' : (s.droneUsed ? 'spent' : 'ready');
    const label = s.dronePiloting ? 'RECALL' : (s.droneUsed ? 'SPENT' : 'DRONE');
    if (el.dataset.key !== state) {
      el.dataset.key = state;
      el.className = `drone-chip ${state}`;
      el.innerHTML = `${DRONE_GLYPH}<span>${label}</span><b>Z</b>`;
    }
    el.classList.toggle('hidden', !s.alive);
  }
  /**
   * The feed chrome. The picture is the whole screen, so this is only the
   * edges: what it is, what it can do, and which key does it. The scan
   * prompt is the part that matters — a control nobody can find is not a
   * control.
   */
  renderDroneFeed(s) {
    const el = $('drone-feed');
    el.classList.toggle('hidden', !s.dronePiloting);
    if (!s.dronePiloting) { this.lastScanKey = null; return; }

    const cd = s.droneScanCooldown || 0;
    const max = s.droneScanMax || 2.2;
    const state = cd > 0 ? 'cooling' : 'ready';
    if (state !== this.lastScanKey) {
      this.lastScanKey = state;
      $('df-scan').className = `df-scan ${cd > 0 ? 'cooling' : ''}`;
      $('df-scan').querySelector('span').textContent =
        cd > 0 ? 'RECHARGING' : 'HOLD TO SCAN';
    }
    // The bar drains as the scanner recharges.
    $('df-scan').querySelector('i').style.width = `${Math.max(0, (1 - cd / max)) * 100}%`;
  }

  renderSpectate(s) {
    const bar = $('spectate-bar');
    const on = !!s.spectating && !!s.spectateName;
    bar.classList.toggle('hidden', !on);
    if (on) $('spectate-name').textContent = s.spectateName;
  }

  /** Big centred round announcement. */
  roundBanner(title, sub, ms = 2500) {
    const el = $('round-banner');
    el.innerHTML = `<div class="rb-title">${title}</div><div class="rb-sub">${sub}</div>`;
    el.classList.add('show');
    clearTimeout(this.roundTimer);
    this.roundTimer = setTimeout(() => el.classList.remove('show'), ms);
  }

  spreadToPixels(spreadDeg, fovDeg) {
    const h = window.innerHeight;
    const halfFov = (fovDeg * Math.PI) / 360;
    const pxPerRad = (h / 2) / Math.tan(halfFov);
    return Math.max(3, Math.min(90, Math.tan((spreadDeg * Math.PI) / 180) * pxPerRad * 0.5));
  }

  renderScores(s) {
    const strip = $('score-strip');
    const alive = s.aliveCounts || [0, 0];
    const key = `t${s.scores[0]}:${s.scores[1]}|${alive[0]}:${alive[1]}|r${s.round}`;
    if (strip.dataset.key === key) return;
    strip.dataset.key = key;

    // Round wins, with the number of operators still standing under each.
    const pips = (team) => {
      const need = s.roundsToWin || 3;
      let out = '<div class="round-pips">';
      for (let i = 0; i < need; i++) {
        out += `<i class="${i < s.scores[team] ? (team === 0 ? 'a' : 'b') : ''}"></i>`;
      }
      return `${out}</div>`;
    };
    strip.innerHTML =
      `<div class="side a">${s.scores[0]}${pips(0)}</div>` +
      `<div class="side b">${s.scores[1]}${pips(1)}</div>`;
    $('mode-tag').textContent = `ROUND ${s.round || 1} · ${alive[0]}v${alive[1]} ALIVE`;
  }

  renderObjectives(s) {
    const bar = $('objective-bar');
    if (!s.objectives || !s.objectives.length) {
      if (bar.childElementCount) bar.innerHTML = '';
      return;
    }
    const key = s.objectives.map((o) => `${o.id}${o.owner}${Math.round(o.progress * 10)}${o.contested}`).join('|');
    if (bar.dataset.key === key) return;
    bar.dataset.key = key;
    bar.innerHTML = s.objectives.map((o) => {
      const cls = o.owner === 0 ? 'a' : o.owner === 1 ? 'b' : '';
      return `<div class="obj ${cls} ${o.contested ? 'contested' : ''}">${o.id}` +
        `<i style="width:${Math.round(o.progress * 100)}%"></i></div>`;
    }).join('');
  }

  drawCompass(yaw, objectives, playerPos) {
    const c = this.compass;
    const ctx = c.getContext('2d');
    const w = c.width, h = c.height;
    ctx.clearRect(0, 0, w, h);
    ctx.font = '600 15px Rajdhani, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    const degPerPx = 90 / w;
    const heading = ((-yaw * 180) / Math.PI + 360) % 360;

    const marks = [
      [0, 'N'], [45, ''], [90, 'E'], [135, ''], [180, 'S'], [225, ''], [270, 'W'], [315, ''],
    ];
    for (const [deg, label] of marks) {
      let d = deg - heading;
      while (d > 180) d -= 360;
      while (d < -180) d += 360;
      const x = w / 2 + d / degPerPx;
      if (x < -20 || x > w + 20) continue;
      ctx.globalAlpha = 1 - Math.abs(d) / 60;
      if (label) {
        ctx.fillStyle = '#e8ecf3';
        ctx.fillText(label, x, h * 0.5);
      } else {
        ctx.fillStyle = 'rgba(220,230,245,0.55)';
        ctx.fillRect(x - 1, h * 0.34, 2, h * 0.32);
      }
    }

    if (objectives && playerPos) {
      for (const o of objectives) {
        if (!o.p) continue;
        const bearing = (Math.atan2(-(o.p[0] - playerPos.x), -(o.p[2] - playerPos.z)) * 180) / Math.PI;
        let d = ((-bearing) - heading + 540) % 360 - 180;
        const x = w / 2 + d / degPerPx;
        if (x < 0 || x > w) continue;
        ctx.globalAlpha = 0.95;
        ctx.fillStyle = o.owner === 0 ? '#ff6a3d' : o.owner === 1 ? '#39b7ff' : '#ffc24a';
        ctx.fillText(o.id, x, h * 0.5);
      }
    }
    ctx.globalAlpha = 1;
  }

  // -------------------------------------------------------------- feedback
  hit(zone, killed) {
    this.hitmarker.classList.remove('show', 'kill');
    void this.hitmarker.offsetWidth;
    this.hitmarker.classList.add('show');
    if (killed) this.hitmarker.classList.add('kill');
    this.hitFlash = killed ? 1 : 0.55;
    void zone;
  }

  damageFrom(angleRad) {
    const el = document.createElement('i');
    el.className = 'dir-hit';
    el.style.transform = `rotate(${angleRad}rad) translateY(-96px)`;
    this.dirIndicators.appendChild(el);
    setTimeout(() => el.remove(), 1000);
  }

  toast(text, ms = 1500) {
    const el = $('center-toast');
    el.textContent = text;
    el.classList.add('show');
    clearTimeout(this.toastTimer);
    this.toastTimer = setTimeout(() => el.classList.remove('show'), ms);
  }

  streak(text, ms = 2200) {
    const el = $('streak-toast');
    el.textContent = text;
    el.classList.add('show');
    clearTimeout(this.streakTimer);
    this.streakTimer = setTimeout(() => el.classList.remove('show'), ms);
  }

  // ------------------------------------------------------------ kill feed
  addKill(ev, localId, teamsMode) {
    const row = document.createElement('div');
    row.className = 'kf-row';
    const mine = ev.killer?.id === localId || ev.victim?.id === localId;
    if (mine) row.classList.add('mine');

    if (ev.killer) {
      const bc = bannerCanvas(ev.killer.banner, 74, { team: teamsMode ? ev.killer.team : undefined });
      row.appendChild(bc);
      const name = document.createElement('span');
      name.className = `kf-name ${teamsMode ? (ev.killer.team === 0 ? 'a' : 'b') : ''}`;
      name.textContent = ev.killer.name;
      row.appendChild(name);
    }

    const icon = document.createElement('span');
    icon.className = 'kf-icon';
    icon.innerHTML = weaponGlyph(ev.weapon);
    row.appendChild(icon);

    if (ev.headshot) {
      const hs = document.createElement('span');
      hs.className = 'kf-hs';
      hs.textContent = 'HS';
      row.appendChild(hs);
    }

    const victim = document.createElement('span');
    victim.className = `kf-name ${teamsMode ? (ev.victim.team === 0 ? 'a' : 'b') : ''}`;
    victim.textContent = ev.victim.name;
    row.appendChild(victim);

    this.killfeed.appendChild(row);
    this.feed.push(row);
    while (this.feed.length > 6) this.feed.shift().remove();
    setTimeout(() => { row.remove(); this.feed = this.feed.filter((r) => r !== row); }, 7000);
  }

  // ---------------------------------------------------------- death screen
  showDeath(ev) {
    const screen = $('death-screen');
    const holder = $('death-banner');
    holder.innerHTML = '';

    if (ev.killer) {
      const c = document.createElement('canvas');
      c.style.width = '440px';
      c.width = 880;
      c.height = Math.round(880 / 3.44);
      holder.appendChild(c);
      drawBanner(c, ev.killer.banner, {
        name: ev.killer.name,
        level: ev.killer.level,
        team: ev.killer.team >= 0 ? ev.killer.team : undefined,
      });
      $('death-meta').innerHTML =
        `<b>${getWeapon(ev.weapon).name}</b> · ${ev.distance}m${ev.headshot ? ' · <b>HEADSHOT</b>' : ''}`;
      document.querySelector('.death-label').textContent = 'ELIMINATED BY';
    } else {
      $('death-meta').textContent = ev.weapon === 'fall' ? 'You fell.' : 'You were eliminated.';
      document.querySelector('.death-label').textContent = 'ELIMINATED';
    }
    screen.classList.remove('hidden');
  }

  /** Take the banner down in `seconds`, so the dead player can spectate. */
  autoHideDeath(seconds) {
    clearTimeout(this.deathTimer);
    this.deathTimer = setTimeout(() => this.hideDeath(), seconds * 1000);
  }

  updateRespawn(seconds) {
    $('respawn-count').textContent = seconds > 0
      ? `RESPAWNING IN ${seconds.toFixed(1)}`
      : 'RESPAWNING…';
  }

  hideDeath() {
    clearTimeout(this.deathTimer);
    this.deathTimer = null;
    $('death-screen').classList.add('hidden');
  }

  // ----------------------------------------------------------- intro cards
  showIntro(match, localId) {
    const intro = $('intro');
    $('intro-mode').textContent = match.modeName;
    $('intro-map').textContent = match.mapName;

    const a = $('intro-team-a');
    const b = $('intro-team-b');
    a.innerHTML = ''; b.innerHTML = '';
    b.classList.add('right');

    const teams = match.teams
      ? [match.players.filter((p) => p.team === 0), match.players.filter((p) => p.team === 1)]
      : [match.players.slice(0, Math.ceil(match.players.length / 2)),
         match.players.slice(Math.ceil(match.players.length / 2))];

    teams.forEach((list, side) => {
      const host = side === 0 ? a : b;
      list.forEach((p, i) => {
        const card = document.createElement('div');
        card.className = 'intro-card';
        card.style.animationDelay = `${0.25 + i * 0.12 + side * 0.06}s`;
        const c = bannerCanvas(p.banner, 150, { team: match.teams ? p.team : undefined });
        const who = document.createElement('div');
        who.className = 'who';
        who.innerHTML = `<b>${escapeHtml(p.name)}</b><span>LEVEL ${p.level}${p.bot ? ' · AI' : ''}</span>`;
        if (p.id === localId) card.style.borderColor = 'var(--warn)';
        card.appendChild(c);
        card.appendChild(who);
        host.appendChild(card);
      });
    });

    if (match.teams) {
      document.querySelector('.intro-vs').textContent = 'VS';
    } else {
      document.querySelector('.intro-vs').textContent = 'FFA';
    }
    intro.classList.remove('hidden');
  }

  updateIntroCount(seconds) {
    $('intro-count').textContent = seconds > 0
      ? `DEPLOYING IN ${Math.ceil(seconds)}`
      : 'GO';
  }

  hideIntro() { $('intro').classList.add('hidden'); }

  // -------------------------------------------------------------- victory
  showVictory(payload, localId, onContinue) {
    const el = $('victory');
    const won = payload.result === 'team'
      ? payload.board.find((p) => p.id === localId)?.team === payload.winnerTeam
      : payload.winner?.id === localId;

    const title = $('victory-title');
    title.textContent = payload.result === 'draw' ? 'DRAW' : (won ? 'VICTORY' : 'DEFEAT');
    title.classList.toggle('defeat', !won && payload.result !== 'draw');

    const holder = $('victory-banner');
    holder.innerHTML = '';
    if (payload.winnerBanner) {
      const c = document.createElement('canvas');
      c.style.width = '460px';
      c.width = 920;
      c.height = Math.round(920 / 3.44);
      holder.appendChild(c);
      drawBanner(c, payload.winnerBanner, {
        name: payload.winnerName,
        team: payload.winnerTeam ?? undefined,
      });
    }
    $('victory-name').textContent = payload.result === 'team'
      ? `${TEAM_INFO[payload.winnerTeam].name} WINS`
      : (payload.winnerName ? `${payload.winnerName} TAKES IT` : '');

    const board = $('victory-board');
    board.innerHTML =
      '<tr><th>OPERATOR</th><th>SCORE</th><th>K</th><th>D</th><th>A</th><th>DMG</th><th>XP</th></tr>' +
      payload.board.map((p) => {
        const cls = payload.winnerTeam != null ? (p.team === 0 ? 'a' : 'b') : '';
        return `<tr class="${p.id === localId ? 'me' : ''}">` +
          `<td class="nm ${cls}">${escapeHtml(p.name)}${p.bot ? ' <span class="muted">AI</span>' : ''}</td>` +
          `<td>${p.score}</td><td>${p.kills}</td><td>${p.deaths}</td><td>${p.assists}</td>` +
          `<td>${p.damage}</td><td>+${p.xp}</td></tr>`;
      }).join('');

    const mine = payload.board.find((p) => p.id === localId);
    $('victory-xp').textContent = mine ? `+${mine.xp} XP EARNED` : '';

    el.classList.remove('hidden');

    // `onContinue` is `{ again, leave, canRestart }`.
    const again = $('victory-again');
    const leave = $('victory-leave');
    const wait = $('victory-wait');
    again.classList.toggle('hidden', !onContinue?.canRestart);
    wait.classList.toggle('hidden', !!onContinue?.canRestart);
    again.onclick = () => { el.classList.add('hidden'); onContinue?.again?.(); };
    leave.onclick = () => { el.classList.add('hidden'); onContinue?.leave?.(); };
    return won;
  }

  hideVictory() { $('victory').classList.add('hidden'); }

  // ----------------------------------------------------------- scoreboard
  setScoreboard(visible, match, roster, localId) {
    const el = $('scoreboard');
    el.classList.toggle('hidden', !visible);
    if (!visible) return;

    $('sb-mode').textContent = `${match.modeName} · ${match.mapName}`;
    $('sb-score').textContent = match.teams
      ? `${match.scores[0]} — ${match.scores[1]}`
      : `${match.players.length} OPERATORS`;

    const cols = $('sb-cols');
    cols.classList.toggle('solo', !match.teams);
    const list = [...roster.values()].sort((a, b) => b.score - a.score || b.kills - a.kills);

    const table = (players, teamId) => {
      const head = teamId != null
        ? `<div class="sb-team" style="color:${TEAM_INFO[teamId].color};font-size:12px;letter-spacing:.24em;margin-bottom:6px">${TEAM_INFO[teamId].name}</div>`
        : '';
      return head + '<table class="board"><tr><th>OPERATOR</th><th>SCORE</th><th>K</th><th>D</th><th>A</th></tr>' +
        players.map((p) => `<tr class="${p.id === localId ? 'me' : ''}">` +
          `<td class="nm ${teamId === 0 ? 'a' : teamId === 1 ? 'b' : ''}">${escapeHtml(p.name)}` +
          `${p.bot ? ' <span class="muted">AI</span>' : ''}</td>` +
          `<td>${p.score}</td><td>${p.kills}</td><td>${p.deaths}</td><td>${p.assists}</td></tr>`).join('') +
        '</table>';
    };

    cols.innerHTML = match.teams
      ? `<div>${table(list.filter((p) => p.team === 0), 0)}</div><div>${table(list.filter((p) => p.team === 1), 1)}</div>`
      : `<div>${table(list, null)}</div>`;
  }
}

function formatTime(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return '--:--';
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/** Tiny inline weapon silhouettes for the kill feed. */
function weaponGlyph(id) {
  const w = getWeapon(id);
  const long = w.cls === 'Marksman Rifle' || w.cls === 'LMG';
  const short = w.cls === 'Sidearm';
  const body = short ? 'M2 8h11v3H2z M4 11h3v4H4z' : (long
    ? 'M1 8h22v3H1z M5 11h3v3H5z M15 6h4v2h-4z'
    : 'M2 8h18v3H2z M5 11h3v3H5z M13 6h3v2h-3z');
  if (id === 'melee') {
    return '<svg viewBox="0 0 26 16" fill="#cfd8e6"><path d="M3 12l10-9 2 2-9 10z"/></svg>';
  }
  if (id === 'fall') {
    return '<svg viewBox="0 0 26 16" fill="#cfd8e6"><path d="M13 2l4 8h-8z M11 11h4v3h-4z"/></svg>';
  }
  return `<svg viewBox="0 0 26 16" fill="#cfd8e6"><path d="${body}"/></svg>`;
}
