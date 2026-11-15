/* Main: owns the state object, fixed-timestep loop, local camera, save/load and action routing.
 * For netplay, route the `actions` below (and input halves) through the network instead. */
(function () {
  'use strict';
  var SOD = window.SOD;
  var Sim = SOD.Sim;
  var STEP = Sim.C.DT;
  var SAVE_KEY = 'sodWatering.save.v1';

  var canvas = document.getElementById('game');
  var ctx = canvas.getContext('2d');
  var camera = { x: Sim.C.WORLD_W / 2, y: Sim.C.WORLD_H / 2, zoom: 1, w: 800, h: 600 };
  var dpr = 1;
  var state = null;
  var acc = 0, last = 0, frameEvents = [], lastPhase = null;

  function seed() { return ((Date.now() & 0x7fffffff) ^ Math.floor(Math.random() * 0x7fffffff)) >>> 0; }

  // ---------------------------------------------------------------- save
  function loadSave() {
    try {
      var raw = localStorage.getItem(SAVE_KEY);
      if (!raw) return null;
      var s = JSON.parse(raw);
      return s && typeof s.money === 'number' ? s : null;
    } catch (e) { return null; }
  }
  function writeSave() {
    try { localStorage.setItem(SAVE_KEY, JSON.stringify(Sim.toSave(state))); } catch (e) { /* ignore */ }
  }
  function clearSave() { try { localStorage.removeItem(SAVE_KEY); } catch (e) { /* ignore */ } }

  // ---------------------------------------------------------------- helpers
  function drain() { var e = Sim.takeEvents(state); for (var i = 0; i < e.length; i++) frameEvents.push(e[i]); }
  function blurFocus() { if (document.activeElement && document.activeElement.blur) document.activeElement.blur(); }
  function toMenu() {
    state = Sim.newGame(seed());
    SOD.UI.setMenuSave(loadSave());
  }

  // ---------------------------------------------------------------- actions
  var actions = {
    newGame: function () {
      if (loadSave() && !window.confirm('Start a new game? Your saved progress will be lost.')) return;
      clearSave();
      state = Sim.newGame(seed());
      Sim.startRound(state); drain();
      SOD.Input.clear(); blurFocus();
    },
    continueGame: function () {
      var s = loadSave();
      if (!s) return;
      state = Sim.fromSave(s, seed());
      blurFocus();
    },
    toShop: function () { Sim.openShop(state); drain(); writeSave(); blurFocus(); },
    buy: function (id) { if (Sim.buyUpgrade(state, id)) { drain(); writeSave(); } },
    startRound: function () {
      if (Sim.startRound(state)) { drain(); SOD.Input.clear(); blurFocus(); }
    },
    togglePause: function () {
      if (state.phase === 'playing') { Sim.setPaused(state, !state.paused); drain(); blurFocus(); }
    },
    resume: function () { if (state.paused) { Sim.setPaused(state, false); drain(); blurFocus(); } },
    quit: function () {
      if (state.phase === 'shop' || state.phase === 'roundEnd') writeSave();
      toMenu();
    },
    mute: function () {
      var m = SOD.Audio.toggleMute();
      SOD.UI.setMuted(m);
    }
  };
  SOD.actions = actions;

  // ---------------------------------------------------------------- view
  function resize() {
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    var w = window.innerWidth, h = window.innerHeight;
    canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr);
    camera.w = w; camera.h = h;
    camera.zoom = Math.max(0.45, Math.min(w / 1450, h / 860));
  }

  function updateCamera(dt) {
    var tx, ty;
    if (state.phase === 'menu') {
      tx = Sim.C.WORLD_W / 2 + Math.cos(performance.now() / 7000) * 380;
      ty = Sim.C.WORLD_H / 2 + Math.sin(performance.now() / 9000) * 220;
    } else {
      var t = state.truck, tr = state.trailer;
      var mx = (t.x * 0.6 + tr.x * 0.4), my = (t.y * 0.6 + tr.y * 0.4);
      tx = mx + Math.cos(t.a) * t.v * 0.35;
      ty = my + Math.sin(t.a) * t.v * 0.35;
      // bias toward the aim point a little so the sprayer sees where they're shooting
      tx = tx * 0.85 + state.spray.hitX * 0.15;
      ty = ty * 0.85 + state.spray.hitY * 0.15;
    }
    var k = 1 - Math.exp(-dt * (state.phase === 'menu' ? 1.5 : 4));
    camera.x += (tx - camera.x) * k;
    camera.y += (ty - camera.y) * k;
    var hw = camera.w / 2 / camera.zoom, hh = camera.h / 2 / camera.zoom;
    if (hw * 2 >= Sim.C.WORLD_W) camera.x = Sim.C.WORLD_W / 2;
    else camera.x = Math.max(hw, Math.min(Sim.C.WORLD_W - hw, camera.x));
    if (hh * 2 >= Sim.C.WORLD_H) camera.y = Sim.C.WORLD_H / 2;
    else camera.y = Math.max(hh, Math.min(Sim.C.WORLD_H - hh, camera.y));
  }

  // ---------------------------------------------------------------- loop
  function frame(now) {
    requestAnimationFrame(frame);
    var dt = last ? Math.min(0.1, (now - last) / 1000) : STEP;
    last = now;

    var inputs = { driver: SOD.Input.getDriver(), sprayer: SOD.Input.getSprayer(camera, state) };
    acc += dt;
    var n = 0;
    while (acc >= STEP && n < 6) {
      Sim.step(state, inputs, STEP);
      drain();
      acc -= STEP; n++;
    }
    if (n >= 6) acc = 0;

    if (state.phase !== lastPhase) {
      if (state.phase === 'roundEnd') writeSave();
      if (state.phase === 'menu') SOD.UI.setMenuSave(loadSave());
      lastPhase = state.phase;
    }

    updateCamera(dt);
    var evts = frameEvents; frameEvents = [];
    SOD.Render.onEvents(evts);
    SOD.Audio.onEvents(evts);
    SOD.Render.draw(ctx, state, { x: camera.x, y: camera.y, zoom: camera.zoom, w: camera.w, h: camera.h, dpr: dpr, dt: dt });
    SOD.Audio.update(state, dt);
    SOD.UI.update(state, dt, SOD.Input.getAimMode());
  }

  // ---------------------------------------------------------------- boot
  function boot() {
    resize();
    window.addEventListener('resize', resize);
    SOD.Input.init(canvas, {
      onPause: function () { actions.togglePause(); },
      onMute: function () { actions.mute(); },
      isGameplay: function () { return state && state.phase === 'playing'; }
    });
    SOD.UI.init({
      onNewGame: actions.newGame,
      onContinue: actions.continueGame,
      onToShop: actions.toShop,
      onBuy: actions.buy,
      onStartRound: actions.startRound,
      onResume: actions.resume,
      onQuit: actions.quit,
      onMute: actions.mute
    });
    SOD.UI.setMuted(SOD.Audio.isMuted());
    toMenu();
    window.addEventListener('blur', function () {
      if (state && state.phase === 'playing' && !state.paused) { Sim.setPaused(state, true); drain(); }
    });
    requestAnimationFrame(frame);
  }

  SOD.getState = function () { return state; };
  boot();
})();
