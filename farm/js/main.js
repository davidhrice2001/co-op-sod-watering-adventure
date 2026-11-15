/* Home base main: owns the state, fixed-timestep loop, save/load, tools and action routing.
 * Renderer: SOD.BaseRender (three.js) when present and init() succeeds; otherwise (or with ?debug2d)
 * the small built-in 2D top-down view below, which implements the same interface.
 * Debug/test hook: SOD.FarmMain (getState, getView, setTool, renderer). */
(function () {
  'use strict';
  var SOD = window.SOD;
  var Sim = SOD.BaseSim, In = SOD.BaseInput, UI = SOD.BaseUI, Audio = SOD.Audio;
  var C = Sim.C, T = C.TILE, STEP = C.DT;
  var SAVE_KEY = 'sodFarm.save.v1';
  var AUTOSAVE = 30;

  // =============================================================== 2D fallback renderer
  var Flat = (function () {
    var cv, ctx, W = 1, H = 1, dpr = 1, cam = { x: 640, y: 640, z: 1.5 }, eff = { x: 640, y: 640, s: 1 };
    var floats = [], lastState = null;
    var STC = ['', '#d9452b', '#2b86e0', '#5fd0e8', '#1f6fb8', '#9a6a3a'], STL = ['', 'P', 'T', 'S', 'F', 'R'];
    function base() { return Math.min(W, H) / (C.WORLD_W + 40); }
    var api = {
      init: function (canvas) { cv = canvas; ctx = canvas.getContext('2d'); return !!ctx; },
      resize: function (w, h) {
        dpr = Math.min(2, window.devicePixelRatio || 1); W = w; H = h;
        cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr);
      },
      panBy: function (dx, dy) { cam.x += dx; cam.y += dy; },               // world units
      zoomBy: function (f) { cam.z = Math.max(0.6, Math.min(5, cam.z * f)); }, // f > 1 zooms in
      recenter: function () {
        var s = lastState, c0 = 99, c1 = -1, r0 = 99, r1 = -1;
        if (s) for (var i = 0; i < s.owned.length; i++) if (s.owned[i]) {
          var c = i % s.cols, r = (i - c) / s.cols;
          c0 = Math.min(c0, c); c1 = Math.max(c1, c); r0 = Math.min(r0, r); r1 = Math.max(r1, r);
        }
        if (c1 < 0) { c0 = r0 = 0; c1 = r1 = C.COLS - 1; }
        cam.x = (c0 + c1 + 1) / 2 * T; cam.y = (r0 + r1 + 1) / 2 * T;
        cam.z = Math.max(0.8, Math.min(2.2, (C.WORLD_W + 40) / ((Math.max(c1 - c0, r1 - r0) + 5) * T)));
      },
      onEvents: function (evts) {
        evts.forEach(function (e) {
          var txt = null, col = '#fff';
          if (e.type === 'built' || e.type === 'tilled' || e.type === 'seeded') { txt = '-$' + e.cost; col = '#ffd0c0'; }
          else if (e.type === 'demolished' && e.refund) { txt = '+$' + e.refund; col = '#ffd23a'; }
          else if (e.type === 'harvested') txt = '+1 roll';
          else if (e.type === 'plotDied') { txt = 'died!'; col = '#ff8a7a'; }
          else if (e.type === 'plotReady') { txt = 'ready'; col = '#ffd23a'; }
          if (txt && e.x != null) floats.push({ x: e.x, y: e.y, t: 0, txt: txt, col: col });
        });
        if (floats.length > 60) floats.splice(0, floats.length - 60);
      },
      camInfo: {
        screenToGround: function (sx, sy) { return { x: (sx - W / 2) / eff.s + eff.x, y: (sy - H / 2) / eff.s + eff.y }; },
        worldToScreen: function (x, y) { return { x: (x - eff.x) * eff.s + W / 2, y: (y - eff.y) * eff.s + H / 2, visible: true }; },
        forward: { x: 0, y: -1 }
      },
      draw: function (s, view) {
        lastState = s;
        var chase = view.cameraMode === 'chase';
        if (chase) { eff.x += (s.truck.x - eff.x) * 0.15; eff.y += (s.truck.y - eff.y) * 0.15; eff.s = base() * 2.6; }
        else { eff.x = cam.x; eff.y = cam.y; eff.s = base() * cam.z; }
        var k = eff.s;
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.fillStyle = '#35602a'; ctx.fillRect(0, 0, W, H);
        ctx.setTransform(dpr * k, 0, 0, dpr * k, dpr * (W / 2 - eff.x * k), dpr * (H / 2 - eff.y * k));
        var cols = s.cols, i, c, r, x, y;
        for (i = 0; i < s.ground.length; i++) {
          c = i % cols; r = (i - c) / cols; x = c * T; y = r * T;
          var g = s.ground[i], col;
          if (g === 2) {
            var gr = s.growth[i], hl = s.health[i];
            col = gr >= 1 ? '#d8c04a' : 'rgb(' + Math.round(140 - 80 * gr + 60 * (1 - hl)) + ',' + Math.round(100 + 90 * gr * hl) + ',' + Math.round(50 + 10 * gr) + ')';
          } else col = g === 1 ? '#8a5a32' : (s.owned[i] ? '#6aa84f' : '#4c7a37');
          ctx.fillStyle = col; ctx.fillRect(x, y, T, T);
          if (g && s.moist[i] > 0.01) { ctx.fillStyle = 'rgba(40,120,255,' + (s.moist[i] * 0.35).toFixed(3) + ')'; ctx.fillRect(x, y, T, T); }
          if (g === 2 && s.sodType[i] === 1) { ctx.fillStyle = 'rgba(30,60,140,.25)'; ctx.fillRect(x + 2, y + 2, 6, 6); }
        }
        ctx.strokeStyle = 'rgba(0,0,0,.12)'; ctx.lineWidth = 1 / k;
        ctx.beginPath();
        for (c = 0; c <= cols; c++) { ctx.moveTo(c * T, 0); ctx.lineTo(c * T, C.WORLD_H); }
        for (r = 0; r <= s.rows; r++) { ctx.moveTo(0, r * T); ctx.lineTo(C.WORLD_W, r * T); }
        ctx.stroke();
        // owned boundary
        ctx.strokeStyle = 'rgba(255,240,180,.6)'; ctx.lineWidth = 2.5 / k; ctx.beginPath();
        for (i = 0; i < s.owned.length; i++) {
          if (!s.owned[i]) continue;
          c = i % cols; r = (i - c) / cols; x = c * T; y = r * T;
          if (c === 0 || !s.owned[i - 1]) { ctx.moveTo(x, y); ctx.lineTo(x, y + T); }
          if (c === cols - 1 || !s.owned[i + 1]) { ctx.moveTo(x + T, y); ctx.lineTo(x + T, y + T); }
          if (r === 0 || !s.owned[i - cols]) { ctx.moveTo(x, y); ctx.lineTo(x + T, y); }
          if (r === s.rows - 1 || !s.owned[i + cols]) { ctx.moveTo(x, y + T); ctx.lineTo(x + T, y + T); }
        }
        ctx.stroke();
        // pipes
        ctx.strokeStyle = view.showPipes ? '#d0d6dc' : 'rgba(200,205,210,.55)'; ctx.lineWidth = view.showPipes ? 7 : 4;
        ctx.lineCap = 'round'; ctx.beginPath();
        for (i = 0; i < s.pipe.length; i++) {
          if (!s.pipe[i]) continue;
          c = i % cols; r = (i - c) / cols; x = (c + 0.5) * T; y = (r + 0.5) * T;
          ctx.moveTo(x, y); ctx.lineTo(x + 0.1, y);
          if (c < cols - 1 && (s.pipe[i + 1] || s.struct[i + 1])) { ctx.moveTo(x, y); ctx.lineTo(x + T, y); }
          if (r < s.rows - 1 && (s.pipe[i + cols] || s.struct[i + cols])) { ctx.moveTo(x, y); ctx.lineTo(x, y + T); }
          if (c > 0 && s.struct[i - 1] && !s.pipe[i - 1]) { ctx.moveTo(x, y); ctx.lineTo(x - T, y); }
          if (r > 0 && s.struct[i - cols] && !s.pipe[i - cols]) { ctx.moveTo(x, y); ctx.lineTo(x, y - T); }
        }
        ctx.stroke();
        // structures
        var on = {};
        s.net.list.forEach(function (n) { n.sprinklers.forEach(function (ci, q) { on[ci] = n.sprOn[q]; }); });
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.font = 'bold 18px system-ui';
        for (i = 0; i < s.struct.length; i++) {
          var sc = s.struct[i]; if (!sc) continue;
          c = i % cols; r = (i - c) / cols; x = (c + 0.5) * T; y = (r + 0.5) * T;
          if (sc === 4) { ctx.strokeStyle = 'rgba(80,170,255,.5)'; ctx.lineWidth = 2; ctx.setLineDash([8, 6]); ctx.beginPath(); ctx.arc(x, y, Sim.BUILDINGS.fill.radius, 0, 7); ctx.stroke(); ctx.setLineDash([]); }
          if (sc === 3 && on[i] > 0) { ctx.fillStyle = 'rgba(120,200,255,.25)'; ctx.fillRect(x - 1.5 * T, y - 1.5 * T, 3 * T, 3 * T); }
          ctx.fillStyle = STC[sc]; ctx.beginPath();
          if (sc === 2 || sc === 3) ctx.arc(x, y, sc === 3 ? 10 : 16, 0, 7); else ctx.rect(x - 15, y - 15, 30, 30);
          ctx.fill();
          if (sc === 2) { var lv = s.tankW[i] / Sim.BUILDINGS.tank.cap; ctx.fillStyle = 'rgba(255,255,255,.35)'; ctx.fillRect(x - 12, y + 12 - 24 * lv, 24, 24 * lv); }
          if (sc !== 5 && s.net.cell[i] < 0) { ctx.strokeStyle = '#ff4030'; ctx.lineWidth = 3; ctx.stroke(); }
          ctx.fillStyle = '#fff'; ctx.fillText(STL[sc], x, y + 1);
        }
        // trailer, truck, hose
        function box(o, len, wid, col) {
          ctx.save(); ctx.translate(o.x, o.y); ctx.rotate(o.a); ctx.fillStyle = col; ctx.fillRect(-len / 2, -wid / 2, len, wid);
          ctx.fillStyle = 'rgba(0,0,0,.25)'; ctx.fillRect(len / 2 - 14, -wid / 2, 14, wid); ctx.restore();
        }
        ctx.strokeStyle = '#333'; ctx.lineWidth = 3; ctx.beginPath(); ctx.moveTo(s.trailer.x, s.trailer.y); ctx.lineTo(s.truck.x, s.truck.y); ctx.stroke();
        var tk = s.tank;
        box(s.trailer, C.TRAILER_LEN, 30, tk.refilling ? '#7fd0ff' : '#c8ccd0');
        box(s.truck, C.TRUCK_LEN, C.TRUCK_W, '#e04a2b');
        var sp = s.spray;
        if (sp.on || sp.sputter) {
          ctx.strokeStyle = sp.on ? 'rgba(120,200,255,.9)' : 'rgba(120,200,255,.3)'; ctx.lineWidth = 4;
          ctx.beginPath(); ctx.moveTo(sp.nozX, sp.nozY); ctx.lineTo(sp.hitX, sp.hitY); ctx.stroke();
          if (sp.on) { ctx.fillStyle = 'rgba(120,200,255,.3)'; ctx.beginPath(); ctx.arc(sp.hitX, sp.hitY, sp.radius, 0, 7); ctx.fill(); }
        }
        if (view.localAim) {
          ctx.strokeStyle = 'rgba(255,255,255,.85)'; ctx.lineWidth = 2;
          ctx.beginPath(); ctx.arc(sp.hitX, sp.hitY, 9, 0, 7); ctx.stroke();
        }
        // hover
        var hv = view.hover;
        if (hv) {
          ctx.fillStyle = hv.ok ? 'rgba(140,255,120,.25)' : 'rgba(255,90,70,.25)';
          ctx.strokeStyle = hv.ok ? '#b9f59a' : '#ff6a4d'; ctx.lineWidth = 3;
          ctx.fillRect(hv.c * T, hv.r * T, (hv.w || 1) * T, (hv.h || 1) * T);
          ctx.strokeRect(hv.c * T, hv.r * T, (hv.w || 1) * T, (hv.h || 1) * T);
          if (hv.kind === 'sprinkler') { ctx.strokeStyle = 'rgba(120,200,255,.8)'; ctx.strokeRect((hv.c - 1) * T, (hv.r - 1) * T, 3 * T, 3 * T); }
        }
        // floating text
        ctx.font = 'bold 15px system-ui';
        for (i = floats.length - 1; i >= 0; i--) {
          var f = floats[i]; f.t += view.dt;
          if (f.t > 1.2) { floats.splice(i, 1); continue; }
          ctx.globalAlpha = 1 - f.t / 1.2; ctx.fillStyle = '#1f4a14'; ctx.fillText(f.txt, f.x + 1, f.y - f.t * 40 + 1);
          ctx.fillStyle = f.col; ctx.fillText(f.txt, f.x, f.y - f.t * 40); ctx.globalAlpha = 1;
        }
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.fillStyle = 'rgba(0,0,0,.45)'; ctx.font = '12px system-ui'; ctx.textAlign = 'left';
        ctx.fillText('2D debug view', 10, H - 10);
      }
    };
    return api;
  })();

  // =============================================================== state
  var canvas = document.getElementById('game');
  var R = null, rendererName = '2d';
  var state = null, phase = 'menu', acc = 0, last = 0, frameEvents = [];
  var tool = 'hose', seedType = 0, cameraMode = 'overview', pipesToggle = false;
  var hover = null, paint = null, saveT = 0, dirty = false, lastWrite = 0, lastView = null;
  var TOOL_BY_ID = {}, TOOL_BY_CODE = {};
  UI.TOOLS.forEach(function (t) {
    TOOL_BY_ID[t.id] = t; TOOL_BY_CODE[t.code] = t;
    if (/^Digit\d$/.test(t.code)) TOOL_BY_CODE['Numpad' + t.code.slice(5)] = t;
  });
  TOOL_BY_CODE.NumpadSubtract = TOOL_BY_ID.demolish; TOOL_BY_CODE.NumpadAdd = TOOL_BY_ID.land;

  function seed() { return ((Date.now() & 0x7fffffff) ^ Math.floor(Math.random() * 0x7fffffff)) >>> 0; }
  function loadSave() {
    try {
      var raw = localStorage.getItem(SAVE_KEY);
      if (!raw) return null;
      var s = JSON.parse(raw);
      return s && typeof s.money === 'number' && s.clock ? s : null;
    } catch (e) { return null; }
  }
  function writeSave() {
    if (!state) return;
    try { localStorage.setItem(SAVE_KEY, JSON.stringify(Sim.toSave(state))); } catch (e) { /* ignore */ }
    dirty = false; saveT = 0; lastWrite = performance.now();
  }
  function drain() { var e = Sim.takeEvents(state); for (var i = 0; i < e.length; i++) frameEvents.push(e[i]); }
  function playing() { return phase === 'playing' && state && !state.paused; }

  // =============================================================== tools
  function setTool(id) {
    if (!TOOL_BY_ID[id]) return;
    if (id === 'seed' && tool === 'seed') seedType = (seedType + 1) % Sim.SOD_TYPES.length;
    tool = id; paint = null;
  }

  function parcelAt(c, r) {
    var ps = Sim.landParcels(state);
    return ps[Math.floor(r / C.PARCEL) * C.PCOLS + Math.floor(c / C.PARCEL)];
  }

  // canDo for the current tool at (c, r), plus a label; land tool returns the parcel rect
  function query(c, r) {
    var t = TOOL_BY_ID[tool];
    if (!t.action) return null;
    var q;
    if (t.action === 'land') {
      var p = parcelAt(c, r);
      if (!p) return null;
      q = { ok: false, reason: '', cost: p.cost, refund: 0, c: p.c0, r: p.r0, w: C.PARCEL, h: C.PARCEL, parcel: p.id };
      if (p.owned) q.reason = 'owned';
      else if (!p.buyable) q.reason = 'notBuyable';
      else if (state.money < p.cost) q.reason = 'money';
      else q.ok = true;
      q.label = 'Buy parcel';
    } else {
      q = Sim.canDo(state, t.action, c, r, t.action === 'seed' ? seedType : undefined);
      q.c = c; q.r = r; q.w = 1; q.h = 1;
      if (t.action === 'demolish') {
        var i = r * state.cols + c;
        q.label = state.struct[i] ? 'Remove ' + Sim.BUILDINGS[C.STRUCTS[state.struct[i]]].name
          : state.pipe[i] ? 'Remove pipe' : state.ground[i] ? 'Clear ' + C.GROUND[state.ground[i]] : 'Demolish';
      } else if (t.action === 'seed') q.label = 'Plant ' + Sim.SOD_TYPES[seedType].name;
      else q.label = Sim.BUILDINGS[t.action] ? Sim.BUILDINGS[t.action].name : t.name;
    }
    q.kind = t.action;
    return q;
  }

  // perform the current tool at a cell. quiet: suppress failure feedback (drag painting)
  function apply(c, r, quiet) {
    var t = TOOL_BY_ID[tool];
    if (!t.action || !state) return false;
    var q = query(c, r);
    if (!q) return false;
    var ok = false;
    if (q.ok) {
      var a = t.action;
      if (a === 'land') ok = Sim.buyLand(state, q.parcel);
      else if (a === 'till') ok = Sim.till(state, c, r);
      else if (a === 'seed') ok = Sim.seed(state, c, r, seedType);
      else if (a === 'harvest') ok = Sim.harvest(state, c, r);
      else if (a === 'demolish') ok = Sim.demolish(state, c, r);
      else ok = Sim.build(state, a, c, r);
      drain();
    }
    if (!ok && (!quiet || ((q.reason === 'money' || q.reason === 'full') && paint && !paint.warned))) {
      if (paint) paint.warned = true;
      UI.toast(UI.reasonText(q.reason), q.reason === 'money' || q.reason === 'full' ? 'bad' : 'warn');
      Audio.fail();
    }
    if (ok) UI.refresh();
    return ok;
  }

  function cellUnderMouse() {
    var m = In.mouse;
    if (!m.inside || !R.camInfo) return null;
    var g = R.camInfo.screenToGround(m.x, m.y);
    return g ? Sim.cellAt(state, g.x, g.y) : null;
  }

  // 4-connected walk from a to b (exclusive of a), so dragged pipe runs never leave diagonal gaps
  function walk(a, b, fn) {
    var c = a.c, r = a.r, dc = b.c - c, dr = b.r - r, sc = Math.sign(dc), sr = Math.sign(dr);
    for (var k = Math.abs(dc) + Math.abs(dr); k > 0; k--) {
      var nc = c + sc, nr = r + sr;
      if (sc && (!sr || Math.abs((nc - a.c) * dr - (r - a.r) * dc) <= Math.abs((c - a.c) * dr - (nr - a.r) * dc))) c = nc; else r = nr;
      fn(c, r);
    }
  }

  function continuePaint() {
    if (!paint || !In.mouse.left) { paint = null; return; }
    var cell = cellUnderMouse();
    if (!cell || (cell.c === paint.c && cell.r === paint.r)) return;
    walk(paint, cell, function (c, r) { apply(c, r, true); });
    paint.c = cell.c; paint.r = cell.r;
  }

  // =============================================================== actions
  var actions = {
    newGame: function () {
      state = Sim.newGame(seed()); Sim.takeEvents(state);
      startPlay(); writeSave();
    },
    continueGame: function () {
      var s = loadSave();
      state = s ? Sim.fromSave(s) : Sim.newGame(seed());
      state.paused = false; Sim.takeEvents(state);
      startPlay();
    },
    togglePause: function () {
      if (phase !== 'playing') return;
      Sim.setPaused(state, !state.paused); drain();
      UI.showPause(state.paused);
      if (state.paused) { In.clear(); paint = null; } else acc = 0;
    },
    mute: function () { Audio.toggleMute(); UI.refresh(); },
    quit: function () {
      Sim.setPaused(state, false); Sim.takeEvents(state);
      writeSave();
      phase = 'menu'; UI.setScreen('menu'); UI.setMenuSave(loadSave());
    },
    toggleCamera: function () { cameraMode = cameraMode === 'overview' ? 'chase' : 'overview'; UI.refresh(); },
    sell: function (n) {
      if (!playing()) return;
      if (Sim.sellSod(state, n)) { drain(); dirty = true; UI.refresh(); } else { UI.toast('No sod to sell', 'warn'); Audio.fail(); }
    },
    buyEquip: function (id) {
      if (!playing()) return;
      if (Sim.buyEquip(state, id)) { drain(); UI.refresh(); } else { UI.toast(UI.reasonText('money'), 'bad'); Audio.fail(); }
    },
    toggleEquip: function () { UI.setEquipOpen(!UI.isEquipOpen()); }
  };

  function startPlay() {
    phase = 'playing'; acc = 0; tool = 'hose'; paint = null; saveT = 0; dirty = false;
    In.clear();
    UI.setScreen('game'); UI.showPause(false); UI.startHints(); UI.refresh();
    if (R.recenter) { lastView = buildView(0); R.draw(state, lastView); R.recenter(); }
  }

  function onKey(code, e) {
    if (code === 'Escape') {
      if (phase !== 'playing') return false;
      if (UI.isEquipOpen()) UI.setEquipOpen(false);
      else if (tool !== 'hose' && !state.paused) setTool('hose');
      else actions.togglePause();
      return true;
    }
    if (code === 'KeyP') { actions.togglePause(); return true; }
    if (code === 'KeyM') { actions.mute(); return true; }
    if (!playing()) return false;
    if (code === 'KeyC') { actions.toggleCamera(); return true; }
    if (code === 'KeyU') { actions.toggleEquip(); return true; }
    if (code === 'KeyX') { pipesToggle = !pipesToggle; return true; }
    if (code === 'Home') { if (R.recenter) R.recenter(); return true; }
    var t = TOOL_BY_CODE[code];
    if (t && !e.ctrlKey && !e.altKey) { setTool(t.id); return true; }
    return false;
  }

  function onMouseDown(btn) {
    if (!playing()) return;
    if (btn === 2) { setTool('hose'); return; }
    if (btn === 0 && tool !== 'hose') {
      var cell = cellUnderMouse();
      if (!cell) return;
      paint = TOOL_BY_ID[tool].paint ? { c: cell.c, r: cell.r, warned: false } : null;
      apply(cell.c, cell.r, false);
    }
  }
  // pan the overview camera by a screen-space drag (dx, dy px): converted to world units via the camera
  function panScreen(x, y, dx, dy) {
    if (!R.panBy || !R.camInfo) return;
    var a = R.camInfo.screenToGround(x - dx, y - dy), b = R.camInfo.screenToGround(x, y);
    if (a && b) R.panBy(a.x - b.x, a.y - b.y);
  }
  function onMouseMove(x, y, dx, dy) {
    if (In.mouse.middle && playing() && cameraMode === 'overview') panScreen(x, y, dx, dy);
  }
  function onWheel(dy) {
    if (playing() && cameraMode === 'overview' && R.zoomBy && dy) R.zoomBy(dy > 0 ? 1 / 1.12 : 1.12);
  }

  // =============================================================== frame
  function buildView(dt) {
    var t = TOOL_BY_ID[tool];
    var showPipes = pipesToggle || /^(pipe|pump|tank|sprinkler|fill|demolish)$/.test(tool);
    var hv = null;
    if (phase === 'playing' && t.action) {
      var cell = cellUnderMouse();
      hover = cell ? query(cell.c, cell.r) : null;
      if (hover) hv = { c: hover.c, r: hover.r, kind: hover.kind, ok: hover.ok, w: hover.w, h: hover.h,
        cost: hover.cost, reason: hover.reason, sodType: tool === 'seed' ? seedType : undefined };
    } else hover = null;
    var aim = phase === 'playing' && tool === 'hose' ? { x: state.spray.aimX, y: state.spray.aimY } : null;
    return { dt: dt, cameraMode: cameraMode, hover: hv, showPipes: showPipes, tool: tool, localAim: aim };
  }

  function update(dt) {
    var live = playing();
    if (live) {
      var inputs = { driver: In.getDriver(), sprayer: In.getSprayer(R.camInfo, state, tool === 'hose') };
      acc += dt;
      var n = 0;
      while (acc >= STEP && n < 15) { Sim.step(state, inputs, STEP); drain(); acc -= STEP; n++; }
      if (n >= 15) acc = 0;
      continuePaint();
      // Shift + screen edge pans the overview camera
      var m = In.mouse;
      if (cameraMode === 'overview' && R.panBy && m.inside && (In.isDown('ShiftLeft') || In.isDown('ShiftRight'))) {
        var e = 40, sp = 700 * dt, px = 0, py = 0;
        if (m.x < e) px = sp; else if (m.x > window.innerWidth - e) px = -sp;
        if (m.y < e) py = sp; else if (m.y > window.innerHeight - e) py = -sp;
        if (px || py) panScreen(window.innerWidth / 2, window.innerHeight / 2, px, py);
      }
      saveT += dt;
    }
    var evts = frameEvents; frameEvents = [];
    for (var i = 0; i < evts.length; i++) {
      var ty = evts[i].type;
      if (ty === 'built' || ty === 'demolished' || ty === 'landBought' || ty === 'equipBought' || ty === 'sold') dirty = true;
    }
    if (phase === 'playing' && ((dirty && performance.now() - lastWrite > 1500) || saveT >= AUTOSAVE)) writeSave();

    lastView = buildView(dt);
    if (evts.length) { R.onEvents(evts); Audio.onEvents(evts); UI.onEvents(evts); }
    R.draw(state, lastView);
    Audio.update(state, live);
    if (phase === 'playing') UI.update(state, { tool: tool, seedType: seedType, hover: hover, mouse: In.mouse, cameraMode: cameraMode, muted: Audio.isMuted() }, dt);
  }

  function frame(now) {
    requestAnimationFrame(frame);
    var dt = last ? Math.min(0.25, (now - last) / 1000) : 0;
    last = now;
    update(dt);
  }

  function resize() { R.resize(window.innerWidth, window.innerHeight); }

  // =============================================================== boot
  function pickRenderer() {
    var force2d = /[?&]debug2d\b/.test(location.search);
    if (!force2d && SOD.BaseRender && window.THREE) {
      try { if (SOD.BaseRender.init(canvas)) { R = SOD.BaseRender; rendererName = '3d'; return; } }
      catch (e) { console.warn('BaseRender init failed, using 2D view', e); }
      // the failed attempt may own a WebGL context: start the 2D view on a fresh canvas
      var fresh = document.createElement('canvas'); fresh.id = 'game';
      canvas.parentNode.replaceChild(fresh, canvas); canvas = fresh;
    }
    Flat.init(canvas); R = Flat; rendererName = '2d';
  }

  function boot() {
    pickRenderer();
    resize();
    window.addEventListener('resize', resize);
    In.init(canvas, {
      onKey: onKey, onMouseDown: onMouseDown, onMouseMove: onMouseMove, onWheel: onWheel,
      isGameplay: function () { return playing(); }
    });
    UI.init({
      onNewGame: actions.newGame, onContinue: actions.continueGame,
      onResume: actions.togglePause, onPause: actions.togglePause, onMute: actions.mute, onQuit: actions.quit,
      onTool: function (id) { if (playing()) setTool(id); },
      onSeedType: function (k) { seedType = k; tool = 'seed'; UI.refresh(); },
      onSell: actions.sell, onBuyEquip: actions.buyEquip, onToggleEquip: actions.toggleEquip
    });
    var save = loadSave();
    state = save ? Sim.fromSave(save) : Sim.newGame(seed());
    state.paused = false; Sim.takeEvents(state);
    UI.setMenuSave(save);
    UI.setScreen('menu');
    lastView = buildView(0);
    R.draw(state, lastView);
    if (R.recenter) R.recenter();
    window.addEventListener('beforeunload', function () { if (phase === 'playing') writeSave(); });
    document.addEventListener('visibilitychange', function () { if (document.hidden && phase === 'playing') writeSave(); });
    requestAnimationFrame(frame);
  }

  SOD.FarmMain = {
    getState: function () { return state; },
    getView: function () { return lastView; },
    setTool: setTool,
    renderer: function () { return rendererName; },
    camInfo: function () { return R.camInfo; },
    tick: function (sec) { update(sec || STEP); }
  };

  boot();
})();
