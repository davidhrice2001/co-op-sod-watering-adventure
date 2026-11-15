// Headless netcode test: node tools/nettest.js
// Runs the sim as "host", pipes encoded snapshots through JSON strings into a "guest" Decoder,
// and checks the guest's reconstructed state against the host's.
var fs = require('fs'), vm = require('vm'), path = require('path');
var ctx = { window: {}, Math: Math, JSON: JSON, console: console };
vm.createContext(ctx);
['sim.js', 'net.js'].forEach(function (f) {
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'js', f), 'utf8'), ctx, { filename: f });
});
var Sim = ctx.window.SOD.Sim, Codec = ctx.window.SOD.Net.Codec;
var fails = 0;
function assert(c, m) { if (!c) { console.error('FAIL: ' + m); fails++; process.exitCode = 1; } else console.log('ok  - ' + m); }
function near(a, b, eps) { return Math.abs(a - b) <= eps; }

function scripted(st, f) {
  var C = Sim.C, t = st.truck;
  var drv = { throttle: 0.7, steer: Math.sin(f / 150) * 0.6, brake: false };
  if (st.tank.water < 1 || st.tank.refilling) {
    var h = st.stations[0];
    var dx = h.x - st.trailer.x, dy = h.y - st.trailer.y;
    var want = Math.atan2(dy, dx), diff = Math.atan2(Math.sin(want - t.a), Math.cos(want - t.a));
    drv.steer = Math.max(-1, Math.min(1, diff * 2));
    var d = Math.sqrt(dx * dx + dy * dy);
    drv.throttle = d < 80 ? 0 : 0.8; drv.brake = d < 80;
  } else if (t.y < C.FIELD_Y + 60) drv.steer = 0.5;
  var nz = Sim.getNozzle(st), best = null, bd = 1e9, F = st.field;
  for (var i = 0; i < F.total; i++) {
    if (F.done[i]) continue;
    var c = i % F.cols, r = (i - c) / F.cols;
    var x = F.x + (c + .5) * F.tile, y = F.y + (r + .5) * F.tile;
    var dd = (x - nz.x) * (x - nz.x) + (y - nz.y) * (y - nz.y);
    if (dd < bd) { bd = dd; best = { x: x, y: y }; }
  }
  return { driver: drv, sprayer: { aimX: best ? best.x : nz.x, aimY: best ? best.y : nz.y, spraying: true } };
}

// Compare guest state to host; returns list of mismatch descriptions.
function diff(h, g) {
  var out = [];
  function eq(name, a, b, eps) {
    if (typeof a === 'number' ? !near(a, b, eps || 0) : JSON.stringify(a) !== JSON.stringify(b)) out.push(name + ' host=' + JSON.stringify(a) + ' guest=' + JSON.stringify(b));
  }
  if (!g) return ['guest state null'];
  ['phase', 'paused', 'round', 'money', 'upgrades', 'stats', 'lastRound'].forEach(function (k) {
    if (k === 'lastRound' || k === 'stats') eq(k, JSON.parse(Codec.enc(h[k])), g[k]); else eq(k, h[k], g[k]);
  });
  ['timer', 'countdown', 'roundLength'].forEach(function (k) { eq(k, h[k], g[k], 0.001); });
  ['water', 'cap'].forEach(function (k) { eq('tank.' + k, h.tank[k], g.tank[k], 0.001); });
  ['refilling', 'near'].forEach(function (k) { eq('tank.' + k, h.tank[k], g.tank[k]); });
  ['count', 'best'].forEach(function (k) { eq('combo.' + k, h.combo[k], g.combo[k]); });
  ['timer', 'mult', 'window'].forEach(function (k) { eq('combo.' + k, h.combo[k], g.combo[k], 0.001); });
  ['earned', 'tiles', 'bonusTiles'].forEach(function (k) { eq('roundStats.' + k, h.roundStats[k], g.roundStats[k], 0.001); });
  ['x', 'y', 'a', 'v'].forEach(function (k) { eq('truck.' + k, h.truck[k], g.truck[k], 0.001); });
  ['x', 'y', 'a'].forEach(function (k) { eq('trailer.' + k, h.trailer[k], g.trailer[k], 0.001); });
  ['on', 'sputter', 'drip'].forEach(function (k) { eq('spray.' + k, h.spray[k], g.spray[k]); });
  eq('stations', h.stations, g.stations);
  var hf = h.field, gf = g.field;
  if (!gf) { out.push('guest field null'); return out; }
  eq('field.doneCount', hf.doneCount, gf.doneCount);
  ['cols', 'rows', 'tile', 'x', 'y', 'total'].forEach(function (k) { eq('field.' + k, hf[k], gf[k]); });
  var bad = 0;
  for (var i = 0; i < hf.total; i++) {
    if (!near(hf.water[i], gf.water[i], 0.0051) || hf.done[i] !== gf.done[i] || !near(hf.need[i], gf.need[i], 0.0051) ||
        hf.pay[i] !== gf.pay[i] || hf.bonus[i] !== gf.bonus[i] || !near(hf.dry[i], gf.dry[i], 0.00051)) {
      if (bad++ < 3) out.push('tile ' + i + ' host w=' + hf.water[i] + ' d=' + hf.done[i] + ' guest w=' + gf.water[i] + ' d=' + gf.done[i]);
    }
  }
  if (bad > 3) out.push('... ' + bad + ' tiles mismatched');
  return out;
}

