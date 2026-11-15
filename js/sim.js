/* Co-Op Sod Watering Adventure - pure simulation.
 * No DOM / canvas / audio access in here. All state is ONE plain JSON-serializable object.
 * Attaches to window.SOD.Sim
 */
(function () {
  'use strict';
  var SOD = (window.SOD = window.SOD || {});

  // ---------------------------------------------------------------- constants
  var C = {
    TILE: 40,
    COLS: 40,
    ROWS: 28,
    BORDER: 5,
    DT: 1 / 60,
    TRUCK_LEN: 74,
    TRUCK_W: 38,
    HITCH: 40,          // truck center -> hitch ball
    TRAILER_LEN: 56,    // hitch ball -> trailer axle
    NOZZLE_OFF: -6,     // nozzle along trailer axis from axle
    JACKKNIFE: 1.35,    // max hitch angle (rad)
    BASE_NEED: 12,
    BASE_PAY: 5,
    NEED_GROWTH: 1.22,
    PAY_GROWTH: 1.34,
    REFILL_RADIUS: 115,
    REFILL_MAX_SPEED: 90,
    COUNTDOWN: 3,
    COMBO_MAX: 40,
    COMBO_STEP: 0.05,
    DRIP_RADIUS: 24
  };
  C.WORLD_W = (C.COLS + C.BORDER * 2) * C.TILE;
  C.WORLD_H = (C.ROWS + C.BORDER * 2) * C.TILE;
  C.FIELD_X = C.BORDER * C.TILE;
  C.FIELD_Y = C.BORDER * C.TILE;
  C.FIELD_W = C.COLS * C.TILE;
  C.FIELD_H = C.ROWS * C.TILE;

  // ---------------------------------------------------------------- upgrades
  function statsFor(u) {
    function l(id) { return u[id] || 0; }
    return {
      speed: 240 + 30 * l('engine'),
      accel: 300 + 50 * l('engine'),
      steer: 2.1 + 0.22 * l('handling'),
      tankCap: 200 + 75 * l('tank'),
      flow: 22 + 7 * l('pump'),
      range: 190 + 30 * l('range'),
      radius: 30 + 8 * l('nozzle'),
      refill: 60 + 35 * l('refill'),
      moneyMult: 1 + 0.2 * l('contract'),
      roundTime: 60 + 7 * l('overtime'),
      drip: 5 * l('drip'),
      comboWindow: 1.6 + 0.35 * l('combo'),
      nozzles: 1 + l('twin'),
      bonusChance: 0.012 + 0.008 * l('premium'),
      bonusMult: 5 + l('premium'),
      tipRate: 0.04 * l('tipjar')
    };
  }

  var UPGRADES = [
    { id: 'engine', name: 'Big Block Engine', desc: 'Top speed & acceleration', base: 55, growth: 1.55, max: 12,
      show: function (s) { return Math.round(s.speed / 6) + ' km/h'; } },
    { id: 'handling', name: 'Power Steering', desc: 'Sharper turning', base: 45, growth: 1.5, max: 10,
      show: function (s) { return Math.round(s.steer / 2.1 * 100) + '%'; } },
    { id: 'tank', name: 'Bigger Tank', desc: 'Water tank capacity', base: 60, growth: 1.55, max: 15,
      show: function (s) { return s.tankCap + ' L'; } },
    { id: 'pump', name: 'Pump Output', desc: 'Water flow rate', base: 75, growth: 1.6, max: 15,
      show: function (s) { return s.flow + ' L/s'; } },
    { id: 'range', name: 'Hose Range', desc: 'How far the stream reaches', base: 55, growth: 1.55, max: 10,
      show: function (s) { return (s.range / C.TILE).toFixed(1) + ' tiles'; } },
    { id: 'nozzle', name: 'Nozzle Width', desc: 'Splash radius', base: 85, growth: 1.65, max: 10,
      show: function (s) { return (s.radius * 2 / C.TILE).toFixed(1) + ' tiles'; } },
    { id: 'refill', name: 'Refill Speed', desc: 'Faster refills at stations', base: 35, growth: 1.5, max: 10,
      show: function (s) { return s.refill + ' L/s'; } },
    { id: 'contract', name: 'Sod Contract', desc: 'Money multiplier on every tile', base: 140, growth: 1.75, max: 15,
      show: function (s) { return 'x' + s.moneyMult.toFixed(2); } },
    { id: 'overtime', name: 'Overtime', desc: 'Longer rounds', base: 110, growth: 1.7, max: 10,
      show: function (s) { return s.roundTime + 's'; } },
    { id: 'drip', name: 'Drip Line', desc: 'Trailer waters tiles it rolls over', base: 180, growth: 1.6, max: 10,
      show: function (s) { return s.drip ? s.drip + ' L/s' : 'none'; } },
    { id: 'combo', name: 'Combo Timer', desc: 'More time to chain tiles', base: 65, growth: 1.55, max: 10,
      show: function (s) { return s.comboWindow.toFixed(2) + 's'; } },
    { id: 'twin', name: 'Twin Nozzle', desc: 'Extra side-by-side streams', base: 900, growth: 3.5, max: 2,
      show: function (s) { return s.nozzles + (s.nozzles === 1 ? ' stream' : ' streams'); } },
    { id: 'premium', name: 'Premium Sod', desc: 'More & richer golden tiles', base: 95, growth: 1.6, max: 8,
      show: function (s) { return (s.bonusChance * 100).toFixed(1) + '% / x' + s.bonusMult; } },
    { id: 'tipjar', name: 'Tip Jar', desc: 'Tips on round earnings', base: 120, growth: 1.65, max: 10,
      show: function (s) { return Math.round(s.tipRate * 100) + '%'; } }
  ];
  var UPG_BY_ID = {};
  UPGRADES.forEach(function (u) { UPG_BY_ID[u.id] = u; });

  function costOf(id, level) {
    var u = UPG_BY_ID[id];
    if (!u) return Infinity;
    return Math.round(u.base * Math.pow(u.growth, level));
  }

  function getStats(state) { return statsFor(state.upgrades); }

  // ---------------------------------------------------------------- helpers
  function rand(state) {
    var t = (state.rng = (state.rng + 0x6D2B79F5) >>> 0);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  function wrap(a) {
    while (a > Math.PI) a -= Math.PI * 2;
    while (a < -Math.PI) a += Math.PI * 2;
    return a;
  }
  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
  function num(v, d) { return (typeof v === 'number' && isFinite(v)) ? v : d; }
  function needScale(r) { return Math.pow(C.NEED_GROWTH, Math.max(0, r - 1)); }
  function payScale(r) { return Math.pow(C.PAY_GROWTH, Math.max(0, r - 1)); }

  function blankRoundStats() {
    return { earned: 0, tiles: 0, bonusTiles: 0, bestCombo: 0, waterUsed: 0, refilled: 0,
      tip: 0, clearBonus: 0, cleared: false, timeLeft: 0, total: 0, fieldPct: 0 };
  }

  // ---------------------------------------------------------------- field gen
  function genField(state) {
    var r = Math.max(1, state.round);
    var st = getStats(state);
    var ns = needScale(r), ps = payScale(r);
    var cols = C.COLS, rows = C.ROWS;

    function lattice(cell) {
      var lw = Math.ceil(cols / cell) + 2, lh = Math.ceil(rows / cell) + 2, arr = [];
      for (var i = 0; i < lw * lh; i++) arr.push(rand(state));
      return { cell: cell, lw: lw, v: arr, ox: rand(state) * cell, oy: rand(state) * cell };
    }
    function sm(t) { return t * t * (3 - 2 * t); }
    function sample(L, c, rr) {
      var fx = (c + L.ox) / L.cell, fy = (rr + L.oy) / L.cell;
      var ix = Math.floor(fx), iy = Math.floor(fy);
      var tx = sm(fx - ix), ty = sm(fy - iy);
      var a = L.v[iy * L.lw + ix], b = L.v[iy * L.lw + ix + 1];
      var c2 = L.v[(iy + 1) * L.lw + ix], d = L.v[(iy + 1) * L.lw + ix + 1];
      return (a + (b - a) * tx) + ((c2 + (d - c2) * tx) - (a + (b - a) * tx)) * ty;
    }
    var big = lattice(Math.max(4, 8 - Math.floor(r / 2)));
    var small = lattice(Math.max(2, 3.5 - r * 0.1));
    var contrast = 1.6 + Math.min(1.2, r * 0.08);

    var need = [], water = [], pay = [], dry = [], bonus = [], done = [];
    for (var y = 0; y < rows; y++) {
      for (var x = 0; x < cols; x++) {
        var n = 0.72 * sample(big, x, y) + 0.28 * sample(small, x, y);
        n = clamp((n - 0.5) * contrast + 0.5, 0, 1);
        var d0 = 0.25 + 1.75 * Math.pow(n, 1.5);
        need.push(C.BASE_NEED * ns * d0);
        water.push(0);
        pay.push(Math.max(1, Math.round(C.BASE_PAY * ps * d0)));
        dry.push(n);
        bonus.push(rand(state) < st.bonusChance ? 1 : 0);
        done.push(0);
      }
    }
    state.field = {
      cols: cols, rows: rows, tile: C.TILE, x: C.FIELD_X, y: C.FIELD_Y,
      need: need, water: water, pay: pay, dry: dry, bonus: bonus, done: done,
      doneCount: 0, total: cols * rows
    };
  }

  function makeStations() {
    return [
      { type: 'hydrant', x: C.FIELD_X - 2.5 * C.TILE, y: C.FIELD_Y + C.FIELD_H * 0.5, r: C.REFILL_RADIUS },
      { type: 'well', x: C.FIELD_X + C.FIELD_W + 2.5 * C.TILE, y: C.FIELD_Y + C.FIELD_H * 0.5, r: C.REFILL_RADIUS }
    ];
  }

  function nozzlePos(state) {
    var tr = state.trailer;
    return { x: tr.x + Math.cos(tr.a) * C.NOZZLE_OFF, y: tr.y + Math.sin(tr.a) * C.NOZZLE_OFF };
  }

  function resetVehicles(state) {
    var t = state.truck;
    t.x = C.FIELD_X - 2.5 * C.TILE;
    t.y = C.FIELD_Y + 6 * C.TILE;
    t.a = Math.PI / 2; t.v = 0; t.steer = 0; t.throttle = 0;
    var tr = state.trailer;
    tr.a = Math.PI / 2;
    tr.x = t.x;
    tr.y = t.y - C.HITCH - C.TRAILER_LEN;
    var nz = nozzlePos(state);
    var sp = state.spray;
    sp.aimX = nz.x + 150; sp.aimY = nz.y + 30;
    sp.hitX = sp.aimX; sp.hitY = sp.aimY;
    sp.nozX = nz.x; sp.nozY = nz.y;
    sp.hits = [{ x: sp.hitX, y: sp.hitY }];
    sp.on = false; sp.want = false; sp.sputter = false; sp.drip = false; sp.sputterT = 0;
  }

  // ---------------------------------------------------------------- lifecycle
  function newGame(seed) {
    seed = (typeof seed === 'number' && isFinite(seed)) ? (seed >>> 0) : 20240611;
    var s = {
      v: 1,
      phase: 'menu',
      paused: false,
      time: 0,
      rng: seed,
      round: 0,
      timer: 0,
      roundLength: 60,
      countdown: 0,
      money: 0,
      upgrades: {},
      truck: { x: 0, y: 0, a: 0, v: 0, steer: 0, throttle: 0 },
      trailer: { x: 0, y: 0, a: 0 },
      tank: { water: 0, cap: 0, refilling: false, near: false, fullAck: true },
      spray: { aimX: 0, aimY: 0, hitX: 0, hitY: 0, nozX: 0, nozY: 0, hits: [],
        want: false, on: false, sputter: false, drip: false, sputterT: 0, range: 0, radius: 0 },
      field: null,
      stations: makeStations(),
      combo: { count: 0, timer: 0, mult: 1, best: 0, window: 1.6 },
      roundStats: blankRoundStats(),
      lastRound: null,
      stats: { rounds: 0, tiles: 0, earned: 0, bestCombo: 0, bestRound: 0 },
      events: []
    };
    UPGRADES.forEach(function (u) { s.upgrades[u.id] = 0; });
    for (var i = 0; i < 4; i++) rand(s); // stir the seed
    genField(s);
    resetVehicles(s);
    var st = getStats(s);
    s.tank.cap = st.tankCap; s.tank.water = st.tankCap;
    s.spray.range = st.range; s.spray.radius = st.radius;
    s.roundLength = st.roundTime; s.timer = st.roundTime;
    return s;
  }

  function startRound(state) {
    if (state.phase === 'playing') return false;
    state.round += 1;
    var st = getStats(state);
    genField(state);
    resetVehicles(state);
    state.tank.cap = st.tankCap;
    state.tank.water = st.tankCap;
    state.tank.refilling = false;
    state.tank.near = false;
    state.spray.range = st.range;
    state.spray.radius = st.radius;
    state.roundLength = st.roundTime;
    state.timer = st.roundTime;
    state.countdown = C.COUNTDOWN;
    state.combo = { count: 0, timer: 0, mult: 1, best: 0, window: st.comboWindow };
    state.roundStats = blankRoundStats();
    state.phase = 'playing';
    state.paused = false;
    state.events.push({ type: 'roundStart', round: state.round });
    state.events.push({ type: 'count', n: C.COUNTDOWN });
    return true;
  }

  function endRound(state, cleared) {
    if (state.phase !== 'playing') return false;
    var st = getStats(state);
    var rs = state.roundStats;
    var f = state.field;
    var tip = Math.floor(rs.earned * st.tipRate);
    var clearBonus = 0;
    if (cleared) clearBonus = Math.round(rs.earned * 0.25 + Math.max(0, state.timer) * 8 * payScale(state.round));
    state.money += tip + clearBonus;
    rs.tip = tip;
    rs.clearBonus = clearBonus;
    rs.cleared = !!cleared;
    rs.timeLeft = Math.max(0, state.timer);
    rs.total = rs.earned + tip + clearBonus;
    rs.fieldPct = f.total ? f.doneCount / f.total : 0;
    rs.bestCombo = state.combo.best;
    state.stats.rounds += 1;
    state.stats.earned += rs.total;
    if (rs.bestCombo > state.stats.bestCombo) state.stats.bestCombo = rs.bestCombo;
    if (rs.total > state.stats.bestRound) state.stats.bestRound = rs.total;
    var lr = {};
    for (var k in rs) lr[k] = rs[k];
    lr.round = state.round;
    state.lastRound = lr;
    state.phase = 'roundEnd';
    state.spray.on = false; state.spray.sputter = false; state.spray.drip = false;
    state.tank.refilling = false;
    state.events.push({ type: 'roundEnd', cleared: !!cleared, total: rs.total });
    if (cleared) state.events.push({ type: 'clear', bonus: clearBonus });
    return true;
  }

  function openShop(state) {
    if (state.phase !== 'roundEnd' && state.phase !== 'menu') return false;
    state.phase = 'shop';
    return true;
  }

  function setPaused(state, paused) {
    if (state.phase !== 'playing') { state.paused = false; return false; }
    state.paused = !!paused;
    state.events.push({ type: paused ? 'pause' : 'resume' });
    return true;
  }

  function buyUpgrade(state, id) {
    var u = UPG_BY_ID[id];
    if (!u) return false;
    if (state.phase !== 'shop') return false;
    var lvl = state.upgrades[id] || 0;
    if (lvl >= u.max) return false;
    var cost = costOf(id, lvl);
    if (state.money < cost) return false;
    state.money -= cost;
    state.upgrades[id] = lvl + 1;
    var st = getStats(state);
    state.tank.cap = st.tankCap;
    state.tank.water = st.tankCap;
    state.spray.range = st.range;
    state.spray.radius = st.radius;
    state.events.push({ type: 'buy', id: id, level: lvl + 1, cost: cost });
    return true;
  }

  function upgradeInfo(state) {
    var cur = statsFor(state.upgrades);
    return UPGRADES.map(function (u) {
      var l = state.upgrades[u.id] || 0;
      var maxed = l >= u.max;
      var nu = {};
      for (var k in state.upgrades) nu[k] = state.upgrades[k];
      nu[u.id] = l + 1;
      var cost = maxed ? 0 : costOf(u.id, l);
      return {
        id: u.id, name: u.name, desc: u.desc, level: l, max: u.max, cost: cost,
        cur: u.show(cur), next: maxed ? null : u.show(statsFor(nu)),
        maxed: maxed, afford: !maxed && state.money >= cost
      };
    });
  }

  function toSave(state) {
    var up = {};
    for (var k in state.upgrades) up[k] = state.upgrades[k];
    var stats = {};
    for (var j in state.stats) stats[j] = state.stats[j];
    return { v: 1, money: state.money, round: state.round, upgrades: up, stats: stats, rng: state.rng };
  }

  function fromSave(save, seed) {
    var s = newGame(save && typeof save.rng === 'number' ? save.rng : seed);
    if (!save) return s;
    s.money = Math.max(0, Math.floor(num(save.money, 0)));
    s.round = Math.max(0, Math.floor(num(save.round, 0)));
    if (save.upgrades) {
      UPGRADES.forEach(function (u) {
        s.upgrades[u.id] = clamp(Math.floor(num(save.upgrades[u.id], 0)), 0, u.max);
      });
    }
    if (save.stats) {
      for (var k in s.stats) s.stats[k] = num(save.stats[k], s.stats[k]);
    }
    var st = getStats(s);
    s.tank.cap = st.tankCap; s.tank.water = st.tankCap;
    s.spray.range = st.range; s.spray.radius = st.radius;
    s.phase = 'shop';
    return s;
  }

  function takeEvents(state) {
    var e = state.events;
    state.events = [];
    return e;
  }

  // ---------------------------------------------------------------- per-step systems
  function normDriver(d) {
    d = d || {};
    return {
      throttle: clamp(num(d.throttle, 0), -1, 1),
      steer: clamp(num(d.steer, 0), -1, 1),
      brake: !!d.brake
    };
  }

  function towardZero(v, amt) {
    if (v > amt) return v - amt;
    if (v < -amt) return v + amt;
    return 0;
  }

  function driveTruck(state, d, st, dt) {
    var t = state.truck;
    var fill = state.tank.cap > 0 ? state.tank.water / state.tank.cap : 0;
    var top = st.speed * (1 - 0.12 * fill);
    var rev = top * 0.45;
    var acc = st.accel;
    var thr = d.throttle;
    t.throttle = thr;
    if (thr > 0) t.v += (t.v < 0 ? acc * 2.4 : acc) * thr * dt;
    else if (thr < 0) t.v += (t.v > 0 ? acc * 2.4 : acc * 0.7) * thr * dt;
    else t.v = towardZero(t.v, 170 * dt);
    if (d.brake) t.v = towardZero(t.v, 950 * dt);
    if (t.v > top) t.v = Math.max(top, t.v - acc * 2 * dt);
    if (t.v < -rev) t.v = -rev;

    t.steer += (d.steer - t.steer) * Math.min(1, dt * 12);
    var sf = clamp(t.v / 150, -1, 1);
    var hs = 1 - 0.25 * Math.min(1, Math.abs(t.v) / 600);
    t.a = wrap(t.a + t.steer * st.steer * sf * hs * dt);
    t.x += Math.cos(t.a) * t.v * dt;
    t.y += Math.sin(t.a) * t.v * dt;

    var m = 36;
    if (t.x < m) { t.x = m; t.v *= 0.5; }
    if (t.y < m) { t.y = m; t.v *= 0.5; }
    if (t.x > C.WORLD_W - m) { t.x = C.WORLD_W - m; t.v *= 0.5; }
    if (t.y > C.WORLD_H - m) { t.y = C.WORLD_H - m; t.v *= 0.5; }
  }

  function updateTrailer(state) {
    var t = state.truck, tr = state.trailer;
    var hx = t.x - Math.cos(t.a) * C.HITCH;
    var hy = t.y - Math.sin(t.a) * C.HITCH;
    var dx = hx - tr.x, dy = hy - tr.y;
    var ta = (dx * dx + dy * dy) > 1e-6 ? Math.atan2(dy, dx) : tr.a;
    var rel = clamp(wrap(ta - t.a), -C.JACKKNIFE, C.JACKKNIFE);
    ta = wrap(t.a + rel);
    tr.a = ta;
    tr.x = hx - Math.cos(ta) * C.TRAILER_LEN;
    tr.y = hy - Math.sin(ta) * C.TRAILER_LEN;
  }

  function updateAim(state, spr, st) {
    var sp = state.spray;
    var nz = nozzlePos(state);
    sp.nozX = nz.x; sp.nozY = nz.y;
    sp.range = st.range; sp.radius = st.radius;
    var ax = num(spr && spr.aimX, sp.aimX), ay = num(spr && spr.aimY, sp.aimY);
    sp.aimX = ax; sp.aimY = ay;
    var dx = ax - nz.x, dy = ay - nz.y;
    var d = Math.sqrt(dx * dx + dy * dy);
    if (d > st.range) { dx *= st.range / d; dy *= st.range / d; d = st.range; }
    sp.hitX = nz.x + dx; sp.hitY = nz.y + dy;
    var n = st.nozzles;
    var px = 0, py = 1;
    if (d > 1) { px = -dy / d; py = dx / d; }
    var spacing = st.radius * 1.5;
    var hits = [];
    for (var i = 0; i < n; i++) {
      var o = (i - (n - 1) / 2) * spacing;
      hits.push({ x: sp.hitX + px * o, y: sp.hitY + py * o });
    }
    sp.hits = hits;
    sp.want = !!(spr && spr.spraying);
  }

  function completeTile(state, i, st) {
    var f = state.field;
    f.done[i] = 1;
    f.water[i] = f.need[i];
    f.doneCount += 1;
    var cb = state.combo;
    if (cb.timer > 0) cb.count += 1; else cb.count = 1;
    cb.timer = st.comboWindow;
    cb.window = st.comboWindow;
    cb.mult = 1 + Math.min(cb.count - 1, C.COMBO_MAX) * C.COMBO_STEP;
    if (cb.count > cb.best) cb.best = cb.count;
    var isBonus = f.bonus[i] === 1;
    var amount = Math.max(1, Math.round(f.pay[i] * cb.mult * st.moneyMult * (isBonus ? st.bonusMult : 1)));
    state.money += amount;
    var rs = state.roundStats;
    rs.earned += amount;
    rs.tiles += 1;
    if (isBonus) rs.bonusTiles += 1;
    state.stats.tiles += 1;
    var c = i % f.cols, r = (i - c) / f.cols;
    state.events.push({
      type: 'pay', i: i, amount: amount, bonus: isBonus, combo: cb.count,
      x: f.x + (c + 0.5) * f.tile, y: f.y + (r + 0.5) * f.tile
    });
  }

  function waterAt(state, x, y, R, amount, st) {
    if (!(amount > 0)) return;
    var f = state.field, T = f.tile;
    var eff = R + T * 0.5;
    var c0 = Math.floor((x - eff - f.x) / T), c1 = Math.floor((x + eff - f.x) / T);
    var r0 = Math.floor((y - eff - f.y) / T), r1 = Math.floor((y + eff - f.y) / T);
    var sum = 0, idx = [], ws = [];
    for (var r = r0; r <= r1; r++) {
      for (var c = c0; c <= c1; c++) {
        var cx = f.x + (c + 0.5) * T, cy = f.y + (r + 0.5) * T;
        var dx = cx - x, dy = cy - y;
        var w = 1 - Math.sqrt(dx * dx + dy * dy) / eff;
        if (w <= 0) continue;
        var inField = c >= 0 && c < f.cols && r >= 0 && r < f.rows;
        // Finished tiles shed most of their share onto thirsty neighbours,
        // so spraying next to green sod is only mildly wasteful.
        sum += (inField && f.done[r * f.cols + c]) ? w * 0.25 : w;
        if (inField) {
          idx.push(r * f.cols + c);
          ws.push(w);
        }
      }
    }
    if (sum <= 0) return;
    for (var k = 0; k < idx.length; k++) {
      var i = idx[k];
      if (f.done[i]) continue;
      f.water[i] += amount * ws[k] / sum;
      if (f.water[i] >= f.need[i]) completeTile(state, i, st);
    }
  }

  function sprayWater(state, st, dt) {
    var sp = state.spray, tank = state.tank;
    sp.on = false; sp.sputter = false;
    if (sp.sputterT > 0) sp.sputterT -= dt;
    if (!sp.want) return;
    var n = st.nozzles;
    var drain = st.flow * dt * (n === 1 ? 1 : n * 0.75);
    if (tank.water > 0.0001) {
      var amt = Math.min(drain, tank.water);
      tank.water -= amt;
      if (tank.water < 0.0001) tank.water = 0;
      state.roundStats.waterUsed += amt;
      var per = st.flow * dt * (amt / drain);
      for (var h = 0; h < sp.hits.length; h++) waterAt(state, sp.hits[h].x, sp.hits[h].y, st.radius, per, st);
      sp.on = true;
    } else {
      sp.sputter = true;
      if (sp.sputterT <= 0) {
        sp.sputterT = 0.45;
        state.events.push({ type: 'sputter', x: sp.nozX, y: sp.nozY });
      }
    }
  }

  function dripWater(state, st, dt) {
    var sp = state.spray, tank = state.tank, tr = state.trailer;
    sp.drip = false;
    if (st.drip <= 0 || tank.water <= 0 || Math.abs(state.truck.v) < 10) return;
    var amt = Math.min(st.drip * dt, tank.water);
    tank.water -= amt;
    if (tank.water < 0.0001) tank.water = 0;
    state.roundStats.waterUsed += amt;
    waterAt(state, tr.x, tr.y, C.DRIP_RADIUS, amt, st);
    sp.drip = true;
  }

  function refillTank(state, st, dt) {
    var tank = state.tank, tr = state.trailer;
    var near = false;
    for (var i = 0; i < state.stations.length; i++) {
      var s = state.stations[i];
      var dx = s.x - tr.x, dy = s.y - tr.y;
      if (dx * dx + dy * dy < s.r * s.r) { near = true; break; }
    }
    tank.near = near;
    var was = tank.refilling;
    var can = near && Math.abs(state.truck.v) < C.REFILL_MAX_SPEED && tank.water < tank.cap;
    if (can) {
      var amt = Math.min(st.refill * dt, tank.cap - tank.water);
      tank.water += amt;
      state.roundStats.refilled += amt;
      if (tank.water >= tank.cap - 0.0001) {
        tank.water = tank.cap;
        if (!tank.fullAck) state.events.push({ type: 'refillFull' });
        tank.fullAck = true;
        can = false;
      }
    }
    if (tank.water < tank.cap * 0.95) tank.fullAck = false;
    tank.refilling = can;
    if (can && !was) state.events.push({ type: 'refillStart' });
  }

  function coast(state, dt) {
    var t = state.truck;
    t.v = towardZero(t.v, 600 * dt);
    t.throttle = 0;
    if (t.v !== 0) {
      t.x += Math.cos(t.a) * t.v * dt;
      t.y += Math.sin(t.a) * t.v * dt;
      updateTrailer(state);
    }
  }

  // ---------------------------------------------------------------- main step
  function step(state, inputs, dt) {
    state.events = [];
    if (!(dt > 0)) dt = C.DT;
    if (state.paused) return state;
    state.time += dt;
    inputs = inputs || {};
    if (state.phase !== 'playing') {
      if (state.phase !== 'menu') coast(state, dt);
      return state;
    }
    var st = getStats(state);
    state.tank.cap = st.tankCap;
    if (state.tank.water > state.tank.cap) state.tank.water = state.tank.cap;
    state.combo.window = st.comboWindow;

    driveTruck(state, normDriver(inputs.driver), st, dt);
    updateTrailer(state);
    updateAim(state, inputs.sprayer, st);

    if (state.countdown > 0) {
      var before = Math.ceil(state.countdown);
      state.countdown -= dt;
      if (state.countdown <= 0) {
        state.countdown = 0;
        state.events.push({ type: 'go' });
      } else if (Math.ceil(state.countdown) !== before) {
        state.events.push({ type: 'count', n: Math.ceil(state.countdown) });
      }
      state.spray.on = false; state.spray.sputter = false;
      refillTank(state, st, dt);
      return state;
    }

    var tb = Math.ceil(state.timer);
    state.timer -= dt;
    var ta = Math.ceil(state.timer);
    if (ta !== tb && ta <= 5 && ta > 0) state.events.push({ type: 'tick', n: ta });

    sprayWater(state, st, dt);
    dripWater(state, st, dt);
    refillTank(state, st, dt);

    var cb = state.combo;
    if (cb.timer > 0) {
      cb.timer -= dt;
      if (cb.timer <= 0) {
        cb.timer = 0;
        if (cb.count >= 5) state.events.push({ type: 'comboEnd', count: cb.count });
        cb.count = 0;
        cb.mult = 1;
      }
    }

    if (state.field.doneCount >= state.field.total) endRound(state, true);
    else if (state.timer <= 0) { state.timer = 0; endRound(state, false); }
    return state;
  }

  SOD.Sim = {
    C: C,
    UPGRADES: UPGRADES,
    newGame: newGame,
    startRound: startRound,
    endRound: endRound,
    openShop: openShop,
    setPaused: setPaused,
    buyUpgrade: buyUpgrade,
    step: step,
    takeEvents: takeEvents,
    getStats: getStats,
    statsFor: statsFor,
    costOf: costOf,
    upgradeInfo: upgradeInfo,
    toSave: toSave,
    fromSave: fromSave,
    getNozzle: function (state) {
      var n = nozzlePos(state);
      n.range = getStats(state).range;
      return n;
    }
  };
})();
