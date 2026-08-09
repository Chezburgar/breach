// Connection hub: identity, parties, private lobbies, matchmaking and routing.

import { randomUUID } from 'node:crypto';
import { PROTOCOL_VERSION } from '../shared/constants.js';
import { getMode, MODES, QUICKPLAY_MODES } from '../shared/modes.js';
import { COMBAT_MAPS, MAP_INFO } from '../shared/maps/index.js';
import { sanitizeLoadout } from '../shared/weapons.js';
import { sanitizeName, randomName, DEFAULT_BANNER, DEFAULT_FANFARE, BANNERS } from '../shared/cosmetics.js';
import { GameRoom } from './room.js';

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const MATCH_TARGET = 10;
const SOLO_FILL_WAIT = 6.0;   // seconds before a lone queuer gets a bot match
const QUICK_START = 4;        // this many real players starts immediately

function makeCode(taken) {
  for (let attempt = 0; attempt < 200; attempt++) {
    let c = '';
    for (let i = 0; i < 5; i++) c += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)];
    if (!taken.has(c)) return c;
  }
  return randomUUID().slice(0, 5).toUpperCase();
}

export class Hub {
  constructor(wss) {
    this.clients = new Map();
    this.groups = new Map();   // code -> group (party or private lobby)
    this.rooms = new Map();
    this.queues = new Map();   // modeId -> [{ groupCode|clientId, since }]
    for (const m of Object.keys(MODES)) this.queues.set(m, []);

    wss.on('connection', (ws, req) => this.onConnect(ws, req));

    this.mmTimer = setInterval(() => this.matchmakingTick(), 500);
    this.pingTimer = setInterval(() => this.heartbeat(), 5000);
  }

  dispose() {
    clearInterval(this.mmTimer);
    clearInterval(this.pingTimer);
    for (const room of this.rooms.values()) room.dispose();
    this.rooms.clear();
  }

  stats() {
    return {
      players: this.clients.size,
      rooms: this.rooms.size,
      queued: [...this.queues.values()].reduce((n, q) => n + q.length, 0),
    };
  }

  // ------------------------------------------------------------ connection
  onConnect(ws, req) {
    const client = {
      id: randomUUID().slice(0, 8),
      ws,
      alive: true,
      name: randomName(),
      banner: DEFAULT_BANNER,
      fanfare: DEFAULT_FANFARE,
      level: 1,
      loadout: sanitizeLoadout(null),
      group: null,
      room: null,
      queueMode: null,
      rtt: 60,
      lastPing: Date.now(),
      ip: req.socket.remoteAddress,
      msgBudget: 0,
    };
    this.clients.set(client.id, client);

    ws.on('message', (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (!msg || typeof msg.t !== 'string') return;
      // Cheap flood guard — inputs are frequent, everything else is not.
      if (msg.t !== 'input' && msg.t !== 'fire' && ++client.msgBudget > 200) return;
      try {
        this.onMessage(client, msg);
      } catch (err) {
        console.error('message error', msg.t, err);
      }
    });

    ws.on('close', () => this.onDisconnect(client));
    ws.on('error', () => this.onDisconnect(client));
    ws.on('pong', () => {
      client.alive = true;
      client.rtt = Math.max(1, Date.now() - client.lastPing);
    });

    this.send(client, {
      t: 'hello',
      id: client.id,
      version: PROTOCOL_VERSION,
      name: client.name,
      modes: Object.values(MODES).map((m) => ({
        id: m.id, name: m.name, short: m.short, blurb: m.blurb, teams: m.teams, maxPlayers: m.maxPlayers,
      })),
      maps: COMBAT_MAPS.map((id) => MAP_INFO[id]),
      banners: BANNERS.map((b) => b.id),
      quickplay: QUICKPLAY_MODES,
      online: this.clients.size,
    });
  }

  onDisconnect(client) {
    if (!this.clients.has(client.id)) return;
    this.clients.delete(client.id);
    this.leaveQueue(client);
    if (client.room) client.room.removeClient(client, 'disconnect');
    this.leaveGroup(client);
    try { client.ws.close(); } catch { /* already gone */ }
  }

  heartbeat() {
    for (const client of this.clients.values()) {
      if (!client.alive) { this.onDisconnect(client); continue; }
      client.alive = false;
      client.lastPing = Date.now();
      client.msgBudget = 0;
      try { client.ws.ping(); } catch { /* socket dying */ }
    }
  }

  send(client, msg) {
    if (client.ws.readyState !== 1) return;
    try { client.ws.send(JSON.stringify(msg)); } catch { /* socket dying */ }
  }

