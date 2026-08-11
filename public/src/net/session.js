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

import { PROTOCOL_VERSION } from '/shared/constants.js';
import { MODES, QUICKPLAY_MODES, DEFAULT_MODE, getMode } from '/shared/modes.js';
import { COMBAT_MAPS, MAP_INFO, DEFAULT_MAP } from '/shared/maps/index.js';
import { sanitizeLoadout } from '/shared/weapons.js';
import { sanitizeName, randomName, BANNERS } from '/shared/cosmetics.js';
import { GameRoom } from '/shared/sim/room.js';

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

const slotId = (n) => `${PREFIX}-pub-${n}`;
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
      setTimeout(() => { try { conn.close(); } catch { /* noop */ } finish(null); }, CONNECT_TIMEOUT);
    });
  }

  /** Quick play: drop into a public lobby, or open one if none are running. */
  async quickPlay() {
    this.setStatus('connecting', 'contacting relay');
    await this.open();

    const order = [...Array(PUBLIC_SLOTS).keys()].map((i) => i + 1);
    // Start from a random slot so a rush of players spreads across lobbies.
    const start = Math.floor(Math.random() * PUBLIC_SLOTS);
    const rotated = [...order.slice(start), ...order.slice(0, start)];

    for (const n of rotated) {
      this.setStatus('searching', `checking lobby ${n}`);
      const conn = await this.tryJoin(slotId(n));
      if (conn) return this.becomeGuest(conn, `PUB${n}`);
    }

    // Nobody home — host one.
    for (const n of rotated) {
      try {
        this.setStatus('hosting', `opening lobby ${n}`);
        await this.open(slotId(n));
        return this.becomeHost(`PUB${n}`, { isPrivate: false });
      } catch (err) {
        if (err?.type !== 'unavailable-id') throw err;
        // Someone claimed it while we were looking; try to join them instead.
        await this.open();
        const conn = await this.tryJoin(slotId(n));
        if (conn) return this.becomeGuest(conn, `PUB${n}`);
      }
    }
    throw new Error('no lobby available');
  }

  async hostPrivate(mode = DEFAULT_MODE, bots = 6) {
    this.setStatus('connecting', 'contacting relay');
    const code = makeCode();
    await this.open(codeId(code));
    this.pendingMode = MODES[mode] ? mode : DEFAULT_MODE;
    this.pendingBots = bots;
    return this.becomeHost(code, { isPrivate: true });
  }

  async joinCode(code) {
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
    this.setStatus('connected', code);

    conn.on('data', (raw) => {
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
      this.emit(msg.t, msg);
    });

    conn.on('close', () => this.onHostLost());
    conn.on('error', () => this.onHostLost());

    this.startPing();
    this.sendProfile();
    return { host: false, code };
  }

  onHostLost() {
    if (!this.connected) return;
    this.connected = false;
    this.stopPing();
    this.emit('close');
    this.emit('err', { msg: 'The host left. Returning to the menu.' });
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
  becomeHost(code, { isPrivate }) {
    this.isHost = true;
    this.code = code;
    this.connected = true;
    this.id = this.peer.id;
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
    this.clients.set(this.peer.id, this.localClient);

    this.peer.on('connection', (conn) => this.onGuest(conn));
    this.peer.on('error', (err) => console.warn('peer error', err));

    this.localClient.deliver(this.helloFor(this.localClient));
    this.lobbyOpenedAt = performance.now() / 1000;
    this.pushLobby();
    this.lobbyTimer = setInterval(() => this.lobbyTick(), 500);

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
        if (client.room) client.room.onProfileChanged(client);
        this.pushLobby();
        return;
      }
      case 'queue':
      case 'unqueue':
      case 'group.create':
      case 'group.join':
      case 'group.leave':
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
      if (this.room && this.room.phase === 'lobby') this.room.mode = getMode(this.pendingMode);
      this.pushLobby();
    } else if (msg.t === 'group.start') {
      this.startMatch(this.pendingBots);
    }
  }

  /** Lobby roster, in the shape the menu already understands. */
  pushLobby() {
    if (!this.isHost) return;
    const members = [...this.clients.values()].map((c) => ({
      id: c.id, name: c.name, banner: c.banner, level: c.level,
    }));
    const payload = {
      t: 'group',
      group: {
        code: this.code,
        kind: this.room?.isPrivate ? 'private' : 'party',
        leaderId: this.localClient.id,
        mode: this.pendingMode,
        map: DEFAULT_MAP,
        bots: this.pendingBots,
        queued: false,
        members,
      },
    };
    this.broadcastAll(payload);
    this.broadcastAll({ t: 'queue', mode: this.pendingMode, searching: true, found: members.length, wait: Math.round(this.lobbyAge()) });
  }

  lobbyAge() {
    return performance.now() / 1000 - this.lobbyOpenedAt;
  }

  lobbyTick() {
    if (!this.room || this.room.phase !== 'lobby') return;
    const humans = this.clients.size;
    const age = this.lobbyAge();

    const ready = humans >= MATCH_TARGET
      || (humans >= 4 && age >= LOBBY_PARTIAL_WAIT)
      || (humans >= 1 && age >= LOBBY_FILL_WAIT);

    if (!ready) {
      this.broadcastAll({
        t: 'queue', mode: this.pendingMode, searching: true,
        found: humans, wait: Math.round(age),
      });
      return;
    }
    this.startMatch(Math.max(0, MATCH_TARGET - humans));
  }

  startMatch(bots) {
    if (!this.room || this.room.phase !== 'lobby') return;
    clearInterval(this.lobbyTimer);
    this.lobbyTimer = null;

    this.room.mode = getMode(this.pendingMode);
    this.room.botCount = bots;
    // Teams are assigned as players are added, so add them in a stable order.
    for (const client of this.clients.values()) this.room.addClient(client);
    this.room.begin();
    this.broadcastAll({ t: 'queue', searching: false });
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
    });
  }

  leave() {
    this.send({ t: 'leave' });
    this.teardown();
  }

  teardown() {
    this.stopPing();
    if (this.lobbyTimer) clearInterval(this.lobbyTimer);
    this.lobbyTimer = null;
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

function safeParse(raw) {
  if (typeof raw !== 'string') return raw;
  try { return JSON.parse(raw); } catch { return null; }
}
