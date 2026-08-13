// Front end: play menu, loadout editor, profile, settings, party and lobby.

import { MODES, QUICKPLAY_MODES } from '../../shared/modes.js';
import {
  PRIMARIES, SECONDARIES, SCOPES, MUZZLES, GRIPS, LASERS,
  getWeapon, resolveWeapon, sanitizeLoadout,
} from '../../shared/weapons.js';
import { DEFAULT_BANNER, DEFAULT_FANFARE, levelFromXp, xpForLevel, randomName, sanitizeName } from '../../shared/cosmetics.js';
import { QUALITY_PRESETS } from '../engine/renderer.js';
import { allBanners, drawBanner, bannerFromFile, registerBanner } from './banners.js';

const $ = (id) => document.getElementById(id);
const STORE_KEY = 'breach.profile.v1';

export function loadProfile() {
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem(STORE_KEY) || '{}'); } catch { saved = {}; }
  const profile = {
    name: sanitizeName(saved.name) || randomName(),
    banner: saved.banner || DEFAULT_BANNER,
    // The player's own artwork, kept with the profile so it survives a reload
    // and can be handed to everyone else when they join a match.
    uploadedBanner: saved.uploadedBanner || null,
    fanfare: saved.fanfare || DEFAULT_FANFARE,
    xp: Number.isFinite(saved.xp) ? saved.xp : 0,
    loadout: sanitizeLoadout(saved.loadout),
    settings: {
      sensitivity: 0.42,
      adsSensitivity: 0.8,
      invertY: false,
      fov: 90,
      quality: 'medium',
      autoQuality: true,
      masterVolume: 0.8,
      sfxVolume: 1.0,
      musicVolume: 0.7,
      showNameplates: true,
      ...(saved.settings || {}),
    },
  };
  profile.level = levelFromXp(profile.xp);
  return profile;
}

export function saveProfile(p) {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify({
      name: p.name, banner: p.banner, fanfare: p.fanfare, xp: p.xp,
      loadout: p.loadout, settings: p.settings,
      uploadedBanner: p.uploadedBanner || null,
    }));
  } catch { /* storage disabled — the session still works */ }
}

export class Menu {
  constructor({ profile, net, audio, onPlay, onTraining, onQuality, onProfileChange,
                onHost, onJoinCode, onLeaveLobby, onAutoQuality }) {
    this.profile = profile;
    this.net = net;
    this.audio = audio;
    this.onPlay = onPlay;
    this.onTraining = onTraining;
    this.onQuality = onQuality;
    this.onProfileChange = onProfileChange;
    this.onHost = onHost;
    this.onJoinCode = onJoinCode;
    this.onLeaveLobby = onLeaveLobby;
    this.onAutoQuality = onAutoQuality;

    this.el = $('menu');
    this.editingSlot = 'primary';
    this.selectedWeapon = profile.loadout.primary.id;
    this.group = null;

    this.buildTabs();
    this.buildPlay();
    this.buildProfileTab();
    this.buildSettings();
    this.buildLobby();
    this.refreshChip();
    this.renderLoadout();
  }

  show() { this.el.classList.remove('hidden'); }
  hide() { this.el.classList.add('hidden'); }
  get visible() { return !this.el.classList.contains('hidden'); }

  click(kind = 'ui') { this.audio?.click(kind); }

  // ------------------------------------------------------------------ tabs
  buildTabs() {
    for (const tab of document.querySelectorAll('.menu-tabs .tab')) {
      tab.addEventListener('click', () => {
        this.click();
        for (const t of document.querySelectorAll('.menu-tabs .tab')) t.classList.remove('active');
        for (const p of document.querySelectorAll('.panel')) p.classList.remove('active');
        tab.classList.add('active');
        $(`tab-${tab.dataset.tab}`).classList.add('active');
      });
    }
    $('profile-chip').addEventListener('click', () => {
      document.querySelector('.tab[data-tab="profile"]').click();
    });
  }