  // ------------------------------------------------------------- messages
  onMessage(client, msg) {
    switch (msg.t) {
      case 'profile': return this.setProfile(client, msg);
      case 'queue': return this.joinQueue(client, msg.mode);
      case 'unqueue': return this.leaveQueue(client, true);

      case 'group.create': return this.createGroup(client, msg.kind === 'private' ? 'private' : 'party', msg);
      case 'group.join': return this.joinGroup(client, msg.code);
      case 'group.leave': return this.leaveGroup(client, true);
      case 'group.config': return this.configGroup(client, msg);
      case 'group.start': return this.startPrivate(client);
      case 'group.kick': return this.kickFromGroup(client, msg.id);

      case 'leave': return this.leaveMatch(client);
      case 'ping': return this.send(client, { t: 'pong', id: msg.id, time: Date.now() });

      default:
        if (client.room) client.room.onMessage(client, msg);
    }
  }

  setProfile(client, msg) {
    const name = sanitizeName(msg.name);
    if (name) client.name = name;
    if (typeof msg.banner === 'string') client.banner = msg.banner.slice(0, 48);
    if (typeof msg.fanfare === 'string') client.fanfare = msg.fanfare.slice(0, 48);
    if (Number.isFinite(msg.level)) client.level = Math.max(1, Math.min(999, Math.floor(msg.level)));
    client.loadout = sanitizeLoadout(msg.loadout);
    if (client.room) client.room.onProfileChanged(client);
    if (client.group) this.pushGroup(client.group);
    this.send(client, { t: 'profile.ok', name: client.name });
  }

  // --------------------------------------------------------------- groups
  createGroup(client, kind, msg = {}) {
    this.leaveGroup(client);
    const code = makeCode(this.groups);
    const group = {
      code,
      kind,
      leaderId: client.id,
      members: [client.id],
      mode: MODES[msg.mode] ? msg.mode : 'tdm',
      mapId: COMBAT_MAPS.includes(msg.map) ? msg.map : COMBAT_MAPS[0],
      bots: kind === 'private' ? 6 : 0,
      queuedAt: 0,
      queueMode: null,
    };
    this.groups.set(code, group);
    client.group = group;
    this.pushGroup(group);
  }

  joinGroup(client, rawCode) {
    const code = String(rawCode || '').toUpperCase().trim();
    const group = this.groups.get(code);
    if (!group) return this.send(client, { t: 'err', msg: 'No lobby with that code.' });
    if (group.members.length >= MATCH_TARGET) return this.send(client, { t: 'err', msg: 'That lobby is full.' });
    if (group.roomId) return this.send(client, { t: 'err', msg: 'That match already started.' });

    this.leaveGroup(client);
    group.members.push(client.id);
    client.group = group;
    this.pushGroup(group);
  }

  leaveGroup(client, notify = false) {
    const group = client.group;
    if (!group) return;
    client.group = null;
    group.members = group.members.filter((id) => id !== client.id);

    if (!group.members.length) {
      this.dequeueGroup(group);
      this.groups.delete(group.code);
    } else {
      if (group.leaderId === client.id) group.leaderId = group.members[0];
      this.pushGroup(group);
    }
    if (notify) this.send(client, { t: 'group', group: null });
  }

  kickFromGroup(client, targetId) {
    const group = client.group;
    if (!group || group.leaderId !== client.id || targetId === client.id) return;
    const target = this.clients.get(targetId);
    if (!target || target.group !== group) return;
    this.leaveGroup(target);
    this.send(target, { t: 'group', group: null, msg: 'You were removed from the lobby.' });
  }

  configGroup(client, msg) {
    const group = client.group;
    if (!group || group.leaderId !== client.id) return;
    if (MODES[msg.mode]) group.mode = msg.mode;
    if (COMBAT_MAPS.includes(msg.map)) group.mapId = msg.map;
    if (Number.isFinite(msg.bots)) group.bots = Math.max(0, Math.min(9, Math.floor(msg.bots)));
    this.pushGroup(group);
  }

  pushGroup(group) {
    const payload = {
      t: 'group',
      group: {
        code: group.code,
        kind: group.kind,
        leaderId: group.leaderId,
        mode: group.mode,
        map: group.mapId,
        bots: group.bots,
        queued: !!group.queueMode,
        members: group.members
          .map((id) => this.clients.get(id))
          .filter(Boolean)
          .map((c) => ({ id: c.id, name: c.name, banner: c.banner, level: c.level })),
      },
    };
    for (const id of group.members) {
      const c = this.clients.get(id);
      if (c) this.send(c, payload);
    }
  }

  startPrivate(client) {
    const group = client.group;
    if (!group || group.leaderId !== client.id) return;
    const members = group.members.map((id) => this.clients.get(id)).filter(Boolean);
    if (!members.length) return;
    this.dequeueGroup(group);
    const room = this.createRoom({
      mode: group.mode,
      mapId: group.mapId,
      isPrivate: true,
      botCount: group.bots,
    });
    for (const m of members) room.addClient(m);
    room.begin();
  }

