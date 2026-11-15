// Headless home-base sim test: node farm/tools/basetest.js
var fs = require('fs'), vm = require('vm'), path = require('path'), cp = require('child_process');
var simPath = path.join(__dirname, '..', 'js', 'base-sim.js');
cp.execFileSync(process.execPath, ['--check', simPath]);
var ctx = { window: {}, Math: Math, JSON: JSON, console: console };
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(simPath, 'utf8'), ctx);
var S = ctx.window.SOD.BaseSim, C = S.C, T = C.TILE, DT = C.DT;
var fails = 0;
function assert(c, m) { if (!c) { console.error('FAIL: ' + m); fails++; } else console.log('ok  - ' + m); }
function bad(o, p) {
  if (typeof o === 'number') return isFinite(o) ? null : p;
  if (typeof o === 'function' || o === undefined) return p + ' (' + typeof o + ')';
  if (o && typeof o === 'object') for (var k in o) { var r = bad(o[k], p + '.' + k); if (r) return r; }
  return null;
}
function I(s, c, r) { return r * s.cols + c; }
function run(s, secs, inp) { for (var k = Math.round(secs / DT); k > 0; k--) S.step(s, inp || {}, DT); }
function clone(o) { return JSON.parse(JSON.stringify(o)); }

// ---------------------------------------------------------------- start state
var s0 = S.newGame(7);
var info0 = S.networkInfo(s0);
assert(s0.money === 150 && info0.length === 1 && info0[0].pumps === 1 && info0[0].tanks === 1 && info0[0].fills === 1,
  'start: $150, one network with pump+tank+fill');
assert(s0.tank.water === s0.tank.cap && s0.tank.cap > 0, 'start: trailer full');
var tilled = s0.ground.filter(function (g) { return g === 1; }).length;
assert(tilled >= 4 && tilled <= 6, 'start: ' + tilled + ' tilled cells');
assert(!bad(s0, 'state'), 'start state has no NaN/functions');

// ---------------------------------------------------------------- growth & death
(function () {
  var s = S.newGame(1);
  S.seed(s, 16, 14, 0); S.seed(s, 18, 14, 0);
  var a = I(s, 16, 14), b = I(s, 18, 14), readyAt = -1;
  for (var k = 0; k < 120 * 60; k++) {
    s.moist[a] = 0.8;
    S.step(s, {}, DT);
    if (readyAt < 0 && s.growth[a] >= 1) readyAt = s.time;
  }
  assert(readyAt > 60 && readyAt < 90, 'kept-moist fescue ready at ' + readyAt.toFixed(1) + 's (60-90)');
  assert(s.ground[b] === 1 && s.stats.died >= 1, 'unwatered plot died back to dirt');
  var ev = S.takeEvents(s).map(function (e) { return e.type; });
  assert(ev.indexOf('plotReady') >= 0 && ev.indexOf('plotDied') >= 0 && ev.indexOf('seeded') >= 0, 'plotReady/plotDied/seeded events');
  assert(S.harvest(s, 16, 14) && s.inv[0] === 1 && s.ground[a] === 1, 'harvest gives a roll, leaves dirt');
  assert(!S.harvest(s, 16, 14), 'cannot harvest dirt');
})();

// ---------------------------------------------------------------- hose
(function () {
  var s = S.newGame(1);
  var a = I(s, 17, 15), nz = S.getNozzle(s);
  var tx = 17.5 * T, ty = 15.5 * T;
  assert(Math.hypot(tx - nz.x, ty - nz.y) < nz.range, 'start plots are within hose reach of the parked trailer');
  var m0 = s.moist[a], w0 = s.tank.water;
  run(s, 1, { sprayer: { aimX: tx, aimY: ty, spraying: true } });
  assert(s.moist[a] > m0 + 0.4 && s.spray.on, 'hose spray raises moisture (' + s.moist[a].toFixed(2) + ')');
  assert(s.stats.hosed > 20 && s.stats.refilled > 0, 'hose uses trailer water (' + s.stats.hosed.toFixed(0) + ' L), fill station tops it up');
  s.truck.x = 2 * T; s.truck.y = 2 * T; s.trailer.x = s.truck.x; s.trailer.y = s.truck.y - 96; s.tank.water = 0.5;
  S.takeEvents(s);
  run(s, 1, { sprayer: { aimX: 3 * T, aimY: 3 * T, spraying: true } });
  assert(S.takeEvents(s).some(function (e) { return e.type === 'sputter'; }), 'empty tank sputters');
})();