  refreshChip() {
    this.profile.level = levelFromXp(this.profile.xp);
    $('chip-name').textContent = this.profile.name;
    const next = xpForLevel(this.profile.level + 1);
    const cur = xpForLevel(this.profile.level);
    const pct = Math.round(((this.profile.xp - cur) / Math.max(1, next - cur)) * 100);
    $('chip-level').textContent = `LV ${this.profile.level} · ${pct}%`;
    drawBanner(document.querySelector('#profile-chip .chip-banner'), this.profile.banner, {});
  }

  setOnline(n) {
    $('online-count').textContent = n != null ? `${n} ONLINE` : '';
  }

  // ------------------------------------------------------------------ play
  buildPlay() {
    const list = $('mode-list');
    list.innerHTML = '';
    const order = [...QUICKPLAY_MODES, ...Object.keys(MODES).filter((m) => !QUICKPLAY_MODES.includes(m))];
    for (const id of order) {
      const m = MODES[id];
      const card = document.createElement('div');
      card.className = 'mode-card';
      card.innerHTML =
        `<div class="short">${m.short}</div><h4>${m.name}</h4><p>${m.blurb}</p>` +
        `<div class="meta">${m.teams ? '5V5' : 'FREE FOR ALL'} · UP TO ${m.maxPlayers}</div>`;
      card.addEventListener('click', (e) => {
        // A button keeps keyboard focus after a click, so Space re-fires it.
        // Dropping focus is what stops the whole thing being spammable from
        // the keyboard while the search screen is already up.
        e.currentTarget.blur?.();
        if (this.connecting) return;
        this.click();
        this.onPlay(id);
      });
      list.appendChild(card);
    }

    $('party-join').addEventListener('click', (e) => {
      e.currentTarget.blur();
      if (this.connecting) return;
      const code = $('party-code').value.trim().toUpperCase();
      if (!code) return this.click('error');
      this.click();
      this.onJoinCode?.(code);
    });
    $('private-create').addEventListener('click', (e) => {
      e.currentTarget.blur();
      if (this.connecting) return;
      this.click();
      this.onHost?.();
    });
    $('open-training').addEventListener('click', () => {
      this.click();
      this.onTraining();
    });
  }

  // --------------------------------------------------------------- loadout
  renderLoadout() {
    const list = $('weapon-list');
    list.innerHTML = '';

    const toggle = document.createElement('div');
    toggle.className = 'slot-toggle';
    for (const slot of ['primary', 'secondary']) {
      const b = document.createElement('button');
      b.className = `btn ${this.editingSlot === slot ? 'primary' : ''}`;
      b.textContent = slot.toUpperCase();
      b.addEventListener('click', () => {
        this.click();
        this.editingSlot = slot;
        this.selectedWeapon = this.profile.loadout[slot].id;
        this.renderLoadout();
      });
      toggle.appendChild(b);
    }
    list.appendChild(toggle);

    const pool = this.editingSlot === 'primary' ? PRIMARIES : SECONDARIES;
    const groups = new Map();
    for (const w of pool) {
      if (!groups.has(w.cls)) groups.set(w.cls, []);
      groups.get(w.cls).push(w);
    }
    for (const [cls, weapons] of groups) {
      const h = document.createElement('div');
      h.className = 'wl-group';
      h.textContent = cls.toUpperCase();
      list.appendChild(h);
      for (const w of weapons) {
        const item = document.createElement('div');
        item.className = `wl-item ${w.id === this.selectedWeapon ? 'active' : ''}`;
        item.innerHTML = `<b>${w.name}</b><span>${w.rpm} RPM · ${w.damage}</span>`;
        item.addEventListener('click', () => {
          this.click();
          this.selectedWeapon = w.id;
          this.profile.loadout[this.editingSlot] = sanitizeLoadout({
            ...this.profile.loadout,
            [this.editingSlot]: { ...this.profile.loadout[this.editingSlot], id: w.id },
          })[this.editingSlot];
          this.commitLoadout();
          this.renderLoadout();
        });
        list.appendChild(item);
      }
    }

    this.renderWeaponDetail();
  }

