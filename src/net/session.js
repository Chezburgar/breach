// Peer-to-peer session.
//
// There is no game server. One player hosts: their browser runs the exact same
// authoritative simulation the Node server used to run, and everyone else
// connects to it over a WebRTC data channel. PeerJS handles signalling (finding
// each other), and Metered supplies TURN relays for players whose networks
// refuse a direct connection.
//
// The surface here is deliberately identical to the old WebSocket client —
// `on(type, fn)` and `send(msg)` — so the game code does not know or care
// whether it is hosting or connected to someone else.

import { PROTOCOL_VERSION } from '../../shared/constants.js';
import { MODES, QUICKPLAY_MODES, DEFAULT_MODE, getMode } from '../../shared/modes.js';
import { COMBAT_MAPS, MAP_INFO, DEFAULT_MAP } from '../../shared/maps/index.js';
import { sanitizeLoadout } from '../../shared/weapons.js';
import { sanitizeName, randomName, BANNERS } from '../../shared/cosmetics.js';
import { GameRoom } from '../../shared/sim/room.js';

const TURN_API =
  'https://frontlines.metered.live/api/v1/turn/credentials?apiKey=cfbe772df803ec4b0edff0c309c68885a34a';

const PREFIX = 'breach-v1';
const PUBLIC_SLOTS = 6;          // public lobbies people can drop into
const MATCH_TARGET = 10;
const LOBBY_FILL_WAIT = 35;      // seconds before bots top the match up
const LOBBY_PARTIAL_WAIT = 18;   // once a few humans have gathered
const CONNECT_TIMEOUT = 4000;

// PeerJS ships its browser build as a global script — its ES module build
// imports bare specifiers that only a bundler can resolve, and this project
// deliberately has no build step for the game itself.
const PeerCtor = () => window.Peer || window.peerjs?.Peer;

const slotId = (mode, n) => `${PREFIX}-${mode}-pub-${n}`;
const codeId = (code) => `${PREFIX}-room-${String(code).toUpperCase()}`;

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function makeCode() {
  let c = '';
  for (let i = 0; i < 5; i++) c += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)];
  return c;
}

/** Fetch TURN credentials. Falls back to public STUN if the API is unreachable. */
async function iceConfig() {
  const fallback = [{ urls: 'stun:stun.l.google.com:19302' }];
  try {
    const res = await fetch(TURN_API, { cache: 'no-store' });
    if (!res.ok) throw new Error(`turn ${res.status}`);
    const servers = await res.json();
    return Array.isArray(servers) && servers.length ? servers : fallback;
  } catch (err) {
    console.warn('TURN credentials unavailable, falling back to STUN', err);
    return fallback;
  }
}

export class Session {
  constructor(profile) {
    this.profile = profile;
    this.handlers = new Map();
    this.peer = null;
    this.ice = null;

    this.isHost = false;
    this.connected = false;
    this.id = null;
    this.rtt = 60;
    this.code = null;
    this.status = 'idle';

    // Host state.
    this.room = null;
    this.clients = new Map();     // peerId -> client shim
    this.localClient = null;
    this.lobbyOpenedAt = 0;
    this.lobbyTimer = null;
    this.pendingMode = DEFAULT_MODE;
    this.pendingBots = 0;

    // Guest state.
    this.conn = null;
    this.pingTimer = null;
    this.pingSeq = 0;
    this.pending = new Map();
    this.pendingHello = null;
    this.connectAttempt = null;   // connection attempt in flight

    // Host migration.
    this.slot = null;
    this.hostId = null;
    this.migration = null;   // last session snapshot from the host
    this.restore = null;     // score/round carried into a takeover
    this.stateTimer = null;
    this.watchdog = null;
    this.lastHostAt = 0;
  }