// ---------------------------------------------------------------- networks
(function () {
  var s = S.newGame(3);
  s.money = 10000;
  s.truck.x = 2 * T; s.truck.y = 25 * T; s.trailer.x = s.truck.x; s.trailer.y = s.truck.y - 96; // away from fill
  // connected sprinkler at (17,15) via pipes (17,13),(17,14); fill (17,12) conducts from pipe (16,12)
  assert(S.build(s, 'pipe', 17, 13) && S.build(s, 'pipe', 17, 14) && S.build(s, 'sprinkler', 17, 15), 'built pipes + sprinkler');
  assert(S.networkInfo(s).length === 1 && S.networkInfo(s)[0].sprinklers === 1, 'sprinkler joined the starter network');
  // unconnected sprinkler at (13,17) with plots around
  assert(S.build(s, 'sprinkler', 13, 17), 'built lone sprinkler');
  assert(s.net.cell[I(s, 13, 17)] === -1, 'lone sprinkler is not on a network');
  var own = [[16, 14], [17, 14], [18, 14], [16, 15], [18, 15]], lone = [[12, 16], [13, 16], [14, 16]];
  S.till(s, 12, 16); S.till(s, 13, 16); S.till(s, 14, 16);
  own.concat(lone).forEach(function (p) { assert(S.seed(s, p[0], p[1], 0), 'seed ' + p); });
  run(s, 100);
  var ok = own.every(function (p) { var i = I(s, p[0], p[1]); return s.ground[i] === 2 && s.growth[i] >= 1; });
  assert(ok, 'connected sprinkler grew its plots to ready without the truck');
  var dead = lone.every(function (p) { return s.ground[I(s, p[0], p[1])] === 1; });
  assert(dead, 'unconnected sprinkler did nothing (its plots died)');
  // pool-empty sharing: drain tank, add 2 more sprinklers with fresh plots -> demand > inflow
  S.build(s, 'pipe', 17, 16); S.build(s, 'pipe', 17, 17); S.build(s, 'sprinkler', 17, 18);
  for (var c = 16; c <= 18; c++) for (var r = 17; r <= 19; r++) if (!(c === 17 && r === 18)) { S.till(s, c, r); S.seed(s, c, r, 0); }
  own.forEach(function (p) { s.moist[I(s, p[0], p[1])] = 0; });
  s.tankW[I(s, 15, 12)] = 0;
  S.step(s, {}, DT);
  var n = S.networkInfo(s)[0];
  assert(n.stored === 0 && Math.abs(n.supplied - n.inflow) < 1e-6 && n.demand > n.inflow,
    'pool empty: consumers share pump inflow (supplied ' + n.supplied.toFixed(2) + ' = inflow ' + n.inflow + ' < demand ' + n.demand + ')');
  var on = s.net.list[0].sprOn;
  assert(on.length === 2 && Math.abs(on[0] - on[1]) < 1e-9 && on[0] > 0 && on[0] < 1, 'sprinklers get equal fraction ' + on[0].toFixed(3));
  // fill station refills trailer from network and drains pool
  var s2 = S.newGame(4);
  s2.tank.water = 0;
  var p0 = S.networkInfo(s2)[0].stored;
  S.takeEvents(s2);
  run(s2, 2);
  var p1 = S.networkInfo(s2)[0].stored;
  var ev = S.takeEvents(s2).map(function (e) { return e.type; });
  assert(s2.tank.water > 100 && p1 < p0 - 100, 'fill station refills trailer (' + s2.tank.water.toFixed(0) + ' L) and drains pool (' + p0 + ' -> ' + p1.toFixed(0) + ')');
  assert(ev.indexOf('refillStart') >= 0, 'refillStart event');
  run(s2, 4);
  assert(s2.tank.water === s2.tank.cap, 'trailer refilled to full');
  // pool empty -> refill trickles at pump rate
  var s3 = S.newGame(4); s3.tank.water = 0; s3.tankW[I(s3, 15, 12)] = 0; S.takeEvents(s3);
  run(s3, 1);
  assert(Math.abs(s3.tank.water - 4) < 0.2, 'empty pool: fill gets pump inflow only (' + s3.tank.water.toFixed(2) + ' L in 1 s)');
  assert(S.takeEvents(s3).some(function (e) { return e.type === 'tankEmpty'; }), 'tankEmpty event');
})();

