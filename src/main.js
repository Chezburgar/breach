// BREACH — bootstrap.

import { AudioEngine } from './engine/audio.js';
import { TextureLab } from './engine/textures.js';
import { Session } from './net/session.js';
import { Game } from './game/game.js';
import { HUD } from './ui/hud.js';
import { Menu, loadProfile, saveProfile } from './ui/menu.js';
import { loadBannerManifest, registerBanner } from './ui/banners.js';

const boot = document.getElementById('boot');
const bootFill = document.getElementById('boot-fill');
const bootStatus = document.getElementById('boot-status');

function progress(pct, text) {
  bootFill.style.width = `${Math.round(pct * 100)}%`;
  if (text) bootStatus.textContent = text;
  // Yield so the browser can paint between heavy steps. Deliberately not
  // requestAnimationFrame: a page loaded in a background tab never gets one,
  // and loading must not depend on being visible.
  return new Promise((r) => setTimeout(r, 0));
}

async function main() {
  const canvas = document.getElementById('scene');

  await progress(0.05, 'loading profile');
  const profile = loadProfile();

  await progress(0.12, 'loading cosmetics');
  await loadBannerManifest();
  // The player's own upload, restored from their profile.
  if (profile.uploadedBanner) await registerBanner(profile.uploadedBanner);

  await progress(0.2, 'starting renderer');
  const audio = new AudioEngine();
  const net = new Session(profile);
  const hud = new HUD();

  let game;
  try {
    game = new Game({ canvas, profile, audio, net, hud, menu: null });
  } catch (err) {
    bootStatus.textContent = 'WebGL failed to start';
    console.error(err);
    return;
  }

  // Bake materials up front so the first match does not hitch.
  const kinds = TextureLab.kinds();
  for (let i = 0; i < kinds.length; i++) {
    game.lab.bake(kinds[i]);
    if (i % 3 === 0) await progress(0.2 + (i / kinds.length) * 0.55, `painting ${kinds[i]}`);
  }

  await progress(0.8, 'building menu');
  const menu = new Menu({
    profile,
    net,
    audio,
    onPlay: async (mode) => {
      audio.unlock();
      menu.connecting = true;
      menu.setSearching(true, { mode });
      try {
        const res = await net.quickPlay(mode);
        menu.toast(res.host
          ? `Hosting lobby ${res.code} — waiting for players`
          : `Joined lobby ${res.code}`);
      } catch (err) {
        console.error(err);
        menu.setSearching(false);
        menu.toast('Could not reach the matchmaking relay.', true);
      } finally {
        menu.connecting = false;
      }
    },
    onHost: async () => {
      audio.unlock();
      menu.connecting = true;
      try {
        const res = await net.hostPrivate('breach', 6);
        menu.setSearching(false);
        menu.toast(`Lobby ${res.code} open — share the code`);
      } catch (err) {
        console.error(err);
        menu.setSearching(false);
        menu.toast('Could not open a lobby.', true);
      } finally {
        menu.connecting = false;
      }
    },
    onJoinCode: async (code) => {
      audio.unlock();
      menu.connecting = true;
      menu.setSearching(true, { mode: 'breach' });
      try {
        await net.joinCode(code);
        menu.setSearching(false);
      } catch (err) {
        menu.setSearching(false);
        menu.toast(err.message || 'Could not join that lobby.', true);
      } finally {
        menu.connecting = false;
      }
    },
    onLeaveLobby: () => {
      net.teardown();
      menu.setGroup(null, net.id);
      menu.setSearching(false);
    },
    onTraining: async () => {
      await audio.unlock();
      await game.enterTraining();
    },
    onQuality: (q) => {
      if (game.renderer.setQuality(q)) {
        game.lab.size = game.renderer.preset.textureSize;
        menu.toast(`Graphics set to ${q.toUpperCase()} — reload to repaint materials.`);
      }
    },
    onAutoQuality: (on) => { game.renderer.autoQuality = on; },
    onProfileChange: () => {
      net.sendProfile();
      if (game.inMatch && game.local) {
        net.send({ t: 'loadout', loadout: profile.loadout });
      }
    },
  });
  game.menu = menu;
  game.renderer.autoQuality = profile.settings.autoQuality !== false;
  game.renderer.onAutoQuality = (level, fps) => {
    profile.settings.quality = level;
    saveProfile(profile);
    menu.toast(`Graphics lowered to ${level.toUpperCase()} (${fps} fps)`);
  };

  await progress(0.9, 'ready');

  net.on('hello', (msg) => {
    menu.setOnline(msg.online);
    menu.renderFanfares();
  });

  // Somebody else's uploaded banner. Registering it by id is all that is
  // needed — every message that names a banner already resolves through the
  // same lookup, so the intro, kill feed and scoreboard pick it up for free.
  net.on('bannerart', (msg) => registerBanner(msg));

  // Public matchmaking sends a waiting-room roster; a private match sends a
  // lobby with a code. They are deliberately different screens.
  net.on('search', (msg) => menu.setSearching(true, msg));
  net.on('group', (msg) => {
    menu.setSearching(false);
    menu.setGroup(msg.group, net.id);
  });
  // Tuck the lobby away rather than forgetting it — a private match goes back
  // to the same lobby when it ends.
  net.on('match.start', () => {
    menu.setSearching(false);
    menu.hideLobby();
  });
  net.on('status', ({ status, detail }) => {
    if (status === 'searching' || status === 'hosting' || status === 'connecting') {
      menu.setSearching(true, { mode: net.pendingMode, found: 0, wait: 0, detail });
    }
  });
  net.on('close', () => menu.toast('Lost connection to the host.', true));
  net.on('migrating', ({ rank }) => {
    hud.toast(rank === 0 ? 'HOST LEFT — TAKING OVER' : 'HOST LEFT — RECONNECTING', 4000);
    menu.toast('The host left. Moving the match to another player…');
  });
  net.on('migrated', ({ host }) => {
    hud.toast(host ? 'YOU ARE NOW HOSTING' : 'RECONNECTED', 2500);
  });

  // Audio needs a user gesture before it can start.
  const unlock = async () => {
    await audio.unlock();
    menu.renderFanfares();
    if (!game.inMatch) audio.startMenuMusic();
  };
  window.addEventListener('pointerdown', unlock, { once: true });
  window.addEventListener('keydown', unlock, { once: true });

  audio.setVolume('master', profile.settings.masterVolume);
  audio.setVolume('sfx', profile.settings.sfxVolume);
  audio.setVolume('music', profile.settings.musicVolume);

  // Full screen. Offered whenever the page is not already full screen, and
  // it hands the pointer straight back afterwards so clicking it mid-match
  // does not leave the player looking at a cursor.
  const fsBtn = document.getElementById('fullscreen-btn');
  const syncFullscreen = () => {
    fsBtn.classList.toggle('hidden', !!document.fullscreenElement);
  };
  fsBtn.addEventListener('click', async () => {
    audio.unlock();
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else await document.documentElement.requestFullscreen();
    } catch (err) {
      menu.toast('This browser refused full screen.', true);
      console.warn(err);
    }
    fsBtn.blur();
    if (game.inMatch && !game.paused) game.input.requestLock();
  });
  document.addEventListener('fullscreenchange', syncFullscreen);
  syncFullscreen();

  await progress(1.0, 'ready');
  boot.classList.add('hidden');
  menu.show();

  // --- main loop --------------------------------------------------------
  let last = performance.now();

  function step(dtOverride) {
    const now = performance.now();
    const dt = dtOverride ?? Math.min(0.1, (now - last) / 1000);
    last = now;
    try {
      game.update(dt);
      game.render(dt);
    } catch (err) {
      console.error('frame error', err);
    }
  }

  function frame() {
    step();
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);

  window.addEventListener('beforeunload', () => saveProfile(profile));

  // Expose a small surface for debugging and for the authoring harness.
  window.__breach = { game, net, profile, audio, menu, step };
}

main().catch((err) => {
  console.error(err);
  bootStatus.textContent = 'failed to start — see console';
});