  /**
   * Run a connection attempt, refusing to start a second one on top of it.
   *
   * Every entry point below opens a peer, and opening a peer destroys the
   * one before it. Two attempts in flight together therefore kill each
   * other: the first is left holding a destroyed peer, the second inherits
   * half-built state, and everything after that fails with 'could not reach
   * the relay' even though the relay was fine. Hammering the button is the
   * obvious way to get there, so the guard lives here rather than in the UI
   * — any caller is covered, not just the one that was noticed.
   */
  attempt(run) {
    if (this.connectAttempt) return this.connectAttempt;
    this.connectAttempt = (async () => {
      // A previous failure can leave a peer half-open. Start from nothing.
      if (!this.connected && this.peer) {
        try { this.peer.destroy(); } catch { /* already gone */ }
        this.peer = null;
      }
      try {
        return await run();
      } catch (err) {
        // Leave nothing behind for the next attempt to trip over.
        if (!this.connected) {
          if (this.peer) { try { this.peer.destroy(); } catch { /* noop */ } this.peer = null; }
          this.setStatus('idle');
        }
        throw err;
      } finally {
        this.connectAttempt = null;
      }
    })();
    return this.connectAttempt;
  }

  // ------------------------------------------------------------- plumbing
  on(type, fn) {
    if (!this.handlers.has(type)) this.handlers.set(type, new Set());
    this.handlers.get(type).add(fn);
    return () => this.handlers.get(type)?.delete(fn);
  }

  emit(type, payload) {
    const set = this.handlers.get(type);
    if (set) for (const fn of [...set]) {
      try { fn(payload); } catch (err) { console.error('handler', type, err); }
    }
  }

  setStatus(status, detail) {
    this.status = status;
    this.emit('status', { status, detail });
  }

  /** Create our peer. Everyone does this, host or not. */
  async open(desiredId = null) {
    if (!this.ice) this.ice = await iceConfig();
    if (this.peer) { try { this.peer.destroy(); } catch { /* already gone */ } }

    const Peer = PeerCtor();
    if (!Peer) throw new Error('PeerJS failed to load');

    return new Promise((resolve, reject) => {
      const peer = desiredId
        ? new Peer(desiredId, { config: { iceServers: this.ice } })
        : new Peer({ config: { iceServers: this.ice } });
      let settled = false;

      const onOpen = (id) => {
        if (settled) return;
        settled = true;
        this.peer = peer;
        peer.off('error', onError);
        resolve(id);
      };
      const onError = (err) => {
        if (settled) return;
        settled = true;
        peer.off('open', onOpen);
        try { peer.destroy(); } catch { /* already gone */ }
        reject(err);
      };

      peer.once('open', onOpen);
      peer.once('error', onError);
      setTimeout(() => onError(new Error('peer open timed out')), 12000);
    });
  }

  // --------------------------------------------------------------- joining
  /** Try to reach a lobby that already exists. Resolves to a connection or null. */
  tryJoin(targetId) {
    return new Promise((resolve) => {
      let settled = false;
      const finish = (conn) => {
        if (settled) return;
        settled = true;
        this.peer.off('error', onPeerError);
        resolve(conn);
      };
      const onPeerError = (err) => {
        // 'peer-unavailable' just means nobody is hosting that slot.
        if (err?.type === 'peer-unavailable') finish(null);
      };
      this.peer.on('error', onPeerError);

      const conn = this.peer.connect(targetId, { reliable: true, serialization: 'json' });
      if (!conn) return finish(null);
      conn.once('open', () => finish(conn));
      conn.once('error', () => finish(null));
      setTimeout(() => {
        // Only tear the attempt down if it never opened — closing a connection
        // that succeeded drops the player out of the lobby they just joined.
        if (settled) return;
        try { conn.close(); } catch { /* noop */ }
        finish(null);
      }, CONNECT_TIMEOUT);
    });
  }

  /**
   * Quick play: drop into a public lobby, or open one if none are running.
   *
   * Slots are always walked in the same order, lowest first, by everyone. That
   * is the whole trick — players converge on slot 1 and only spill into slot 2
   * once it is full. Randomising the order (which is tempting, to "spread
   * load") does the exact opposite and leaves everybody hosting an empty lobby
   * of their own.
   */
  quickPlay(mode = DEFAULT_MODE) {
    return this.attempt(() => this.runQuickPlay(mode));
  }

