/* Sod Farm - HOME BASE simulation (pure).  Attaches to window.SOD.BaseSim
 * No DOM / canvas / audio / Math.random / Date in here. ALL state is ONE plain JSON-serializable
 * object (no classes, Maps, Sets, typed arrays, functions). step() runs at a fixed C.DT = 1/60.
 * Truck / trailer / hose code is ported from the root js/sim.js.
 *
 * =============================================================================================
 * COORDINATES
 *   Grid of C.COLS x C.ROWS cells (28x28), C.TILE = 40 world units. The grid starts at world (0,0):
 *   cell (c, r) spans x in [c*T, (c+1)*T), y in [r*T, (r+1)*T); its centre is ((c+.5)*T, (r+.5)*T).
 *   World size C.WORLD_W x C.WORLD_H (1120 x 1120). Per-cell arrays are indexed i = r*cols + c.
 *   Angles in radians, 0 = +x, PI/2 = +y (screen-down / three.js +z if you map y->z).
 *
 * STATE SHAPE  (newGame(seed) returns this; everything below is plain data)
 *   v: 1                         save version
 *   time: s                      sim seconds elapsed (step + fastForward)
 *   clock: {day, t}              day counter (from 1) and time of day t in [0,1) (0 = midnight,
 *                                .25 = 6am, .5 = noon); a day lasts C.DAY_LEN (240 s); starts at .3
 *   paused: bool                 step() does nothing while true
 *   rng: uint32                  seeded mulberry32 state (reserved; nothing random yet)
 *   money: $                     whole dollars
 *   cols, rows                   grid size (28, 28)
 *   -- per-cell plain arrays, length cols*rows --
 *   owned[i]    0/1             player owns the cell (build/farm only here; truck drives anywhere)
 *   ground[i]   0 grass | 1 tilled dirt | 2 sod plot (seeded)             (see C.GROUND names)
 *   pipe[i]     0/1             pipe layer, independent of ground and struct (pipes run under plots)
 *   struct[i]   0 none | 1 pump | 2 tank | 3 sprinkler | 4 fill | 5 rack  (see C.STRUCTS names)
 *                               a structure never sits on a plot (ground 2)
 *   moist[i]    0..1            soil moisture (every cell has it; only matters for plots)
 *   growth[i]   0..1            plot growth, 1 = ready to harvest
 *   health[i]   0..1            plot health, 0 = died (reverts to dirt)
 *   sodType[i]  -1 | index into SOD_TYPES
 *   tankW[i]    litres stored in the tank on that cell (0 elsewhere)
 *   -- water network cache (rebuilt only on build/demolish/load; telemetry updated every step) --
 *   net: { cell[i]: network id or -1,
 *          list: [{ id, pipes, pumps:[i], tanks:[i], sprinklers:[i], fills:[i],
 *                   sprOn:[0..1 per sprinkler, share of demand it got last step, 0 = idle],
 *                   inflow L/s, demand L/s, supplied L/s, stored L, cap L, empty bool }] }
 *   inv: [rolls per SOD_TYPES index]       harvested sod in storage (cap = getStats().invCap)
 *   built: {pipe, pump, tank, sprinkler, fill, rack}  number BOUGHT (drives rising cost; the free
 *                                          starting pump/tank/fill/pipes are not counted)
 *   landBought: n                          parcels bought (drives rising land cost)
 *   equip: {engine, tank, flow, range}     equipment levels (see EQUIP)
 *   truck:   {x, y, a, v, steer, throttle}
 *   trailer: {x, y, a}
 *   tank:    {water, cap, refilling, near, fullAck}   the trailer's water tank (litres)
 *   spray:   {aimX, aimY, hitX, hitY, nozX, nozY, want, on, sputter, sputterT, range, radius}
 *   stats:   {harvested, sold, earned, spent, died, hosed, refilled}  lifetime totals
 *   events:  [ {type, ...} ]               drained with takeEvents(); NOT cleared by step()
 *                                          (capped at C.MAX_EVENTS, oldest dropped)
 *
 * INPUTS to step():  { driver: {throttle -1..1, steer -1..1, brake bool},
 *                      sprayer: {aimX, aimY (world), spraying bool} }   (same as root sim)
 *
 * API  (SOD.BaseSim)
 *   newGame(seed) -> state
 *   step(state, inputs, dt)      advance one fixed step (dt defaults to C.DT); returns state
 *   takeEvents(state) -> [events] and clears them. Call once per frame.
 *   toSave(state) -> plain object (deep copy, events dropped);  fromSave(save) -> state
 *                                (validates/sanitizes; unknown/invalid save -> newGame())
 *   fastForward(state, seconds)  coarse farm-only advance (moisture, growth, pumps, sprinklers,
 *                                tanks; truck stops, no hose/fill). Matches stepping closely.
 *   Actions (return true/false; push an event and spend/earn money on success):
 *     till(state,c,r)            grass -> dirt ($C.TILL_COST)
 *     seed(state,c,r,sodType)    dirt -> plot; sodType = SOD_TYPES index (default 0)
 *     harvest(state,c,r)         ready plot -> +1 roll in inv, cell back to dirt (needs inv space)
 *     build(state,kind,c,r)      kind: 'pipe'|'pump'|'tank'|'sprinkler'|'fill'|'rack'
 *     demolish(state,c,r,layer)  layer 'struct'|'pipe'|'ground' (ground: plot/dirt -> grass, no
 *                                refund); omitted = topmost (struct, then pipe, then ground).
 *                                struct/pipe refund C.REFUND of its current price.
 *     buyLand(state,parcelId)    parcels are C.PARCEL x C.PARCEL blocks, id = py*PCOLS+px;
 *                                must be 4-adjacent to an owned parcel
 *     sellSod(state,n,sodType?)  sell up to n rolls to the wholesaler (SOD_TYPES[].price each);
 *                                no sodType = sell types in index order. n = Infinity sells all.
 *     buyEquip(state,id)         id in EQUIP
 *     setPaused(state,bool)
 *   Queries (pure, never modify state):
 *     canDo(state, action, c, r, arg) -> {ok, reason, cost, refund}
 *        action: 'till'|'seed'(arg=sodType)|'harvest'|'demolish'(arg=layer)| any build kind.
 *        Every cell action calls canDo itself, so they always agree.
 *        reason: ''|'bounds'|'unowned'|'kind'|'occupied'|'plot'|'vehicle'|'notGrass'|
 *                'notDirt'|'notReady'|'full'|'nothing'|'money'
 *     cellAt(state, x, y) -> {c, r, i} or null (outside the grid)
 *     costOf(state, kind, arg) -> $ for a build kind, 'till', 'seed' (arg = sodType), 'land'
 *     networkInfo(state) -> [{id, pumps, tanks, sprinklers, fills, pipes, inflow, demand,
 *                            supplied, stored, capacity}]   counts; flows in L/s
 *     landParcels(state) -> [{id, px, py, c0, r0, c1, r1 (inclusive), cost, owned, buyable}]
 *     getStats(state) -> equipment stats {speed, accel, steer, tankCap, flow, range, radius,
 *                        refill} + {invCap, invTotal, counts:{pump..rack}, plots, ready}
 *     getNozzle(state) -> {x, y, range, radius}
 *     sprinklerCells(state, i) -> [cell indices a sprinkler at cell i covers]  (for previews)
 *   Constants: C, BUILDINGS, SOD_TYPES, EQUIP
 *
 * EVENTS (all carry x,y world centre where it makes sense, and c,r,i for cell events)
 *   built {kind,cost}  demolished {kind|layer,refund}  tilled {cost}  seeded {sodType,cost}
 *   harvested {sodType}  plotReady  plotDied  sold {n,amount}  landBought {id,cost}
 *   equipBought {id,level,cost}  tankEmpty {net}  refillStart  refillFull  sputter
 *   newDay {day}  pause  resume
 *
 * RULES / DECISIONS
 *   Water network: pipes connect 4-neighbour. A structure joins a network if its own cell has a
 *   pipe or a 4-neighbour has a pipe, and it CONDUCTS: two pipe runs touching the same structure
 *   are one network. Two structures side by side without pipe do NOT connect. Per network per
 *   step: pumps add inflow into pooled storage (sum of tank caps, tank levels equalised);
 *   sprinklers (smart: only draw while a covered plot is below .95 moisture) and the fill station
 *   draw; if pool+inflow can't cover demand, every consumer gets the same fraction. A network
 *   without tanks just passes pump inflow through. No pressure. Racks need no network.
 *   Sprinklers water plot cells (ground 2) within BUILDINGS.sprinkler.radius tiles (3x3 block).
 *   Fill station: refills the trailer while the trailer is within its radius and truck speed <
 *   C.REFILL_MAX_SPEED. Only one fill station serves the trailer per step.
 *   Moisture: dm/dt = -(K*m + E) * sodType.thirst (exact integration), so fastForward agrees.
 *   1 moisture = C.CELL_L litres. Growth only while moist >= sodType.minMoist; while moist <
 *   C.DRY health falls (growing: dies in C.DIE_TIME s; ready: C.READY_DIE_TIME s); otherwise it
 *   recovers. Structures block the truck (centre + bumper point test); building on a cell under
 *   the truck or trailer is refused ('vehicle'). The mouse player's farm actions do not need the
 *   truck nearby.
 * =============================================================================================
 */
