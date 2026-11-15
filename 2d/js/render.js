/* Renderer: draws (state, view). Holds only transient, derived FX (particles, popups, tracks).
 * Never keeps references into state across frames.
 *   SOD.Render.onEvents(events)
 *   SOD.Render.draw(ctx, state, view)  view = {x, y, zoom, w, h, dpr, dt}
 */
(function () {
  'use strict';
  var SOD = (window.SOD = window.SOD || {});
  var C = null;
  var bg = null;
  var T = 0; // render clock

  var fx = {
    drops: [],     // stream droplets
    splash: [],    // splash droplets
    pops: [],      // money popups
    sparks: [],    // completion sparkles
    rings: [],     // ripple rings
    tracks: [],    // tire tracks
    banners: [],   // big centre text
    lastWheels: null,
    round: -1,
    shake: 0,
    spawnAcc: 0,
    dripAcc: 0
  };

  // ---------------------------------------------------------------- utils
  function lcg(seed) { var s = seed >>> 0; return function () { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; }; }
  function lerp(a, b, t) { return a + (b - a) * t; }
  function mix(c1, c2, t) { return [lerp(c1[0], c2[0], t), lerp(c1[1], c2[1], t), lerp(c1[2], c2[2], t)]; }
  function rgb(c, a) {
    return a == null ? 'rgb(' + (c[0] | 0) + ',' + (c[1] | 0) + ',' + (c[2] | 0) + ')'
      : 'rgba(' + (c[0] | 0) + ',' + (c[1] | 0) + ',' + (c[2] | 0) + ',' + a + ')';
  }
  function rr(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }
  function hash(n) { var x = Math.sin(n * 127.1 + 311.7) * 43758.5453; return x - Math.floor(x); }
  function fmtMoney(n) { return '$' + Math.round(n).toLocaleString('en-US'); }

  // ---------------------------------------------------------------- static background
  function buildBackground() {
    var c = document.createElement('canvas');
    c.width = C.WORLD_W; c.height = C.WORLD_H;
    var g = c.getContext('2d');
    var R = lcg(1234);
    // grass verge
    g.fillStyle = '#5f9a3e'; g.fillRect(0, 0, C.WORLD_W, C.WORLD_H);
    for (var i = 0; i < 2500; i++) {
      g.fillStyle = R() < 0.5 ? 'rgba(40,90,30,0.25)' : 'rgba(150,200,90,0.2)';
      g.fillRect(R() * C.WORLD_W, R() * C.WORLD_H, 3, 6);
    }
    // dirt road ring
    var m = C.TILE * 1.2;
    var rx = m, ry = m, rw = C.WORLD_W - m * 2, rh = C.WORLD_H - m * 2;
    g.fillStyle = '#c49a64'; rr(g, rx, ry, rw, rh, 60); g.fill();
    g.save(); rr(g, rx, ry, rw, rh, 60); g.clip();
    for (i = 0; i < 9000; i++) {
      var px = rx + R() * rw, py = ry + R() * rh, s = 1 + R() * 3;
      g.fillStyle = R() < 0.5 ? 'rgba(120,80,40,0.25)' : 'rgba(240,210,160,0.25)';
      g.fillRect(px, py, s, s);
    }
    for (i = 0; i < 400; i++) { // pebbles
      g.fillStyle = 'rgba(150,140,130,0.8)';
      g.beginPath(); g.arc(rx + R() * rw, ry + R() * rh, 1.5 + R() * 2, 0, 7); g.fill();
    }
    g.restore();
    g.strokeStyle = 'rgba(90,60,30,0.35)'; g.lineWidth = 4; rr(g, rx, ry, rw, rh, 60); g.stroke();
    // field soil + curb
    g.fillStyle = '#7a4f2c'; g.fillRect(C.FIELD_X - 8, C.FIELD_Y - 8, C.FIELD_W + 16, C.FIELD_H + 16);
    g.fillStyle = '#5b3a20'; g.fillRect(C.FIELD_X, C.FIELD_Y, C.FIELD_W, C.FIELD_H);
    g.strokeStyle = '#e8dcc0'; g.lineWidth = 3; g.setLineDash([14, 10]);
    g.strokeRect(C.FIELD_X - 14, C.FIELD_Y - 14, C.FIELD_W + 28, C.FIELD_H + 28);
    g.setLineDash([]);
    // trees / bushes on verge
    for (i = 0; i < 140; i++) {
      var side = Math.floor(R() * 4), tx, ty;
      var along = R();
      if (side === 0) { tx = along * C.WORLD_W; ty = R() * m * 0.7; }
      else if (side === 1) { tx = along * C.WORLD_W; ty = C.WORLD_H - R() * m * 0.7; }
      else if (side === 2) { tx = R() * m * 0.7; ty = along * C.WORLD_H; }
      else { tx = C.WORLD_W - R() * m * 0.7; ty = along * C.WORLD_H; }
      var tr = 12 + R() * 16;
      g.fillStyle = 'rgba(0,0,0,0.18)'; g.beginPath(); g.arc(tx + 6, ty + 7, tr, 0, 7); g.fill();
      g.fillStyle = R() < 0.5 ? '#3f7a2c' : '#4a8a33'; g.beginPath(); g.arc(tx, ty, tr, 0, 7); g.fill();
      g.fillStyle = 'rgba(160,220,110,0.35)'; g.beginPath(); g.arc(tx - tr * 0.3, ty - tr * 0.3, tr * 0.45, 0, 7); g.fill();
    }
    bg = c;
  }

  // ---------------------------------------------------------------- events -> fx
  function onEvents(evts) {
    if (!evts) return;
    for (var i = 0; i < evts.length; i++) {
      var e = evts[i];
      if (e.type === 'pay') {
        fx.pops.push({ x: e.x, y: e.y, text: '+' + fmtMoney(e.amount), bonus: e.bonus, combo: e.combo, t: 0, life: e.bonus ? 1.6 : 1.1 });
        var nS = e.bonus ? 10 : 4;
        for (var k = 0; k < nS; k++) {
          fx.sparks.push({ x: e.x + (Math.random() - 0.5) * C.TILE, y: e.y + (Math.random() - 0.5) * C.TILE,
            t: -Math.random() * 0.3, life: 0.7 + Math.random() * 0.4, gold: e.bonus, s: 3 + Math.random() * 4 });
        }
        if (e.bonus) fx.shake = Math.max(fx.shake, 4);
        if (fx.pops.length > 60) fx.pops.shift();
      } else if (e.type === 'roundStart') {
        fx.tracks = []; fx.drops = []; fx.splash = []; fx.pops = []; fx.sparks = []; fx.lastWheels = null;
      } else if (e.type === 'go') {
        fx.banners.push({ text: 'GO!', t: 0, life: 0.9, color: '#ffe066' });
      } else if (e.type === 'clear') {
        fx.banners.push({ text: 'FIELD CLEARED!', t: 0, life: 2.2, color: '#9ff06a' });
        fx.shake = 8;
      } else if (e.type === 'comboEnd') {
        fx.banners.push({ text: e.count + 'x COMBO!', t: 0, life: 1.0, color: '#ffb347', small: true });
      } else if (e.type === 'refillFull') {
        fx.banners.push({ text: 'TANK FULL', t: 0, life: 0.9, color: '#8fd3ff', small: true });
      } else if (e.type === 'sputter') {
        for (var s = 0; s < 4; s++) fx.splash.push({ x: e.x, y: e.y, vx: (Math.random() - 0.5) * 60, vy: (Math.random() - 0.5) * 60, z: 6, vz: 60, t: 0, life: 0.4 });
      }
    }
  }

  // ---------------------------------------------------------------- fx update
  function updateFx(state, dt) {
    var sp = state.spray;
    var playing = state.phase === 'playing' && !state.paused;
    var i;
    if (state.round !== fx.round) { fx.round = state.round; fx.tracks = []; fx.lastWheels = null; }

    // spawn stream droplets
    if (playing && sp.on && dt > 0) {
      fx.spawnAcc += dt * 70 * sp.hits.length;
      while (fx.spawnAcc >= 1) {
        fx.spawnAcc -= 1;
        var h = sp.hits[Math.floor(Math.random() * sp.hits.length)];
        var ang = Math.random() * Math.PI * 2, rad = Math.sqrt(Math.random()) * sp.radius * 0.7;
        var ex = h.x + Math.cos(ang) * rad, ey = h.y + Math.sin(ang) * rad;
        var dx = ex - sp.nozX, dy = ey - sp.nozY, d = Math.sqrt(dx * dx + dy * dy);
        fx.drops.push({ sx: sp.nozX, sy: sp.nozY, ex: ex, ey: ey, t: 0, dur: 0.22 + d / 850, h: 10 + d * 0.28, r: 2.5 + Math.random() * 2 });
      }
    } else fx.spawnAcc = 0;

    // drip
    if (playing && sp.drip && dt > 0) {
      fx.dripAcc += dt * 25;
      while (fx.dripAcc >= 1) {
        fx.dripAcc -= 1;
        fx.splash.push({ x: state.trailer.x + (Math.random() - 0.5) * 30, y: state.trailer.y + (Math.random() - 0.5) * 30, vx: 0, vy: 0, z: 8, vz: 0, t: 0, life: 0.35 });
      }
    }

    for (i = fx.drops.length - 1; i >= 0; i--) {
      var p = fx.drops[i];
      p.t += dt / p.dur;
      if (p.t >= 1) {
        if (Math.random() < 0.35) {
          var a = Math.random() * Math.PI * 2, v = 30 + Math.random() * 70;
          fx.splash.push({ x: p.ex, y: p.ey, vx: Math.cos(a) * v, vy: Math.sin(a) * v, z: 0, vz: 80 + Math.random() * 80, t: 0, life: 0.5 });
        }
        if (Math.random() < 0.06) fx.rings.push({ x: p.ex, y: p.ey, t: 0, life: 0.6 });
        fx.drops.splice(i, 1);
      }
    }
    for (i = fx.splash.length - 1; i >= 0; i--) {
      var s = fx.splash[i];
      s.t += dt; s.x += s.vx * dt; s.y += s.vy * dt; s.vz -= 400 * dt; s.z = Math.max(0, s.z + s.vz * dt);
      if (s.t > s.life) fx.splash.splice(i, 1);
    }
    for (i = fx.rings.length - 1; i >= 0; i--) { fx.rings[i].t += dt; if (fx.rings[i].t > fx.rings[i].life) fx.rings.splice(i, 1); }
    for (i = fx.pops.length - 1; i >= 0; i--) { fx.pops[i].t += dt; if (fx.pops[i].t > fx.pops[i].life) fx.pops.splice(i, 1); }
    for (i = fx.sparks.length - 1; i >= 0; i--) { fx.sparks[i].t += dt; if (fx.sparks[i].t > fx.sparks[i].life) fx.sparks.splice(i, 1); }
    for (i = fx.banners.length - 1; i >= 0; i--) { fx.banners[i].t += dt; if (fx.banners[i].t > fx.banners[i].life) fx.banners.splice(i, 1); }
    if (fx.drops.length > 900) fx.drops.splice(0, fx.drops.length - 900);
    if (fx.splash.length > 600) fx.splash.splice(0, fx.splash.length - 600);

    // tire tracks
    var t = state.truck, tr = state.trailer;
    var wheels = wheelPoints(t, tr);
    if (fx.lastWheels) {
      var ddx = wheels[0].x - fx.lastWheels[0].x, ddy = wheels[0].y - fx.lastWheels[0].y;
      var dd = ddx * ddx + ddy * ddy;
      if (dd > 200 * 200) fx.lastWheels = null;
      else if (dd > 36) {
        for (var w = 0; w < wheels.length; w++) {
          fx.tracks.push({ x1: fx.lastWheels[w].x, y1: fx.lastWheels[w].y, x2: wheels[w].x, y2: wheels[w].y, age: 0 });
        }
        fx.lastWheels = wheels;
      }
    }
    if (!fx.lastWheels) fx.lastWheels = wheels;
    for (i = 0; i < fx.tracks.length; i++) fx.tracks[i].age += dt;
    while (fx.tracks.length && (fx.tracks[0].age > 14 || fx.tracks.length > 2400)) fx.tracks.shift();
    fx.shake = Math.max(0, fx.shake - dt * 20);
  }

  function wheelPoints(t, tr) {
    var ca = Math.cos(t.a), sa = Math.sin(t.a), cb = Math.cos(tr.a), sb = Math.sin(tr.a);
    return [
      { x: t.x - ca * 22 - sa * 17, y: t.y - sa * 22 + ca * 17 },
      { x: t.x - ca * 22 + sa * 17, y: t.y - sa * 22 - ca * 17 },
      { x: tr.x - sb * 22, y: tr.y + cb * 22 },
      { x: tr.x + sb * 22, y: tr.y - cb * 22 }
    ];
  }

  // ---------------------------------------------------------------- draw pieces
  var PARCHED_HI = [196, 128, 58], PARCHED_LO = [206, 204, 128], WET = [112, 156, 66];
  var LUSH_A = [72, 168, 62], LUSH_B = [86, 184, 72], GOLD = [255, 205, 40];

  function drawField(ctx, state, vx0, vy0, vx1, vy1) {
    var f = state.field;
    if (!f) return;
    var Tt = f.tile;
    var c0 = Math.max(0, Math.floor((vx0 - f.x) / Tt)), c1 = Math.min(f.cols - 1, Math.floor((vx1 - f.x) / Tt));
    var r0 = Math.max(0, Math.floor((vy0 - f.y) / Tt)), r1 = Math.min(f.rows - 1, Math.floor((vy1 - f.y) / Tt));
    var glintSlot = Math.floor(T * 3);
    for (var r = r0; r <= r1; r++) {
      for (var c = c0; c <= c1; c++) {
        var i = r * f.cols + c;
        var x = f.x + c * Tt, y = f.y + r * Tt;
        var col, frac = 0;
        var bonus = f.bonus[i] === 1;
        if (f.done[i]) {
          col = (r % 2 === 0) ? LUSH_A : LUSH_B;
          if (bonus) col = mix(col, GOLD, 0.25);
        } else {
          frac = Math.min(1, f.water[i] / f.need[i]);
          var parched = mix(PARCHED_LO, PARCHED_HI, f.dry[i]);
          if (bonus) parched = GOLD;
          col = mix(parched, WET, Math.pow(frac, 0.8) * 0.85);
        }
        ctx.fillStyle = rgb(col);
        ctx.fillRect(x + 1, y + 1, Tt - 2, Tt - 2);
        if (f.done[i]) {
          // mowed stripe + glint
          ctx.fillStyle = 'rgba(255,255,255,0.06)';
          ctx.fillRect(x + 1, y + 1, Tt - 2, (Tt - 2) * 0.45);
          if (hash(i * 7.3 + glintSlot) < 0.025) {
            var gx = x + 8 + hash(i + glintSlot) * (Tt - 16), gy = y + 8 + hash(i * 3 + glintSlot) * (Tt - 16);
            drawStar(ctx, gx, gy, 3.5, 'rgba(255,255,255,0.85)');
          }
          if (bonus) { ctx.strokeStyle = 'rgba(255,220,90,0.8)'; ctx.lineWidth = 2; ctx.strokeRect(x + 3, y + 3, Tt - 6, Tt - 6); }
        } else {
          // dryness cracks on very parched tiles
          if (f.dry[i] > 0.72 && frac < 0.5) {
            ctx.strokeStyle = 'rgba(120,80,30,' + (0.35 * (1 - frac * 2)).toFixed(2) + ')';
            ctx.lineWidth = 1.2;
            ctx.beginPath();
            var h1 = hash(i), h2 = hash(i + 5);
            ctx.moveTo(x + 6 + h1 * 10, y + 6); ctx.lineTo(x + 18, y + 18 + h2 * 6); ctx.lineTo(x + Tt - 8, y + 12 + h1 * 14);
            ctx.moveTo(x + 18, y + 18 + h2 * 6); ctx.lineTo(x + 12 + h2 * 8, y + Tt - 6);
            ctx.stroke();
          }
          if (bonus) {
            var sh = (Math.sin(T * 3 + c * 0.5 + r * 0.5) + 1) * 0.5;
            ctx.fillStyle = 'rgba(255,250,200,' + (0.1 + sh * 0.3).toFixed(2) + ')';
            ctx.fillRect(x + 1, y + 1, Tt - 2, Tt - 2);
            ctx.strokeStyle = 'rgba(255,240,150,0.95)'; ctx.lineWidth = 2;
            ctx.strokeRect(x + 3, y + 3, Tt - 6, Tt - 6);
            drawStar(ctx, x + Tt / 2, y + Tt / 2, 7 + sh * 2, 'rgba(255,255,255,0.9)');
          }
          if (frac > 0.02) {
            ctx.fillStyle = 'rgba(20,40,60,0.25)';
            ctx.fillRect(x + 5, y + Tt - 8, Tt - 10, 4);
            ctx.fillStyle = 'rgba(140,220,255,0.95)';
            ctx.fillRect(x + 5, y + Tt - 8, (Tt - 10) * frac, 4);
          }
        }
      }
    }
  }

  function drawStar(ctx, x, y, s, color) {
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.moveTo(x, y - s); ctx.lineTo(x + s * 0.25, y - s * 0.25); ctx.lineTo(x + s, y);
    ctx.lineTo(x + s * 0.25, y + s * 0.25); ctx.lineTo(x, y + s); ctx.lineTo(x - s * 0.25, y + s * 0.25);
    ctx.lineTo(x - s, y); ctx.lineTo(x - s * 0.25, y - s * 0.25); ctx.closePath(); ctx.fill();
  }

  function drawTracks(ctx) {
    ctx.lineCap = 'round';
    ctx.lineWidth = 6;
    for (var i = 0; i < fx.tracks.length; i++) {
      var k = fx.tracks[i];
      var a = 0.22 * (1 - k.age / 14);
      if (a <= 0) continue;
      ctx.strokeStyle = 'rgba(50,30,15,' + a.toFixed(3) + ')';
      ctx.beginPath(); ctx.moveTo(k.x1, k.y1); ctx.lineTo(k.x2, k.y2); ctx.stroke();
    }
  }

  function drawStations(ctx, state) {
    var tank = state.tank;
    for (var i = 0; i < state.stations.length; i++) {
      var s = state.stations[i];
      var dx = s.x - state.trailer.x, dy = s.y - state.trailer.y;
      var inRange = dx * dx + dy * dy < s.r * s.r;
      // pad
      ctx.save();
      ctx.fillStyle = inRange ? 'rgba(90,180,255,0.22)' : 'rgba(90,180,255,0.1)';
      ctx.beginPath(); ctx.arc(s.x, s.y, s.r, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = 'rgba(60,150,240,' + (inRange ? 0.9 : 0.5) + ')';
      ctx.lineWidth = 3; ctx.setLineDash([12, 9]); ctx.lineDashOffset = -T * 20;
      ctx.beginPath(); ctx.arc(s.x, s.y, s.r, 0, Math.PI * 2); ctx.stroke();
      ctx.setLineDash([]);
      if (tank.refilling && inRange) {
        var pr = (T * 1.5) % 1;
        ctx.strokeStyle = 'rgba(140,210,255,' + (1 - pr).toFixed(2) + ')';
        ctx.beginPath(); ctx.arc(s.x, s.y, 20 + pr * (s.r - 20), 0, Math.PI * 2); ctx.stroke();
        // fill hose
        ctx.strokeStyle = '#2b6cb0'; ctx.lineWidth = 5;
        ctx.beginPath(); ctx.moveTo(s.x, s.y);
        ctx.quadraticCurveTo((s.x + state.trailer.x) / 2, (s.y + state.trailer.y) / 2 + 30, state.trailer.x, state.trailer.y);
        ctx.stroke();
      }
      ctx.restore();
      // object
      if (s.type === 'hydrant') {
        ctx.fillStyle = 'rgba(0,0,0,0.25)'; ctx.beginPath(); ctx.arc(s.x + 4, s.y + 5, 15, 0, 7); ctx.fill();
        ctx.fillStyle = '#d62f2f'; ctx.beginPath(); ctx.arc(s.x, s.y, 14, 0, 7); ctx.fill();
        ctx.fillStyle = '#b01f1f'; ctx.fillRect(s.x - 20, s.y - 5, 40, 10);
        ctx.fillStyle = '#f04b4b'; ctx.beginPath(); ctx.arc(s.x, s.y, 9, 0, 7); ctx.fill();
        ctx.fillStyle = '#ffd34d'; ctx.beginPath(); ctx.arc(s.x, s.y, 4, 0, 7); ctx.fill();
      } else {
        // water well / tower pad
        ctx.fillStyle = 'rgba(0,0,0,0.25)'; ctx.beginPath(); ctx.arc(s.x + 5, s.y + 6, 24, 0, 7); ctx.fill();
        ctx.fillStyle = '#8a8f98'; ctx.beginPath(); ctx.arc(s.x, s.y, 23, 0, 7); ctx.fill();
        ctx.fillStyle = '#3d8fe0'; ctx.beginPath(); ctx.arc(s.x, s.y, 17, 0, 7); ctx.fill();
        ctx.fillStyle = 'rgba(255,255,255,0.5)';
        ctx.beginPath(); ctx.arc(s.x - 5, s.y - 5, 5 + Math.sin(T * 3) * 1.5, 0, 7); ctx.fill();
        ctx.strokeStyle = '#6b4a2b'; ctx.lineWidth = 4;
        ctx.beginPath(); ctx.moveTo(s.x - 26, s.y - 26); ctx.lineTo(s.x + 26, s.y - 26); ctx.stroke();
      }
      ctx.fillStyle = 'rgba(255,255,255,0.9)'; ctx.font = 'bold 13px system-ui, sans-serif'; ctx.textAlign = 'center';
      ctx.fillText('REFILL', s.x, s.y + s.r + 16);
    }
  }

  function drawTrailer(ctx, state) {
    var tr = state.trailer, t = state.truck, tank = state.tank;
    var hx = t.x - Math.cos(t.a) * C.HITCH, hy = t.y - Math.sin(t.a) * C.HITCH;
    // tongue
    ctx.strokeStyle = '#3b3f45'; ctx.lineWidth = 6; ctx.lineCap = 'round';
    var fx0 = tr.x + Math.cos(tr.a) * 26, fy0 = tr.y + Math.sin(tr.a) * 26;
    ctx.beginPath(); ctx.moveTo(fx0, fy0); ctx.lineTo(hx, hy); ctx.stroke();
    ctx.fillStyle = '#222'; ctx.beginPath(); ctx.arc(hx, hy, 4, 0, 7); ctx.fill();

    ctx.save();
    ctx.translate(tr.x, tr.y); ctx.rotate(tr.a);
    ctx.fillStyle = 'rgba(0,0,0,0.25)'; rr(ctx, -30 + 5, -21 + 6, 58, 42, 6); ctx.fill();
    // wheels
    ctx.fillStyle = '#1d1d1f';
    rr(ctx, -9, -26, 18, 8, 3); ctx.fill(); rr(ctx, -9, 18, 18, 8, 3); ctx.fill();
    // frame
    ctx.fillStyle = '#4a5058'; rr(ctx, -30, -20, 58, 40, 5); ctx.fill();
    // tank (poly tank, top view) with water window
    ctx.fillStyle = '#e9eef2'; rr(ctx, -28, -16, 44, 32, 13); ctx.fill();
    ctx.fillStyle = 'rgba(0,0,0,0.08)'; rr(ctx, -28, 4, 44, 12, 6); ctx.fill();
    var fill = tank.cap > 0 ? tank.water / tank.cap : 0;
    ctx.fillStyle = 'rgba(40,60,80,0.35)'; rr(ctx, -24, -3, 36, 6, 3); ctx.fill();
    ctx.fillStyle = fill < 0.2 ? '#ff6b5a' : '#3aa0ff'; rr(ctx, -24, -3, Math.max(0, 36 * fill), 6, 3); ctx.fill();
    ctx.fillStyle = 'rgba(255,255,255,0.7)'; rr(ctx, -22, -13, 30, 4, 2); ctx.fill();
    // pump box
    ctx.fillStyle = '#f2b928'; rr(ctx, 17, -9, 10, 18, 2); ctx.fill();
    ctx.fillStyle = '#7a5a10'; ctx.fillRect(20, -6, 4, 12);
    ctx.restore();

    // hose turret
    var sp = state.spray;
    var aa = Math.atan2(sp.hitY - sp.nozY, sp.hitX - sp.nozX);
    ctx.save();
    ctx.translate(sp.nozX, sp.nozY); ctx.rotate(aa);
    ctx.fillStyle = '#2f3338'; ctx.beginPath(); ctx.arc(0, 0, 8, 0, 7); ctx.fill();
    ctx.fillStyle = '#c99a2e'; rr(ctx, 0, -3.5, 20, 7, 3); ctx.fill();
    ctx.fillStyle = '#e6c25a'; ctx.fillRect(16, -4.5, 5, 9);
    ctx.restore();
  }

  function drawTruck(ctx, state) {
    var t = state.truck;
    ctx.save();
    ctx.translate(t.x, t.y); ctx.rotate(t.a);
    ctx.fillStyle = 'rgba(0,0,0,0.28)'; rr(ctx, -37 + 6, -19 + 7, 74, 38, 9); ctx.fill();
    // wheels
    ctx.fillStyle = '#1d1d1f';
    rr(ctx, -31, -23, 17, 8, 3); ctx.fill(); rr(ctx, -31, 15, 17, 8, 3); ctx.fill();
    var sa = t.steer * 0.45;
    ctx.save(); ctx.translate(22, -19); ctx.rotate(sa); rr(ctx, -8.5, -4, 17, 8, 3); ctx.fill(); ctx.restore();
    ctx.save(); ctx.translate(22, 19); ctx.rotate(sa); rr(ctx, -8.5, -4, 17, 8, 3); ctx.fill(); ctx.restore();
    // body
    ctx.fillStyle = '#d93a2b'; rr(ctx, -37, -18, 74, 36, 8); ctx.fill();
    ctx.fillStyle = '#ef5a44'; rr(ctx, 14, -16, 21, 32, 6); ctx.fill(); // hood
    ctx.fillStyle = 'rgba(0,0,0,0.12)'; ctx.fillRect(22, -1, 12, 2);
    // bed
    ctx.fillStyle = '#7d2a20'; rr(ctx, -35, -15, 30, 30, 4); ctx.fill();
    ctx.strokeStyle = 'rgba(0,0,0,0.25)'; ctx.lineWidth = 1.5;
    for (var k = -9; k <= 9; k += 6) { ctx.beginPath(); ctx.moveTo(-33, k); ctx.lineTo(-7, k); ctx.stroke(); }
    // cab
    ctx.fillStyle = '#b72d21'; rr(ctx, -6, -16, 21, 32, 5); ctx.fill();
    ctx.fillStyle = '#9fd6f5'; // windshield
    ctx.beginPath(); ctx.moveTo(11, -14); ctx.lineTo(17, -12); ctx.lineTo(17, 12); ctx.lineTo(11, 14); ctx.closePath(); ctx.fill();
    ctx.fillStyle = '#7fbfe0'; ctx.fillRect(-5, -12, 3, 24); // rear window
    ctx.fillStyle = 'rgba(255,255,255,0.25)'; rr(ctx, -2, -13, 11, 5, 2); ctx.fill();
    // mirrors
    ctx.fillStyle = '#333'; ctx.fillRect(8, -21, 4, 4); ctx.fillRect(8, 17, 4, 4);
    // lights
    ctx.fillStyle = '#fff6b0'; rr(ctx, 33, -15, 4, 7, 1.5); ctx.fill(); rr(ctx, 33, 8, 4, 7, 1.5); ctx.fill();
    ctx.fillStyle = state.truck.v < -5 ? '#ffffff' : '#ff3030';
    ctx.fillRect(-38, -15, 3, 6); ctx.fillRect(-38, 9, 3, 6);
    ctx.fillStyle = '#9aa0a6'; ctx.fillRect(36, -13, 3, 26); // bumper
    // headlight beams (subtle)
    ctx.fillStyle = 'rgba(255,250,200,0.08)';
    ctx.beginPath(); ctx.moveTo(37, -12); ctx.lineTo(110, -34); ctx.lineTo(110, 34); ctx.lineTo(37, 12); ctx.closePath(); ctx.fill();
    ctx.restore();
  }

  function drawStream(ctx, state) {
    var sp = state.spray;
    var playing = state.phase === 'playing';
    if (playing && sp.on) {
      // continuous arc body per hit
      for (var h = 0; h < sp.hits.length; h++) {
        var hx = sp.hits[h].x, hy = sp.hits[h].y;
        var dx = hx - sp.nozX, dy = hy - sp.nozY, d = Math.sqrt(dx * dx + dy * dy);
        var cx = (sp.nozX + hx) / 2, cy = (sp.nozY + hy) / 2 - (10 + d * 0.28) * 2;
        ctx.strokeStyle = 'rgba(150,215,255,0.35)'; ctx.lineWidth = 7; ctx.lineCap = 'round';
        ctx.beginPath(); ctx.moveTo(sp.nozX, sp.nozY); ctx.quadraticCurveTo(cx, cy, hx, hy); ctx.stroke();
        ctx.strokeStyle = 'rgba(230,248,255,0.5)'; ctx.lineWidth = 2.5;
        ctx.beginPath(); ctx.moveTo(sp.nozX, sp.nozY); ctx.quadraticCurveTo(cx, cy, hx, hy); ctx.stroke();
      }
    }
    var i, p;
    // shadows
    ctx.fillStyle = 'rgba(20,50,80,0.15)';
    for (i = 0; i < fx.drops.length; i++) {
      p = fx.drops[i];
      ctx.fillRect(lerp(p.sx, p.ex, p.t) - 1.5, lerp(p.sy, p.ey, p.t) - 1.5, 3, 3);
    }
    for (i = 0; i < fx.drops.length; i++) {
      p = fx.drops[i];
      var x = lerp(p.sx, p.ex, p.t), y = lerp(p.sy, p.ey, p.t) - 4 * p.h * p.t * (1 - p.t);
      ctx.fillStyle = 'rgba(110,190,255,0.85)';
      ctx.beginPath(); ctx.arc(x, y, p.r, 0, 7); ctx.fill();
      ctx.fillStyle = 'rgba(255,255,255,0.8)';
      ctx.fillRect(x - p.r * 0.4, y - p.r * 0.5, p.r * 0.6, p.r * 0.6);
    }
    for (i = 0; i < fx.splash.length; i++) {
      var s = fx.splash[i], a = 1 - s.t / s.life;
      ctx.fillStyle = 'rgba(170,225,255,' + a.toFixed(2) + ')';
      ctx.beginPath(); ctx.arc(s.x, s.y - s.z, 2.2, 0, 7); ctx.fill();
    }
    for (i = 0; i < fx.rings.length; i++) {
      var g = fx.rings[i], k = g.t / g.life;
      ctx.strokeStyle = 'rgba(200,240,255,' + (0.6 * (1 - k)).toFixed(2) + ')'; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.ellipse(g.x, g.y, 4 + k * 18, 3 + k * 12, 0, 0, 7); ctx.stroke();
    }
  }

  function drawAim(ctx, state) {
    var sp = state.spray;
    if (state.phase !== 'playing') return;
    // range ring
    ctx.save();
    ctx.strokeStyle = 'rgba(255,255,255,0.22)'; ctx.lineWidth = 2; ctx.setLineDash([6, 10]);
    ctx.beginPath(); ctx.arc(sp.nozX, sp.nozY, sp.range, 0, Math.PI * 2); ctx.stroke();
    ctx.setLineDash([]);
    var empty = state.tank.water <= 0.0001;
    var col = empty ? '255,90,80' : '120,210,255';
    for (var h = 0; h < sp.hits.length; h++) {
      var x = sp.hits[h].x, y = sp.hits[h].y;
      ctx.strokeStyle = 'rgba(' + col + ',0.9)'; ctx.lineWidth = 2.5;
      ctx.beginPath(); ctx.arc(x, y, sp.radius, 0, Math.PI * 2); ctx.stroke();
      if (sp.on) {
        var pr = (T * 2.5) % 1;
        ctx.strokeStyle = 'rgba(' + col + ',' + (0.6 * (1 - pr)).toFixed(2) + ')';
        ctx.beginPath(); ctx.arc(x, y, sp.radius * (0.3 + pr * 0.7), 0, Math.PI * 2); ctx.stroke();
      }
      ctx.strokeStyle = 'rgba(255,255,255,0.95)'; ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(x - 9, y); ctx.lineTo(x - 3, y); ctx.moveTo(x + 3, y); ctx.lineTo(x + 9, y);
      ctx.moveTo(x, y - 9); ctx.lineTo(x, y - 3); ctx.moveTo(x, y + 3); ctx.lineTo(x, y + 9);
      ctx.stroke();
    }
    // raw aim marker when clamped
    var dx = sp.aimX - sp.hitX, dy = sp.aimY - sp.hitY;
    if (dx * dx + dy * dy > 100) {
      ctx.fillStyle = 'rgba(255,255,255,0.35)';
      ctx.beginPath(); ctx.arc(sp.aimX, sp.aimY, 4, 0, 7); ctx.fill();
    }
    ctx.restore();
  }

  function drawPops(ctx) {
    var i;
    for (i = 0; i < fx.sparks.length; i++) {
      var s = fx.sparks[i];
      if (s.t < 0) continue;
      var k = s.t / s.life, sz = s.s * Math.sin(Math.PI * k);
      drawStar(ctx, s.x, s.y - k * 10, sz, s.gold ? 'rgba(255,225,90,0.95)' : 'rgba(255,255,255,0.9)');
    }
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    for (i = 0; i < fx.pops.length; i++) {
      var p = fx.pops[i], q = p.t / p.life;
      var sc = q < 0.15 ? 0.6 + q / 0.15 * 0.6 : 1.2 - Math.min(0.2, (q - 0.15));
      var a = q > 0.7 ? 1 - (q - 0.7) / 0.3 : 1;
      var size = (p.bonus ? 24 : 17) * sc;
      ctx.font = '900 ' + size.toFixed(1) + 'px system-ui, "Segoe UI", sans-serif';
      var y = p.y - 10 - q * 46;
      ctx.lineWidth = 4; ctx.strokeStyle = 'rgba(20,50,20,' + (a * 0.85).toFixed(2) + ')';
      ctx.strokeText(p.text, p.x, y);
      ctx.fillStyle = p.bonus ? 'rgba(255,215,64,' + a.toFixed(2) + ')' : 'rgba(255,255,255,' + a.toFixed(2) + ')';
      ctx.fillText(p.text, p.x, y);
      if (p.combo >= 3) {
        ctx.font = '800 ' + (11 * sc).toFixed(1) + 'px system-ui, sans-serif';
        ctx.fillStyle = 'rgba(255,190,80,' + a.toFixed(2) + ')';
        ctx.fillText('x' + p.combo, p.x, y + size * 0.75);
      }
    }
    ctx.textBaseline = 'alphabetic';
  }

  function drawOffscreenArrow(ctx, state, view) {
    // point at nearest refill station when tank is low
    if (state.phase !== 'playing') return;
    var fill = state.tank.cap ? state.tank.water / state.tank.cap : 1;
    if (fill > 0.25) return;
    var best = null, bd = 1e12;
    for (var i = 0; i < state.stations.length; i++) {
      var s = state.stations[i], dx = s.x - state.trailer.x, dy = s.y - state.trailer.y, d = dx * dx + dy * dy;
      if (d < bd) { bd = d; best = s; }
    }
    if (!best) return;
    var sx = (best.x - view.x) * view.zoom + view.w / 2, sy = (best.y - view.y) * view.zoom + view.h / 2;
    var m = 60;
    if (sx > m && sx < view.w - m && sy > m && sy < view.h - m) return;
    var cx = view.w / 2, cy = view.h / 2, ang = Math.atan2(sy - cy, sx - cx);
    var px = Math.max(m, Math.min(view.w - m, sx)), py = Math.max(m, Math.min(view.h - m, sy));
    var pulse = 1 + Math.sin(T * 8) * 0.12;
    ctx.save(); ctx.translate(px, py); ctx.rotate(ang); ctx.scale(pulse, pulse);
    ctx.fillStyle = 'rgba(60,160,255,0.95)'; ctx.strokeStyle = '#fff'; ctx.lineWidth = 3;
    ctx.beginPath(); ctx.moveTo(22, 0); ctx.lineTo(-12, -16); ctx.lineTo(-6, 0); ctx.lineTo(-12, 16); ctx.closePath();
    ctx.fill(); ctx.stroke();
    ctx.restore();
    ctx.fillStyle = '#fff'; ctx.font = 'bold 13px system-ui, sans-serif'; ctx.textAlign = 'center';
    ctx.fillText('REFILL', px - Math.cos(ang) * 34, py - Math.sin(ang) * 34 + 4);
  }

  function drawScreenText(ctx, state, view) {
    var cx = view.w / 2, cy = view.h * 0.38;
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    if (state.phase === 'playing' && state.countdown > 0) {
      var n = Math.ceil(state.countdown), k = n - state.countdown;
      var sc = 1.6 - k * 0.6;
      ctx.font = '900 ' + Math.round(120 * sc) + 'px system-ui, "Segoe UI", sans-serif';
      ctx.lineWidth = 10; ctx.strokeStyle = 'rgba(30,60,20,0.8)'; ctx.strokeText(String(n), cx, cy);
      ctx.fillStyle = '#fff'; ctx.fillText(String(n), cx, cy);
      ctx.font = '800 26px system-ui, sans-serif';
      ctx.lineWidth = 6; ctx.strokeText('Round ' + state.round, cx, cy + 90);
      ctx.fillStyle = '#ffe680'; ctx.fillText('Round ' + state.round, cx, cy + 90);
    }
    for (var i = 0; i < fx.banners.length; i++) {
      var b = fx.banners[i], q = b.t / b.life;
      var s2 = q < 0.15 ? q / 0.15 : 1;
      var a = q > 0.7 ? 1 - (q - 0.7) / 0.3 : 1;
      var size = (b.small ? 40 : 84) * (0.7 + 0.3 * s2);
      var y = b.small ? view.h * 0.62 - q * 30 : cy;
      ctx.globalAlpha = a;
      ctx.font = '900 ' + Math.round(size) + 'px system-ui, "Segoe UI", sans-serif';
      ctx.lineWidth = b.small ? 6 : 10; ctx.strokeStyle = 'rgba(30,50,20,0.85)'; ctx.strokeText(b.text, cx, y);
      ctx.fillStyle = b.color; ctx.fillText(b.text, cx, y);
      ctx.globalAlpha = 1;
    }
    ctx.textBaseline = 'alphabetic';
  }

  // ---------------------------------------------------------------- main draw
  function draw(ctx, state, view) {
    C = SOD.Sim.C;
    if (!bg) buildBackground();
    var dt = state.paused ? 0 : (view.dt || 0);
    T += dt;
    updateFx(state, dt);

    var dpr = view.dpr || 1, z = view.zoom;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = '#4c8433';
    ctx.fillRect(0, 0, view.w, view.h);

    var shx = fx.shake ? (Math.random() - 0.5) * fx.shake : 0, shy = fx.shake ? (Math.random() - 0.5) * fx.shake : 0;
    ctx.setTransform(dpr * z, 0, 0, dpr * z, dpr * (view.w / 2 - view.x * z + shx), dpr * (view.h / 2 - view.y * z + shy));
    var vx0 = view.x - view.w / 2 / z, vy0 = view.y - view.h / 2 / z;
    var vx1 = view.x + view.w / 2 / z, vy1 = view.y + view.h / 2 / z;

    ctx.drawImage(bg, 0, 0);
    drawField(ctx, state, vx0, vy0, vx1, vy1);
    drawTracks(ctx);
    drawStations(ctx, state);
    drawTrailer(ctx, state);
    drawTruck(ctx, state);
    drawStream(ctx, state);
    drawAim(ctx, state);
    drawPops(ctx);

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    // vignette
    var g = ctx.createRadialGradient(view.w / 2, view.h / 2, Math.min(view.w, view.h) * 0.45, view.w / 2, view.h / 2, Math.max(view.w, view.h) * 0.75);
    g.addColorStop(0, 'rgba(0,0,0,0)'); g.addColorStop(1, 'rgba(0,20,0,0.28)');
    ctx.fillStyle = g; ctx.fillRect(0, 0, view.w, view.h);
    drawOffscreenArrow(ctx, state, view);
    drawScreenText(ctx, state, view);
  }

  SOD.Render = { draw: draw, onEvents: onEvents };
})();
