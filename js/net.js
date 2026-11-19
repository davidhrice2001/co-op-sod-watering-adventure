/* Online two-player play (SOD.Net) over a PeerJS (WebRTC) data channel.
 * Host-authoritative: the host steps SOD.Sim with its own input half + the guest's latest half and
 * streams snapshots; the guest only sends its input half + action requests and renders reconstructed state.
 *
 * Protocol (every message is a JSON string with a `t` field; one reliable, ordered channel):
 *   guest -> host  hello | in {r: role, d: inputHalf} (~30 Hz) | act {a, id} | resync | ping/pong | bye
 *   host  -> guest lobby {hr: hostRole, g: inGame, code} | field {fid, f: static field arrays, st: stations}
 *                  snap {seq, fid, ht, s: dynamic state, full?, w: water, dn: done, ev: events} (~20 Hz)
 *                  full (room taken) | ping/pong | bye
 *   Snapshots carry water/done as [index, value, ...] deltas against the previous snapshot; `full` ones
 *   (on connect, on field change, on resync request, every FULL_EVERY snaps) carry whole arrays.
 *
 * The codec (Encoder/Decoder) is DOM-free so tools/nettest.js can run it under node.
 */
(function () {
  'use strict';
  var SOD = (window.SOD = window.SOD || {});

  var PREFIX = 'sodwater3d-v1-';
  var CODE_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // no I, L, O, 0, 1
  var CODE_LEN = 5;
  var SNAP_MS = 50, INPUT_MS = 33, PING_MS = 1000, TIMEOUT_MS = 6000, JOIN_TIMEOUT_MS = 15000;
  var FULL_EVERY = 200, INTERP_MS = 100, TELEPORT = 150;

  // ---------------------------------------------------------------- codec helpers
  function r2(v) { return Math.round(v * 100) / 100; }
  function r3(v) { return Math.round(v * 1000) / 1000; }
  function replacer(k, v) { return (typeof v === 'number' && v % 1 !== 0) ? Math.round(v * 1000) / 1000 : v; }
  function enc(msg) { return JSON.stringify(msg, replacer); }
  function dec(data) {
    if (typeof data === 'string') { try { return JSON.parse(data); } catch (e) { return null; } }
    return (data && typeof data === 'object') ? data : null;
  }
  function wrap(a) {
    while (a > Math.PI) a -= Math.PI * 2;
    while (a < -Math.PI) a += Math.PI * 2;
    return a;
  }
  function lerp(a, b, t) { return a + (b - a) * t; }
  function lerpAng(a, b, t) { return wrap(a + wrap(b - a) * t); }
  function copy(o) { var r = {}; for (var k in o) r[k] = o[k]; return r; }

  // Recompute the nozzle position and splash hit points from an aim point (same math as Sim's updateAim).
  function applyAim(state, ax, ay) {
    var Sim = SOD.Sim, sp = state.spray, st = Sim.getStats(state);
    var nz = Sim.getNozzle(state);
    sp.nozX = nz.x; sp.nozY = nz.y;
    sp.aimX = ax; sp.aimY = ay;
    var dx = ax - nz.x, dy = ay - nz.y, d = Math.sqrt(dx * dx + dy * dy);
    if (d > st.range) { dx *= st.range / d; dy *= st.range / d; d = st.range; }
    sp.hitX = nz.x + dx; sp.hitY = nz.y + dy;
    var n = st.nozzles, px = 0, py = 1;
    if (d > 1) { px = -dy / d; py = dx / d; }
    var spacing = st.radius * 1.5, hits = [];
    for (var i = 0; i < n; i++) {
      var o = (i - (n - 1) / 2) * spacing;
      hits.push({ x: sp.hitX + px * o, y: sp.hitY + py * o });
    }
    sp.hits = hits;
  }

  // ---------------------------------------------------------------- Encoder (host)
  var DYN_SKIP = { field: 1, stations: 1, events: 1 };
  function Encoder() { this.seq = 0; this.fid = 0; this.reset(); }
  // Forget what the guest has: the next encode re-sends the static field and a full snapshot.
  Encoder.prototype.reset = function () { this.fieldRef = null; this.lastW = null; this.lastD = null; this.sinceFull = 0; };
  // Returns an array of JSON strings to send, in order.
  Encoder.prototype.encode = function (state, events, ht) {
    var out = [], f = state.field, i, n;
    if (f !== this.fieldRef) {
      this.fieldRef = f; this.fid++; this.lastW = null;
      out.push({
        t: 'field', fid: this.fid, st: state.stations,
        f: f ? { cols: f.cols, rows: f.rows, tile: f.tile, x: f.x, y: f.y, total: f.total,
          need: f.need.map(r2), pay: f.pay, dry: f.dry.map(r3), bonus: f.bonus.join('') } : null
      });
    }
    var s = {};
    for (var k in state) if (!DYN_SKIP[k]) s[k] = state[k];
    var snap = { t: 'snap', seq: ++this.seq, fid: this.fid, ht: ht, s: s };
    if (events && events.length) snap.ev = events;
    if (f) {
      s._dc = f.doneCount;
      n = f.total;
      if (!this.lastW || ++this.sinceFull >= FULL_EVERY) {
        this.lastW = new Array(n); this.lastD = new Array(n);
        for (i = 0; i < n; i++) { this.lastW[i] = r2(f.water[i]); this.lastD[i] = f.done[i]; }
        snap.full = 1; snap.w = this.lastW; snap.dn = this.lastD; this.sinceFull = 0;
      } else {
        var w = [], dn = [];
        for (i = 0; i < n; i++) {
          var v = r2(f.water[i]);
          if (v !== this.lastW[i]) { this.lastW[i] = v; w.push(i, v); }
          if (f.done[i] !== this.lastD[i]) { this.lastD[i] = f.done[i]; dn.push(i, f.done[i]); }
        }
        if (w.length) snap.w = w;
        if (dn.length) snap.dn = dn;
      }
    }
    out.push(snap);
    return out.map(enc); // stringify NOW: snap references live state objects
  };

  // ---------------------------------------------------------------- Decoder (guest)
  function Decoder() { this.reset(); }
  Decoder.prototype.reset = function () {
    this.fid = -1; this.fstat = null; this.stations = null; this.water = null; this.done = null;
    this.seq = -1; this.snaps = []; this.events = []; this.clockOff = null; this.ready = false; this.wantResync = false;
  };
  // m: parsed message. now: local ms clock.
  Decoder.prototype.receive = function (m, now) {
    var i;
    if (!m) return;
    if (m.t === 'field') {
      this.fid = m.fid; this.stations = m.st; this.seq = -1; this.wantResync = false;
      if (m.f) {
        var f = m.f, bonus = [];
        for (i = 0; i < f.bonus.length; i++) bonus.push(f.bonus.charCodeAt(i) === 49 ? 1 : 0);
        this.fstat = { cols: f.cols, rows: f.rows, tile: f.tile, x: f.x, y: f.y, total: f.total,
          need: f.need, pay: f.pay, dry: f.dry, bonus: bonus };
        this.water = []; this.done = [];
        for (i = 0; i < f.total; i++) { this.water.push(0); this.done.push(0); }
      } else this.fstat = null;
      return;
    }
    if (m.t !== 'snap') return;
    if (m.ev) for (i = 0; i < m.ev.length; i++) this.events.push({ e: m.ev[i], ht: m.ht, recv: now });
    if (this.events.length > 300) this.events.splice(0, this.events.length - 300);
    if (m.fid < this.fid) return;                       // stale, from before the newest field
    if (m.fid > this.fid) { this.wantResync = true; return; }
    if (this.fstat) {
      if (m.full) { this.water = m.w.slice(); this.done = m.dn.slice(); }
      else if (this.seq < 0 || m.seq !== this.seq + 1) { this.wantResync = true; return; }
      else {
        var w = m.w || [], dn = m.dn || [];
        for (i = 0; i < w.length; i += 2) this.water[w[i]] = w[i + 1];
        for (i = 0; i < dn.length; i += 2) this.done[dn[i]] = dn[i + 1];
      }
    }
    this.seq = m.seq; this.ready = true; this.wantResync = false;
    var off = now - m.ht;
    if (this.clockOff === null || off < this.clockOff) this.clockOff = off;
    else this.clockOff += (off - this.clockOff) * 0.02;
    var snaps = this.snaps;
    if (snaps.length && m.ht < snaps[snaps.length - 1].ht) snaps.length = 0; // host clock restarted
    snaps.push({ ht: m.ht, s: m.s });
    if (snaps.length > 16) snaps.shift();
  };
  Decoder.prototype._base = function (snap) {
    var st = copy(snap.s);
    delete st._dc;
    st.truck = copy(snap.s.truck); st.trailer = copy(snap.s.trailer); st.spray = copy(snap.s.spray);
    st.stations = this.stations || [];
    st.events = [];
    st.field = this.fstat ? {
      cols: this.fstat.cols, rows: this.fstat.rows, tile: this.fstat.tile, x: this.fstat.x, y: this.fstat.y,
      total: this.fstat.total, need: this.fstat.need, pay: this.fstat.pay, dry: this.fstat.dry, bonus: this.fstat.bonus,
      water: this.water, done: this.done, doneCount: snap.s._dc || 0
    } : null;
    return st;
  };
  // Latest snapshot, no interpolation.
  Decoder.prototype.latest = function () {
    return this.ready ? this._base(this.snaps[this.snaps.length - 1]) : null;
  };
  // Full renderable state: latest values, with truck/trailer/aim interpolated INTERP_MS in the past.
  // localSprayer (optional {aimX, aimY, spraying}): draw this player's own aim immediately.
  Decoder.prototype.view = function (now, localSprayer) {
    if (!this.ready) return null;
    var snaps = this.snaps, last = snaps[snaps.length - 1];
    var st = this._base(last);
    var rt = now - this.clockOff - INTERP_MS;
    var a = null, b = null, i;
    for (i = snaps.length - 1; i >= 0; i--) if (snaps[i].ht <= rt) { a = snaps[i]; b = snaps[i + 1] || null; break; }
    if (!a) a = snaps[0];
    var t = 0;
    if (b) {
      var A = a.s.truck, B = b.s.truck, dx = B.x - A.x, dy = B.y - A.y;
      if (dx * dx + dy * dy > TELEPORT * TELEPORT || a.s.round !== b.s.round) { a = b; b = null; }
      else t = Math.max(0, Math.min(1, (rt - a.ht) / Math.max(1, b.ht - a.ht)));
    }
    var ta = a.s.truck, tra = a.s.trailer, spa = a.s.spray;
    var tb = b ? b.s.truck : ta, trb = b ? b.s.trailer : tra, spb = b ? b.s.spray : spa;
    var tr = st.truck, tl = st.trailer;
    tr.x = lerp(ta.x, tb.x, t); tr.y = lerp(ta.y, tb.y, t); tr.a = lerpAng(ta.a, tb.a, t);
    tr.v = lerp(ta.v, tb.v, t); tr.steer = lerp(ta.steer, tb.steer, t);
    tl.x = lerp(tra.x, trb.x, t); tl.y = lerp(tra.y, trb.y, t); tl.a = lerpAng(tra.a, trb.a, t);
    var ax = lerp(spa.aimX, spb.aimX, t), ay = lerp(spa.aimY, spb.aimY, t);
    var sp = st.spray;
    if (localSprayer && isFinite(localSprayer.aimX) && isFinite(localSprayer.aimY)) {
      ax = localSprayer.aimX; ay = localSprayer.aimY;
      var live = st.phase === 'playing' && !st.paused && st.countdown <= 0;
      sp.want = !!localSprayer.spraying;
      sp.on = live && sp.want && st.tank.water > 0.0001;
      if (!sp.want) sp.sputter = false;
    }
    applyAim(st, ax, ay);
    return st;
  };
  // Events are released in step with the interpolated view (or after 400 ms at the latest).
  Decoder.prototype.takeEvents = function (now) {
    var out = [], rt = this.clockOff === null ? Infinity : now - this.clockOff - INTERP_MS;
    while (this.events.length && (this.events[0].ht <= rt || now - this.events[0].recv > 400)) out.push(this.events.shift().e);
    return out;
  };

  // ================================================================= session (browser only below)
  var cb = {};
  var S = null;           // current session
  var SER = 'raw';
  var $ = function (id) { return document.getElementById(id); };
  function nowMs() { return performance.now(); }
  function available() { return typeof window.Peer === 'function'; }
  function other(r) { return r === 'driver' ? 'sprayer' : 'driver'; }
  function roleName(r) { return r === 'driver' ? 'Driver' : 'Sprayer'; }

  function newSession(kind) {
    return { kind: kind, peer: null, conn: null, code: '', hostRole: 'driver', inGame: false, connected: false,
      remoteIn: null, lastRecv: 0, lastSnap: 0, lastInput: 0, lastPing: 0, rtt: null, enc: new Encoder(),
      dec: new Decoder(), pendingEv: [], lastResync: 0, joinTimer: null, tries: 0, rejoin: false, dropped: false };
  }
  function myRole() { return !S ? null : S.kind === 'host' ? S.hostRole : other(S.hostRole); }
  function genCode() {
    var c = '';
    for (var i = 0; i < CODE_LEN; i++) c += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
    return c;
  }
  function cleanCode(s) {
    return String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  }
  function validCode(s) {
    if (s.length !== CODE_LEN) return false;
    for (var i = 0; i < s.length; i++) if (CODE_CHARS.indexOf(s[i]) < 0) return false;
    return true;
  }

  function send(msg) {
    if (!S || !S.conn || !S.conn.open) return false;
    try { S.conn.send(typeof msg === 'string' ? msg : enc(msg)); return true; } catch (e) { return false; }
  }
  function backlog() {
    var c = S && S.conn;
    if (!c) return 0;
    var b = (c.dataChannel && c.dataChannel.bufferedAmount) || 0;
    return b + (c.bufferSize || 0) * 16000;
  }

  // ---------------------------------------------------------------- UI helpers
  function show(id, on) { var el = $(id); if (el) el.classList.toggle('hidden', !on); }
  function lobbyStatus(text, isErr) {
    var el = $('net-status-text');
    el.textContent = text || '';
    el.classList.toggle('err', !!isErr);
  }
  function dropMsg(text) { $('drop-msg').textContent = text || ''; }
  function updateRoleUI() {
    var me = myRole();
    if (!me) return;
    $('net-role-me').textContent = 'You: ' + roleName(me);
    $('net-role-me').className = 'net-role-card ' + me;
    $('net-role-them').textContent = 'Partner: ' + roleName(other(me));
    $('net-role-them').className = 'net-role-card ' + other(me);
    applyClasses();
  }
  function applyClasses() {
    var b = document.body, on = !!(S && S.inGame), r = myRole();
    b.classList.toggle('net-online', on);
    b.classList.toggle('net-role-driver', on && r === 'driver');
    b.classList.toggle('net-role-sprayer', on && r === 'sprayer');
    b.classList.toggle('net-guest', on && S.kind === 'guest');
    var q = $('btn-menu-from-shop');
    if (q) q.textContent = on && S.kind === 'guest' ? 'Leave Game' : 'Save & Quit';
    show('net-status', !!S && (S.inGame || S.connected));
  }
  var chipText = '';
  function updateChip() {
    if (!S) return;
    var parts = [];
    var r = myRole();
    if (r) parts.push('You: ' + roleName(r));
    if (S.connected) {
      parts.push('Online');
      if (S.rtt !== null) parts.push(Math.round(S.rtt) + ' ms');
    } else parts.push(S.kind === 'host' ? 'Partner offline' : 'Disconnected');
    var t = parts.join(' \u00b7 ');
    if (t !== chipText) {
      chipText = t;
      var el = $('net-status');
      el.textContent = t;
      el.classList.toggle('bad', !S.connected);
    }
  }

  function openLobby(kind) {
    show('netlobby', true);
    show('net-host-box', kind === 'host');
    show('net-join-box', kind === 'guest');
    show('net-role-box', false);
    show('net-start-box', false);
    $('net-title').textContent = kind === 'host' ? 'Host Online Game' : 'Join Online Game';
    lobbyStatus('');
  }
  function closeLobby() { show('netlobby', false); }
  function showDrop(kind, title, msg) {
    show('netdrop', true);
    $('drop-title').textContent = title;
    dropMsg(msg);
    $('drop-code').textContent = S ? S.code : '';
    show('drop-code', kind === 'host');
    show('drop-retry', kind === 'guest');
    show('drop-solo', kind === 'host');
    $('drop-quit').textContent = kind === 'host' ? 'Save & Quit to Menu' : 'Back to Menu';
  }
  function hideDrop() { show('netdrop', false); }

  // ---------------------------------------------------------------- peer plumbing
  function peerErrorText(err) {
    var t = err && err.type;
    if (t === 'peer-unavailable') return 'No game found with that code. Check the code and that the host is still waiting.';
    if (t === 'network' || t === 'server-error' || t === 'socket-error' || t === 'socket-closed')
      return 'Could not reach the matchmaking server (0.peerjs.com). Check your internet connection and try again.';
    if (t === 'browser-incompatible') return 'This browser does not support WebRTC data channels.';
    if (t === 'webrtc') return 'The direct connection failed (a firewall or strict NAT may be blocking WebRTC).';
    return 'Connection error' + (t ? ' (' + t + ')' : '') + '.';
  }
  function destroyPeer(sess) {
    if (!sess) return;
    if (sess.joinTimer) { clearTimeout(sess.joinTimer); sess.joinTimer = null; }
    var p = sess.peer, c = sess.conn;
    sess.peer = null; sess.conn = null;
    try { if (c) c.close(); } catch (e) { /* ignore */ }
    try { if (p) p.destroy(); } catch (e) { /* ignore */ }
  }

  function attachConn(sess, conn) {
    conn.on('open', function () { if (S === sess && sess.conn === conn) onOpen(sess); });
    conn.on('data', function (d) { if (S === sess && sess.conn === conn) onData(sess, dec(d)); });
    conn.on('close', function () { if (S === sess && sess.conn === conn) onLost(sess, 'close'); });
    conn.on('error', function () { if (S === sess && sess.conn === conn) onLost(sess, 'error'); });
  }

  // ---------------------------------------------------------------- host
  function startHost() {
    if (!available()) return;
    leave(true);
    var sess = S = newSession('host');
    openLobby('host');
    $('net-code').textContent = '-----';
    lobbyStatus('Contacting matchmaking server\u2026');
    hostPeer(sess);
  }
  function hostPeer(sess) {
    sess.code = genCode();
    var peer;
    try { peer = new window.Peer(PREFIX + sess.code, { debug: 0 }); } catch (e) { lobbyStatus('Online play unavailable: ' + e.message, true); return; }
    sess.peer = peer;
    peer.on('open', function () {
      if (S !== sess) return;
      $('net-code').textContent = sess.code;
      if (!sess.connected && !sess.inGame) lobbyStatus('Waiting for your partner to join\u2026');
      show('net-role-box', true); updateRoleUI();
    });
    peer.on('connection', function (conn) {
      if (S !== sess) { try { conn.close(); } catch (e) { /* ignore */ } return; }
      if (sess.conn && sess.conn.open && sess.connected) {
        conn.on('open', function () { try { conn.send(enc({ t: 'full' })); } catch (e) { /* ignore */ } setTimeout(function () { try { conn.close(); } catch (e) { /* ignore */ } }, 500); });
        return;
      }
      if (sess.conn) { var old = sess.conn; sess.conn = null; try { old.close(); } catch (e) { /* ignore */ } }
      sess.conn = conn;
      attachConn(sess, conn);
    });
    peer.on('disconnected', function () {
      // lost the broker (not the partner): stay joinable
      if (S === sess && sess.peer === peer && !peer.destroyed) setTimeout(function () { try { if (S === sess && !peer.destroyed) peer.reconnect(); } catch (e) { /* ignore */ } }, 1500);
    });
    peer.on('error', function (err) {
      if (S !== sess || sess.peer !== peer) return;
      if (err && err.type === 'unavailable-id' && sess.tries++ < 5) {
        try { peer.destroy(); } catch (e) { /* ignore */ }
        hostPeer(sess);
        return;
      }
      if (err && err.type === 'peer-unavailable') return;
      if (!sess.inGame && !sess.connected) lobbyStatus(peerErrorText(err), true);
    });
  }
  function sendLobby() { send({ t: 'lobby', hr: S.hostRole, g: S.inGame, code: S.code }); }
  function hostStart(kind) {
    if (!S || S.kind !== 'host' || !S.connected) return;
    if (!cb.startGame || !cb.startGame(kind)) return;
    S.inGame = true;
    S.enc.reset();
    closeLobby();
    sendLobby();
    applyClasses();
  }
  function swapRoles() {
    if (!S) return;
    if (S.kind === 'guest') { send({ t: 'act', a: 'swap' }); return; }
    var st = cb.getState && cb.getState();
    if (S.inGame && st && st.phase === 'playing') return;
    S.hostRole = other(S.hostRole);
    S.remoteIn = null;
    if (SOD.Input) SOD.Input.clear();
    sendLobby();
    updateRoleUI();
  }

  // ---------------------------------------------------------------- guest
  function startJoin(code, rejoin) {
    if (!available()) return;
    code = cleanCode(code);
    var say = rejoin ? dropMsg : function (t, e) { lobbyStatus(t, e); };
    if (!validCode(code)) { say('Room codes are ' + CODE_LEN + ' letters/numbers, like K7QXM.', true); return; }
    var keepMode = rejoin && S && S.inGame;
    leave(true);
    var sess = S = newSession('guest');
    sess.code = code; sess.rejoin = !!rejoin; sess.inGame = false;
    sess.dropped = !!keepMode;
    say('Connecting to room ' + code + '\u2026');
    var fail = function (text) {
      if (S !== sess) return;
      destroyPeer(sess);
      sess.connected = false;
      if (sess.rejoin) say(text); else { say(text, true); show('net-connect', true); }
    };
    sess.joinTimer = setTimeout(function () { fail('Timed out connecting to room ' + code + '. Check the code, and that the host is still in the lobby.'); }, JOIN_TIMEOUT_MS);
    var peer;
    try { peer = new window.Peer({ debug: 0 }); } catch (e) { fail('Online play unavailable: ' + e.message); return; }
    sess.peer = peer;
    peer.on('open', function () {
      if (S !== sess) return;
      var conn = peer.connect(PREFIX + code, { reliable: true, serialization: SER });
      sess.conn = conn;
      attachConn(sess, conn);
    });
    peer.on('error', function (err) {
      if (S !== sess) return;
      if (sess.connected) { if (err && err.type !== 'peer-unavailable') onLost(sess, 'error'); return; }
      fail(peerErrorText(err));
    });
  }

  // ---------------------------------------------------------------- shared connection events
  function onOpen(sess) {
    sess.connected = true;
    sess.lastRecv = nowMs();
    sess.rtt = null;
    if (sess.kind === 'host') {
      sess.remoteIn = null;
      sendLobby();
      if (sess.inGame) {
        sess.enc.reset();
        hideDrop();
      } else {
        lobbyStatus('Partner connected! Pick roles, then start.');
        show('net-start-box', true);
        show('net-continue', !!(cb.hasSave && cb.hasSave()));
      }
    } else {
      if (sess.joinTimer) { clearTimeout(sess.joinTimer); sess.joinTimer = null; }
      send({ t: 'hello', v: 1 });
      if (sess.rejoin) dropMsg('Connected - waiting for the host\u2026');
      else {
        lobbyStatus('Connected! Waiting for the host to start the game\u2026');
        show('net-connect', false);
      }
    }
    applyClasses();
  }

  function onData(sess, m) {
    if (!m) return;
    var now = nowMs();
    sess.lastRecv = now;
    switch (m.t) {
      case 'ping': send({ t: 'pong', c: m.c }); return;
      case 'pong':
        var r = now - m.c;
        if (r >= 0) sess.rtt = sess.rtt === null ? r : sess.rtt + (r - sess.rtt) * 0.3;
        return;
      case 'bye': onLost(sess, 'bye'); return;
    }
    if (sess.kind === 'host') {
      if (m.t === 'in') { if (m.r === other(sess.hostRole) && m.d && typeof m.d === 'object') sess.remoteIn = m.d; }
      else if (m.t === 'act') { if (m.a === 'swap') swapRoles(); else if (sess.inGame && cb.hostAction) cb.hostAction(String(m.a), m.id); }
      else if (m.t === 'resync') sess.enc.reset();
      return;
    }
    // guest
    if (m.t === 'lobby') {
      var changed = sess.hostRole !== m.hr;
      sess.hostRole = m.hr === 'sprayer' ? 'sprayer' : 'driver';
      if (changed && SOD.Input) SOD.Input.clear();
      if (!sess.rejoin && !sess.inGame) show('net-role-box', true);
      updateRoleUI();
    } else if (m.t === 'field' || m.t === 'snap') {
      sess.dec.receive(m, now);
      if (m.t === 'snap' && sess.dec.ready && !sess.inGame) {
        sess.inGame = true; sess.dropped = false;
        closeLobby(); hideDrop();
        if (cb.enterGuest) cb.enterGuest();
        applyClasses();
      }
    } else if (m.t === 'full') {
      var text = 'That room already has two players.';
      destroyPeer(sess); sess.connected = false;
      if (sess.rejoin) dropMsg(text); else lobbyStatus(text, true);
    }
  }

  function onLost(sess, why) {
    if (!sess.connected && why !== 'bye') { /* already handled */ }
    var c = sess.conn;
    sess.conn = null;
    sess.connected = false;
    sess.remoteIn = null;
    try { if (c) c.close(); } catch (e) { /* ignore */ }
    if (sess.kind === 'host') {
      if (sess.inGame) {
        if (cb.hostAction) cb.hostAction('autopause');
        showDrop('host', 'Partner disconnected', 'The game is paused. Your partner can rejoin with the same room code, or you can keep playing on this computer.');
      } else {
        lobbyStatus('Your partner left. Waiting for a partner to join\u2026');
        show('net-start-box', false);
      }
    } else {
      destroyPeer(sess);
      var msg = why === 'bye' ? 'The host ended the session.' : 'Lost the connection to the host.';
      if (sess.inGame || sess.rejoin) {
        sess.dropped = true;
        sess.inGame = false;
        showDrop('guest', 'Host disconnected', msg + ' You can try to reconnect to room ' + sess.code + '.');
      } else {
        lobbyStatus(msg, true);
        show('net-connect', true);
        show('net-role-box', false);
      }
    }
    applyClasses();
    updateChip();
  }

  // ---------------------------------------------------------------- per-tick work (called by main, also from the background timer)
  function tick(now) {
    if (!S) return;
    if (S.connected) {
      if (now - S.lastPing >= PING_MS) { S.lastPing = now; send({ t: 'ping', c: now }); }
      if (now - S.lastRecv > TIMEOUT_MS) onLost(S, 'timeout');
    }
    if (S && S.kind === 'guest' && S.connected && S.dec.wantResync && now - S.lastResync > 1500) {
      S.lastResync = now; send({ t: 'resync' });
    }
    updateChip();
  }
  function hostSend(state, events, now) {
    if (!S || S.kind !== 'host') return;
    if (!S.connected || !S.inGame) { S.pendingEv.length = 0; return; }
    for (var i = 0; i < events.length; i++) S.pendingEv.push(events[i]);
    if (S.pendingEv.length > 300) S.pendingEv.splice(0, S.pendingEv.length - 300);
    if (now - S.lastSnap < SNAP_MS - 6) return; // tolerance so 16.7/25 ms ticks still give ~20 Hz
    if (backlog() > 512 * 1024) return; // channel congested: skip; next delta covers it
    S.lastSnap = now;
    var msgs = S.enc.encode(state, S.pendingEv, now);
    S.pendingEv = [];
    for (var j = 0; j < msgs.length; j++) if (!send(msgs[j])) { S.enc.reset(); break; }
  }
  function sendInput(half, now) {
    if (!S || S.kind !== 'guest' || !S.connected || !S.inGame) return;
    if (now - S.lastInput < INPUT_MS - 6) return;
    S.lastInput = now;
    send({ t: 'in', r: myRole(), d: half });
  }
  function guestView(now, localSprayer) { return (S && S.kind === 'guest') ? S.dec.view(now, localSprayer) : null; }
  function takeEvents(now) { return (S && S.kind === 'guest') ? S.dec.takeEvents(now) : []; }
  function request(action, id) { if (S && S.kind === 'guest') send({ t: 'act', a: action, id: id }); }
  function remoteInput() { return S && S.kind === 'host' && S.connected ? S.remoteIn : null; }

  // End the session. quiet: don't touch the lobby overlay (used when restarting a session).
  function leave(quiet) {
    var sess = S;
    S = null;
    if (sess) {
      if (sess.conn && sess.conn.open) { try { sess.conn.send(enc({ t: 'bye' })); } catch (e) { /* ignore */ } }
      setTimeout(function () { destroyPeer(sess); }, 250);
      if (sess.joinTimer) { clearTimeout(sess.joinTimer); sess.joinTimer = null; }
    }
    if (!quiet) { closeLobby(); hideDrop(); }
    chipText = '';
    if (typeof document !== 'undefined') applyClasses();
  }

  // ---------------------------------------------------------------- boot
  function init(callbacks) {
    cb = callbacks || {};
    var ok = available();
    var bh = $('btn-host'), bj = $('btn-join');
    if (!ok) {
      bh.disabled = true; bj.disabled = true;
      bh.textContent = 'Host Online (unavailable)'; bj.textContent = 'Join Online (unavailable)';
      $('net-unavail').textContent = 'Online play is unavailable: the PeerJS library could not be loaded. Local co-op still works.';
      return;
    }
    bh.onclick = function () { startHost(); };
    bj.onclick = function () {
      leave(true);
      openLobby('guest');
      show('net-connect', true);
      var inp = $('net-code-input');
      inp.value = '';
      setTimeout(function () { inp.focus(); }, 30);
    };
    $('net-connect').onclick = function () { startJoin($('net-code-input').value, false); };
    $('net-code-input').addEventListener('keydown', function (e) {
      e.stopPropagation();
      if (e.key === 'Enter') startJoin($('net-code-input').value, false);
    });
    $('net-code-input').addEventListener('input', function (e) {
      var v = e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, CODE_LEN);
      if (v !== e.target.value) e.target.value = v;
    });
    $('net-copy').onclick = function () {
      var code = S ? S.code : '';
      if (!code) return;
      var btn = $('net-copy');
      var done = function () { btn.textContent = 'Copied!'; setTimeout(function () { btn.textContent = 'Copy'; }, 1200); };
      try {
        if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(code).then(done, function () { btn.textContent = 'Select & copy'; });
        else btn.textContent = 'Select & copy';
      } catch (e) { btn.textContent = 'Select & copy'; }
    };
    $('net-swap').onclick = function () { swapRoles(); };
    $('btn-swap-roles').onclick = function () { swapRoles(); };
    $('net-new').onclick = function () { hostStart('new'); };
    $('net-continue').onclick = function () { hostStart('continue'); };
    $('net-cancel').onclick = function () { leave(false); };
    $('drop-retry').onclick = function () { if (S) startJoin(S.code, true); };
    $('drop-solo').onclick = function () { leave(false); if (cb.goLocal) cb.goLocal(); };
    $('drop-quit').onclick = function () { if (cb.quit) cb.quit(); else leave(false); };
    window.addEventListener('beforeunload', function () { if (S && S.conn && S.conn.open) { try { S.conn.send(enc({ t: 'bye' })); } catch (e) { /* ignore */ } } });
  }

  SOD.Net = {
    PREFIX: PREFIX,
    available: available,
    init: init,
    tick: tick,
    hostSend: hostSend,
    sendInput: sendInput,
    guestView: guestView,
    takeEvents: takeEvents,
    request: request,
    remoteInput: remoteInput,
    leave: leave,
    swapRoles: swapRoles,
    myRole: myRole,
    active: function () { return !!S; },
    isHost: function () { return !!S && S.kind === 'host'; },
    isGuest: function () { return !!S && S.kind === 'guest'; },
    inGame: function () { return !!S && S.inGame; },
    code: function () { return S ? S.code : ''; },
    debug: function () { return S ? { kind: S.kind, code: S.code, connected: S.connected, inGame: S.inGame, hostRole: S.hostRole, rtt: S.rtt, remoteIn: S.remoteIn, seq: S.kind === 'host' ? S.enc.seq : S.dec.seq } : null; },
    Codec: { Encoder: Encoder, Decoder: Decoder, enc: enc, dec: dec, applyAim: applyAim, CODE_CHARS: CODE_CHARS, validCode: validCode }
  };
})();