  async runQuickPlay(mode) {
    // Decided before anything opens: the slot names are per mode, and the
    // room the host builds is shaped by it.
    this.pendingMode = MODES[mode] ? mode : DEFAULT_MODE;
    this.setStatus('connecting', 'contacting relay');
    await this.open();

    const slots = [...Array(PUBLIC_SLOTS).keys()].map((i) => i + 1);

    for (const n of slots) {
      this.setStatus('searching', `lobby ${n}`);
      const conn = await this.tryJoin(slotId(this.pendingMode, n));
      if (!conn) continue;
      const joined = await this.handshake(conn);
      // A full lobby turns us away; carry on to the next slot.
      if (joined) return this.becomeGuest(conn, `PUB${n}`);
      try { conn.close(); } catch { /* noop */ }
    }

    // Nobody home — open the lowest slot we can claim.
    for (const n of slots) {
      try {
        this.setStatus('hosting', `opening lobby ${n}`);
        await this.open(slotId(this.pendingMode, n));
        return this.becomeHost(`PUB${n}`, { isPrivate: false, slot: n });
      } catch (err) {
        if (err?.type !== 'unavailable-id') throw err;
        // Someone claimed it while we were looking; join them instead.
        await this.open();
        const conn = await this.tryJoin(slotId(this.pendingMode, n));
        if (conn && await this.handshake(conn)) return this.becomeGuest(conn, `PUB${n}`);
      }
    }
    throw new Error('every lobby is full');
  }

  /** Wait for the host's first message so a rejection is seen before joining. */
  handshake(conn, timeout = 3500) {
    return new Promise((resolve) => {
      let settled = false;
      const done = (ok) => { if (!settled) { settled = true; conn.off('data', onData); resolve(ok); } };
      const onData = (raw) => {
        const msg = typeof raw === 'string' ? safeParse(raw) : raw;
        if (!msg) return;
        if (msg.t === 'hello') { this.pendingHello = msg; done(true); }
        else if (msg.t === 'err') done(false);
      };
      conn.on('data', onData);
      setTimeout(() => done(false), timeout);
    });
  }

  hostPrivate(mode = DEFAULT_MODE, bots = 6) {
    return this.attempt(() => this.runHostPrivate(mode, bots));
  }

  async runHostPrivate(mode, bots) {
    this.setStatus('connecting', 'contacting relay');
    const code = makeCode();
    await this.open(codeId(code));
    this.pendingMode = MODES[mode] ? mode : DEFAULT_MODE;
    this.pendingBots = bots;
    return this.becomeHost(code, { isPrivate: true });
  }

  joinCode(code) {
    return this.attempt(() => this.runJoinCode(code));
  }

  async runJoinCode(code) {
    this.setStatus('connecting', 'contacting relay');
    await this.open();
    const conn = await this.tryJoin(codeId(code));
    if (!conn) throw new Error('No lobby with that code.');
    return this.becomeGuest(conn, String(code).toUpperCase());
  }

  // ----------------------------------------------------------------- guest
  becomeGuest(conn, code) {
    this.isHost = false;
    this.code = code;
    this.conn = conn;
    this.connected = true;
    this.hostId = conn.peer;
    this.setStatus('connected', code);

    // The hello that got us past the handshake still has to reach the game.
    if (this.pendingHello) {
      const hello = this.pendingHello;
      this.pendingHello = null;
      this.id = hello.id;
      queueMicrotask(() => this.emit('hello', hello));
    }

    conn.on('data', (raw) => {
      this.lastHostAt = performance.now();
      const msg = typeof raw === 'string' ? safeParse(raw) : raw;
      if (!msg || typeof msg.t !== 'string') return;
      if (msg.t === 'pong') {
        const sent = this.pending.get(msg.id);
        if (sent != null) {
          this.pending.delete(msg.id);
          this.rtt = this.rtt * 0.7 + (performance.now() - sent) * 0.3;
        }
        return;
      }
      if (msg.t === 'hello') this.id = msg.id;
      // Keep the information needed to take over if the host disappears.
      if (msg.t === 'session') { this.migration = msg; return; }
      this.emit(msg.t, msg);
    });

    conn.on('close', () => this.onHostLost());
    conn.on('error', () => this.onHostLost());

    this.startPing();
    this.startHostWatchdog();
    this.sendProfile();
    return { host: false, code };
  }