  renderWeaponDetail() {
    const host = $('weapon-detail');
    const cfg = this.profile.loadout[this.editingSlot];
    const w = getWeapon(this.selectedWeapon);
    const equipped = cfg.id === w.id;
    const rw = resolveWeapon(equipped ? cfg : { id: w.id, scope: w.defaultScope });

    const stat = (label, value, max, text) => `
      <div class="stat">
        <label>${label}</label>
        <div class="track"><i style="width:${Math.round(Math.min(1, value / max) * 100)}%"></i></div>
        <b>${text}</b>
      </div>`;

    host.innerHTML = `
      <div class="wd-head"><h2>${w.name}</h2><span class="cls">${w.cls}</span></div>
      <div class="stat-grid">
        ${stat('DAMAGE', w.damage * w.pellets, 120, String(w.damage * (w.pellets > 1 ? w.pellets : 1)))}
        ${stat('FIRE RATE', w.rpm, 1200, `${w.rpm}`)}
        ${stat('MAGAZINE', w.mag, 100, `${w.mag}`)}
        ${stat('MOBILITY', w.mobility, 1, `${Math.round(w.mobility * 100)}`)}
        ${stat('RANGE', w.falloff.end, 95, `${w.falloff.end}m`)}
        ${stat('CONTROL', 2.2 - w.recoil.vert, 2.2, `${Math.round((2.2 - w.recoil.vert) / 2.2 * 100)}`)}
      </div>
      <div class="attach-row"><h3>OPTIC</h3><div class="chips" id="chip-scope"></div></div>
      <div class="attach-row"><h3>MUZZLE</h3><div class="chips" id="chip-muzzle"></div></div>
      ${this.editingSlot === 'primary' ? '<div class="attach-row"><h3>GRIP</h3><div class="chips" id="chip-grip"></div></div>' : ''}
      <div class="attach-row"><h3>LASER</h3><div class="chips" id="chip-laser"></div></div>
      <div class="attach-row muted">Aim-down-sight time ${(rw.adsTime * 1000).toFixed(0)}ms ·
        time to kill ${(w.ttk * 1000).toFixed(0)}ms · optic zoom ${rw.scope.mag.toFixed(1)}x</div>
    `;

    if (!equipped) {
      // Selecting a weapon equips it, so this branch only shows briefly.
      return;
    }

    const chips = (hostId, options, current, key) => {
      const el = $(hostId);
      if (!el) return;
      el.innerHTML = '';
      for (const opt of options) {
        const c = document.createElement('div');
        c.className = `chip ${opt.id === current ? 'active' : ''}`;
        c.textContent = opt.name;
        c.addEventListener('click', () => {
          this.click();
          cfg[key] = opt.id;
          this.profile.loadout = sanitizeLoadout(this.profile.loadout);
          this.commitLoadout();
          this.renderWeaponDetail();
        });
        el.appendChild(c);
      }
    };

    chips('chip-scope', w.scopes.map((s) => SCOPES[s]), cfg.scope, 'scope');
    chips('chip-muzzle', Object.values(MUZZLES), cfg.muzzle, 'muzzle');
    if (this.editingSlot === 'primary') chips('chip-grip', Object.values(GRIPS), cfg.grip, 'grip');
    chips('chip-laser', Object.values(LASERS), cfg.laser, 'laser');
  }

  commitLoadout() {
    this.profile.loadout = sanitizeLoadout(this.profile.loadout);
    saveProfile(this.profile);
    this.onProfileChange?.();
  }