// ---------------------------------------------------------------- action validation & canDo agreement
(function () {
  var s = S.newGame(5);
  var kinds = ['pipe', 'pump', 'tank', 'sprinkler', 'fill', 'rack'];
  var agree = true, n = 0;
  function check(action, c, r, arg, fn) {
    var q = S.canDo(s, action, c, r, arg), m = s.money, got = fn();
    if (q.ok !== got) { agree = false; console.error('  disagree', action, c, r, q, got); }
    if (got && action !== 'demolish' && action !== 'harvest' && s.money !== m - q.cost) { agree = false; console.error('  cost mismatch', action); }
    n++;
  }
  // a pseudo-random sweep of actions over the map with varying money
  var rng = 12345;
  function rnd(k) { rng = (rng * 1103515245 + 12345) & 0x7fffffff; return rng % k; }
  for (var t = 0; t < 3000; t++) {
    var c = 8 + rnd(16), r = 8 + rnd(16), a = rnd(6);
    if (t % 500 === 0) s.money = [0, 30, 300, 3000][rnd(4)];
    if (a === 0) check('till', c, r, undefined, function () { return S.till(s, c, r); });
    else if (a === 1) { var ty = rnd(3); check('seed', c, r, ty, function () { return S.seed(s, c, r, ty); }); }
    else if (a === 2) { var k = kinds[rnd(6)]; check(k, c, r, undefined, function () { return S.build(s, k, c, r); }); }
    else if (a === 3) { var L = [undefined, 'struct', 'pipe', 'ground'][rnd(4)]; check('demolish', c, r, L, function () { return S.demolish(s, c, r, L); }); }
    else if (a === 4) check('harvest', c, r, undefined, function () { return S.harvest(s, c, r); });
    else S.step(s, {}, DT);
  }
  assert(agree, 'canDo agrees with ' + n + ' random actions (result and cost)');
  assert(!bad(s, 'state'), 'no NaN after random action sweep');
  // specific validations
  var f = S.newGame(6);
  assert(S.canDo(f, 'pump', 2, 2).reason === 'unowned' && !S.build(f, 'pump', 2, 2), 'cannot build on unowned land');
  assert(S.canDo(f, 'pump', 15, 12).reason === 'occupied', 'cannot build on a structure');
  assert(S.canDo(f, 'pipe', 14, 12).reason === 'occupied', 'cannot double pipe');
  assert(S.canDo(f, 'pipe', 15, 12).ok, 'pipe can go under a structure');
  S.seed(f, 16, 14, 0);
  assert(S.canDo(f, 'tank', 16, 14).reason === 'plot', 'no structure on a plot');
  assert(S.canDo(f, 'pipe', 16, 14).ok, 'pipe can go under a plot');
  assert(S.canDo(f, 'tank', 20, 16).reason === 'unowned', 'truck cell unowned');
  f.money = 50;
  assert(S.canDo(f, 'sprinkler', 13, 17).reason === 'money' && !S.build(f, 'sprinkler', 13, 17), 'money is validated');
  f.money = 10000;
  var c1 = S.costOf(f, 'sprinkler'); S.build(f, 'sprinkler', 13, 17);
  var c2 = S.costOf(f, 'sprinkler');
  assert(c2 > c1, 'sprinkler cost rises ' + c1 + ' -> ' + c2);
  var m = f.money;
  assert(S.demolish(f, 13, 17) && f.money === m + Math.floor(c1 * C.REFUND) && S.costOf(f, 'sprinkler') === c1, 'demolish refunds 50% and lowers price');
  assert(!S.demolish(f, 13, 17), 'demolish empty cell fails');
  // land
  var parcels = S.landParcels(f);
  var buyable = parcels.filter(function (p) { return p.buyable; });
  var far = parcels.filter(function (p) { return !p.owned && !p.buyable; })[0];
  assert(buyable.length === 8, '8 parcels buyable around the start block');
  assert(!S.buyLand(f, far.id), 'non-adjacent parcel refused');
  var lc = buyable[0].cost; m = f.money;
  assert(S.buyLand(f, buyable[0].id) && f.money === m - lc && f.owned[I(f, buyable[0].c0, buyable[0].r0)] === 1, 'bought parcel $' + lc);
  assert(!S.buyLand(f, buyable[0].id), 'cannot rebuy owned parcel');
  assert(S.costOf(f, 'land') > lc, 'land cost rises');
  f.money = 1; assert(!S.buyLand(f, buyable[1].id), 'land needs money');
  // sell & inventory cap
  var g = S.newGame(8);
  g.inv[0] = 0;
  var cap = S.getStats(g).invCap;
  for (var i = 0; i < cap + 3; i++) {
    var ci = I(g, 16, 14); g.ground[ci] = 2; g.sodType[ci] = 0; g.growth[ci] = 1;
    S.harvest(g, 16, 14);
  }
  assert(g.inv[0] === cap && S.canDo(g, 'harvest', 16, 14).reason === 'full', 'inventory capped at ' + cap);
  g.money = 1000; S.build(g, 'rack', 13, 15);
  assert(S.getStats(g).invCap === cap + S.BUILDINGS.rack.inv && S.harvest(g, 16, 14), 'rack raises capacity');
  m = g.money;
  assert(S.sellSod(g, 5) && g.money === m + 5 * S.SOD_TYPES[0].price && g.inv[0] === cap + 1 - 5, 'sell 5 rolls');
  assert(S.sellSod(g, Infinity) && g.inv[0] === 0 && !S.sellSod(g, 1) && !S.sellSod(g, 0), 'sell all; empty / zero fails');
  // equip
  g.money = 50; assert(!S.buyEquip(g, 'tank'), 'equip needs money');
  g.money = 1000; var cap0 = g.tank.cap;
  assert(S.buyEquip(g, 'tank') && g.tank.cap > cap0 && g.equip.tank === 1, 'bought trailer tank upgrade');
  assert(!S.buyEquip(g, 'nope') && !S.buyEquip(g, 'toString'), 'unknown equip refused');
  assert(S.setPaused(g, true) && (function () { var t = g.time; S.step(g, {}, DT); return g.time === t; })(), 'paused does not advance');
  S.setPaused(g, false);
})();

