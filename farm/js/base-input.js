/* Home base input. Raw keyboard / mouse / gamepad state plus the two sim input halves.
 *   SOD.BaseInput.init(canvas, opts)   opts callbacks (all optional):
 *     onKey(code, e) -> true if handled (called on keydown, not for repeats)
 *     onMouseDown(button, x, y), onMouseUp(button, x, y), onMouseMove(x, y, dx, dy), onWheel(deltaY, x, y)
 *     isGameplay() -> bool (game keys only get preventDefault while playing)
 *   getDriver()                              -> {throttle, steer, brake}
 *   getSprayer(camInfo, state, mouseAims)    -> {aimX, aimY, spraying} (world coords)
 *     mouseAims = true while the Hose tool is selected: the mouse aims and left button sprays.
 *     Otherwise the stream keeps its last offset from the nozzle and only keys/pad spray.
 *   mouse = {x, y, left, middle, inside}, isDown(code)
 */
(function () {
  'use strict';
  var SOD = (window.SOD = window.SOD || {});

  var keys = {};
  var mouse = { x: 0, y: 0, left: false, middle: false, inside: false, leftOnCanvas: false };
  var aimMode = 'mouse';
  var offset = { x: -120, y: 40 };
  var lastAim = null, lastT = 0, opts = {};

  var SPRAY_KEYS = { ControlRight: 1, Enter: 1, NumpadEnter: 1, Numpad0: 1 };
  var AIM_KEYS = { ArrowUp: 1, ArrowDown: 1, ArrowLeft: 1, ArrowRight: 1 };
  var GAME_KEYS = { KeyW: 1, KeyA: 1, KeyS: 1, KeyD: 1, Space: 1, Home: 1, Tab: 1 };

  function inGameplay() { return opts.isGameplay ? opts.isGameplay() : true; }
  function typing(e) { var t = e.target; return t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA'); }

  function switchMode(m) {
    if (m === aimMode) return;
    if ((m === 'keys' || m === 'pad') && lastAim) { offset.x = lastAim.x - lastAim.nx; offset.y = lastAim.y - lastAim.ny; }
    aimMode = m;
  }

  function init(canvas, o) {
    opts = o || {};
    window.addEventListener('keydown', function (e) {
      if (typing(e)) return;
      var code = e.code;
      if (!e.repeat && opts.onKey && opts.onKey(code, e)) { e.preventDefault(); return; }
      keys[code] = true;
      if (AIM_KEYS[code] || SPRAY_KEYS[code]) switchMode('keys');
      if (inGameplay() && (AIM_KEYS[code] || GAME_KEYS[code] || SPRAY_KEYS[code])) e.preventDefault();
    });
    window.addEventListener('keyup', function (e) { keys[e.code] = false; });
    window.addEventListener('blur', function () { keys = {}; mouse.left = mouse.middle = false; });
    canvas.addEventListener('mousemove', function (e) {
      var dx = e.clientX - mouse.x, dy = e.clientY - mouse.y;
      mouse.x = e.clientX; mouse.y = e.clientY; mouse.inside = true;
      if (dx * dx + dy * dy > 9) switchMode('mouse');
      if (opts.onMouseMove) opts.onMouseMove(mouse.x, mouse.y, dx, dy);
    });
    // middle-drag continues outside the canvas (over HUD)
    window.addEventListener('mousemove', function (e) {
      if (e.target === canvas || !mouse.middle) return;
      var dx = e.clientX - mouse.x, dy = e.clientY - mouse.y;
      mouse.x = e.clientX; mouse.y = e.clientY;
      if (opts.onMouseMove) opts.onMouseMove(mouse.x, mouse.y, dx, dy);
    });
    canvas.addEventListener('mouseleave', function () { mouse.inside = false; });
    canvas.addEventListener('mouseenter', function () { mouse.inside = true; });
    canvas.addEventListener('mousedown', function (e) {
      mouse.x = e.clientX; mouse.y = e.clientY; mouse.inside = true;
      if (e.button === 0) { mouse.left = true; mouse.leftOnCanvas = true; switchMode('mouse'); }
      if (e.button === 1) mouse.middle = true;
      if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
      if (opts.onMouseDown) opts.onMouseDown(e.button, e.clientX, e.clientY);
      e.preventDefault();
    });
    window.addEventListener('mouseup', function (e) {
      if (e.button === 0) { mouse.left = false; mouse.leftOnCanvas = false; }
      if (e.button === 1) mouse.middle = false;
      if (opts.onMouseUp) opts.onMouseUp(e.button, e.clientX, e.clientY);
    });
    canvas.addEventListener('wheel', function (e) {
      e.preventDefault();
      if (opts.onWheel) opts.onWheel(e.deltaY, e.clientX, e.clientY);
    }, { passive: false });
    window.addEventListener('contextmenu', function (e) { e.preventDefault(); });
    // stop middle-click autoscroll
    window.addEventListener('auxclick', function (e) { if (e.button === 1) e.preventDefault(); });
  }

  function pads() {
    if (!navigator.getGamepads) return [];
    var list = navigator.getGamepads() || [], out = [];
    for (var i = 0; i < list.length; i++) if (list[i] && list[i].connected) out.push(list[i]);
    return out;
  }
  function dz(v) { return Math.abs(v) < 0.18 ? 0 : v; }
  function btn(p, i) { var b = p.buttons[i]; return b ? (typeof b === 'object' ? b.value : b) : 0; }

  function getDriver() {
    var thr = (keys.KeyW ? 1 : 0) - (keys.KeyS ? 1 : 0);
    var steer = (keys.KeyD ? 1 : 0) - (keys.KeyA ? 1 : 0);
    var brake = !!keys.Space;
    var p = pads()[0];
    if (p) {
      var pt = btn(p, 7) - btn(p, 6);
      if (Math.abs(pt) < 0.05) pt = Math.abs(p.axes[1] || 0) > 0.5 ? -dz(p.axes[1] || 0) : 0;
      var ps = dz(p.axes[0] || 0);
      if (Math.abs(pt) > Math.abs(thr)) thr = pt;
      if (Math.abs(ps) > Math.abs(steer)) steer = ps;
      if (btn(p, 0) > 0.5 || btn(p, 1) > 0.5) brake = true;
    }
    return { throttle: Math.max(-1, Math.min(1, thr)), steer: Math.max(-1, Math.min(1, steer)), brake: brake };
  }

  function getSprayer(camera, state, mouseAims) {
    var now = performance.now() / 1000;
    var dt = lastT ? Math.min(0.1, now - lastT) : 0;
    lastT = now;
    var noz = { x: 0, y: 0, range: 200 };
    if (state && SOD.BaseSim) noz = SOD.BaseSim.getNozzle(state);

    var spraying = !!(mouseAims && mouse.left && mouse.leftOnCanvas);
    for (var k in SPRAY_KEYS) if (keys[k]) spraying = true;

    var ps = pads(), sx = 0, sy = 0;
    if (ps[1]) {
      sx = dz(ps[1].axes[0] || 0); sy = dz(ps[1].axes[1] || 0);
      if (btn(ps[1], 7) > 0.3 || btn(ps[1], 0) > 0.5 || btn(ps[1], 5) > 0.5) spraying = true;
    } else if (ps[0]) {
      sx = dz(ps[0].axes[2] || 0); sy = dz(ps[0].axes[3] || 0);
      if (btn(ps[0], 5) > 0.5) spraying = true;
    }
    if (sx || sy) switchMode('pad');

    var ax, ay, g = null;
    if (aimMode === 'mouse' && mouseAims && camera && camera.screenToGround) g = camera.screenToGround(mouse.x, mouse.y);
    if (aimMode === 'mouse' && g) {
      ax = g.x; ay = g.y;
    } else if (aimMode === 'mouse') {
      ax = noz.x + (lastAim ? lastAim.x - lastAim.nx : offset.x);
      ay = noz.y + (lastAim ? lastAim.y - lastAim.ny : offset.y);
    } else {
      if (aimMode === 'pad' && (sx || sy)) {
        var L = Math.sqrt(sx * sx + sy * sy) || 1, m = Math.min(1, L);
        offset.x = sx / L * m * noz.range; offset.y = sy / L * m * noz.range;
      } else if (aimMode === 'keys') {
        var spd = 430 * dt, fx = 0, fy = -1;
        if (camera && camera.forward) { fx = camera.forward.x; fy = camera.forward.y; }
        var u = (keys.ArrowUp ? 1 : 0) - (keys.ArrowDown ? 1 : 0);
        var rg = (keys.ArrowRight ? 1 : 0) - (keys.ArrowLeft ? 1 : 0);
        offset.x += (fx * u - fy * rg) * spd;
        offset.y += (fy * u + fx * rg) * spd;
      }
      var d = Math.sqrt(offset.x * offset.x + offset.y * offset.y);
      if (d > noz.range) { offset.x *= noz.range / d; offset.y *= noz.range / d; }
      ax = noz.x + offset.x; ay = noz.y + offset.y;
    }
    lastAim = { x: ax, y: ay, nx: noz.x, ny: noz.y };
    return { aimX: ax, aimY: ay, spraying: spraying };
  }

  SOD.BaseInput = {
    init: init,
    getDriver: getDriver,
    getSprayer: getSprayer,
    mouse: mouse,
    isDown: function (code) { return !!keys[code]; },
    getAimMode: function () { return aimMode; },
    clear: function () { keys = {}; mouse.left = mouse.middle = mouse.leftOnCanvas = false; }
  };
})();
