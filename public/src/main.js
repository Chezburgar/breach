// BREACH — bootstrap.

import { AudioEngine } from './engine/audio.js';
import { TextureLab } from './engine/textures.js';
import { NetClient } from './net/client.js';
import { Game } from './game/game.js';
import { HUD } from './ui/hud.js';
import { Menu, loadProfile, saveProfile } from './ui/menu.js';
import { loadBannerManifest } from './ui/banners.js';

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

  await progress(0.2, 'starting renderer');
  const audio = new AudioEngine();
  const net = new NetClient();
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
    onPlay: (mode) => {
      audio.unlock();
      net.send({ t: 'queue', mode });
      menu.setSearching(true, { mode });
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
    onProfileChange: () => {
      net.send({
        t: 'profile',
        name: profile.name,
        banner: profile.banner,
        fanfare: profile.fanfare,
        level: profile.level,
        loadout: profile.loadout,
      });
      if (game.inMatch && game.local) {
        net.send({ t: 'loadout', loadout: profile.loadout });
      }
    },
  });
  game.menu = menu;

  await progress(0.9, 'connecting');

  net.on('open', () => {
    net.send({
      t: 'profile',
      name: profile.name,
      banner: profile.banner,
      fanfare: profile.fanfare,
      level: profile.level,
      loadout: profile.loadout,
    });
  });

  net.on('hello', (msg) => {
    menu.setOnline(msg.online);
    menu.renderFanfares();
  });

  net.on('queue', (msg) => {
    if (msg.searching) menu.setSearching(true, msg);
    else menu.setSearching(false);
  });

  net.on('group', (msg) => menu.setGroup(msg.group, net.id));

  net.on('close', () => menu.toast('Connection lost — reconnecting…', true));
  net.on('versionMismatch', () => menu.toast('Client is out of date. Reload the page.', true));

  net.connect();

  // Audio needs a user gesture before it can start.
  const unlock = async () => { await audio.unlock(); menu.renderFanfares(); };
  window.addEventListener('pointerdown', unlock, { once: true });
  window.addEventListener('keydown', unlock, { once: true });

  audio.setVolume('master', profile.settings.masterVolume);
  audio.setVolume('sfx', profile.settings.sfxVolume);
  audio.setVolume('music', profile.settings.musicVolume);

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