// ---------------------------------------------------------------- fast forward vs stepping
function farmSetup(seed) {
  var s = S.newGame(seed);
  s.money = 10000;
  S.build(s, 'pipe', 17, 13); S.build(s, 'pipe', 17, 14); S.build(s, 'sprinkler', 17, 15);
  S.build(s, 'pipe', 17, 16); S.build(s, 'pipe', 17, 17); S.build(s, 'sprinkler', 17, 18); S.build(s, 'pump', 16, 13);
  for (var c = 16; c <= 18; c++) for (var r = 14; r <= 19; r++) { S.till(s, c, r); S.seed(s, c, r, (c + r) % 2); }
  S.till(s, 13, 18); S.seed(s, 13, 18, 0); // unwatered -> dies
  return s;
}
(function () {
  var a = farmSetup(9), b = clone(a);
  run(a, 600);
  S.fastForward(b, 600);
  var dm = 0, dg = 0, same = true;
  for (var i = 0; i < a.moist.length; i++) {
    dm = Math.max(dm, Math.abs(a.moist[i] - b.moist[i]));
    dg = Math.max(dg, Math.abs(a.growth[i] - b.growth[i]));
    if (a.ground[i] !== b.ground[i]) same = false;
  }
  var pa = S.networkInfo(a)[0].stored, pb = S.networkInfo(b)[0].stored;
  console.log('   ff600 vs step600: max dMoist ' + dm.toFixed(3) + ' max dGrowth ' + dg.toFixed(3) + ' pool ' + pa.toFixed(0) + ' vs ' + pb.toFixed(0));
  assert(same && dm < 0.1 && dg < 0.05 && Math.abs(pa - pb) < 30 && Math.abs(a.time - b.time) < 1e-6 && a.stats.died === b.stats.died,
    'fastForward(600) roughly matches 600 s of stepping');
})();

