/* ArcPlay v1.2 — resilient encrypted signaling: 443-first, delayed alternate ports.
   This file is shared by the host offscreen document and the guest extension page.
   No application server, accounts, external JS, or API keys are required. */
(function (global) {
  'use strict';
  // Standard HTTPS port 443 is more widely reachable than non-standard WebSocket ports.
  // These independent test services do NOT forward messages to one another; both
  // participants broadcast on all available routes and deduplicate by message id.
  const PRIMARY_ENDPOINTS = [
    'wss://mqtt.eclipseprojects.io/mqtt',
    'wss://api.sondahub.com/mqtt'
  ];
  const FALLBACK_ENDPOINTS = [
    'wss://broker.emqx.io:8084/mqtt',
    'wss://broker.connectmq.com:8084/mqtt'
  ];
  const VERSION = 'AP2';
  const utf8 = new TextEncoder();
  const decode = new TextDecoder();
  const rand = n => crypto.getRandomValues(new Uint8Array(n));
  const hex = data => [...data].map(b => b.toString(16).padStart(2, '0')).join('');
  const toBase64 = arr => btoa(String.fromCharCode(...arr)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const fromBase64 = str => Uint8Array.from(atob(str.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - str.length % 4) % 4)), c => c.charCodeAt(0));
  const join = (...buffers) => {
    const out = new Uint8Array(buffers.reduce((n, b) => n + b.length, 0));
    let at = 0;
    for (const b of buffers) { out.set(b, at); at += b.length; }
    return out;
  };
  const varlen = value => {
    const out = [];
    do { let digit = value % 128; value = Math.floor(value / 128); if (value > 0) digit |= 128; out.push(digit); } while (value > 0);
    return Uint8Array.from(out);
  };
  const str = value => {
    const bytes = utf8.encode(value);
    if (bytes.length > 65535) throw Error('Mensaje demasiado largo');
    return join(Uint8Array.from([bytes.length >> 8, bytes.length & 255]), bytes);
  };
  const packet = (header, body) => join(Uint8Array.from([header]), varlen(body.length), body);
  const connectPacket = clientId => packet(0x10, join(str('MQTT'), Uint8Array.from([4, 2, 0, 30]), str(clientId)));
  const subscribePacket = topic => packet(0x82, join(Uint8Array.from([0, 1]), str(topic), Uint8Array.of(0)));
  const publishPacket = (topic, value) => packet(0x30, join(str(topic), value));

  function makeCode() { return `${VERSION}-${hex(rand(16))}-${toBase64(rand(32))}`; }
  function parseCode(input) {
    const value = String(input || '').trim().replace(/\s+/g, '');
    const matched = /^AP2-([a-f0-9]{32})-([a-zA-Z0-9_-]{43})$/.exec(value);
    if (!matched || fromBase64(matched[2]).length !== 32) throw Error('El código de invitación no es válido');
    return { code: value, room: matched[1], secret: fromBase64(matched[2]) };
  }

  class MqttRelay {
    constructor(url, topic, receive, change) {
      this.url = url; this.topic = topic; this.receive = receive; this.change = change;
      this.ws = null; this.ready = false; this.closed = false; this.pending = [];
      this.retryTimer = null; this.pingTimer = null; this.attempt = 0; this.clientId = `ap_${hex(rand(9))}`;
      this.connect();
    }
    connect() {
      if (this.closed) return;
      let ws;
      try { ws = new WebSocket(this.url, ['mqtt']); }
      catch (_) { this.reconnect(); return; }
      this.ws = ws; ws.binaryType = 'arraybuffer';
      // If the TLS/WebSocket handshake stalls, stop this attempt and retry.
      // Chrome may report closing a still-CONNECTING socket in DevTools; that is
      // a transport failure indication, not an ICE/TURN or video error.
      const timeout = setTimeout(() => {
        if (this.ws === ws && !this.closed && !this.ready && ws.readyState < WebSocket.CLOSING) ws.close();
      }, 15000);
      ws.onopen = () => {
        if (this.closed || this.ws !== ws) { ws.close(); return; }
        try { ws.send(connectPacket(this.clientId)); } catch { ws.close(); }
      };
      ws.onmessage = event => {
        let data;
        try { data = new Uint8Array(event.data); } catch { return; }
        let offset = 0;
        while (offset < data.length) {
          const type = data[offset] >> 4;
          let pos = offset + 1, mult = 1, len = 0, digit;
          do {
            if (pos >= data.length || mult > 128 * 128 * 128) return;
            digit = data[pos++]; len += (digit & 127) * mult; mult *= 128;
          } while (digit & 128);
          if (pos + len > data.length) return;
          const body = data.subarray(pos, pos + len);
          offset = pos + len;
          if (type === 2) {
            if (body.length < 2 || body[1] !== 0) { ws.close(); return; }
            try { ws.send(subscribePacket(this.topic)); } catch { ws.close(); }
          } else if (type === 9) {
            if (body.length < 3 || body[2] === 0x80) { ws.close(); return; }
            if (this.ws !== ws || this.closed) return;
            clearTimeout(timeout);
            this.ready = true; this.attempt = 0; this.change();
            for (const item of this.pending.splice(0)) {
              if (Date.now() - item.at < 12000) this.publish(item.payload);
            }
          } else if (type === 3 && body.length > 2) {
            const count = (body[0] << 8) + body[1];
            if (count > body.length - 2) continue;
            const receivedTopic = decode.decode(body.subarray(2, 2 + count));
            // This is an intentionally minimal QoS 0 MQTT implementation.
            if (receivedTopic === this.topic) this.receive(decode.decode(body.subarray(2 + count)));
          }
        }
      };
      ws.onerror = () => {};
      ws.onclose = () => {
        clearTimeout(timeout); clearInterval(this.pingTimer); this.pingTimer = null;
        if (this.ws !== ws) return;
        this.ready = false; this.change();
        this.reconnect();
      };
      this.pingTimer = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN && this.ready) {
          try { ws.send(Uint8Array.from([0xc0, 0])); } catch { ws.close(); }
        }
      }, 15000);
    }
    reconnect() {
      if (this.closed || this.retryTimer) return;
      const delay = Math.min(12000, 700 * 2 ** Math.min(this.attempt++, 4)) + Math.floor(Math.random() * 350);
      this.retryTimer = setTimeout(() => { this.retryTimer = null; this.connect(); }, delay);
    }
    publish(payload) {
      if (!this.ready || this.ws?.readyState !== WebSocket.OPEN) {
        this.pending.push({at: Date.now(), payload});
        if (this.pending.length > 30) this.pending.shift();
        return;
      }
      try { this.ws.send(publishPacket(this.topic.replace(/\/([hg])$/, (_, suffix) => suffix === 'h' ? '/g' : '/h'), utf8.encode(payload))); }
      catch { this.ws.close(); }
    }
    close() {
      this.closed = true; this.ready = false;
      clearTimeout(this.retryTimer); clearInterval(this.pingTimer);
      try { this.ws?.close(); } catch {}
      this.pending.length = 0;
    }
  }

  class SignalBus {
    static async connect(code, role, onMessage, onStatus = () => {}) {
      if (!['host', 'guest'].includes(role)) throw Error('Rol no válido');
      const info = parseCode(code);
      const key = await crypto.subtle.importKey('raw', info.secret, 'AES-GCM', false, ['encrypt', 'decrypt']);
      const bus = new SignalBus(info.room, key, role, onMessage, onStatus);
      bus.start();
      return bus;
    }
    constructor(room, key, role, onMessage, onStatus) {
      this.room = room; this.key = key; this.role = role; this.onMessage = onMessage;
      this.onStatus = onStatus; this.relays = []; this.seen = new Set(); this.closed = false;
      this.fallbackTimer = null; this.peerSeen = false;
      this.topic = `arcplay/v2/${room}/${role === 'host' ? 'h' : 'g'}`;
    }
    start() {
      const add = url => this.relays.push(new MqttRelay(url, this.topic, text => this.receive(text),
        () => this.onStatus(this.relays.some(r => r.ready))));
      for (const url of PRIMARY_ENDPOINTS) add(url);
      // No unnecessarily opened extra connections after the peer is found.
      // When the first two public services cannot find each other, enable two
      // independent alternate paths (may be blocked on restricted networks).
      this.fallbackTimer = setTimeout(() => {
        this.fallbackTimer = null;
        if (!this.closed && !this.peerSeen) for (const url of FALLBACK_ENDPOINTS) add(url);
      }, 8000);
    }
    async send(message) {
      if (this.closed) return;
      const content = { ...message, id: hex(rand(12)), ts: Date.now() };
      const iv = rand(12);
      const encrypted = new Uint8Array(await crypto.subtle.encrypt(
        {name:'AES-GCM', iv, additionalData: utf8.encode(`arcplay/v2/${this.room}`)},
        this.key, utf8.encode(JSON.stringify(content))
      ));
      const payload = JSON.stringify({iv:toBase64(iv), ct:toBase64(encrypted)});
      if (payload.length > 45000) throw Error('Mensaje de conexión demasiado grande');
      for (const relay of this.relays) relay.publish(payload);
    }
    async receive(payload) {
      if (this.closed || payload.length > 45000) return;
      try {
        const wrapper = JSON.parse(payload);
        if (typeof wrapper.iv !== 'string' || typeof wrapper.ct !== 'string') return;
        const plain = await crypto.subtle.decrypt(
          {name:'AES-GCM',iv:fromBase64(wrapper.iv),additionalData:utf8.encode(`arcplay/v2/${this.room}`)},
          this.key, fromBase64(wrapper.ct)
        );
        const msg = JSON.parse(decode.decode(plain));
        if (typeof msg.t !== 'string' || typeof msg.id !== 'string' || typeof msg.ts !== 'number') return;
        if (Math.abs(Date.now() - msg.ts) > 120000 || this.seen.has(msg.id)) return;
        this.seen.add(msg.id);
        if (this.seen.size > 500) this.seen.delete(this.seen.values().next().value);
        this.peerSeen = true;
        if (this.fallbackTimer !== null) { clearTimeout(this.fallbackTimer); this.fallbackTimer = null; }
        this.onMessage(msg);
      } catch { /* Public channels can contain unrelated or malformed packets. */ }
    }
    close() {
      this.closed = true;
      if (this.fallbackTimer !== null) clearTimeout(this.fallbackTimer);
      this.fallbackTimer = null;
      for (const relay of this.relays) relay.close();
      this.relays.length = 0;
    }
  }
  global.ArcSignal = {SignalBus, makeCode, parseCode};
})(globalThis);
