/* Bulong mesh core: relay (flooding with TTL + dedupe + store-and-forward),
   encryption, contacts, groups and chats. No UI here.
   Transport is injected: { connect(ep), disconnect(ep), send(epIds, text) }. */
(function (root) {
  'use strict';
  const subtle = root.crypto.subtle;
  const enc = new TextEncoder(), dec = new TextDecoder();

  const MSG_TTL = 10;            // max hops for messages
  const HI_TTL = 5;              // max hops for "I'm here" announcements
  const MAX_LINKS = 4;           // links we start ourselves
  const HARD_MAX_LINKS = 6;      // incoming links beyond this get dropped
  const HELLO_EVERY = 45e3;
  const RELAY_KEEP = 30 * 60e3;  // keep others' messages to pass on for 30 min
  const OWN_KEEP = 2 * 3600e3;   // keep own undelivered messages for 2 h
  const SEEN_KEEP = 3 * 3600e3;
  const BUFFER_MAX = 400;
  const ONLINE_WINDOW = 3 * 60e3;
  const MAX_TEXT = 2000;

  function b64u(bytes) {
    bytes = new Uint8Array(bytes); let s = '';
    for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }
  function unb64u(str) {
    str = String(str).replace(/-/g, '+').replace(/_/g, '/');
    while (str.length % 4) str += '=';
    const s = atob(str), a = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) a[i] = s.charCodeAt(i);
    return a;
  }
  const hex = a => Array.from(a, b => b.toString(16).padStart(2, '0')).join('');
  const rid = (n = 9) => b64u(root.crypto.getRandomValues(new Uint8Array(n)));
  const sha = async bytes => new Uint8Array(await subtle.digest('SHA-256', bytes));
  const cat = (...arrs) => { const out = new Uint8Array(arrs.reduce((n, a) => n + a.length, 0)); let o = 0; for (const a of arrs) { out.set(a, o); o += a.length; } return out; };

  async function nodeIdOf(pubB64) { return hex((await sha(unb64u(pubB64))).slice(0, 8)); }

  async function aesKey(raw) { return subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']); }
  async function seal(key, obj, aad) {
    const iv = root.crypto.getRandomValues(new Uint8Array(12));
    const ct = await subtle.encrypt({ name: 'AES-GCM', iv, additionalData: enc.encode(aad) }, key, enc.encode(JSON.stringify(obj)));
    return { iv: b64u(iv), ct: b64u(ct) };
  }
  async function open(key, p, aad) {
    const pt = await subtle.decrypt({ name: 'AES-GCM', iv: unb64u(p.iv), additionalData: enc.encode(aad) }, key, unb64u(p.ct));
    return JSON.parse(dec.decode(pt));
  }
  const aadOf = p => [p.k, p.id, p.from || '', p.to || p.g || ''].join('|');

  function parseInvite(text) {
    const m = /bulong:g:([A-Za-z0-9_-]{43}):(.*)$/.exec(String(text).trim());
    if (!m) return null;
    let name; try { name = decodeURIComponent(m[2]); } catch (e) { return null; }
    return { key: m[1], name: name.slice(0, 40) || 'Group' };
  }

  class MeshNode {
    /* state: persisted object ({me, contacts, groups, chats}); save(): persist hook;
       onEvent(type, data): UI hook; now(): clock (for tests). */
    constructor({ state, transport, save, onEvent, now }) {
      this.state = state;
      this.state.contacts = this.state.contacts || {};
      this.state.groups = this.state.groups || {};
      this.state.chats = this.state.chats || {};
      this.t = transport;
      this.save = save || (() => {});
      this.emit = onEvent || (() => {});
      this.now = now || (() => Date.now());
      this.links = new Map();   // endpointId -> nodeId
      this.found = new Map();   // endpointId -> {name, at, retryAt}
      this.pending = new Map(); // endpointId -> since
      this.seen = new Map();    // packet id -> time
      this.buffer = [];         // [{p, at, own}] packets ready to hand to new neighbours
      this.keys = new Map();    // contact/group id -> CryptoKey
      this.lastHello = 0;
    }

    async init(name) {
      if (!this.state.me) {
        const kp = await subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
        const pub = b64u(await subtle.exportKey('raw', kp.publicKey));
        this.state.me = { name: String(name || 'Me').slice(0, 40), pub, priv: await subtle.exportKey('jwk', kp.privateKey), id: await nodeIdOf(pub) };
        this.save();
      } else if (name) { this.state.me.name = String(name).slice(0, 40); this.save(); }
      this.priv = await subtle.importKey('jwk', this.state.me.priv, { name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']);
      return this.state.me;
    }
    get id() { return this.state.me.id; }

    async dmKey(contactId, pubB64) {
      if (this.keys.has(contactId)) return this.keys.get(contactId);
      const theirs = await subtle.importKey('raw', unb64u(pubB64), { name: 'ECDH', namedCurve: 'P-256' }, false, []);
      const bits = new Uint8Array(await subtle.deriveBits({ name: 'ECDH', public: theirs }, this.priv, 256));
      const key = await aesKey(await sha(cat(bits, enc.encode('bulong-dm-v1'))));
      this.keys.set(contactId, key);
      return key;
    }
    async groupKey(tag) {
      if (!this.keys.has('g:' + tag)) this.keys.set('g:' + tag, await aesKey(unb64u(this.state.groups[tag].key)));
      return this.keys.get('g:' + tag);
    }

    /* ---------- transport events ---------- */
    onFound(ep, name) { this.pending.delete(ep); this.found.set(ep, { name, at: this.now(), retryAt: 0 }); this.tryConnect(); }
    onLost(ep) { this.found.delete(ep); this.pending.delete(ep); }
    onConnectFailed(ep) {
      this.pending.delete(ep);
      const f = this.found.get(ep); if (f) f.retryAt = this.now() + 10e3;
    }
    onConnected(ep, name) {
      this.pending.delete(ep);
      if (name === this.id || this.links.size >= HARD_MAX_LINKS || [...this.links.values()].includes(name)) { this.t.disconnect(ep); return; }
      this.links.set(ep, name);
      this.sendTo([ep], this.helloPacket());
      const t = this.now();
      this.buffer = this.buffer.filter(b => t - b.at < (b.own ? OWN_KEEP : RELAY_KEEP));
      for (const b of this.buffer) this.sendTo([ep], b.p);
      this.markWaitingSent();
      this.emit('links', this.links.size);
    }
    onDisconnected(ep) {
      this.pending.delete(ep);
      if (this.links.delete(ep)) this.emit('links', this.links.size);
      this.tryConnect();
    }

    tryConnect() {
      const t = this.now();
      const linkedNodes = new Set(this.links.values());
      for (const [ep, f] of this.found) {
        if (this.links.size + this.pending.size >= MAX_LINKS) return;
        if (this.links.has(ep) || this.pending.has(ep) || linkedNodes.has(f.name) || f.name === this.id) continue;
        if (t < f.retryAt) continue;
        // the phone with the smaller id calls first; the other waits 8 s before trying too
        if (!(this.id < f.name) && t - f.at < 8e3) continue;
        this.pending.set(ep, t);
        try { Promise.resolve(this.t.connect(ep)).catch(() => this.onConnectFailed(ep)); } catch (e) { this.onConnectFailed(ep); }
      }
    }

    /* call every ~2 s */
    tick() {
      const t = this.now();
      for (const [ep, since] of this.pending) if (t - since > 20e3) this.onConnectFailed(ep);
      for (const [id, at] of this.seen) if (t - at > SEEN_KEEP) this.seen.delete(id);
      // bigger crowd -> announce less often, so the radio isn't flooded
      if (t - this.lastHello > HELLO_EVERY + 2e3 * this.online().length && this.links.size) { this.lastHello = t; this.broadcast(this.helloPacket()); }
      this.tryConnect();
    }

    async onData(ep, text) {
      let p;
      try { p = JSON.parse(text); } catch (e) { return; }
      if (!p || typeof p.id !== 'string' || typeof p.k !== 'string' || this.seen.has(p.id)) return;
      this.seen.set(p.id, this.now());
      const ttl = Math.min(Number(p.ttl) || 0, MSG_TTL);
      const forMeOnly = (p.k === 'dm' || p.k === 'ack') && p.to === this.id;
      if (ttl > 1 && !forMeOnly) {
        const fwd = Object.assign({}, p, { ttl: ttl - 1 });
        if (p.k !== 'hi') this.remember(fwd, false);
        this.broadcast(fwd, ep);
      }
      try { await this.handle(p); } catch (e) { /* bad or foreign packet: ignore */ }
    }

    /* ---------- sending ---------- */
    sendTo(eps, p) { if (eps.length) try { Promise.resolve(this.t.send(eps, JSON.stringify(p))).catch(() => {}); } catch (e) { /* link gone */ } }
    broadcast(p, exceptEp) { this.sendTo([...this.links.keys()].filter(e => e !== exceptEp), p); }
    remember(p, own) {
      this.buffer.push({ p, at: this.now(), own });
      if (this.buffer.length > BUFFER_MAX) this.buffer.splice(0, this.buffer.length - BUFFER_MAX);
    }
    originate(p) { this.seen.set(p.id, this.now()); this.remember(p, true); this.broadcast(p); }
    helloPacket() {
      const p = { k: 'hi', id: rid(), ttl: HI_TTL, from: this.id, name: this.state.me.name, pub: this.state.me.pub };
      this.seen.set(p.id, this.now());
      return p;
    }
    markWaitingSent() {
      let changed = false;
      for (const b of this.buffer) {
        if (!b.own || (b.p.k !== 'dm' && b.p.k !== 'gm')) continue;
        const chat = b.p.k === 'dm' ? 'dm:' + b.p.to : 'g:' + b.p.g;
        const m = (this.state.chats[chat] || []).find(x => x.id === b.p.id);
        if (m && m.status === 'waiting') { m.status = 'sent'; changed = true; this.emit('status', { chat, id: m.id }); }
      }
      if (changed) this.save();
    }

    async sendDM(contactId, text) {
      const c = this.state.contacts[contactId]; if (!c) throw new Error('unknown contact');
      text = String(text).slice(0, MAX_TEXT); if (!text.trim()) return null;
      const p = { k: 'dm', id: rid(), ttl: MSG_TTL, from: this.id, to: contactId, pub: this.state.me.pub };
      const t = this.now();
      Object.assign(p, await seal(await this.dmKey(contactId, c.pub), { text, name: this.state.me.name, t }, aadOf(p)));
      const msg = { id: p.id, from: this.id, name: this.state.me.name, text, t, mine: true, status: this.links.size ? 'sent' : 'waiting' };
      this.addMsg('dm:' + contactId, msg);
      this.originate(p);
      return msg;
    }

    async sendGroup(tag, text) {
      if (!this.state.groups[tag]) throw new Error('unknown group');
      text = String(text).slice(0, MAX_TEXT); if (!text.trim()) return null;
      const p = { k: 'gm', id: rid(), ttl: MSG_TTL, g: tag };
      const t = this.now();
      Object.assign(p, await seal(await this.groupKey(tag), { from: this.id, name: this.state.me.name, text, t }, aadOf(p)));
      const msg = { id: p.id, from: this.id, name: this.state.me.name, text, t, mine: true, status: this.links.size ? 'sent' : 'waiting' };
      this.addMsg('g:' + tag, msg);
      this.originate(p);
      return msg;
    }

    /* ---------- groups ---------- */
    async createGroup(name) {
      return this.joinGroup('bulong:g:' + b64u(root.crypto.getRandomValues(new Uint8Array(32))) + ':' + encodeURIComponent(String(name || 'Group').slice(0, 40)));
    }
    async joinGroup(invite) {
      const g = parseInvite(invite); if (!g) throw new Error('Not a Bulong group invite');
      const tag = hex((await sha(cat(unb64u(g.key), enc.encode('bulong-tag')))).slice(0, 8));
      if (!this.state.groups[tag]) { this.state.groups[tag] = { name: g.name, key: g.key, joined: this.now() }; this.save(); }
      this.emit('chats');
      return tag;
    }
    inviteFor(tag) { const g = this.state.groups[tag]; return 'bulong:g:' + g.key + ':' + encodeURIComponent(g.name); }
    leaveGroup(tag) { delete this.state.groups[tag]; delete this.state.chats['g:' + tag]; this.keys.delete('g:' + tag); this.save(); this.emit('chats'); }

    /* ---------- receiving ---------- */
    async learn(from, pub, name, hops) {
      if (from === this.id || typeof pub !== 'string' || (await nodeIdOf(pub)) !== from) return null;
      const c = this.state.contacts[from] || (this.state.contacts[from] = { pub, name: 'Someone' });
      if (name) c.name = String(name).slice(0, 40);
      if (hops) {
        const fresh = this.now() - (c.lastSeen || 0) < 60e3;
        c.hops = fresh && c.hops ? Math.min(c.hops, hops) : hops;
        c.lastSeen = this.now();
      }
      return c;
    }

    async handle(p) {
      if (p.k === 'hi') {
        if (await this.learn(p.from, p.pub, p.name, HI_TTL - Math.min(p.ttl, HI_TTL) + 1)) { this.save(); this.emit('peers'); }
      } else if (p.k === 'dm' && p.to === this.id) {
        const c = await this.learn(p.from, p.pub); if (!c) return;
        const body = await open(await this.dmKey(p.from, c.pub), p, aadOf(p));
        if (body.name && c.name === 'Someone') c.name = String(body.name).slice(0, 40);
        this.addMsg('dm:' + p.from, { id: p.id, from: p.from, name: c.name, text: String(body.text).slice(0, MAX_TEXT), t: Number(body.t) || this.now(), mine: false });
        const ack = { k: 'ack', id: rid(), ttl: MSG_TTL, from: this.id, to: p.from };
        Object.assign(ack, await seal(await this.dmKey(p.from, c.pub), { ref: p.id }, aadOf(ack)));
        this.originate(ack);
      } else if (p.k === 'ack' && p.to === this.id) {
        const c = this.state.contacts[p.from]; if (!c) return;
        const { ref } = await open(await this.dmKey(p.from, c.pub), p, aadOf(p));
        const m = (this.state.chats['dm:' + p.from] || []).find(x => x.id === ref && x.mine);
        if (m && m.status !== 'delivered') {
          m.status = 'delivered';
          this.buffer = this.buffer.filter(b => b.p.id !== ref);
          this.save(); this.emit('status', { chat: 'dm:' + p.from, id: ref });
        }
      } else if (p.k === 'gm' && this.state.groups[p.g]) {
        const body = await open(await this.groupKey(p.g), p, aadOf(p));
        if (body.from === this.id) return;
        this.addMsg('g:' + p.g, { id: p.id, from: String(body.from), name: String(body.name || 'Someone').slice(0, 40), text: String(body.text).slice(0, MAX_TEXT), t: Number(body.t) || this.now(), mine: false });
      }
    }

    addMsg(chat, msg) {
      const list = this.state.chats[chat] || (this.state.chats[chat] = []);
      if (list.some(m => m.id === msg.id)) return;
      list.push(msg);
      list.sort((a, b) => a.t - b.t);
      if (list.length > 500) list.splice(0, list.length - 500);
      if (!msg.mine) this.state.unread = Object.assign(this.state.unread || {}, { [chat]: ((this.state.unread || {})[chat] || 0) + 1 });
      this.save();
      this.emit('msg', { chat, msg });
    }

    /* ---------- info for the UI ---------- */
    online() {
      const t = this.now();
      return Object.entries(this.state.contacts)
        .filter(([, c]) => t - (c.lastSeen || 0) < ONLINE_WINDOW)
        .map(([id, c]) => Object.assign({ id }, c))
        .sort((a, b) => (a.hops || 9) - (b.hops || 9) || a.name.localeCompare(b.name));
    }
    async safetyCode(contactId) {
      const pubs = [this.state.me.pub, this.state.contacts[contactId].pub].sort();
      const h = await sha(enc.encode(pubs.join('.')));
      const n = Array.from(h.slice(0, 6), b => String(b % 100).padStart(2, '0')).join('');
      return n.slice(0, 4) + ' ' + n.slice(4, 8) + ' ' + n.slice(8, 12);
    }
  }

  const api = { MeshNode, parseInvite, nodeIdOf, MAX_TEXT };
  root.BulongMesh = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