// ---------------------------------------------------------------- determinism, JSON round trip, save/load
(function () {
  var s = farmSetup(10), okNaN = true, okDet = true;
  function inp(f) { return { driver: { throttle: 0.6, steer: Math.sin(f / 90), brake: f % 700 > 650 },
    sprayer: { aimX: 17 * T + Math.sin(f / 30) * 80, aimY: 16 * T + Math.cos(f / 40) * 80, spraying: f % 300 < 200 } }; }
  try {
    for (var f = 0; f < 60 * 900; f++) {
      S.step(s, inp(f), DT);
      if (f % 97 === 0) S.takeEvents(s);
      if (f % 3600 === 0) {
        var b = bad(s, 'state'); if (b) { console.error('  bad at ' + b); okNaN = false; break; }
        var x = clone(s), y = clone(s);
        for (var k = 0; k < 240; k++) { S.step(x, inp(f + k), DT); S.step(y, inp(f + k), DT); }
        if (JSON.stringify(x) !== JSON.stringify(y)) okDet = false;
        var z = clone(s);
        for (k = 0; k < 240; k++) S.step(z, inp(f + k), DT);
        if (JSON.stringify(x) !== JSON.stringify(z)) okDet = false;
      }
    }
  } catch (e) { console.error(e); okNaN = false; }
  assert(okNaN, '15 min scripted driving/spraying run: no exceptions, no NaN/Infinity');
  assert(okDet, 'JSON round-tripped state keeps stepping identically');
  var sv = JSON.parse(JSON.stringify(S.toSave(s)));
  var l = S.fromSave(sv);
  var a1 = clone(s); a1.events = []; a1.net = 0; var b1 = clone(l); b1.events = []; b1.net = 0;
  assert(JSON.stringify(a1) === JSON.stringify(b1), 'toSave/fromSave round-trips exactly (net cache rebuilt)');
  run(s, 5); run(l, 5); s.events = []; l.events = [];
  assert(JSON.stringify(s) === JSON.stringify(l), 'loaded save steps identically');
  var junk = S.fromSave({ v: 1, money: 'x', moist: [1, 2], owned: null, inv: [NaN, 3], equip: { tank: 99 } });
  assert(!bad(junk, 'junk') && junk.money === 150 && junk.equip.tank === S.EQUIP[1].max, 'fromSave sanitizes junk');
  assert(S.fromSave(null).v === 1 && S.fromSave({ v: 2 }).money === 150, 'fromSave: invalid save -> new game');
})();