  // --------------------------------------------------------------- profile
  buildProfileTab() {
    const nameInput = $('name-input');
    nameInput.value = this.profile.name;
    nameInput.addEventListener('change', () => {
      const clean = sanitizeName(nameInput.value);
      this.profile.name = clean || randomName();
      nameInput.value = this.profile.name;
      saveProfile(this.profile);
      this.refreshChip();
      this.onProfileChange?.();
    });

    const upload = $('banner-upload');
    const picker = $('banner-file');
    upload.onclick = () => { this.click(); picker.value = ''; picker.click(); };
    picker.onchange = async () => {
      const file = picker.files?.[0];
      if (!file) return;
      try {
        const def = await bannerFromFile(file);
        await registerBanner(def);
        // Keep one upload at a time — the artwork travels to every other
        // player in the lobby, and a gallery of them is a lot to push down a
        // data channel for a picture only one person is wearing.
        this.profile.uploadedBanner = def;
        this.profile.banner = def.id;
        saveProfile(this.profile);
        this.buildProfileTab();
        this.refreshChip();
        this.onProfileChange?.();
        this.toast(`Banner "${def.name}" uploaded.`);
      } catch (err) {
        this.toast(err.message || 'Could not use that image.', true);
      }
    };

    const grid = $('banner-grid');
    grid.innerHTML = '';
    for (const b of allBanners()) {
      const opt = document.createElement('div');
      opt.className = `banner-opt ${b.id === this.profile.banner ? 'active' : ''}`;
      const c = document.createElement('canvas');
      c.width = 360;
      c.height = Math.round(360 / 3.44);
      opt.appendChild(c);
      const label = document.createElement('div');
      label.className = 'bn';
      label.textContent = b.name;
      opt.appendChild(label);
      requestAnimationFrame(() => drawBanner(c, b, {}));
      opt.addEventListener('click', () => {
        this.click();
        this.profile.banner = b.id;
        saveProfile(this.profile);
        this.refreshChip();
        this.onProfileChange?.();
        for (const o of grid.children) o.classList.remove('active');
        opt.classList.add('active');
      });
      grid.appendChild(opt);
    }

    this.renderFanfares();
  }

  renderFanfares() {
    const host = $('fanfare-list');
    host.innerHTML = '';
    const list = this.audio?.fanfareList?.() || [];
    for (const f of list) {
      const row = document.createElement('div');
      row.className = `fanfare-opt ${f.id === this.profile.fanfare ? 'active' : ''}`;
      row.innerHTML = `<span>${f.name}</span>`;
      const play = document.createElement('button');
      play.className = 'btn tiny';
      play.textContent = 'PREVIEW';
      play.addEventListener('click', (e) => {
        e.stopPropagation();
        this.audio?.playFanfare(f.id);
      });
      row.appendChild(play);
      row.addEventListener('click', () => {
        this.click();
        this.profile.fanfare = f.id;
        saveProfile(this.profile);
        this.onProfileChange?.();
        for (const o of host.children) o.classList.remove('active');
        row.classList.add('active');
      });
      host.appendChild(row);
    }
    if (!list.length) {
      host.innerHTML = '<p class="muted">No fanfares available.</p>';
    }
  }