var host = Sim.newGame(1234);
var enc = new Codec.Encoder(), dec = new Codec.Decoder();
var clock = 0, frame = 0, sentEv = {}, gotEv = {}, lostEv = {}, pending = [];
var bytes = { snaps: 0, snapBytes: 0, maxMsg: 0, fullCount: 0, fieldMsgs: 0 };
var LAT = 40; // simulated one-way latency (ms, constant)
var mismatches = [];
var dropNext = false, dropped = 0;

function deliver(str) {
  bytes.maxMsg = Math.max(bytes.maxMsg, str.length);
  var m = JSON.parse(str);
  if (m.t === 'snap') { bytes.snaps++; bytes.snapBytes += str.length; if (m.full) bytes.fullCount++; }
  if (m.t === 'field') bytes.fieldMsgs++;
  if (dropNext && m.t === 'snap' && !m.full) { // simulate a lost delta (its events are lost too)
    dropNext = false; dropped++;
    (m.ev || []).forEach(function (e) { lostEv[e.type] = (lostEv[e.type] || 0) + 1; });
    return;
  }
  dec.receive(m, clock + LAT);
  if (dec.wantResync) enc.reset(); // guest would send {t:'resync'}
  dec.takeEvents(clock + LAT + 1000).forEach(function (e) { gotEv[e.type] = (gotEv[e.type] || 0) + 1; });
}
function sendSnap() {
  enc.encode(host, pending, clock).forEach(deliver);
  pending = [];
}
function stepFrames(nFrames, inputsFn) {
  for (var k = 0; k < nFrames; k++) {
    Sim.step(host, inputsFn ? inputsFn(host, frame) : {}, 1 / 60);
    var e = Sim.takeEvents(host);
    e.forEach(function (x) { sentEv[x.type] = (sentEv[x.type] || 0) + 1; pending.push(x); });
    frame++; clock += 1000 / 60;
    if (frame % 3 === 0) {
      sendSnap();
      if (frame % 30 === 0) {
        var d = diff(host, dec.latest());
        if (d.length) mismatches.push('frame ' + frame + ': ' + d.join('; '));
      }
      if (frame === 900) dropNext = true;
    }
  }
}
function action(fn) { fn(); Sim.takeEvents(host).forEach(function (x) { sentEv[x.type] = (sentEv[x.type] || 0) + 1; pending.push(x); }); }

// ---- round 1
action(function () { Sim.startRound(host); });
var guard = 0;
while (host.phase === 'playing' && guard++ < 60 * 200) stepFrames(1, scripted);
stepFrames(3);
assert(host.phase === 'roundEnd', 'host round 1 ended (tiles ' + host.lastRound.tiles + ', $' + host.money + ')');
assert(dropped === 1, 'one delta was dropped mid-round to exercise resync');
assert(mismatches.length === 0, 'guest matched host at every check during round 1' + (mismatches.length ? '\n   ' + mismatches.slice(0, 5).join('\n   ') : ''));
var g = dec.latest();
assert(g.phase === 'roundEnd' && g.lastRound && g.lastRound.total === host.lastRound.total, 'guest sees roundEnd with same lastRound total');

// ---- shop + purchase
action(function () { Sim.openShop(host); });
stepFrames(6);
var cheapest = Sim.upgradeInfo(host).filter(function (u) { return u.afford; })[0];
assert(!!cheapest, 'host can afford an upgrade');
action(function () { Sim.buyUpgrade(host, cheapest.id); });
stepFrames(6); sendSnap();
g = dec.latest();
assert(g.phase === 'shop' && g.upgrades[cheapest.id] === 1 && g.money === host.money, 'guest sees shop, purchase of ' + cheapest.id + ' and new balance');
assert(diff(host, g).length === 0, 'full state match in shop' + (diff(host, g).length ? ': ' + diff(host, g).join('; ') : ''));