  // ---------------------------------------------------------- matchmaking
  joinQueue(client, modeId) {
    const mode = getMode(modeId);
    const group = client.group;

    if (group && group.kind === 'party') {
      if (group.leaderId !== client.id) {
        return this.send(client, { t: 'err', msg: 'Only the party leader can search.' });
      }
      this.dequeueGroup(group);
      group.queueMode = mode.id;
      group.queuedAt = Date.now();
      this.queues.get(mode.id).push({ group, size: group.members.length, since: Date.now() });
      this.pushGroup(group);
      for (const id of group.members) {
        const c = this.clients.get(id);
        if (c) { c.queueMode = mode.id; this.send(c, { t: 'queue', mode: mode.id, searching: true }); }
      }
      return;
    }

    this.leaveQueue(client);
    client.queueMode = mode.id;
    this.queues.get(mode.id).push({ client, size: 1, since: Date.now() });
    this.send(client, { t: 'queue', mode: mode.id, searching: true });
  }

  leaveQueue(client, notify = false) {
    if (client.group && client.group.queueMode && client.group.leaderId === client.id) {
      this.dequeueGroup(client.group);
      for (const id of client.group.members) {
        const c = this.clients.get(id);
        if (c) { c.queueMode = null; if (notify) this.send(c, { t: 'queue', searching: false }); }
      }
      this.pushGroup(client.group);
      return;
    }
    if (!client.queueMode) return;
    const q = this.queues.get(client.queueMode);
    if (q) {
      const i = q.findIndex((e) => e.client === client);
      if (i >= 0) q.splice(i, 1);
    }
    client.queueMode = null;
    if (notify) this.send(client, { t: 'queue', searching: false });
  }

  dequeueGroup(group) {
    if (!group.queueMode) return;
    const q = this.queues.get(group.queueMode);
    if (q) {
      const i = q.findIndex((e) => e.group === group);
      if (i >= 0) q.splice(i, 1);
    }
    group.queueMode = null;
  }

  matchmakingTick() {
    const now = Date.now();
    for (const [modeId, q] of this.queues) {
      if (!q.length) continue;

      // Prune entries whose players vanished.
      for (let i = q.length - 1; i >= 0; i--) {
        const e = q[i];
        const alive = e.group
          ? e.group.members.some((id) => this.clients.has(id))
          : this.clients.has(e.client.id);
        if (!alive) q.splice(i, 1);
      }
      if (!q.length) continue;

      const total = q.reduce((n, e) => n + e.size, 0);
      const oldestWait = (now - Math.min(...q.map((e) => e.since))) / 1000;

      const ready = total >= QUICK_START || (oldestWait >= SOLO_FILL_WAIT && total >= 1);
      if (!ready) {
        // Keep the client's search UI honest while it waits.
        for (const e of q) {
          const targets = e.group ? e.group.members.map((id) => this.clients.get(id)) : [e.client];
          for (const c of targets) {
            if (c) this.send(c, { t: 'queue', mode: modeId, searching: true, found: total, wait: Math.round(oldestWait) });
          }
        }
        continue;
      }

      // Take entries in order until the match is full.
      const taken = [];
      let count = 0;
      for (const e of [...q]) {
        if (count + e.size > MATCH_TARGET) continue;
        taken.push(e);
        count += e.size;
        q.splice(q.indexOf(e), 1);
        if (count >= MATCH_TARGET) break;
      }
      if (!taken.length) continue;

      const room = this.createRoom({
        mode: modeId,
        mapId: COMBAT_MAPS[Math.floor(Math.random() * COMBAT_MAPS.length)],
        isPrivate: false,
        botCount: Math.max(0, Math.min(9, MATCH_TARGET - count)),
      });

      for (const e of taken) {
        if (e.group) {
          e.group.queueMode = null;
          // Keep parties on the same team.
          const team = room.nextPartyTeam();
          for (const id of e.group.members) {
            const c = this.clients.get(id);
            if (c) { c.queueMode = null; room.addClient(c, team); }
          }
        } else {
          e.client.queueMode = null;
          room.addClient(e.client);
        }
      }
      room.begin();
    }
  }

  // ---------------------------------------------------------------- rooms
  createRoom(opts) {
    const id = randomUUID().slice(0, 8);
    const room = new GameRoom(this, { id, ...opts });
    this.rooms.set(id, room);
    return room;
  }

  destroyRoom(room) {
    room.dispose();
    this.rooms.delete(room.id);
  }

  leaveMatch(client) {
    if (client.room) client.room.removeClient(client, 'left');
    this.send(client, { t: 'match.left' });
  }
}