  /**
   * Closing a browser tab does not reliably close a data channel — the peer
   * connection can sit in `connected` for tens of seconds before ICE gives up.
   * Silence is the only dependable signal that the host is gone, and the host
   * sends snapshots twenty times a second.
   */
  startHostWatchdog() {
    this.stopHostWatchdog();
    this.lastHostAt = performance.now();
    this.watchdog = setInterval(() => {
      if (!this.connected || this.isHost) return;
      if (performance.now() - this.lastHostAt > 5000) {
        this.stopHostWatchdog();
        this.onHostLost();
      }
    }, 1000);
  }

  stopHostWatchdog() {
    if (this.watchdog) clearInterval(this.watchdog);
    this.watchdog = null;
  }

  // ------------------------------------------------------- host migration
  /**
   * The host broadcasts who is present and where the match is up to. Everyone
   * keeps the latest copy so that if the host vanishes the survivors can agree
   * on a successor without talking to each other first.
   */
  pushSessionState() {
    if (!this.isHost || !this.room) return;
    this.broadcastAll({
      t: 'session',
      code: this.code,
      slot: this.slot,
      hostId: this.peer.id,
      peers: [...this.clients.keys()],
      scores: this.room.scores,
      round: this.room.roundNo,
      mode: this.pendingMode,
    });
  }

  async onHostLost() {
    if (!this.connected) return;
    this.connected = false;
    this.stopPing();
    this.stopHostWatchdog();

    const state = this.migration;
    const targetId = this.hostId;
    if (!state || !targetId) return this.giveUp('Lost connection to the host.');

    // Everyone ranks the survivors the same way, so exactly one of us claims
    // the lobby and the rest wait to be let back in.
    const survivors = (state.peers || []).filter((p) => p !== state.hostId).sort();
    const rank = survivors.indexOf(this.peer?.id);
    this.emit('migrating', { rank, survivors: survivors.length });
    this.setStatus('migrating', 'host left — reconnecting');

    if (rank === 0) {
      // Give the old peer id a moment to be released by the broker.
      await sleep(1200);
      try {
        await this.open(targetId);
        this.pendingMode = state.mode || this.pendingMode;
        this.restore = { scores: state.scores, round: state.round };
        this.becomeHost(state.code || this.code, {
          isPrivate: !String(state.code || '').startsWith('PUB'),
          slot: state.slot,
        });
        this.emit('migrated', { host: true });
        return;
      } catch {
        // Someone beat us to it; fall through and reconnect as a guest.
      }
    }

    // Wait for the new host to come up, then rejoin.
    for (let attempt = 0; attempt < 12; attempt++) {
      await sleep(1000 + rank * 150);
      if (!this.peer || this.peer.destroyed) {
        try { await this.open(); } catch { continue; }
      }
      const conn = await this.tryJoin(targetId);
      if (conn && await this.handshake(conn)) {
        this.becomeGuest(conn, state.code || this.code);
        this.emit('migrated', { host: false });
        return;
      }
    }
    this.giveUp('The host left and the match could not be recovered.');
  }

  giveUp(reason) {
    this.emit('close');
    this.emit('err', { msg: reason });
    this.emit('match.over');
  }

  startPing() {
    this.stopPing();
    this.pingTimer = setInterval(() => {
      const id = ++this.pingSeq;
      this.pending.set(id, performance.now());
      if (this.pending.size > 12) this.pending.delete(this.pending.keys().next().value);
      this.send({ t: 'ping', id });
    }, 1500);
  }

  stopPing() {
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = null;
  }