  // -------------------------------------------------------------- settings
  buildSettings() {
    const grid = $('settings-grid');
    grid.innerHTML = '';
    const s = this.profile.settings;

    const slider = (label, key, min, max, step, format, onChange) => {
      const row = document.createElement('div');
      row.className = 'setting';
      row.innerHTML = `<label>${label}</label>
        <input type="range" min="${min}" max="${max}" step="${step}" value="${s[key]}">
        <b>${format(s[key])}</b>`;
      const input = row.querySelector('input');
      const out = row.querySelector('b');
      input.addEventListener('input', () => {
        s[key] = parseFloat(input.value);
        out.textContent = format(s[key]);
        onChange?.(s[key]);
        saveProfile(this.profile);
      });
      grid.appendChild(row);
    };

    const select = (label, key, options, onChange, hint) => {
      const row = document.createElement('div');
      row.className = 'setting';
      row.innerHTML = `<label>${label}</label>
        <select>${options.map((o) => `<option value="${o.value}" ${s[key] === o.value ? 'selected' : ''}>${o.label}</option>`).join('')}</select><b></b>
        ${hint ? `<div class="hint">${hint}</div>` : ''}`;
      const sel = row.querySelector('select');
      sel.addEventListener('change', () => {
        s[key] = sel.value;
        onChange?.(sel.value);
        saveProfile(this.profile);
      });
      grid.appendChild(row);
    };

    const toggle = (label, key, onChange) => {
      const row = document.createElement('div');
      row.className = 'setting';
      row.innerHTML = `<label>${label}</label>
        <input type="range" min="0" max="1" step="1" value="${s[key] ? 1 : 0}">
        <b>${s[key] ? 'ON' : 'OFF'}</b>`;
      const input = row.querySelector('input');
      const out = row.querySelector('b');
      input.addEventListener('input', () => {
        s[key] = input.value === '1';
        out.textContent = s[key] ? 'ON' : 'OFF';
        onChange?.(s[key]);
        saveProfile(this.profile);
      });
      grid.appendChild(row);
    };

    slider('MOUSE SENSITIVITY', 'sensitivity', 0.05, 2.0, 0.01, (v) => v.toFixed(2));
    slider('ADS SENSITIVITY', 'adsSensitivity', 0.2, 1.5, 0.01, (v) => v.toFixed(2));
    toggle('INVERT VERTICAL', 'invertY');
    slider('FIELD OF VIEW', 'fov', 70, 110, 1, (v) => `${v}°`);
    select('GRAPHICS QUALITY', 'quality',
      Object.keys(QUALITY_PRESETS).map((q) => ({ value: q, label: q.toUpperCase() })),
      (v) => this.onQuality?.(v),
      'Ultra enables 4K shadows, higher-resolution materials and denser ambient occlusion.');
    toggle('AUTO-ADJUST QUALITY', 'autoQuality', (v) => { this.onAutoQuality?.(v); });
    slider('MASTER VOLUME', 'masterVolume', 0, 1, 0.01, (v) => `${Math.round(v * 100)}`,
      (v) => this.audio?.setVolume('master', v));
    slider('EFFECTS VOLUME', 'sfxVolume', 0, 1, 0.01, (v) => `${Math.round(v * 100)}`,
      (v) => this.audio?.setVolume('sfx', v));
    slider('MUSIC VOLUME', 'musicVolume', 0, 1, 0.01, (v) => `${Math.round(v * 100)}`,
      (v) => this.audio?.setVolume('music', v));
    toggle('TEAMMATE NAMEPLATES', 'showNameplates');
  }

  // ----------------------------------------------------------------- lobby
  buildLobby() {
    $('lobby-leave').addEventListener('click', () => {
      this.click('back');
      this.onLeaveLobby?.();
    });
    $('lobby-start').addEventListener('click', () => {
      this.click();
      this.net.send({ t: 'group.start' });
    });
    $('copy-code').addEventListener('click', async () => {
      this.click();
      try { await navigator.clipboard.writeText(this.group?.code || ''); } catch { /* denied */ }
    });
    $('search-cancel').addEventListener('click', () => {
      this.click('back');
      this.onLeaveLobby?.();
      this.setSearching(false);
    });
  }