// ---------------------------------------------------------------- bot: 10 minutes
(function () {
  var s = S.newGame(11);
  var log = [], firstSpr = -1, projIdx = 0, lastEarn = 0;
  var projects = [
    { name: 'sprinkler A', build: [['pipe', 17, 13], ['pipe', 17, 14], ['sprinkler', 17, 15]], till: [[16, 16], [17, 16], [18, 16]] },
    { name: 'hand plots', build: [], till: [[19, 13], [19, 14], [19, 15], [19, 16], [19, 17]] },
    { name: 'pump', build: [['pump', 16, 13]], till: [] },
    { name: 'sprinkler B', build: [['pipe', 17, 16], ['pipe', 17, 17], ['sprinkler', 17, 18]],
      till: [[16, 17], [18, 17], [16, 18], [18, 18], [16, 19], [17, 19], [18, 19]] },
  ];
  function projCost(p) {
    var t = 0, cnt = {};
    p.build.forEach(function (b) { cnt[b[0]] = (cnt[b[0]] || 0); t += Math.round(S.BUILDINGS[b[0]].base * Math.pow(S.BUILDINGS[b[0]].growth, s.built[b[0]] + cnt[b[0]])); cnt[b[0]]++; });
    return t + p.till.length * (C.TILL_COST + S.SOD_TYPES[0].seedCost);
  }
  var nz0 = S.getNozzle(s);
  for (var f = 0; f < 600 * 60; f++) {
    // mouse player: farm actions twice a second
    if (f % 30 === 0) {
      for (var i = 0; i < s.ground.length; i++) {
        var c = i % s.cols, r = (i - c) / s.cols;
        if (s.ground[i] === 2 && s.growth[i] >= 1) S.harvest(s, c, r);
        if (s.ground[i] === 1 && s.owned[i]) S.seed(s, c, r, 0);
      }
      if (S.getStats(s).invTotal > 0) S.sellSod(s, Infinity);
      var p = projects[projIdx];
      if (p && s.time < 420 && s.money >= projCost(p) + 5) {
        p.build.forEach(function (b) { if (!S.build(s, b[0], b[1], b[2])) console.error('  bot build failed', b, S.canDo(s, b[0], b[1], b[2])); });
        p.till.forEach(function (t) { S.till(s, t[0], t[1]); S.seed(s, t[0], t[1], 0); });
        if (p.name === 'sprinkler A') firstSpr = s.time;
        log.push('  t=' + s.time.toFixed(0) + 's built ' + p.name);
        projIdx++;
      }
    }
    // hose: aim at the driest reachable plot under 0.45 moisture
    var nz = S.getNozzle(s), best = -1, bm = 0.45;
    for (i = 0; i < s.ground.length; i++) {
      if (s.ground[i] !== 2 || s.moist[i] >= bm) continue;
      c = i % s.cols; r = (i - c) / s.cols;
      if (Math.hypot((c + .5) * T - nz.x, (r + .5) * T - nz.y) > nz.range - 10) continue;
      bm = s.moist[i]; best = i;
    }
    var sp = { aimX: nz.x, aimY: nz.y, spraying: false };
    if (best >= 0) { c = best % s.cols; r = (best - c) / s.cols; sp = { aimX: (c + .5) * T, aimY: (r + .5) * T, spraying: true }; }
    S.step(s, { driver: { throttle: 0, steer: 0, brake: true }, sprayer: sp }, DT);
    S.takeEvents(s);
    if (f % 3600 === 0) { log.push('  t=' + (f / 60) + 's money $' + s.money + ' plots ' + S.getStats(s).plots + ' sold ' + s.stats.sold + ' earned last min $' + (s.stats.earned - lastEarn)); lastEarn = s.stats.earned; }
  }
  var st = S.getStats(s), n = S.networkInfo(s)[0];
  log.push('  t=600s money $' + s.money + ' plots ' + st.plots + ' sold ' + s.stats.sold + ' earned $' + s.stats.earned + ' spent $' + s.stats.spent + ' died ' + s.stats.died);
  console.log('   BOT BALANCE (park-and-hose bot, sells everything, stops buying at 420 s):\n' + log.join('\n'));
  console.log('   first sprinkler at ' + (firstSpr < 0 ? 'never' : firstSpr.toFixed(0) + 's') + '; network ' + JSON.stringify(n));
  var sprOk = s.net.list[0].sprOn.length >= 1;
  assert(firstSpr > 0 && sprOk, 'bot bought a working sprinkler setup');
  assert(s.money > 150, 'bot ends with more money than it started ($' + s.money + ')');
  assert(s.stats.died === 0, 'bot lost no plots');
})();

console.log(fails ? fails + ' FAILED' : 'ALL PASSED');
process.exit(fails ? 1 : 0);