  // ------------------------------------------------------------------ host
  becomeHost(code, { isPrivate, slot = null }) {
    this.isHost = true;
    this.isPrivateLobby = !!isPrivate;
    this.code = code;
    this.slot = slot;
    this.connected = true;
    this.id = this.peer.id;
    this.hostId = this.peer.id;
    this.setStatus('connected', code);

    const hub = {
      send: (client, msg) => client?.deliver?.(msg),
      destroyRoom: (room) => {
        room.dispose();
        if (this.room === room) this.room = null;
        this.broadcastAll({ t: 'match.over' });
      },
    };

    this.room = new GameRoom(hub, {
      id: code,
      mode: this.pendingMode,
      mapId: DEFAULT_MAP,
      isPrivate,
      botCount: 0,
    });

    // Our own player talks to the room through a shim that loops straight back
    // into this session, so hosting and guesting share one code path.
    this.localClient = this.makeClient(this.peer.id, (msg) => {
      if (msg.t === 'hello') this.id = msg.id;
      this.emit(msg.t, msg);
    });
    this.applyProfileTo(this.localClient, this.profile);
    // The host's own upload has to be on the client record too, or guests
    // joining later are never told about it.
    this.localClient.bannerArt = this.myBannerArt();
    this.clients.set(this.peer.id, this.localClient);

    this.peer.on('connection', (conn) => this.onGuest(conn));
    this.peer.on('error', (err) => console.warn('peer error', err));

    this.localClient.deliver(this.helloFor(this.localClient));

    // Taking over from a departed host: carry the score across and get the
    // next round underway rather than restarting the match.
    if (this.restore) {
      this.room.scores = [...this.restore.scores];
      this.room.roundNo = this.restore.round || 0;
      this.restore = null;
      this.lobbyOpenedAt = performance.now() / 1000 - LOBBY_FILL_WAIT + 8;
    } else {
      this.lobbyOpenedAt = performance.now() / 1000;
    }

    this.pushLobby();
    this.lobbyTimer = setInterval(() => this.lobbyTick(), 500);
    this.stateTimer = setInterval(() => this.pushSessionState(), 2000);

    return { host: true, code };
  }

  makeClient(id, deliver) {
    const client = {
      id,
      name: randomName(),
      banner: BANNERS[0].id,
      fanfare: null,
      level: 1,
      loadout: sanitizeLoadout(null),
      room: null,
      group: null,
      queueMode: null,
      rtt: 40,
      deliver,
      // The room writes through `client.ws`, mirroring the old socket.
      ws: { readyState: 1, send: (raw) => deliver(safeParse(raw)) },
    };
    return client;
  }

  applyProfileTo(client, profile) {
    client.name = sanitizeName(profile.name) || client.name;
    client.banner = profile.banner;
    client.fanfare = profile.fanfare;
    client.level = profile.level || 1;
    client.loadout = sanitizeLoadout(profile.loadout);
  }

  /** Our own uploaded artwork, if that is the banner we are actually wearing. */
  myBannerArt() {
    const art = this.profile.uploadedBanner;
    return art && art.id === this.profile.banner ? art : null;
  }

  helloFor(client) {
    return {
      t: 'hello',
      id: client.id,
      version: PROTOCOL_VERSION,
      name: client.name,
      host: client === this.localClient,
      code: this.code,
      modes: Object.values(MODES).map((m) => ({
        id: m.id, name: m.name, short: m.short, blurb: m.blurb,
        teams: m.teams, maxPlayers: m.maxPlayers,
      })),
      maps: COMBAT_MAPS.map((id) => MAP_INFO[id]),
      banners: BANNERS.map((b) => b.id),
      quickplay: QUICKPLAY_MODES,
      online: this.clients.size,
    };
  }

  onGuest(conn) {
    conn.on('open', () => {
      if (this.clients.size >= MATCH_TARGET) {
        conn.send(JSON.stringify({ t: 'err', msg: 'That lobby is full.' }));
        setTimeout(() => conn.close(), 200);
        return;
      }
      const client = this.makeClient(conn.peer, (msg) => {
        try { conn.send(JSON.stringify(msg)); } catch { /* channel dying */ }
      });
      client.conn = conn;
      this.clients.set(conn.peer, client);

      conn.on('data', (raw) => {
        const msg = typeof raw === 'string' ? safeParse(raw) : raw;
        if (!msg || typeof msg.t !== 'string') return;
        this.handleFromClient(client, msg);
      });

      const drop = () => {
        this.clients.delete(conn.peer);
        if (client.room) client.room.removeClient(client, 'disconnect');
        this.pushLobby();
      };
      conn.on('close', drop);
      conn.on('error', drop);

      client.deliver(this.helloFor(client));
      // Catch the newcomer up on everyone's uploaded banners.
      for (const c of this.clients.values()) {
        if (c.bannerArt) client.deliver({ t: 'bannerart', ...c.bannerArt });
      }
      this.pushLobby();

      // Someone joining a match already underway is folded straight into it.
      if (this.room && this.room.phase !== 'lobby') this.room.addClient(client);
    });
  }