(function () {
  'use strict';
  var SOD = (window.SOD = window.SOD || {});

  // ---------------------------------------------------------------- constants
  var C = {
    TILE: 40, COLS: 28, ROWS: 28, DT: 1 / 60,
    TRUCK_LEN: 74, TRUCK_W: 38, HITCH: 40, TRAILER_LEN: 56, NOZZLE_OFF: -6, JACKKNIFE: 1.35,
    REFILL_MAX_SPEED: 90,
    CELL_L: 20,          // litres to take a cell from 0 to 1 moisture
    DECAY_K: 1 / 30,     // moisture decay, proportional part (1/s)
    DECAY_E: 0.004,      // moisture decay, constant part (1/s)
    DRY: 0.05,           // below this a plot is "bone dry"
    DIE_TIME: 40,        // s of bone dry for a growing plot to die from full health
    READY_DIE_TIME: 120, // same for a ready plot
    HEAL_TIME: 60,       // s to recover from 0 to full health while moist
    SMART_FULL: 0.95,    // sprinklers skip plots wetter than this
    INV_BASE: 12,
    PARCEL: 4,
    LAND_BASE: 150, LAND_GROWTH: 1.25,
    TILL_COST: 1,
    REFUND: 0.5,
    START_MONEY: 150,
    DAY_LEN: 240, DAY_START: 0.3,
    FF_CHUNK: 0.5,
    MAX_EVENTS: 256,
    GROUND: ['grass', 'dirt', 'plot'],
    STRUCTS: ['', 'pump', 'tank', 'sprinkler', 'fill', 'rack']
  };
  C.WORLD_W = C.COLS * C.TILE;
  C.WORLD_H = C.ROWS * C.TILE;
  C.PCOLS = C.COLS / C.PARCEL;
  C.PROWS = C.ROWS / C.PARCEL;
  C.START_PARCELS = [[3, 3], [4, 3], [3, 4], [4, 4]]; // owned at start: cells 12..19 x 12..19

  // code: struct code (0 = pipe layer). base * growth^built = price.
  var BUILDINGS = {
    pipe:      { kind: 'pipe', code: 0, name: 'Pipe', base: 4, growth: 1,
      desc: 'Connects pumps, tanks, sprinklers and fill stations. Can run under plots.' },
    pump:      { kind: 'pump', code: 1, name: 'Well Pump', base: 140, growth: 1.2, rate: 4,
      desc: 'Pumps 4 L/s into its network.' },
    tank:      { kind: 'tank', code: 2, name: 'Water Tank', base: 100, growth: 1.15, cap: 300,
      desc: 'Stores 300 L for its network.' },
    sprinkler: { kind: 'sprinkler', code: 3, name: 'Sprinkler', base: 160, growth: 1.15, rate: 3, radius: 1.5,
      desc: 'Waters the 8 surrounding plots, up to 3 L/s.' },
    fill:      { kind: 'fill', code: 4, name: 'Fill Station', base: 250, growth: 1.3, radius: 130,
      desc: 'Refills the trailer tank from its network when parked nearby.' },
    rack:      { kind: 'rack', code: 5, name: 'Pallet Rack', base: 90, growth: 1.15, inv: 24,
      desc: 'Stores 24 more sod rolls.' }
  };
  var KIND_BY_CODE = ['pipe', 'pump', 'tank', 'sprinkler', 'fill', 'rack'];

  var SOD_TYPES = [
    { id: 'fescue', name: 'Tall Fescue', grow: 75, minMoist: 0.2, thirst: 1, seedCost: 2, price: 7 },
    { id: 'bluegrass', name: 'Kentucky Bluegrass', grow: 110, minMoist: 0.3, thirst: 1.5, seedCost: 6, price: 18 }
  ];

  var EQUIP = [
    { id: 'engine', name: 'Big Block Engine', desc: 'Top speed & acceleration', base: 90, growth: 1.6, max: 8 },
    { id: 'tank', name: 'Bigger Trailer Tank', desc: 'Trailer water capacity', base: 80, growth: 1.55, max: 8 },
    { id: 'flow', name: 'Hose Pump', desc: 'Hose flow rate', base: 100, growth: 1.6, max: 8 },
    { id: 'range', name: 'Hose Range', desc: 'How far the stream reaches', base: 70, growth: 1.55, max: 8 }
  ];
  var EQUIP_BY_ID = {};
  EQUIP.forEach(function (e) { EQUIP_BY_ID[e.id] = e; });

  function statsFor(eq) {
    function l(id) { return eq[id] || 0; }
    return {
      speed: 240 + 30 * l('engine'), accel: 300 + 50 * l('engine'), steer: 2.1,
      tankCap: 200 + 75 * l('tank'), flow: 22 + 6 * l('flow'),
      range: 190 + 30 * l('range'), radius: 30 + 3 * l('range'), refill: 60
    };
  }

  // sprinkler coverage offsets (excluding own cell)
  var SPR_OFF = [];
  (function () {
    var R = BUILDINGS.sprinkler.radius, n = Math.ceil(R);
    for (var dr = -n; dr <= n; dr++) for (var dc = -n; dc <= n; dc++) {
      if ((dc || dr) && dc * dc + dr * dr <= R * R) SPR_OFF.push([dc, dr]);
    }
  })();

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
  function towardZero(v, amt) { return v > amt ? v - amt : v < -amt ? v + amt : 0; }
  function inGrid(state, c, r) { return c >= 0 && r >= 0 && c < state.cols && r < state.rows && c === Math.floor(c) && r === Math.floor(r); }
  function push(state, e) {
    state.events.push(e);
    if (state.events.length > C.MAX_EVENTS) state.events.splice(0, state.events.length - C.MAX_EVENTS);
  }
  function cellEvent(state, type, i, extra) {
    var c = i % state.cols, r = (i - c) / state.cols;
    var e = { type: type, c: c, r: r, i: i, x: (c + 0.5) * C.TILE, y: (r + 0.5) * C.TILE };
    if (extra) for (var k in extra) e[k] = extra[k];
    push(state, e);
  }
  function fillArr(n, v) { var a = []; for (var i = 0; i < n; i++) a.push(v); return a; }
  function countStruct(state, code) {
    var n = 0, s = state.struct;
    for (var i = 0; i < s.length; i++) if (s[i] === code) n++;
    return n;
  }
  function invTotal(state) { var t = 0; for (var k = 0; k < state.inv.length; k++) t += state.inv[k]; return t; }
  function invCap(state) { return C.INV_BASE + countStruct(state, 5) * BUILDINGS.rack.inv; }

  function getStats(state) {
    var s = statsFor(state.equip);
    s.invCap = invCap(state);
    s.invTotal = invTotal(state);
    s.counts = {};
    for (var k = 1; k < KIND_BY_CODE.length; k++) s.counts[KIND_BY_CODE[k]] = countStruct(state, k);
    var plots = 0, ready = 0;
    for (var i = 0; i < state.ground.length; i++) if (state.ground[i] === 2) { plots++; if (state.growth[i] >= 1) ready++; }
    s.plots = plots; s.ready = ready;
    return s;
  }

  function costOf(state, kind, arg) {
    if (kind === 'till') return C.TILL_COST;
    if (kind === 'seed') { var t = SOD_TYPES[arg | 0]; return t ? t.seedCost : Infinity; }
    if (kind === 'land') return Math.round(C.LAND_BASE * Math.pow(C.LAND_GROWTH, state.landBought));
    var b = BUILDINGS[kind];
    if (!b) return Infinity;
    return Math.round(b.base * Math.pow(b.growth, state.built[kind] || 0));
  }
  function refundOf(state, kind) {
    var b = BUILDINGS[kind];
    return Math.floor(C.REFUND * b.base * Math.pow(b.growth, Math.max(0, (state.built[kind] || 0) - 1)));
  }

  function nozzlePos(state) {
    var tr = state.trailer;
    return { x: tr.x + Math.cos(tr.a) * C.NOZZLE_OFF, y: tr.y + Math.sin(tr.a) * C.NOZZLE_OFF };
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

  // ---------------------------------------------------------------- water network
  function rebuildNet(state) {
    var cols = state.cols, N = cols * state.rows, P = state.pipe, S = state.struct;
    var cell = fillArr(N, -1), list = [];
    for (var i0 = 0; i0 < N; i0++) {
      if (!P[i0] || cell[i0] >= 0) continue;
      var id = list.length;
      var n = { id: id, pipes: 0, pumps: [], tanks: [], sprinklers: [], fills: [], sprOn: [],
        inflow: 0, demand: 0, supplied: 0, stored: 0, cap: 0, empty: false };
      list.push(n);
      var stack = [i0];
      cell[i0] = id;
      while (stack.length) {
        var j = stack.pop();
        if (P[j]) n.pipes++;
        var s = S[j];
        if (s === 1) n.pumps.push(j);
        else if (s === 2) n.tanks.push(j);
        else if (s === 3) { n.sprinklers.push(j); n.sprOn.push(0); }
        else if (s === 4) n.fills.push(j);
        var c = j % cols, r = (j - c) / cols;
        var nb = [r > 0 ? j - cols : -1, c < cols - 1 ? j + 1 : -1, r < state.rows - 1 ? j + cols : -1, c > 0 ? j - 1 : -1];
        for (var q = 0; q < 4; q++) {
          var k = nb[q];
          if (k < 0 || cell[k] >= 0) continue;
          if (!(P[k] || S[k])) continue;
          if (!(P[j] || P[k])) continue; // struct-struct without pipe: no link
          cell[k] = id;
          stack.push(k);
        }
      }
      // pool telemetry right away so networkInfo is valid before the first step
      n.cap = n.tanks.length * BUILDINGS.tank.cap;
      for (var t = 0; t < n.tanks.length; t++) n.stored += state.tankW[n.tanks[t]];
      n.inflow = n.pumps.length * BUILDINGS.pump.rate;
    }
    state.net = { cell: cell, list: list };
  }

  function sprinklerCells(state, i) {
    var cols = state.cols, c = i % cols, r = (i - c) / cols, out = [];
    for (var k = 0; k < SPR_OFF.length; k++) {
      var cc = c + SPR_OFF[k][0], rr = r + SPR_OFF[k][1];
      if (cc >= 0 && rr >= 0 && cc < cols && rr < state.rows) out.push(rr * cols + cc);
    }
    return out;
  }
  function thirstyCells(state, i) {
    var all = sprinklerCells(state, i), out = [];
    for (var k = 0; k < all.length; k++) {
      var j = all[k];
      if (state.ground[j] === 2 && state.moist[j] < C.SMART_FULL) out.push(j);
    }
    return out;
  }

  // withTruck: also serve the trailer at fill stations (step only, not fastForward)
  function runNetworks(state, dt, withTruck) {
    var B = BUILDINGS, list = state.net.list, tank = state.tank, tr = state.trailer;
    var fillDone = false, near = false, got = 0;
    var st = withTruck ? statsFor(state.equip) : null;
    for (var ni = 0; ni < list.length; ni++) {
      var n = list[ni];
      var inflow = n.pumps.length * B.pump.rate * dt;
      var cap = n.tanks.length * B.tank.cap;
      var pool = 0, t;
      for (t = 0; t < n.tanks.length; t++) pool += state.tankW[n.tanks[t]];
      var D = 0, cellsBy = [], dem = [];
      for (var k = 0; k < n.sprinklers.length; k++) {
        var cs = thirstyCells(state, n.sprinklers[k]);
        var d = cs.length ? B.sprinkler.rate * dt : 0;
        cellsBy.push(cs); dem.push(d); D += d;
      }
      var fillDem = 0;
      if (withTruck && !fillDone) {
        for (var f = 0; f < n.fills.length; f++) {
          var fi = n.fills[f], fc = fi % state.cols, fr = (fi - fc) / state.cols;
          var dx = (fc + 0.5) * C.TILE - tr.x, dy = (fr + 0.5) * C.TILE - tr.y;
          if (dx * dx + dy * dy < B.fill.radius * B.fill.radius) {
            near = true; fillDone = true;
            if (Math.abs(state.truck.v) < C.REFILL_MAX_SPEED && tank.water < tank.cap) {
              fillDem = Math.min(st.refill * dt, tank.cap - tank.water);
            }
            break;
          }
        }
      }
      D += fillDem;
      var avail = pool + inflow;
      var frac = D > 0 ? Math.min(1, avail / D) : 0;
      for (k = 0; k < dem.length; k++) {
        n.sprOn[k] = dem[k] > 0 ? frac : 0;
        if (dem[k] <= 0) continue;
        var per = dem[k] * frac / cellsBy[k].length / C.CELL_L;
        for (var q = 0; q < cellsBy[k].length; q++) {
          var j = cellsBy[k][q];
          state.moist[j] = Math.min(1, state.moist[j] + per);
        }
      }
      got += fillDem * frac;
      var np = clamp(pool + inflow - D * frac, 0, cap);
      if (np < 1e-9) np = 0;
      for (t = 0; t < n.tanks.length; t++) state.tankW[n.tanks[t]] = np / n.tanks.length;
      n.inflow = inflow / dt; n.demand = D / dt; n.supplied = D * frac / dt; n.stored = np; n.cap = cap;
      if (cap > 0 && np <= 0 && D > 0) {
        if (!n.empty) { n.empty = true; push(state, { type: 'tankEmpty', net: n.id }); }
      } else if (np > cap * 0.1) n.empty = false;
    }
    if (!withTruck) return;
    tank.near = near;
    var was = tank.refilling, can = got > 1e-9;
    if (can) {
      tank.water += got;
      state.stats.refilled += got;
      if (tank.water >= tank.cap - 0.0001) {
        tank.water = tank.cap;
        if (!tank.fullAck) push(state, { type: 'refillFull' });
        tank.fullAck = true;
        can = false;
      }
    }
    if (tank.water < tank.cap * 0.95) tank.fullAck = false;
    tank.refilling = can;
    if (can && !was) push(state, { type: 'refillStart' });
  }

  // ---------------------------------------------------------------- farm tick (shared by step & fastForward)
  function farmTick(state, dt, withTruck) {
    runNetworks(state, dt, withTruck);
    var M = state.moist, G = state.ground, N = M.length;
    for (var i = 0; i < N; i++) {
      var plot = G[i] === 2, T = plot ? SOD_TYPES[state.sodType[i]] : null;
      var m = M[i];
      if (m > 0) {
        var mul = T ? T.thirst : 1, k = C.DECAY_K * mul, e = C.DECAY_E * mul;
        m = (m + e / k) * Math.exp(-k * dt) - e / k;
        if (m < 1e-6) m = 0;
        M[i] = m;
      }
      if (!plot) continue;
      var h = state.health[i];
      if (state.growth[i] < 1) {
        if (m >= T.minMoist) {
          state.growth[i] += dt / T.grow;
          h += dt / C.HEAL_TIME;
          if (state.growth[i] >= 1) { state.growth[i] = 1; cellEvent(state, 'plotReady', i, { sodType: state.sodType[i] }); }
        } else if (m < C.DRY) h -= dt / C.DIE_TIME;
      } else {
        if (m < C.DRY) h -= dt / C.READY_DIE_TIME; else h += dt / C.HEAL_TIME;
      }
      if (h <= 0) {
        G[i] = 1; state.growth[i] = 0; state.health[i] = 1;
        var ty = state.sodType[i];
        state.sodType[i] = -1;
        state.stats.died += 1;
        cellEvent(state, 'plotDied', i, { sodType: ty });
      } else state.health[i] = Math.min(1, h);
    }
  }

  function advanceClock(state, dt) {
    state.time += dt;
    var ck = state.clock;
    ck.t += dt / C.DAY_LEN;
    while (ck.t >= 1) { ck.t -= 1; ck.day += 1; push(state, { type: 'newDay', day: ck.day }); }
  }

  // ---------------------------------------------------------------- lifecycle
  function newGame(seed) {
    seed = (typeof seed === 'number' && isFinite(seed)) ? (seed >>> 0) : 20240611;
    var cols = C.COLS, rows = C.ROWS, N = cols * rows;
    var s = {
      v: 1, time: 0, clock: { day: 1, t: C.DAY_START }, paused: false, rng: seed,
      money: C.START_MONEY, cols: cols, rows: rows,
      owned: fillArr(N, 0), ground: fillArr(N, 0), pipe: fillArr(N, 0), struct: fillArr(N, 0),
      moist: fillArr(N, 0), growth: fillArr(N, 0), health: fillArr(N, 1), sodType: fillArr(N, -1),
      tankW: fillArr(N, 0),
      net: { cell: [], list: [] },
      inv: fillArr(SOD_TYPES.length, 0),
      built: { pipe: 0, pump: 0, tank: 0, sprinkler: 0, fill: 0, rack: 0 },
      landBought: 0,
      equip: {},
      truck: { x: 0, y: 0, a: 0, v: 0, steer: 0, throttle: 0 },
      trailer: { x: 0, y: 0, a: 0 },
      tank: { water: 0, cap: 0, refilling: false, near: false, fullAck: true },
      spray: { aimX: 0, aimY: 0, hitX: 0, hitY: 0, nozX: 0, nozY: 0, want: false, on: false,
        sputter: false, sputterT: 0, range: 0, radius: 0 },
      stats: { harvested: 0, sold: 0, earned: 0, spent: 0, died: 0, hosed: 0, refilled: 0 },
      events: []
    };
    EQUIP.forEach(function (e) { s.equip[e.id] = 0; });
    for (var q = 0; q < 4; q++) rand(s);
    function at(c, r) { return r * cols + c; }
    C.START_PARCELS.forEach(function (p) { setParcelOwned(s, p[0], p[1]); });
    // starter infrastructure along the north edge of the parcel: pump - pipe - tank - pipe - fill
    s.struct[at(13, 12)] = 1;
    s.pipe[at(14, 12)] = 1;
    s.struct[at(15, 12)] = 2; s.tankW[at(15, 12)] = BUILDINGS.tank.cap;
    s.pipe[at(16, 12)] = 1;
    s.struct[at(17, 12)] = 4;
    // tilled U around (17,15): the natural first sprinkler spot
    [[16, 14], [17, 14], [18, 14], [16, 15], [18, 15]].forEach(function (p) { s.ground[at(p[0], p[1])] = 1; });
    rebuildNet(s);
    // truck parked east of the parcel facing south, trailer in reach of the fill station
    var st = statsFor(s.equip), T = C.TILE;
    s.truck.x = 20.5 * T; s.truck.y = 16 * T; s.truck.a = Math.PI / 2;
    s.trailer.a = Math.PI / 2; s.trailer.x = s.truck.x; s.trailer.y = s.truck.y - C.HITCH - C.TRAILER_LEN;
    s.tank.cap = st.tankCap; s.tank.water = st.tankCap;
    var nz = nozzlePos(s), sp = s.spray;
    sp.aimX = nz.x - 120; sp.aimY = nz.y + 40; sp.hitX = sp.aimX; sp.hitY = sp.aimY;
    sp.nozX = nz.x; sp.nozY = nz.y; sp.range = st.range; sp.radius = st.radius;
    return s;
  }

  function setParcelOwned(state, px, py) {
    for (var r = py * C.PARCEL; r < (py + 1) * C.PARCEL; r++)
      for (var c = px * C.PARCEL; c < (px + 1) * C.PARCEL; c++) state.owned[r * state.cols + c] = 1;
  }
  function parcelOwned(state, px, py) {
    if (px < 0 || py < 0 || px >= C.PCOLS || py >= C.PROWS) return false;
    return state.owned[(py * C.PARCEL) * state.cols + px * C.PARCEL] === 1;
  }

  function takeEvents(state) { var e = state.events; state.events = []; return e; }

  function toSave(state) {
    var s = JSON.parse(JSON.stringify(state));
    s.events = [];
    return s;
  }

  function merge(dst, src) {
    for (var k in dst) {
      if (!(k in src) || k === 'net' || k === 'events') continue;
      var d = dst[k], v = src[k];
      if (typeof d === 'number') dst[k] = num(v, d);
      else if (typeof d === 'boolean') dst[k] = !!v;
      else if (Array.isArray(d)) {
        if (Array.isArray(v) && v.length === d.length) for (var j = 0; j < d.length; j++) d[j] = num(v[j], d[j]);
      } else if (d && typeof d === 'object' && v && typeof v === 'object') merge(d, v);
    }
  }

  function fromSave(save) {
    if (!save || typeof save !== 'object' || save.v !== 1) return newGame();
    var s = newGame(num(save.rng, 0) >>> 0);
    merge(s, save);
    s.rng = s.rng >>> 0;
    s.money = Math.max(0, Math.floor(s.money));
    for (var i = 0; i < s.owned.length; i++) {
      s.owned[i] = s.owned[i] ? 1 : 0;
      s.pipe[i] = s.pipe[i] ? 1 : 0;
      s.struct[i] = clamp(Math.floor(s.struct[i]), 0, 5);
      s.ground[i] = clamp(Math.floor(s.ground[i]), 0, 2);
      s.sodType[i] = clamp(Math.floor(s.sodType[i]), -1, SOD_TYPES.length - 1);
      s.moist[i] = clamp(s.moist[i], 0, 1);
      s.growth[i] = clamp(s.growth[i], 0, 1);
      s.health[i] = clamp(s.health[i], 0, 1);
      if (s.ground[i] === 2 && s.sodType[i] < 0) s.ground[i] = 1;
      if (s.ground[i] !== 2) { s.sodType[i] = -1; s.growth[i] = 0; s.health[i] = 1; }
      if (s.ground[i] === 2 && s.struct[i]) s.struct[i] = 0;
      s.tankW[i] = s.struct[i] === 2 ? clamp(s.tankW[i], 0, BUILDINGS.tank.cap) : 0;
    }
    for (var k = 0; k < s.inv.length; k++) s.inv[k] = Math.max(0, Math.floor(s.inv[k]));
    EQUIP.forEach(function (e) { s.equip[e.id] = clamp(Math.floor(s.equip[e.id]), 0, e.max); });
    s.tank.cap = statsFor(s.equip).tankCap;
    s.tank.water = clamp(s.tank.water, 0, s.tank.cap);
    s.clock.t = clamp(s.clock.t, 0, 0.999999);
    rebuildNet(s);
    s.events = [];
    return s;
  }

  // ---------------------------------------------------------------- queries
  function cellAt(state, x, y) {
    var c = Math.floor(x / C.TILE), r = Math.floor(y / C.TILE);
    if (!(c >= 0 && r >= 0 && c < state.cols && r < state.rows)) return null;
    return { c: c, r: r, i: r * state.cols + c };
  }

  function vehicleOn(state, c, r) {
    var t = state.truck, tr = state.trailer, h = C.TRUCK_LEN / 2;
    var pts = [[t.x, t.y], [t.x + Math.cos(t.a) * h, t.y + Math.sin(t.a) * h],
      [t.x - Math.cos(t.a) * h, t.y - Math.sin(t.a) * h], [tr.x, tr.y]];
    for (var k = 0; k < pts.length; k++) {
      if (Math.floor(pts[k][0] / C.TILE) === c && Math.floor(pts[k][1] / C.TILE) === r) return true;
    }
    return false;
  }

  function topLayer(state, i) {
    if (state.struct[i]) return 'struct';
    if (state.pipe[i]) return 'pipe';
    if (state.ground[i]) return 'ground';
    return '';
  }

  function canDo(state, action, c, r, arg) {
    var res = { ok: false, reason: '', cost: 0, refund: 0 };
    function no(why) { res.reason = why; return res; }
    if (!inGrid(state, c, r)) return no('bounds');
    var i = r * state.cols + c;
    var g = state.ground[i], s = state.struct[i];
    if (action === 'harvest') {
      if (g !== 2 || state.growth[i] < 1) return no('notReady');
      if (invTotal(state) >= invCap(state)) return no('full');
      res.ok = true; return res;
    }
    if (!state.owned[i]) return no('unowned');
    if (action === 'demolish') {
      var layer = arg || topLayer(state, i);
      if (layer === 'struct') { if (!s) return no('nothing'); res.refund = refundOf(state, KIND_BY_CODE[s]); }
      else if (layer === 'pipe') { if (!state.pipe[i]) return no('nothing'); res.refund = refundOf(state, 'pipe'); }
      else if (layer === 'ground') { if (!g) return no('nothing'); }
      else return no('nothing');
      res.ok = true; return res;
    }
    if (action === 'till') {
      res.cost = C.TILL_COST;
      if (s) return no('occupied');
      if (g !== 0) return no('notGrass');
    } else if (action === 'seed') {
      var T = SOD_TYPES[arg | 0];
      if (!T || (arg !== undefined && arg !== (arg | 0))) return no('kind');
      res.cost = T.seedCost;
      if (s) return no('occupied');
      if (g !== 1) return no('notDirt');
    } else {
      var b = BUILDINGS[action];
      if (!b || !BUILDINGS.hasOwnProperty(action)) return no('kind');
      res.cost = costOf(state, action);
      if (action === 'pipe') {
        if (state.pipe[i]) return no('occupied');
      } else {
        if (s) return no('occupied');
        if (g === 2) return no('plot');
        if (vehicleOn(state, c, r)) return no('vehicle');
      }
    }
    if (state.money < res.cost) return no('money');
    res.ok = true;
    return res;
  }

  function networkInfo(state) {
    return state.net.list.map(function (n) {
      return { id: n.id, pumps: n.pumps.length, tanks: n.tanks.length, sprinklers: n.sprinklers.length,
        fills: n.fills.length, pipes: n.pipes, inflow: n.inflow, demand: n.demand, supplied: n.supplied,
        stored: n.stored, capacity: n.cap };
    });
  }

  function landParcels(state) {
    var out = [], cost = costOf(state, 'land');
    for (var py = 0; py < C.PROWS; py++) for (var px = 0; px < C.PCOLS; px++) {
      var owned = parcelOwned(state, px, py);
      var adj = parcelOwned(state, px - 1, py) || parcelOwned(state, px + 1, py) ||
        parcelOwned(state, px, py - 1) || parcelOwned(state, px, py + 1);
      out.push({ id: py * C.PCOLS + px, px: px, py: py, c0: px * C.PARCEL, r0: py * C.PARCEL,
        c1: (px + 1) * C.PARCEL - 1, r1: (py + 1) * C.PARCEL - 1, cost: owned ? 0 : cost,
        owned: owned, buyable: !owned && adj });
    }
    return out;
  }

  // ---------------------------------------------------------------- actions
  function spend(state, n) { state.money -= n; state.stats.spent += n; }

  function till(state, c, r) {
    var q = canDo(state, 'till', c, r);
    if (!q.ok) return false;
    var i = r * state.cols + c;
    spend(state, q.cost);
    state.ground[i] = 1;
    cellEvent(state, 'tilled', i, { cost: q.cost });
    return true;
  }

  function seed(state, c, r, sodType) {
    if (sodType === undefined) sodType = 0;
    var q = canDo(state, 'seed', c, r, sodType);
    if (!q.ok) return false;
    var i = r * state.cols + c;
    spend(state, q.cost);
    state.ground[i] = 2; state.sodType[i] = sodType; state.growth[i] = 0; state.health[i] = 1;
    cellEvent(state, 'seeded', i, { sodType: sodType, cost: q.cost });
    return true;
  }

  function harvest(state, c, r) {
    var q = canDo(state, 'harvest', c, r);
    if (!q.ok) return false;
    var i = r * state.cols + c, t = state.sodType[i];
    state.inv[t] += 1;
    state.stats.harvested += 1;
    state.ground[i] = 1; state.sodType[i] = -1; state.growth[i] = 0; state.health[i] = 1;
    cellEvent(state, 'harvested', i, { sodType: t });
    return true;
  }

  function build(state, kind, c, r) {
    var q = canDo(state, kind, c, r);
    if (!q.ok || kind === 'till' || kind === 'seed' || kind === 'harvest' || kind === 'demolish') return false;
    var i = r * state.cols + c, b = BUILDINGS[kind];
    spend(state, q.cost);
    if (kind === 'pipe') state.pipe[i] = 1;
    else { state.struct[i] = b.code; state.tankW[i] = 0; }
    state.built[kind] += 1;
    rebuildNet(state);
    cellEvent(state, 'built', i, { kind: kind, cost: q.cost });
    return true;
  }

  function demolish(state, c, r, layer) {
    var q = canDo(state, 'demolish', c, r, layer);
    if (!q.ok) return false;
    var i = r * state.cols + c;
    layer = layer || topLayer(state, i);
    var kind;
    if (layer === 'struct') {
      kind = KIND_BY_CODE[state.struct[i]];
      state.struct[i] = 0; state.tankW[i] = 0;
    } else if (layer === 'pipe') {
      kind = 'pipe'; state.pipe[i] = 0;
    } else {
      kind = C.GROUND[state.ground[i]];
      state.ground[i] = 0; state.sodType[i] = -1; state.growth[i] = 0; state.health[i] = 1;
    }
    if (layer !== 'ground') {
      state.built[kind] = Math.max(0, state.built[kind] - 1);
      state.money += q.refund;
      rebuildNet(state);
    }
    cellEvent(state, 'demolished', i, { layer: layer, kind: kind, refund: q.refund });
    return true;
  }

  function buyLand(state, parcelId) {
    var p = landParcels(state)[parcelId];
    if (typeof parcelId !== 'number' || !p || !p.buyable || state.money < p.cost) return false;
    spend(state, p.cost);
    setParcelOwned(state, p.px, p.py);
    state.landBought += 1;
    push(state, { type: 'landBought', id: parcelId, cost: p.cost,
      x: (p.c0 + C.PARCEL / 2) * C.TILE, y: (p.r0 + C.PARCEL / 2) * C.TILE });
    return true;
  }

  function sellSod(state, n, sodType) {
    n = Math.floor(num(n, n === Infinity ? Infinity : 0));
    if (!(n >= 1)) return false;
    var sold = 0, amount = 0;
    for (var t = 0; t < SOD_TYPES.length && sold < n; t++) {
      if (sodType !== undefined && t !== sodType) continue;
      var k = Math.min(state.inv[t], n - sold);
      state.inv[t] -= k; sold += k; amount += k * SOD_TYPES[t].price;
    }
    if (!sold) return false;
    state.money += amount;
    state.stats.sold += sold; state.stats.earned += amount;
    push(state, { type: 'sold', n: sold, amount: amount });
    return true;
  }

  function equipCost(state, id) {
    var e = EQUIP_BY_ID[id];
    return e ? Math.round(e.base * Math.pow(e.growth, state.equip[id] || 0)) : Infinity;
  }

  function buyEquip(state, id) {
    var e = EQUIP_BY_ID[id];
    if (!e || !EQUIP_BY_ID.hasOwnProperty(id)) return false;
    var lvl = state.equip[id] || 0, cost = equipCost(state, id);
    if (lvl >= e.max || state.money < cost) return false;
    spend(state, cost);
    state.equip[id] = lvl + 1;
    var st = statsFor(state.equip);
    state.tank.cap = st.tankCap;
    state.spray.range = st.range; state.spray.radius = st.radius;
    push(state, { type: 'equipBought', id: id, level: lvl + 1, cost: cost });
    return true;
  }

  function equipInfo(state) {
    var cur = statsFor(state.equip);
    return EQUIP.map(function (e) {
      var l = state.equip[e.id] || 0, nx = {};
      for (var k in state.equip) nx[k] = state.equip[k];
      nx[e.id] = l + 1;
      var maxed = l >= e.max, cost = maxed ? 0 : equipCost(state, e.id);
      return { id: e.id, name: e.name, desc: e.desc, level: l, max: e.max, cost: cost, maxed: maxed,
        afford: !maxed && state.money >= cost, cur: cur, next: maxed ? null : statsFor(nx) };
    });
  }

  function setPaused(state, paused) {
    state.paused = !!paused;
    push(state, { type: paused ? 'pause' : 'resume' });
    return true;
  }

  // ---------------------------------------------------------------- truck & hose (ported)
  function normDriver(d) {
    d = d || {};
    return { throttle: clamp(num(d.throttle, 0), -1, 1), steer: clamp(num(d.steer, 0), -1, 1), brake: !!d.brake };
  }

  function blockedAt(state, x, y) {
    var c = Math.floor(x / C.TILE), r = Math.floor(y / C.TILE);
    return c >= 0 && r >= 0 && c < state.cols && r < state.rows && state.struct[r * state.cols + c] !== 0;
  }
  function truckBlocked(state) {
    var t = state.truck, h = (t.v >= 0 ? 1 : -1) * C.TRUCK_LEN / 2;
    return blockedAt(state, t.x, t.y) || blockedAt(state, t.x + Math.cos(t.a) * h, t.y + Math.sin(t.a) * h);
  }

  function driveTruck(state, d, st, dt) {
    var t = state.truck;
    var ox = t.x, oy = t.y, wasBlocked = truckBlocked(state);
    var fill = state.tank.cap > 0 ? state.tank.water / state.tank.cap : 0;
    var top = st.speed * (1 - 0.12 * fill), rev = top * 0.45, acc = st.accel, thr = d.throttle;
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
    if (!wasBlocked && truckBlocked(state)) { t.x = ox; t.y = oy; t.v = -t.v * 0.25; }
    var m = 36;
    if (t.x < m) { t.x = m; t.v *= 0.5; }
    if (t.y < m) { t.y = m; t.v *= 0.5; }
    if (t.x > C.WORLD_W - m) { t.x = C.WORLD_W - m; t.v *= 0.5; }
    if (t.y > C.WORLD_H - m) { t.y = C.WORLD_H - m; t.v *= 0.5; }
  }

  function updateAim(state, spr, st) {
    var sp = state.spray, nz = nozzlePos(state);
    sp.nozX = nz.x; sp.nozY = nz.y; sp.range = st.range; sp.radius = st.radius;
    var ax = num(spr && spr.aimX, sp.aimX), ay = num(spr && spr.aimY, sp.aimY);
    sp.aimX = ax; sp.aimY = ay;
    var dx = ax - nz.x, dy = ay - nz.y, d = Math.sqrt(dx * dx + dy * dy);
    if (d > st.range) { dx *= st.range / d; dy *= st.range / d; }
    sp.hitX = nz.x + dx; sp.hitY = nz.y + dy;
    sp.want = !!(spr && spr.spraying);
  }

  // spread `litres` over cells around (x,y) like the root game's waterAt, raising moisture
  function waterAt(state, x, y, R, litres) {
    if (!(litres > 0)) return;
    var T = C.TILE, eff = R + T * 0.5, cols = state.cols;
    var c0 = Math.floor((x - eff) / T), c1 = Math.floor((x + eff) / T);
    var r0 = Math.floor((y - eff) / T), r1 = Math.floor((y + eff) / T);
    var sum = 0, idx = [], ws = [];
    for (var r = r0; r <= r1; r++) for (var c = c0; c <= c1; c++) {
      var dx = (c + 0.5) * T - x, dy = (r + 0.5) * T - y;
      var w = 1 - Math.sqrt(dx * dx + dy * dy) / eff;
      if (w <= 0) continue;
      sum += w;
      if (c >= 0 && r >= 0 && c < cols && r < state.rows) { idx.push(r * cols + c); ws.push(w); }
    }
    if (sum <= 0) return;
    for (var k = 0; k < idx.length; k++) {
      var i = idx[k];
      state.moist[i] = Math.min(1, state.moist[i] + litres * ws[k] / sum / C.CELL_L);
    }
  }

  function sprayWater(state, st, dt) {
    var sp = state.spray, tank = state.tank;
    sp.on = false; sp.sputter = false;
    if (sp.sputterT > 0) sp.sputterT -= dt;
    if (!sp.want) return;
    var drain = st.flow * dt;
    if (tank.water > 0.0001) {
      var amt = Math.min(drain, tank.water);
      tank.water -= amt;
      if (tank.water < 0.0001) tank.water = 0;
      state.stats.hosed += amt;
      waterAt(state, sp.hitX, sp.hitY, st.radius, amt);
      sp.on = true;
    } else {
      sp.sputter = true;
      if (sp.sputterT <= 0) { sp.sputterT = 0.45; push(state, { type: 'sputter', x: sp.nozX, y: sp.nozY }); }
    }
  }

  // ---------------------------------------------------------------- main step
  function step(state, inputs, dt) {
    if (!(dt > 0)) dt = C.DT;
    if (state.paused) return state;
    inputs = inputs || {};
    advanceClock(state, dt);
    var st = statsFor(state.equip);
    state.tank.cap = st.tankCap;
    if (state.tank.water > state.tank.cap) state.tank.water = state.tank.cap;
    driveTruck(state, normDriver(inputs.driver), st, dt);
    updateTrailer(state);
    updateAim(state, inputs.sprayer, st);
    sprayWater(state, st, dt);
    farmTick(state, dt, true);
    return state;
  }

  function fastForward(state, seconds) {
    seconds = num(seconds, 0);
    if (!(seconds > 0)) return false;
    var t = state.truck;
    t.v = 0; t.throttle = 0;
    state.spray.on = false; state.spray.sputter = false; state.spray.want = false;
    state.tank.refilling = false;
    while (seconds > 1e-9) {
      var ch = Math.min(C.FF_CHUNK, seconds);
      farmTick(state, ch, false);
      advanceClock(state, ch);
      seconds -= ch;
    }
    return true;
  }

  SOD.BaseSim = {
    C: C, BUILDINGS: BUILDINGS, SOD_TYPES: SOD_TYPES, EQUIP: EQUIP,
    newGame: newGame, step: step, takeEvents: takeEvents, toSave: toSave, fromSave: fromSave,
    fastForward: fastForward,
    till: till, seed: seed, harvest: harvest, build: build, demolish: demolish, buyLand: buyLand,
    sellSod: sellSod, buyEquip: buyEquip, setPaused: setPaused,
    canDo: canDo, cellAt: cellAt, costOf: costOf, networkInfo: networkInfo, landParcels: landParcels,
    getStats: getStats, statsFor: statsFor, equipInfo: equipInfo, equipCost: equipCost,
    sprinklerCells: sprinklerCells,
    getNozzle: function (state) {
      var n = nozzlePos(state), st = statsFor(state.equip);
      n.range = st.range; n.radius = st.radius;
      return n;
    }
  };
})();
