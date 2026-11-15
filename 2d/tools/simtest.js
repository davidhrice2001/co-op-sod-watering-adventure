// Headless sim test: node tools/simtest.js
var fs = require('fs'), vm = require('vm'), path = require('path');
var src = fs.readFileSync(path.join(__dirname, '..', 'js', 'sim.js'), 'utf8');
var ctx = { window: {}, Math: Math, JSON: JSON, console: console };
vm.createContext(ctx);
vm.runInContext(src, ctx);
var Sim = ctx.window.SOD.Sim;
function assert(c, m) { if (!c) { console.error('FAIL: ' + m); process.exit(1); } console.log('ok  - ' + m); }
function hasBad(o, p) {
  if (typeof o === 'number') return (!isFinite(o)) ? p : null;
  if (typeof o === 'function') return p + ' (function)';
  if (o && typeof o === 'object') {
    for (var k in o) { var r = hasBad(o[k], p + '.' + k); if (r) return r; }
  }
  return null;
}

var s = Sim.newGame(42);
assert(s.phase === 'menu', 'newGame in menu phase');
assert(Sim.startRound(s), 'startRound');
assert(s.phase === 'playing', 'playing');

// scripted inputs: drive in a loop over the field, spray at nearest unfinished tile, refill when empty
function scripted(st, f) {
  var C = Sim.C, t = st.truck;
  var drv = { throttle: 0.7, steer: Math.sin(f / 150) * 0.6, brake: false };
  // go to hydrant when tank empty
  if (st.tank.water < 1 || st.tank.refilling) {
    var h = st.stations[0];
    var dx = h.x - st.trailer.x, dy = h.y - st.trailer.y;
    var want = Math.atan2(dy, dx), diff = Math.atan2(Math.sin(want - t.a), Math.cos(want - t.a));
    drv.steer = Math.max(-1, Math.min(1, diff * 2));
    var d = Math.sqrt(dx * dx + dy * dy);
    drv.throttle = d < 80 ? 0 : 0.8;
    drv.brake = d < 80;
  } else if (t.y < C.FIELD_Y + 60) { drv.steer = 0.5; }
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

var money0 = s.money, frames = 0, events = { pay: 0, roundEnd: 0, sputter: 0, refillStart: 0 };
var ok = true;
try {
  while (s.phase === 'playing' && frames < 60 * 200) {
    var inp = scripted(s, frames);
    Sim.step(s, inp, 1 / 60);
    s.events.forEach(function (e) { events[e.type] = (events[e.type] || 0) + 1; });
    frames++;
    if (frames % 600 === 0) {
      var bad = hasBad(s, 'state'); if (bad) { console.error('bad value at ' + bad); ok = false; break; }
      // determinism check across JSON roundtrip
      var clone = JSON.parse(JSON.stringify(s));
      var a = JSON.parse(JSON.stringify(s));
      for (var k = 0; k < 120; k++) { var ii = scripted(a, frames + k); Sim.step(a, ii, 1 / 60); Sim.step(clone, ii, 1 / 60); }
      if (JSON.stringify(a) !== JSON.stringify(clone)) { console.error('determinism mismatch at frame ' + frames); ok = false; break; }
    }
  }
} catch (e) { console.error(e); ok = false; }
assert(ok, 'stepped ' + frames + ' frames without exceptions/NaN, JSON-roundtrip deterministic');
console.log('   events', JSON.stringify(events), 'tiles', s.roundStats.tiles, 'money', s.money, 'fieldPct', s.field.doneCount / s.field.total);
assert(s.money > money0, 'money increased (' + s.money + ')');
assert(s.phase === 'roundEnd', 'round ended');
assert(Sim.openShop(s) && s.phase === 'shop', 'shop opened');
var info = Sim.upgradeInfo(s);
console.log('   shop:', info.map(function (u) { return u.id + ' $' + u.cost + (u.afford ? '*' : ''); }).join(', '));
var cheapest = info.filter(function (u) { return u.afford; })[0];
assert(!!cheapest, 'can afford at least one upgrade');
var m = s.money;
assert(Sim.buyUpgrade(s, cheapest.id) && s.upgrades[cheapest.id] === 1 && s.money === m - cheapest.cost, 'bought ' + cheapest.id);
assert(!Sim.buyUpgrade(s, 'nope'), 'unknown upgrade rejected');
var save = JSON.parse(JSON.stringify(Sim.toSave(s)));
var s2 = Sim.fromSave(save, 7);
assert(s2.phase === 'shop' && s2.money === s.money && s2.upgrades[cheapest.id] === 1, 'save/load roundtrip');
assert(Sim.startRound(s) && s.round === 2, 'round 2 starts');
var need1 = 0; s.field.need.forEach(function (n) { need1 += n; });
// play rounds 2..6 with max-ish upgrades purchased greedily
for (var rr = 0; rr < 5; rr++) {
  var fr = 0;
  while (s.phase === 'playing' && fr < 60 * 300) { Sim.step(s, scripted(s, fr), 1 / 60); fr++; }
  Sim.openShop(s);
  var bought = true;
  while (bought) { bought = false; Sim.upgradeInfo(s).forEach(function (u) { if (u.afford && Sim.buyUpgrade(s, u.id)) bought = true; }); }
  console.log('   round', s.round, 'earned', s.lastRound.total, 'tiles', s.lastRound.tiles, 'pct', s.lastRound.fieldPct.toFixed(2), 'money left', s.money);
  Sim.startRound(s);
}
assert(!hasBad(s, 'state'), 'no NaN after multiple rounds');
Sim.setPaused(s, true);
var t0 = s.timer; Sim.step(s, {}, 1 / 60);
assert(s.timer === t0, 'paused does not advance');
console.log('ALL PASSED');