// ---- round 2: new field must be re-sent
var fieldsBefore = bytes.fieldMsgs;
action(function () { Sim.startRound(host); });
stepFrames(60 * 8, scripted); sendSnap();
assert(bytes.fieldMsgs === fieldsBefore + 1, 'new field sent exactly once on round start');
assert(diff(host, dec.latest()).length === 0, 'round 2 state matches after 8s' + (diff(host, dec.latest()).length ? ': ' + diff(host, dec.latest()).join('; ') : ''));

// ---- pause
action(function () { Sim.setPaused(host, true); });
stepFrames(6);
assert(dec.latest().paused === true, 'guest sees pause');
action(function () { Sim.setPaused(host, false); });
stepFrames(6, scripted);

// ---- reconnect: brand-new decoder + encoder.reset() resyncs everything
dec = new Codec.Decoder(); enc.reset();
stepFrames(3, scripted); sendSnap();
assert(diff(host, dec.latest()).length === 0, 'fresh guest (rejoin) fully synced after one snapshot');

// ---- events
['pay', 'roundStart', 'roundEnd', 'buy', 'go', 'pause', 'resume'].forEach(function (t) {
  if (t === 'pay') return;
  assert((gotEv[t] || 0) >= 1 && (sentEv[t] || 0) >= 1, 'event ' + t + ' forwarded (' + (gotEv[t] || 0) + '/' + (sentEv[t] || 0) + ')');
});
assert(gotEv.pay + (lostEv.pay || 0) === sentEv.pay, 'all pay events forwarded (' + gotEv.pay + ' + ' + (lostEv.pay || 0) + ' in the dropped delta / ' + sentEv.pay + ')');

// ---- interpolation: guest view between two snapshots
var d2 = new Codec.Decoder(), e2 = new Codec.Encoder();
var s2 = Sim.newGame(5); Sim.startRound(s2); s2.countdown = 0;
for (var i = 0; i < 30; i++) Sim.step(s2, { driver: { throttle: 1, steer: 0.3 } }, 1 / 60);
e2.encode(s2, [], 1000).forEach(function (m) { d2.receive(JSON.parse(m), 1000); });
var x0 = s2.truck.x, a0 = s2.truck.a;
for (i = 0; i < 3; i++) Sim.step(s2, { driver: { throttle: 1, steer: 0.3 } }, 1 / 60);
e2.encode(s2, [], 1050).forEach(function (m) { d2.receive(JSON.parse(m), 1050); });
var x1 = s2.truck.x, a1 = s2.truck.a;
var v = d2.view(1050 + 100 - 25); // render time = 1025 host-ms: halfway
assert(near(v.truck.x, (x0 + x1) / 2, 0.01) && near(v.truck.a, (a0 + a1) / 2, 0.001), 'interpolated truck pose is halfway between snapshots');
var vs = d2.view(1200, { aimX: 900, aimY: 700, spraying: true });
assert(vs.spray.aimX === 900 && vs.spray.hits.length >= 1 && vs.spray.want === true, 'local sprayer aim applied immediately in guest view');
// angle shortest-arc
var d3 = new Codec.Decoder(), e3 = new Codec.Encoder(), s3 = Sim.newGame(9);
s3.truck.a = 3.1; e3.encode(s3, [], 0).forEach(function (m) { d3.receive(JSON.parse(m), 0); });
s3.truck.a = -3.1; e3.encode(s3, [], 100).forEach(function (m) { d3.receive(JSON.parse(m), 100); });
var va = d3.view(150).truck.a;
assert(Math.abs(Math.abs(va) - Math.PI) < 0.01, 'angle interpolation takes the short way across +-PI (' + va.toFixed(3) + ')');

console.log('   snapshots: ' + bytes.snaps + ', avg ' + Math.round(bytes.snapBytes / bytes.snaps) + ' B, full: ' + bytes.fullCount +
  ', field msgs: ' + bytes.fieldMsgs + ', largest message ' + bytes.maxMsg + ' B (~' + Math.round(bytes.snapBytes / bytes.snaps * 20 / 1024) + ' KB/s at 20 Hz)');
console.log(fails ? fails + ' FAILED' : 'ALL PASSED');