  handleFromClient(client, msg) {
    switch (msg.t) {
      case 'ping':
        client.deliver({ t: 'pong', id: msg.id, time: Date.now() });
        return;
      case 'profile': {
        this.applyProfileTo(client, {
          name: msg.name, banner: msg.banner, fanfare: msg.fanfare,
          level: msg.level, loadout: msg.loadout,
        });
        // Uploaded artwork is relayed once, on its own, rather than riding
        // along with every roster update — it is a picture, and the roster
        // goes out on every profile change, kill and round start.
        if (msg.bannerArt?.id && msg.bannerArt.image) {
          client.bannerArt = msg.bannerArt;
          this.broadcastAll({ t: 'bannerart', ...msg.bannerArt });
        }
        if (client.room) client.room.onProfileChanged(client);
        this.pushLobby();
        return;
      }
      case 'group.config':
      case 'group.start':
        // Lobby control belongs to the host alone.
        if (client === this.localClient) this.hostLobbyCommand(msg);
        return;
      case 'leave':
        if (client.room) client.room.removeClient(client, 'left');
        client.deliver({ t: 'match.left' });
        return;
      default:
        if (client.room) client.room.onMessage(client, msg);
    }
  }

  hostLobbyCommand(msg) {
    if (msg.t === 'group.config') {
      if (MODES[msg.mode]) this.pendingMode = msg.mode;
      if (Number.isFinite(msg.bots)) this.pendingBots = Math.max(0, Math.min(9, msg.bots | 0));
      if (this.room && this.room.phase === 'lobby') this.room.setMode(this.pendingMode);
      this.pushLobby();
    } else if (msg.t === 'group.start') {
      // Fill to whatever the mode actually wants — Cashout needs twelve
      // across four crews, not the ten a 5v5 asks for.
      if (this.room) this.room.setMode(this.pendingMode);
      const want = this.room ? this.room.fillTarget() : MATCH_TARGET;
      this.startMatch(Math.max(this.pendingBots, want - this.clients.size));
    }
  }

  /**
   * Tell everyone who is here.
   *
   * Public matchmaking is not a party: it is a waiting room that shows who has
   * turned up and then starts. Only an explicitly created private match gets
   * the lobby screen with a code and a start button.
   */
  pushLobby() {
    if (!this.isHost) return;
    const members = [...this.clients.values()].map((c) => ({
      id: c.id, name: c.name, banner: c.banner, level: c.level,
    }));

    if (this.isPrivateLobby) {
      this.broadcastAll({
        t: 'group',
        group: {
          code: this.code,
          leaderId: this.localClient.id,
          mode: this.pendingMode,
          map: DEFAULT_MAP,
          bots: this.pendingBots,
          members,
        },
      });
      return;
    }

    this.broadcastAll({
      t: 'search',
      mode: this.pendingMode,
      members,
      found: members.length,
      target: this.room ? this.room.fillTarget() : MATCH_TARGET,
      wait: Math.round(this.lobbyAge()),
      fillAt: Math.round(this.fillDeadline()),
    });
  }

  /** Seconds from lobby open until bots top the match up. */
  fillDeadline() {
    const humans = this.clients.size;
    if (humans >= 4) return LOBBY_PARTIAL_WAIT;
    return LOBBY_FILL_WAIT;
  }

  lobbyAge() {
    return performance.now() / 1000 - this.lobbyOpenedAt;
  }

