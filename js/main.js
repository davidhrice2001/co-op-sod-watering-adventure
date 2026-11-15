/* Main: owns the state object, fixed-timestep loop, save/load and action routing.
 * The 3D camera lives in SOD.Render.
 * Modes: 'local' (both players on this computer), 'host' (online, this machine runs the sim),
 * 'guest' (online, state comes from SOD.Net snapshots; actions become requests to the host). */
(function () {
  'use strict';
  var SOD = window.SOD;
  var Sim = SOD.Sim;
  var Net = SOD.Net;
  var STEP = Sim.C.DT;
  var SAVE_KEY = 'sodWatering3d.save.v1'; // separate from the classic 2D build's key

  var canvas = document.getElementById('game');
  var state = null;
  var mode = 'local';
  var acc = 0, last = 0, frameEvents = [], lastPhase = null;

  if (!SOD.Render || !SOD.Render.available()) {
    document.getElementById('no3d').classList.remove('hidden');
    document.getElementById('menu').classList.add('hidden');
    return;
  }

  function seed() { return ((Date.now() & 0x7fffffff) ^ Math.floor(Math.random() * 0x7fffffff)) >>> 0; }

  // ---------------------------------------------------------------- save (local + host only; a guest never saves)
  function loadSave() {
    try {
      var raw = localStorage.getItem(SAVE_KEY);
      if (!raw) return null;
      var s = JSON.parse(raw);
      return s && typeof s.money === 'number' ? s : null;
    } catch (e) { return null; }
  }
  function writeSave() {
    if (mode === 'guest') return;
    try { localStorage.setItem(SAVE_KEY, JSON.stringify(Sim.toSave(state))); } catch (e) { /* ignore */ }
  }
  function clearSave() { try { localStorage.removeItem(SAVE_KEY); } catch (e) { /* ignore */ } }

  // ---------------------------------------------------------------- helpers
  function drain() { var e = Sim.takeEvents(state); for (var i = 0; i < e.length; i++) frameEvents.push(e[i]); }
  function blurFocus() { if (document.activeElement && document.activeElement.blur) document.activeElement.blur(); }
  function toMenu() {
    mode = 'local';
    state = Sim.newGame(seed());
    SOD.UI.setMenuSave(loadSave());
  }
  function guest() { return mode === 'guest'; }
  // In-page two-click confirm (window.confirm is silently blocked in some embedded browsers).
  // First click relabels the button for 4s and returns false; a second click within that time returns true.
  var armTimers = {};
  function confirmClick(id, armLabel) {
    var b = document.getElementById(id);
    if (!b) return true;
    function disarm() { if (b.dataset.armed) { b.textContent = b.dataset.armed; delete b.dataset.armed; } }
    clearTimeout(armTimers[id]);
    if (b.dataset.armed) { disarm(); return true; }
    b.dataset.armed = b.textContent;
    b.textContent = armLabel;
    armTimers[id] = setTimeout(disarm, 4000);
    return false;
  }

  // ---------------------------------------------------------------- actions
  var actions = {
    newGame: function () {
      if (loadSave() && !confirmClick('btn-new', 'Erase save? Click again')) return;
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
    toShop: function () {
      if (guest()) { Net.request('toShop'); blurFocus(); return; }
      Sim.openShop(state); drain(); writeSave(); blurFocus();
    },
    buy: function (id) {
      if (guest()) { Net.request('buy', id); return; }
      if (Sim.buyUpgrade(state, id)) { drain(); writeSave(); }
    },
    startRound: function () {
      if (guest()) { Net.request('start'); SOD.Input.clear(); blurFocus(); return; }
      if (Sim.startRound(state)) { drain(); SOD.Input.clear(); blurFocus(); }
    },
    togglePause: function () {
      if (state.phase !== 'playing') return;
      if (guest()) { Net.request('pause'); blurFocus(); return; }
      Sim.setPaused(state, !state.paused); drain(); blurFocus();
    },
    resume: function () {
      if (!state.paused) return;
      if (guest()) { Net.request('resume'); blurFocus(); return; }
      Sim.setPaused(state, false); drain(); blurFocus();
    },
    quit: function () {
      if (mode !== 'guest' && (state.phase === 'shop' || state.phase === 'roundEnd')) writeSave();
      if (Net && Net.active()) Net.leave(false);
      toMenu();
    },
    mute: function () {
      var m = SOD.Audio.toggleMute();
      SOD.UI.setMuted(m);
    },
    toggleCamera: function () { SOD.Render.toggleCamera(); }
  };
  SOD.actions = actions;

  // Requests from the online guest, validated by the sim action functions.
  function hostAction(name, arg) {
    if (mode !== 'host') return;
    if (name === 'buy') { if (typeof arg === 'string') actions.buy(arg); }
    else if (name === 'start') { if (state.phase === 'shop') actions.startRound(); }
    else if (name === 'toShop') { if (state.phase === 'roundEnd') actions.toShop(); }
    else if (name === 'pause') actions.togglePause();
    else if (name === 'resume') actions.resume();
    else if (name === 'autopause') {
      if (state.phase === 'playing' && !state.paused) { Sim.setPaused(state, true); drain(); }
    }
  }

  // ---------------------------------------------------------------- view
  function resize() {
    SOD.Render.resize(window.innerWidth, window.innerHeight, window.devicePixelRatio || 1);
  }

  // ---------------------------------------------------------------- loop
  var fpsT = 0, fpsN = 0;
  // render=false: background tick while the tab is hidden (online only) - simulate/network, skip drawing.
  function update(now, render) {
    var dt = last ? Math.min(0.1, (now - last) / 1000) : STEP;
    if (dt < 0) dt = 0;
    last = now;
    if (render) {
      fpsT += dt; fpsN++;
      if (fpsT >= 1) { SOD.fps = fpsN / fpsT; fpsT = 0; fpsN = 0; }
    }
    if (Net) Net.tick(now);

    if (mode === 'guest') {
      var role = Net.myRole();
      var half = role === 'driver' ? SOD.Input.getDriver() : SOD.Input.getSprayer(SOD.Render.camInfo, state);
      Net.sendInput(half, now);
      var v = Net.guestView(now, role === 'sprayer' && Net.inGame() ? half : null);
      if (v) state = v;
      var ge = Net.takeEvents(now);
      for (var gi = 0; gi < ge.length; gi++) frameEvents.push(ge[gi]);
    } else {
      var inputs;
      if (mode === 'host') {
        var mine = Net.myRole(), rem = Net.remoteInput();
        if (mine === 'driver') {
          inputs = { driver: SOD.Input.getDriver(),
            sprayer: rem || { aimX: state.spray.aimX, aimY: state.spray.aimY, spraying: false } };
        } else {
          inputs = { driver: rem || { throttle: 0, steer: 0, brake: false },
            sprayer: SOD.Input.getSprayer(SOD.Render.camInfo, state) };
        }
      } else {
        inputs = { driver: SOD.Input.getDriver(), sprayer: SOD.Input.getSprayer(SOD.Render.camInfo, state) };
      }
      acc += dt;
      var n = 0;
      while (acc >= STEP && n < 6) {
        Sim.step(state, inputs, STEP);
        drain();
        acc -= STEP; n++;
      }
      if (n >= 6) acc = 0;
      if (mode === 'host') Net.hostSend(state, frameEvents, now);
    }

    if (state.phase !== lastPhase) {
      if (state.phase === 'roundEnd') writeSave();
      if (state.phase === 'menu') SOD.UI.setMenuSave(loadSave());
      lastPhase = state.phase;
    }

    var evts = frameEvents; frameEvents = [];
    if (!render) return;
    SOD.Render.onEvents(evts);
    SOD.Audio.onEvents(evts);
    SOD.Render.draw(state, { dt: dt });
    SOD.Audio.update(state, dt);
    SOD.UI.update(state, dt, SOD.Input.getAimMode(), SOD.Render.getCameraMode());
  }
  var lastRaf = 0;
  function frame(now) {
    requestAnimationFrame(frame);
    lastRaf = performance.now();
    update(now, true);
  }
  // Browsers stop/throttle requestAnimationFrame (and main-thread timers) in hidden/background tabs - some
  // even while reporting visibilityState 'visible'. While an online session is active, a worker-driven timer
  // keeps the host simulating/sending and the guest sending input whenever rAF has stalled.
  function bgTick() {
    if (!Net || !Net.active()) return;
    var now = performance.now();
    if (document.hidden || now - lastRaf > 150) update(now, false);
  }
  function startBgTicker() {
    try {
      var blob = new Blob(['setInterval(function(){postMessage(0);},25);'], { type: 'text/javascript' });
      var w = new Worker(URL.createObjectURL(blob));
      w.onmessage = bgTick;
    } catch (e) {
      setInterval(bgTick, 25);
    }
  }

  // ---------------------------------------------------------------- boot
  function boot() {
    SOD.Render.init(canvas);
    resize();
    window.addEventListener('resize', resize);
    SOD.Input.init(canvas, {
      onPause: function () { actions.togglePause(); },
      onMute: function () { actions.mute(); },
      onCamera: function () { actions.toggleCamera(); },
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
    if (Net) {
      Net.init({
        getState: function () { return state; },
        hostAction: hostAction,
        hasSave: function () { return !!loadSave(); },
        startGame: function (kind) {
          if (kind === 'continue') {
            var s = loadSave();
            if (!s) return false;
            state = Sim.fromSave(s, seed());
          } else {
            if (loadSave() && !confirmClick('net-new', 'Erase save? Click again')) return false;
            clearSave();
            state = Sim.newGame(seed());
            Sim.startRound(state); drain();
          }
          mode = 'host';
          acc = 0;
          SOD.Input.clear(); blurFocus();
          return true;
        },
        enterGuest: function () { mode = 'guest'; acc = 0; SOD.Input.clear(); blurFocus(); },
        goLocal: function () { mode = 'local'; SOD.Input.clear(); },
        quit: function () { actions.quit(); }
      });
    }
    toMenu();
    window.addEventListener('blur', function () {
      if (mode !== 'local' || (Net && Net.active())) return; // never auto-pause an online game
      if (state && state.phase === 'playing' && !state.paused) { Sim.setPaused(state, true); drain(); }
    });
    startBgTicker();
    requestAnimationFrame(frame);
  }

  SOD.getState = function () { return state; };
  SOD.getMode = function () { return mode; };
  boot();
})();
