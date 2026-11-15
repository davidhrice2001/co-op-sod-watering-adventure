/* Input: produces the sim `inputs` object. Driver and sprayer halves are independently obtainable
 * so an online client can supply only its own half.
 *   SOD.Input.getDriver()                -> {throttle, steer, brake}
 *   SOD.Input.getSprayer(camera, state)  -> {aimX, aimY, spraying}  (aim in WORLD coords)
 *     camera = SOD.Render.camInfo = {screenToGround(sx, sy) -> {x,y}|null, forward: {x,y}}
 *       (mouse is raycast onto the ground; arrow keys move relative to camera forward)
 *     state is read-only, used to anchor keyboard/gamepad aim to the trailer nozzle.
 */
(function () {
  'use strict';
  var SOD = (window.SOD = window.SOD || {});

  var keys = {};
  var mouse = { x: 0, y: 0, down: false, seen: false };
  var aimMode = 'mouse';            // 'mouse' | 'keys' | 'pad'
  var offset = { x: 120, y: 80 };    // keyboard/pad aim offset from nozzle (world px)
  var lastAim = null;
  var lastT = 0;
  var opts = {};

  var SPRAY_KEYS = { ControlRight: 1, Enter: 1, NumpadEnter: 1, Numpad0: 1 };
  var AIM_KEYS = { ArrowUp: 1, ArrowDown: 1, ArrowLeft: 1, ArrowRight: 1 };
  var GAME_KEYS = { KeyW: 1, KeyA: 1, KeyS: 1, KeyD: 1, Space: 1 };

  function inGameplay() { return opts.isGameplay ? opts.isGameplay() : true; }

  function onKeyDown(e) {
    var code = e.code;
    if (code === 'Escape' || code === 'KeyP') { if (!e.repeat && opts.onPause) opts.onPause(); e.preventDefault(); return; }
    if (code === 'KeyM' && !e.repeat) { if (opts.onMute) opts.onMute(); }
    if (code === 'KeyC' && !e.repeat) { if (opts.onCamera) opts.onCamera(); }
    keys[code] = true;
    if (AIM_KEYS[code] || SPRAY_KEYS[code]) switchMode('keys');
    if (AIM_KEYS[code] || (inGameplay() && (GAME_KEYS[code] || SPRAY_KEYS[code]))) e.preventDefault();
  }
  function onKeyUp(e) { keys[e.code] = false; }

  function switchMode(m) {
    if (m === aimMode) return;
    if ((m === 'keys' || m === 'pad') && lastAim && lastAim.nx != null) {
      offset.x = lastAim.x - lastAim.nx;
      offset.y = lastAim.y - lastAim.ny;
    }
    aimMode = m;
  }

  function init(canvas, o) {
    opts = o || {};
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('blur', function () { keys = {}; mouse.down = false; });
    canvas.addEventListener('mousemove', function (e) {
      var dx = e.clientX - mouse.x, dy = e.clientY - mouse.y;
      mouse.x = e.clientX; mouse.y = e.clientY;
      if (!mouse.seen || dx * dx + dy * dy > 9) switchMode('mouse');
      mouse.seen = true;
    });
    canvas.addEventListener('mousedown', function (e) {
      if (e.button === 0) { mouse.down = true; mouse.x = e.clientX; mouse.y = e.clientY; mouse.seen = true; switchMode('mouse'); }
      e.preventDefault();
    });
    window.addEventListener('mouseup', function (e) { if (e.button === 0) mouse.down = false; });
    canvas.addEventListener('contextmenu', function (e) { e.preventDefault(); });
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
      if (Math.abs(pt) < 0.05) pt = -dz(p.axes[1] || 0) * (Math.abs(p.axes[1] || 0) > 0.5 ? 1 : 0);
      var ps = dz(p.axes[0] || 0);
      if (Math.abs(pt) > Math.abs(thr)) thr = pt;
      if (Math.abs(ps) > Math.abs(steer)) steer = ps;
      if (btn(p, 0) > 0.5 || btn(p, 1) > 0.5) brake = true;
    }
    return { throttle: Math.max(-1, Math.min(1, thr)), steer: Math.max(-1, Math.min(1, steer)), brake: brake };
  }

  function getSprayer(camera, state) {
    var now = (typeof performance !== 'undefined' ? performance.now() : Date.now()) / 1000;
    var dt = lastT ? Math.min(0.1, now - lastT) : 0;
    lastT = now;

    var noz = { x: 0, y: 0, range: 200 };
    if (state && SOD.Sim) noz = SOD.Sim.getNozzle(state);

    var spraying = mouse.down;
    var k;
    for (k in SPRAY_KEYS) if (keys[k]) spraying = true;

    // gamepads: pad[1] left stick aims (+RT/A sprays); else pad[0] right stick aims (+RB sprays)
    var ps = pads(), sx = 0, sy = 0;
    if (ps[1]) {
      sx = dz(ps[1].axes[0] || 0); sy = dz(ps[1].axes[1] || 0);
      if (btn(ps[1], 7) > 0.3 || btn(ps[1], 0) > 0.5 || btn(ps[1], 5) > 0.5) spraying = true;
    } else if (ps[0]) {
      sx = dz(ps[0].axes[2] || 0); sy = dz(ps[0].axes[3] || 0);
      if (btn(ps[0], 5) > 0.5) spraying = true;
    }
    if (sx || sy) switchMode('pad');

    var ax, ay;
    var g = (aimMode === 'mouse' && camera && camera.screenToGround) ? camera.screenToGround(mouse.x, mouse.y) : null;
    if (aimMode === 'mouse' && g) {
      ax = g.x; ay = g.y;
    } else if (aimMode === 'mouse') {
      // ray above the horizon: keep previous aim (relative to the nozzle)
      ax = lastAim ? noz.x + (lastAim.x - lastAim.nx) : noz.x + offset.x;
      ay = lastAim ? noz.y + (lastAim.y - lastAim.ny) : noz.y + offset.y;
    } else {
      if (aimMode === 'pad' && (sx || sy)) {
        var m = Math.min(1, Math.sqrt(sx * sx + sy * sy));
        var L = Math.sqrt(sx * sx + sy * sy) || 1;
        offset.x = sx / L * m * noz.range;
        offset.y = sy / L * m * noz.range;
      } else if (aimMode === 'keys') {
        // camera-relative: "up" = away from the camera. Offset is stored in world coords so it
        // stays put relative to the trailer while the camera rotates.
        var spd = 430 * dt;
        var fx = 0, fy = -1;
        if (camera && camera.forward) { fx = camera.forward.x; fy = camera.forward.y; }
        var rx = -fy, ry = fx;
        var u = (keys.ArrowUp ? 1 : 0) - (keys.ArrowDown ? 1 : 0);
        var rgt = (keys.ArrowRight ? 1 : 0) - (keys.ArrowLeft ? 1 : 0);
        offset.x += (fx * u + rx * rgt) * spd;
        offset.y += (fy * u + ry * rgt) * spd;
      }
      var d = Math.sqrt(offset.x * offset.x + offset.y * offset.y);
      if (d > noz.range) { offset.x *= noz.range / d; offset.y *= noz.range / d; }
      ax = noz.x + offset.x;
      ay = noz.y + offset.y;
    }
    lastAim = { x: ax, y: ay, nx: noz.x, ny: noz.y };
    return { aimX: ax, aimY: ay, spraying: !!spraying };
  }

  SOD.Input = {
    init: init,
    getDriver: getDriver,
    getSprayer: getSprayer,
    getInputs: function (camera, state) { return { driver: getDriver(), sprayer: getSprayer(camera, state) }; },
    getAimMode: function () { return aimMode; },
    clear: function () { keys = {}; mouse.down = false; }
  };
})();