  lobbyTick() {
    if (!this.room || this.room.phase !== 'lobby') return;
    // A private match waits for its host to press start; it never fills itself.
    if (this.isPrivateLobby) return;

    const humans = this.clients.size;
    const age = this.lobbyAge();
    const target = this.room ? this.room.fillTarget() : MATCH_TARGET;

    const ready = humans >= target
      || (humans >= 4 && age >= LOBBY_PARTIAL_WAIT)
      || (humans >= 1 && age >= LOBBY_FILL_WAIT);

    if (!ready) { this.pushLobby(); return; }
    const want = this.room ? this.room.fillTarget() : MATCH_TARGET;
    this.startMatch(Math.max(0, want - humans));
  }

  startMatch(bots) {
    if (!this.room || this.room.phase !== 'lobby') return;
    clearInterval(this.lobbyTimer);
    this.lobbyTimer = null;

    this.room.setMode(this.pendingMode);
    this.room.botCount = bots;
    // Teams are assigned as players are added, so add them in a stable order.
    for (const client of this.clients.values()) this.room.addClient(client);
    this.room.begin();
  }

  /**
   * Put a fresh match together with whoever is still here. Host only — a guest
   * pressing "play again" would have nothing to restart.
   */
  restartMatch() {
    if (!this.isHost) return;
    if (this.room) { this.room.dispose(); this.room = null; }
    if (this.lobbyTimer) clearInterval(this.lobbyTimer);

    const hub = {
      send: (client, msg) => client?.deliver?.(msg),
      destroyRoom: (room) => {
        room.dispose();
        if (this.room === room) this.room = null;
        this.broadcastAll({ t: 'match.over' });
      },
    };
    this.room = new GameRoom(hub, {
      id: this.code,
      mode: this.pendingMode,
      mapId: DEFAULT_MAP,
      isPrivate: this.isPrivateLobby,
      botCount: 0,
    });
    for (const c of this.clients.values()) c.room = null;

    // A rematch has its crowd already; don't make them sit out the full wait.
    this.lobbyOpenedAt = performance.now() / 1000 - Math.max(0, this.fillDeadline() - 8);
    this.pushLobby();
    this.lobbyTimer = setInterval(() => this.lobbyTick(), 500);
    this.broadcastAll({ t: 'rematch' });
  }

  broadcastAll(msg) {
    for (const client of this.clients.values()) client.deliver(msg);
  }

  // ---------------------------------------------------------------- egress
  send(msg) {
    if (this.isHost) {
      if (this.localClient) this.handleFromClient(this.localClient, msg);
      return;
    }
    if (this.conn?.open) {
      try { this.conn.send(JSON.stringify(msg)); } catch { /* channel dying */ }
    }
  }

  sendInputs(inputs) {
    if (!inputs.length) return;
    this.send({
      t: 'input',
      i: inputs.map((c) => [c.seq, c.btn, +c.yaw.toFixed(4), +c.pitch.toFixed(4)]),
    });
  }

  sendProfile() {
    this.send({
      t: 'profile',
      name: this.profile.name,
      banner: this.profile.banner,
      fanfare: this.profile.fanfare,
      level: this.profile.level,
      loadout: this.profile.loadout,
      bannerArt: this.myBannerArt(),
    });
  }

  leave() {
    this.send({ t: 'leave' });
    this.teardown();
  }

  teardown() {
    this.connectAttempt = null;
    this.stopPing();
    this.stopHostWatchdog();
    if (this.lobbyTimer) clearInterval(this.lobbyTimer);
    if (this.stateTimer) clearInterval(this.stateTimer);
    this.lobbyTimer = null;
    this.stateTimer = null;
    this.migration = null;
    this.restore = null;
    if (this.room) { this.room.dispose(); this.room = null; }
    for (const c of this.clients.values()) {
      if (c.conn) { try { c.conn.close(); } catch { /* noop */ } }
    }
    this.clients.clear();
    if (this.conn) { try { this.conn.close(); } catch { /* noop */ } this.conn = null; }
    if (this.peer) { try { this.peer.destroy(); } catch { /* noop */ } this.peer = null; }
    this.connected = false;
    this.isHost = false;
    this.code = null;
    this.setStatus('idle');
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function safeParse(raw) {
  if (typeof raw !== 'string') return raw;
  try { return JSON.parse(raw); } catch { return null; }
}