  setGroup(group, localId) {
    this.group = group;
    const el = $('lobby');
    if (!group) { el.classList.add('hidden'); return; }

    const isLeader = group.leaderId === localId;
    $('lobby-title').textContent = 'PRIVATE MATCH';
    $('lobby-code').textContent = group.code;

    const members = $('lobby-members');
    members.innerHTML = '';
    for (const m of group.members) {
      const row = document.createElement('div');
      row.className = 'lm';
      const c = document.createElement('canvas');
      c.width = 192; c.height = Math.round(192 / 3.44);
      c.style.width = '96px';
      row.appendChild(c);
      drawBanner(c, m.banner, {});
      const b = document.createElement('b');
      b.textContent = m.name;
      row.appendChild(b);
      if (m.id === group.leaderId) {
        const tag = document.createElement('span');
        tag.className = 'tagl';
        tag.textContent = 'LEADER';
        row.appendChild(tag);
      }
      members.appendChild(row);
    }

    const cfg = $('lobby-config');
    {
      cfg.innerHTML = `
        <h3>MODE</h3>
        <div class="chips" id="lobby-modes"></div>
        <h3 style="margin-top:16px">BOTS</h3>
        <div class="setting" style="grid-template-columns:1fr 120px 40px">
          <label>FILL WITH</label>
          <input type="range" min="0" max="9" step="1" value="${group.bots}" ${isLeader ? '' : 'disabled'}>
          <b>${group.bots}</b>
        </div>`;
      const modes = $('lobby-modes');
      for (const id of Object.keys(MODES)) {
        const chip = document.createElement('div');
        chip.className = `chip ${group.mode === id ? 'active' : ''}`;
        chip.textContent = MODES[id].short;
        if (isLeader) {
          chip.addEventListener('click', () => {
            this.click();
            this.net.send({ t: 'group.config', mode: id });
          });
        }
        modes.appendChild(chip);
      }
      const range = cfg.querySelector('input');
      if (range && isLeader) {
        range.addEventListener('change', () => {
          this.net.send({ t: 'group.config', bots: parseInt(range.value, 10) });
        });
      }
      $('lobby-start').classList.toggle('hidden', !isLeader);
      $('lobby-start').textContent = 'START MATCH';
    }

    el.classList.remove('hidden');
  }

  /** Tuck the lobby away while a match is running, without forgetting it. */
  hideLobby() { $('lobby').classList.add('hidden'); }

  restoreLobby(localId) {
    if (this.group) this.setGroup(this.group, localId);
  }

  /**
   * The waiting room. Shows the banner of everyone who has turned up and how
   * long until bots fill the rest — deliberately not a party screen.
   */
  setSearching(on, info = {}) {
    const el = $('searching');
    el.classList.toggle('hidden', !on);
    if (!on) { this._searchKey = null; return; }

    $('search-mode').textContent = (MODES[info.mode]?.name || 'FINDING A MATCH').toUpperCase();
    const found = info.found ?? 0;
    const target = info.target ?? 10;
    $('search-meta').textContent = found
      ? `${found} of ${target} operators · searching ${info.wait || 0}s`
      : 'looking for operators…';

    const left = Math.max(0, (info.fillAt ?? 0) - (info.wait ?? 0));
    $('search-fill').textContent = found && left > 0
      ? `FILLING WITH AI IN ${left}s`
      : (found ? 'STARTING…' : '');

    const members = info.members || [];
    const key = members.map((m) => `${m.id}:${m.banner}`).join('|') + `|${target}`;
    if (this._searchKey === key) return;
    this._searchKey = key;

    const host = $('search-roster');
    host.innerHTML = '';
    for (const m of members) {
      const slot = document.createElement('div');
      slot.className = 'sr-slot';
      const c = document.createElement('canvas');
      c.width = 280; c.height = Math.round(280 / 3.44);
      slot.appendChild(c);
      const name = document.createElement('div');
      name.className = 'sr-name';
      name.textContent = m.name;
      slot.appendChild(name);
      host.appendChild(slot);
      drawBanner(c, m.banner, {});
    }
    for (let i = members.length; i < Math.min(target, 10); i++) {
      const slot = document.createElement('div');
      slot.className = 'sr-slot empty';
      slot.textContent = 'OPEN';
      host.appendChild(slot);
    }
  }

  toast(text, bad) {
    const host = $('toasts');
    const el = document.createElement('div');
    el.className = `toast ${bad ? 'bad' : ''}`;
    el.textContent = text;
    host.appendChild(el);
    setTimeout(() => el.remove(), 3200);
  }
}
