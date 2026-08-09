// WebSocket client: reconnection, latency tracking and input batching.

import { PROTOCOL_VERSION } from '/shared/constants.js';

export class NetClient {
  constructor() {
    this.ws = null;
    this.handlers = new Map();
    this.id = null;
    this.connected = false;
    this.rtt = 60;
    this.serverTimeOffset = 0;
    this.pingSeq = 0;
    this.pending = new Map();
    this.reconnectDelay = 700;
    this.shouldReconnect = true;
    this.outbox = [];
  }

  on(type, fn) {
    if (!this.handlers.has(type)) this.handlers.set(type, new Set());
    this.handlers.get(type).add(fn);
    return () => this.handlers.get(type).delete(fn);
  }

  emit(type, payload) {
    const set = this.handlers.get(type);
    if (set) for (const fn of set) fn(payload);
    const any = this.handlers.get('*');
    if (any) for (const fn of any) fn(type, payload);
  }

  connect() {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const url = `${proto}//${location.host}/ws`;
    this.ws = new WebSocket(url);

    this.ws.addEventListener('open', () => {
      this.connected = true;
      this.reconnectDelay = 700;
      this.emit('open');
      for (const msg of this.outbox) this.rawSend(msg);
      this.outbox.length = 0;
      this.startPing();
    });

    this.ws.addEventListener('message', (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      if (msg.t === 'pong') {
        const sent = this.pending.get(msg.id);
        if (sent) {
          this.pending.delete(msg.id);
          this.rtt = this.rtt * 0.7 + (performance.now() - sent) * 0.3;
          // Server clock minus local clock, adjusted for one-way latency.
          this.serverTimeOffset = msg.time - (Date.now() - this.rtt / 2);
        }
        return;
      }
      if (msg.t === 'hello') {
        this.id = msg.id;
        if (msg.version !== PROTOCOL_VERSION) {
          this.emit('versionMismatch', msg.version);
        }
      }
      this.emit(msg.t, msg);
    });

    const closed = () => {
      if (!this.connected) return;
      this.connected = false;
      this.stopPing();
      this.emit('close');
      if (this.shouldReconnect) {
        setTimeout(() => this.connect(), this.reconnectDelay);
        this.reconnectDelay = Math.min(8000, this.reconnectDelay * 1.7);
      }
    };
    this.ws.addEventListener('close', closed);
    this.ws.addEventListener('error', closed);
  }

  disconnect() {
    this.shouldReconnect = false;
    this.stopPing();
    try { this.ws?.close(); } catch { /* already closed */ }
  }

  startPing() {
    this.stopPing();
    this.pingTimer = setInterval(() => {
      const id = ++this.pingSeq;
      this.pending.set(id, performance.now());
      if (this.pending.size > 12) {
        const oldest = this.pending.keys().next().value;
        this.pending.delete(oldest);
      }
      this.send({ t: 'ping', id });
    }, 1500);
  }

  stopPing() {
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = null;
  }

  rawSend(msg) {
    if (this.ws?.readyState === 1) {
      try { this.ws.send(JSON.stringify(msg)); } catch { /* socket dying */ }
    }
  }

  send(msg) {
    if (this.ws?.readyState === 1) this.rawSend(msg);
    else if (this.outbox.length < 32) this.outbox.push(msg);
  }

  /** Inputs are sent as compact arrays: [seq, buttons, yaw, pitch]. */
  sendInputs(inputs) {
    if (!inputs.length) return;
    this.send({
      t: 'input',
      i: inputs.map((c) => [c.seq, c.btn, +c.yaw.toFixed(4), +c.pitch.toFixed(4)]),
    });
  }
}
