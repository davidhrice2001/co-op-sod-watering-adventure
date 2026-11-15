/* 3D renderer (three.js r160 global build). Draws (state, view) only.
 * Holds only derived/transient things (meshes, particles, popups) keyed by indices and diffed by value,
 * so it tolerates a brand-new (deserialized) state object every frame.
 * Sim (x, y) maps to three (x, 0, y); sim angle a -> rotation.y = -a.
 *
 *   SOD.Render.available()            -> bool (false if THREE failed to load)
 *   SOD.Render.init(canvas)
 *   SOD.Render.resize(w, h, dpr)
 *   SOD.Render.onEvents(events)
 *   SOD.Render.draw(state, {dt})
 *   SOD.Render.camInfo                -> {screenToGround(sx, sy) -> {x,y}|null, forward:{x,y}}  (for SOD.Input)
 *   SOD.Render.toggleCamera() / getCameraMode()
 */
(function () {
  'use strict';
  var SOD = (window.SOD = window.SOD || {});
  if (typeof THREE === 'undefined') {
    SOD.Render = { available: function () { return false; } };
    return;
  }

  var C = null;
  var renderer, scene, camera, sun;
  var W = 800, H = 600;
  var camMode = 'chase';
  var camYaw = 0, camReady = false;
  var camPos = new THREE.Vector3(), camTarget = new THREE.Vector3();
  var dummy = new THREE.Object3D();
  var tmpColor = new THREE.Color();
  var tmpV = new THREE.Vector3();
  var T = 0;

  var M = {};        // persistent meshes
  var tileKeys = null;
  var fxLayer, bannerEl, countEl;
  var fx = { drops: [], splash: [], pops: [], banners: [], spawnAcc: 0, dripAcc: 0, lastWheels: null, trackIdx: 0,
    wheelSpin: 0, trailerSpin: 0, round: -1 };

  var camInfo = {
    forward: { x: 1, y: 0 },
    screenToGround: function (sx, sy) {
      if (!camera) return null;
      tmpV.set(sx / W * 2 - 1, -(sy / H) * 2 + 1, 0.5).unproject(camera);
      tmpV.sub(camera.position).normalize();
      if (tmpV.y > -0.01) return null;
      var t = (4 - camera.position.y) / tmpV.y;
      return { x: camera.position.x + tmpV.x * t, y: camera.position.z + tmpV.z * t };
    }
  };

  // ---------------------------------------------------------------- utils
  function lcg(seed) { var s = seed >>> 0; return function () { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; }; }
  function hash(n) { var x = Math.sin(n * 127.1 + 311.7) * 43758.5453; return x - Math.floor(x); }
  function lerp(a, b, t) { return a + (b - a) * t; }
  function mix(c1, c2, t) { return [lerp(c1[0], c2[0], t), lerp(c1[1], c2[1], t), lerp(c1[2], c2[2], t)]; }
  function wrap(a) { while (a > Math.PI) a -= Math.PI * 2; while (a < -Math.PI) a += Math.PI * 2; return a; }
  function lam(color, extra) {
    var o = { color: color };
    if (extra) for (var k in extra) o[k] = extra[k];
    return new THREE.MeshLambertMaterial(o);
  }
  function box(w, h, d, mat, x, y, z, parent, shadow) {
    var m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
    m.position.set(x || 0, y || 0, z || 0);
    if (shadow !== false) { m.castShadow = true; }
    if (parent) parent.add(m);
    return m;
  }
  function fmtMoney(n) { return '$' + Math.round(n).toLocaleString('en-US'); }

  // ---------------------------------------------------------------- init
  function init(canvas) {
    C = SOD.Sim.C;
    renderer = new THREE.WebGLRenderer({ canvas: canvas, antialias: true, powerPreference: 'high-performance' });
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFShadowMap;
    scene = new THREE.Scene();
    scene.background = new THREE.Color(0xa8dcff);
    scene.fog = new THREE.Fog(0xa8dcff, 2200, 6000);
    camera = new THREE.PerspectiveCamera(50, 1, 10, 9000);

    scene.add(new THREE.HemisphereLight(0xe4f4ff, 0x5d7a3c, 1.6));
    sun = new THREE.DirectionalLight(0xfff0d0, 2.3);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    var sc = sun.shadow.camera;
    sc.left = -800; sc.right = 800; sc.top = 800; sc.bottom = -800; sc.near = 50; sc.far = 3000;
    sun.shadow.bias = -0.0006;
    sun.shadow.normalBias = 1.5;
    scene.add(sun); scene.add(sun.target);

    buildWorld();
    buildTiles();
    buildVehicles();
    buildFx();
    buildDom();
  }

  function resize(w, h, dpr) {
    W = w; H = h;
    if (!renderer) return;
    renderer.setPixelRatio(Math.min(dpr || 1, 2));
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }

  // ---------------------------------------------------------------- world
  function buildWorld() {
    var R = lcg(4242);
    var cx = C.WORLD_W / 2, cz = C.WORLD_H / 2;
    // grass
    var g = new THREE.Mesh(new THREE.PlaneGeometry(C.WORLD_W + 8000, C.WORLD_H + 8000).rotateX(-Math.PI / 2), lam(0x67a646));
    g.position.set(cx, -1, cz); g.receiveShadow = true; scene.add(g);
    // dirt road (world area minus verge)
    var m = 48;
    var road = new THREE.Mesh(new THREE.PlaneGeometry(C.WORLD_W - m * 2, C.WORLD_H - m * 2).rotateX(-Math.PI / 2), lam(0xc69d68));
    road.position.set(cx, 0, cz); road.receiveShadow = true; scene.add(road);
    // field soil
    var soil = new THREE.Mesh(new THREE.BoxGeometry(C.FIELD_W + 16, 2, C.FIELD_H + 16), lam(0x6b4426));
    soil.position.set(C.FIELD_X + C.FIELD_W / 2, 0.5, C.FIELD_Y + C.FIELD_H / 2); soil.receiveShadow = true; scene.add(soil);
    // curb stones
    var curbMat = lam(0xe2d6b8);
    box(C.FIELD_W + 40, 4, 6, curbMat, C.FIELD_X + C.FIELD_W / 2, 2, C.FIELD_Y - 18, scene, false);
    box(C.FIELD_W + 40, 4, 6, curbMat, C.FIELD_X + C.FIELD_W / 2, 2, C.FIELD_Y + C.FIELD_H + 18, scene, false);
    box(6, 4, C.FIELD_H + 40, curbMat, C.FIELD_X - 18, 2, C.FIELD_Y + C.FIELD_H / 2, scene, false);
    box(6, 4, C.FIELD_H + 40, curbMat, C.FIELD_X + C.FIELD_W + 18, 2, C.FIELD_Y + C.FIELD_H / 2, scene, false);

    // fence around the world edge
    var fenceMat = lam(0xf1e6cc);
    var inset = 16, x0 = inset, x1 = C.WORLD_W - inset, z0 = inset, z1 = C.WORLD_H - inset;
    var posts = [];
    var step = 80, x, z;
    for (x = x0; x <= x1; x += step) { posts.push([x, z0]); posts.push([x, z1]); }
    for (z = z0 + step; z < z1; z += step) { posts.push([x0, z]); posts.push([x1, z]); }
    var pm = new THREE.InstancedMesh(new THREE.BoxGeometry(6, 32, 6), fenceMat, posts.length);
    posts.forEach(function (p, i) { dummy.position.set(p[0], 16, p[1]); dummy.rotation.set(0, 0, 0); dummy.scale.set(1, 1, 1); dummy.updateMatrix(); pm.setMatrixAt(i, dummy.matrix); });
    pm.castShadow = true; scene.add(pm);
    [12, 24].forEach(function (h) {
      box(x1 - x0, 4, 3, fenceMat, (x0 + x1) / 2, h, z0, scene);
      box(x1 - x0, 4, 3, fenceMat, (x0 + x1) / 2, h, z1, scene);
      box(3, 4, z1 - z0, fenceMat, x0, h, (z0 + z1) / 2, scene);
      box(3, 4, z1 - z0, fenceMat, x1, h, (z0 + z1) / 2, scene);
    });

    // trees outside the fence
    var trees = [];
    for (var i = 0; i < 170; i++) {
      var side = Math.floor(R() * 4), along = R(), out = 60 + R() * 650, tx, tz;
      if (side === 0) { tx = -600 + along * (C.WORLD_W + 1200); tz = -out; }
      else if (side === 1) { tx = -600 + along * (C.WORLD_W + 1200); tz = C.WORLD_H + out; }
      else if (side === 2) { tx = -out; tz = along * C.WORLD_H; }
      else { tx = C.WORLD_W + out; tz = along * C.WORLD_H; }
      trees.push([tx, tz, 0.7 + R() * 0.8, R()]);
    }
    var trunk = new THREE.InstancedMesh(new THREE.CylinderGeometry(5, 7, 34, 6), lam(0x7a5230), trees.length);
    var crownGeo = new THREE.IcosahedronGeometry(30, 0);
    var crown = new THREE.InstancedMesh(crownGeo, lam(0xffffff, { flatShading: true }), trees.length);
    trees.forEach(function (t, k) {
      var s = t[2];
      dummy.position.set(t[0], 17 * s, t[1]); dummy.scale.set(s, s, s); dummy.rotation.set(0, t[3] * 6, 0); dummy.updateMatrix();
      trunk.setMatrixAt(k, dummy.matrix);
      dummy.position.set(t[0], (34 + 22) * s, t[1]); dummy.scale.set(s, s * 1.15, s); dummy.updateMatrix();
      crown.setMatrixAt(k, dummy.matrix);
      tmpColor.setRGB(0.22 + t[3] * 0.12, 0.48 + t[3] * 0.15, 0.18, THREE.SRGBColorSpace);
      crown.setColorAt(k, tmpColor);
    });
    trunk.castShadow = true; crown.castShadow = true;
    scene.add(trunk); scene.add(crown);

    // houses
    addHouse(-330, C.WORLD_H * 0.3, 0.3, 0xf2e2c4, 0xb5483a);
    addHouse(C.WORLD_W + 340, C.WORLD_H * 0.72, -0.2, 0xd8e6f0, 0x4a5f7a);
    addHouse(C.WORLD_W * 0.62, -360, 1.4, 0xf6d7a0, 0x8a3b2c);
    addBarn(C.WORLD_W * 0.25, C.WORLD_H + 380);

    // stations
    M.stationRings = [];
    var st = SOD.Sim.newGame(1).stations; // positions are constant
    st.forEach(function (s) {
      var ring = new THREE.Mesh(new THREE.RingGeometry(s.r - 7, s.r, 64).rotateX(-Math.PI / 2),
        new THREE.MeshBasicMaterial({ color: 0x3aa0ff, transparent: true, opacity: 0.7, depthWrite: false }));
      ring.position.set(s.x, 1.5, s.y); scene.add(ring);
      var disc = new THREE.Mesh(new THREE.CircleGeometry(s.r - 7, 48).rotateX(-Math.PI / 2),
        new THREE.MeshBasicMaterial({ color: 0x3aa0ff, transparent: true, opacity: 0.12, depthWrite: false }));
      disc.position.set(s.x, 1.2, s.y); scene.add(disc);
      var pulse = new THREE.Mesh(new THREE.RingGeometry(0.9, 1, 48).rotateX(-Math.PI / 2),
        new THREE.MeshBasicMaterial({ color: 0xbfe6ff, transparent: true, opacity: 0, depthWrite: false }));
      pulse.position.set(s.x, 2, s.y); scene.add(pulse);
      M.stationRings.push({ ring: ring, disc: disc, pulse: pulse, x: s.x, y: s.y, r: s.r });
      if (s.type === 'hydrant') addHydrant(s.x, s.y); else addPond(s.x, s.y);
    });
  }

  function addHouse(x, z, rot, wall, roof) {
    var g = new THREE.Group();
    var wm = lam(wall), rm = lam(roof, { flatShading: true });
    box(170, 90, 130, wm, 0, 45, 0, g);
    var r = new THREE.Mesh(new THREE.ConeGeometry(130, 70, 4), rm);
    r.rotation.y = Math.PI / 4; r.scale.set(1, 1, 0.8); r.position.y = 125; r.castShadow = true; g.add(r);
    var dark = lam(0x5a3a22), glass = lam(0x9fd0ef, { emissive: 0x223344 });
    box(26, 46, 4, dark, 0, 23, 66, g);
    box(30, 26, 4, glass, -52, 54, 66, g); box(30, 26, 4, glass, 52, 54, 66, g);
    box(18, 40, 18, lam(0x8a6a5a), 50, 140, -20, g); // chimney
    g.position.set(x, 0, z); g.rotation.y = rot;
    scene.add(g);
  }
  function addBarn(x, z) {
    var g = new THREE.Group();
    box(220, 110, 150, lam(0xb8352b), 0, 55, 0, g);
    var roof = new THREE.Mesh(new THREE.CylinderGeometry(80, 80, 224, 4, 1, false, 0, Math.PI).rotateZ(Math.PI / 2), lam(0x5a5f66, { flatShading: true }));
    roof.position.y = 110; roof.scale.set(1, 0.6, 1); roof.castShadow = true; g.add(roof);
    box(70, 80, 4, lam(0xf2efe6), 0, 40, 76, g);
    var silo = new THREE.Mesh(new THREE.CylinderGeometry(36, 36, 200, 16), lam(0xc9ccd1));
    silo.position.set(160, 100, 0); silo.castShadow = true; g.add(silo);
    var cap = new THREE.Mesh(new THREE.SphereGeometry(36, 16, 8, 0, Math.PI * 2, 0, Math.PI / 2), lam(0x9aa0a8));
    cap.position.set(160, 200, 0); g.add(cap);
    g.position.set(x, 0, z);
    scene.add(g);
  }
  function addHydrant(x, z) {
    var g = new THREE.Group(), red = lam(0xd8302c), yel = lam(0xffd34d);
    var body = new THREE.Mesh(new THREE.CylinderGeometry(9, 11, 30, 12), red); body.position.y = 15; body.castShadow = true; g.add(body);
    var cap = new THREE.Mesh(new THREE.SphereGeometry(10, 12, 8, 0, Math.PI * 2, 0, Math.PI / 2), red); cap.position.y = 30; g.add(cap);
    var top = new THREE.Mesh(new THREE.CylinderGeometry(3, 3, 6, 6), yel); top.position.y = 40; g.add(top);
    var side = new THREE.Mesh(new THREE.CylinderGeometry(4, 4, 30, 8).rotateZ(Math.PI / 2), red); side.position.y = 20; g.add(side);
    var base = new THREE.Mesh(new THREE.CylinderGeometry(14, 14, 3, 12), lam(0x8a8f98)); base.position.y = 1.5; g.add(base);
    g.position.set(x, 0, z);
    scene.add(g);
  }
  function addPond(x, z) {
    var g = new THREE.Group();
    var shore = new THREE.Mesh(new THREE.CircleGeometry(62, 32).rotateX(-Math.PI / 2), lam(0xd8c08a));
    shore.position.y = 0.6; shore.receiveShadow = true; g.add(shore);
    var water = new THREE.Mesh(new THREE.CircleGeometry(50, 32).rotateX(-Math.PI / 2),
      new THREE.MeshPhongMaterial({ color: 0x2f86d6, shininess: 120, specular: 0xffffff }));
    water.position.y = 1; g.add(water);
    M.pondWater = water;
    var reedMat = lam(0x4f7a2a), R = lcg(77);
    for (var i = 0; i < 14; i++) {
      var a = R() * Math.PI * 2, rr = 50 + R() * 10;
      var reed = new THREE.Mesh(new THREE.CylinderGeometry(1, 1.5, 18 + R() * 14, 4), reedMat);
      reed.position.set(Math.cos(a) * rr, 12, Math.sin(a) * rr); reed.rotation.z = (R() - 0.5) * 0.4; g.add(reed);
    }
    // little pump post
    box(8, 34, 8, lam(0x3b6fb0), 0, 17, -66, g);
    box(20, 4, 4, lam(0x3b6fb0), 6, 32, -66, g);
    g.position.set(x, 0, z);
    scene.add(g);
  }

  // ---------------------------------------------------------------- tiles
  function buildTiles() {
    var n = C.COLS * C.ROWS;
    var mesh = new THREE.InstancedMesh(new THREE.BoxGeometry(C.TILE - 2, 6, C.TILE - 2), lam(0xffffff), n);
    mesh.receiveShadow = true;
    for (var i = 0; i < n; i++) {
      tmpColor.setRGB(0.8, 0.7, 0.4, THREE.SRGBColorSpace);
      mesh.setColorAt(i, tmpColor);
    }
    scene.add(mesh);
    M.tiles = mesh;
    var tuftGeo = new THREE.ConeGeometry(3.2, 13, 4);
    var tufts = new THREE.InstancedMesh(tuftGeo, lam(0x4aa83a), n * 3);
    dummy.position.set(0, -50, 0); dummy.scale.set(0.001, 0.001, 0.001); dummy.rotation.set(0, 0, 0); dummy.updateMatrix();
    for (var k = 0; k < n * 3; k++) tufts.setMatrixAt(k, dummy.matrix);
    scene.add(tufts);
    M.tufts = tufts;
    tileKeys = new Array(n);
    for (var j = 0; j < n; j++) tileKeys[j] = null;

    var gold = new THREE.MeshLambertMaterial({ color: 0xffd23a, emissive: 0x6a4a00 });
    M.gems = new THREE.InstancedMesh(new THREE.OctahedronGeometry(7), gold, 160);
    M.gems.count = 0; M.gems.castShadow = true;
    scene.add(M.gems);
  }

  var PARCHED_HI = [196, 128, 58], PARCHED_LO = [206, 204, 128], WET = [112, 156, 66];
  var LUSH_A = [72, 168, 62], LUSH_B = [86, 184, 72], GOLD = [255, 205, 40];

  function updateTiles(state) {
    var f = state.field;
    if (!f) return;
    var mesh = M.tiles, tufts = M.tufts, T0 = f.tile;
    var colorDirty = false, matDirty = false, tuftDirty = false;
    var n = f.cols * f.rows;
    for (var i = 0; i < n; i++) {
      var done = f.done[i] === 1, bonus = f.bonus[i] === 1;
      var frac = done ? 1 : Math.min(1, f.water[i] / f.need[i]);
      var key = done ? (bonus ? -2 : -1) : ((Math.round(f.dry[i] * 20) * 64 + Math.round(frac * 48)) * 2 + (bonus ? 1 : 0));
      if (tileKeys[i] === key) continue;
      var wasDone = tileKeys[i] === -1 || tileKeys[i] === -2;
      tileKeys[i] = key;
      var c = i % f.cols, r = (i - c) / f.cols;
      var col;
      if (done) {
        col = (r % 2 === 0) ? LUSH_A : LUSH_B;
        if (bonus) col = mix(col, GOLD, 0.35);
      } else {
        var parched = bonus ? GOLD : mix(PARCHED_LO, PARCHED_HI, f.dry[i]);
        col = mix(parched, WET, Math.pow(frac, 0.8) * 0.85);
      }
      tmpColor.setRGB(col[0] / 255, col[1] / 255, col[2] / 255, THREE.SRGBColorSpace);
      mesh.setColorAt(i, tmpColor);
      colorDirty = true;
      var sy = done ? 1.5 : 0.6 + frac * 0.5;
      var x = f.x + (c + 0.5) * T0, z = f.y + (r + 0.5) * T0;
      dummy.rotation.set(0, 0, 0);
      dummy.position.set(x, 3 * sy, z); dummy.scale.set(1, sy, 1); dummy.updateMatrix();
      mesh.setMatrixAt(i, dummy.matrix);
      matDirty = true;
      if (done !== wasDone) {
        for (var k = 0; k < 3; k++) {
          if (done) {
            var ox = (hash(i * 3 + k) - 0.5) * (T0 - 12), oz = (hash(i * 3 + k + 0.5) - 0.5) * (T0 - 12);
            var s = 0.8 + hash(i + k * 9) * 0.6;
            dummy.position.set(x + ox, 9 + 6 * s, z + oz); dummy.scale.set(s, s, s);
            dummy.rotation.set(0, hash(i + k) * 3, 0);
          } else {
            dummy.position.set(x, -50, z); dummy.scale.set(0.001, 0.001, 0.001); dummy.rotation.set(0, 0, 0);
          }
          dummy.updateMatrix();
          tufts.setMatrixAt(i * 3 + k, dummy.matrix);
        }
        tuftDirty = true;
      }
    }
    if (colorDirty) mesh.instanceColor.needsUpdate = true;
    if (matDirty) mesh.instanceMatrix.needsUpdate = true;
    if (tuftDirty) tufts.instanceMatrix.needsUpdate = true;

    // golden gems over unfinished premium tiles
    var g = 0;
    for (var j = 0; j < n && g < 160; j++) {
      if (f.bonus[j] !== 1 || f.done[j] === 1) continue;
      var cc = j % f.cols, rr = (j - cc) / f.cols;
      dummy.position.set(f.x + (cc + 0.5) * T0, 26 + Math.sin(T * 2.5 + j) * 4, f.y + (rr + 0.5) * T0);
      dummy.rotation.set(0, T * 2 + j, 0); dummy.scale.set(1, 1.4, 1); dummy.updateMatrix();
      M.gems.setMatrixAt(g++, dummy.matrix);
    }
    M.gems.count = g;
    M.gems.instanceMatrix.needsUpdate = true;
  }

  // ---------------------------------------------------------------- vehicles
  function wheel(parent, x, y, z) {
    var pivot = new THREE.Group();
    pivot.position.set(x, y, z);
    var w = new THREE.Mesh(M.wheelGeo, M.tireMat); w.castShadow = true;
    var hub = new THREE.Mesh(M.hubGeo, M.hubMat);
    hub.position.z = z > 0 ? 4.2 : -4.2;
    w.add(hub);
    var spoke = new THREE.Mesh(new THREE.BoxGeometry(12, 2.5, 1), M.hubMat);
    spoke.position.z = z > 0 ? 4.6 : -4.6;
    w.add(spoke);
    pivot.add(w);
    parent.add(pivot);
    return { pivot: pivot, wheel: w };
  }

  function buildVehicles() {
    M.wheelGeo = new THREE.CylinderGeometry(10, 10, 8, 14).rotateX(Math.PI / 2);
    M.hubGeo = new THREE.CylinderGeometry(5, 5, 1, 10).rotateX(Math.PI / 2);
    M.tireMat = lam(0x1f1f22);
    M.hubMat = lam(0xc8ccd2);

    // ---- truck (faces +x)
    var t = new THREE.Group();
    var red = lam(0xd93a2b), redL = lam(0xef5a44), redD = lam(0xa82a1f), glass = lam(0x23415e, { emissive: 0x0a1520 });
    var grey = lam(0x9aa0a6), dark = lam(0x3a3a3e);
    box(74, 12, 36, red, 0, 18, 0, t);
    box(24, 8, 34, redL, 25, 28, 0, t);           // hood
    box(26, 22, 34, red, 1, 35, 0, t);            // cab
    box(27, 11, 35, glass, 1, 38, 0, t);          // window band
    box(26, 3, 34, redD, 1, 47, 0, t);            // roof
    box(4, 10, 32, glass, 13.5, 38, 0, t);        // windshield
    box(30, 9, 3, red, -22, 28, 16.5, t);         // bed walls
    box(30, 9, 3, red, -22, 28, -16.5, t);
    box(3, 9, 36, red, -36, 28, 0, t);
    box(28, 1, 30, lam(0x5a2a22), -22, 24.5, 0, t, false); // bed floor
    box(4, 6, 38, grey, 38, 16, 0, t);            // bumper
    box(3, 6, 38, dark, -38, 16, 0, t);
    box(2, 4, 8, lam(0xfff6b0, { emissive: 0x887a30 }), 37.5, 23, 12, t, false);
    box(2, 4, 8, lam(0xfff6b0, { emissive: 0x887a30 }), 37.5, 23, -12, t, false);
    M.tailMat = lam(0xff3030, { emissive: 0x550000 });
    box(2, 4, 6, M.tailMat, -38, 26, 13, t, false);
    box(2, 4, 6, M.tailMat, -38, 26, -13, t, false);
    box(4, 4, 4, dark, 8, 40, 19, t); box(4, 4, 4, dark, 8, 40, -19, t); // mirrors
    box(10, 3, 30, lam(0xffd34d, { emissive: 0x443300 }), -2, 50, 0, t, false); // roof light bar
    M.truckWheels = [wheel(t, 24, 10, 19), wheel(t, 24, 10, -19), wheel(t, -24, 10, 19), wheel(t, -24, 10, -19)];
    scene.add(t);
    M.truck = t;

    // ---- trailer (origin at axle, faces +x)
    var tr = new THREE.Group();
    var frame = lam(0x4a5058);
    box(58, 5, 40, frame, -2, 14, 0, tr);
    box(32, 4, 4, frame, 42, 14, 0, tr);          // tongue to hitch (hitch at x = 56)
    box(6, 6, 6, dark, 56, 14, 0, tr);
    box(10, 14, 18, lam(0xf2b928), 21, 23, 0, tr); // pump
    box(4, 18, 3, frame, -16, 26, 17, tr); box(4, 18, 3, frame, -16, 26, -17, tr); // cradles
    box(4, 18, 3, frame, 8, 26, 17, tr); box(4, 18, 3, frame, 8, 26, -17, tr);
    var tankMat = new THREE.MeshPhongMaterial({ color: 0xeaf6ff, transparent: true, opacity: 0.32, shininess: 90, depthWrite: false, side: THREE.DoubleSide });
    var tank = new THREE.Mesh(new THREE.CylinderGeometry(16, 16, 46, 20).rotateZ(Math.PI / 2), tankMat);
    tank.position.set(-4, 34, 0); tr.add(tank);
    var waterMat = new THREE.MeshLambertMaterial({ color: 0x2f8fff, transparent: true, opacity: 0.85, emissive: 0x0a2a55 });
    var water = new THREE.Mesh(new THREE.BoxGeometry(43, 1, 24), waterMat);
    water.position.set(-4, 20, 0); tr.add(water);
    M.water = water; M.waterMat = waterMat;
    M.trailerWheels = [wheel(tr, 0, 10, 23), wheel(tr, 0, 10, -23)];
    scene.add(tr);
    M.trailer = tr;

    // ---- nozzle turret (world-oriented)
    var nz = new THREE.Group();
    var base = new THREE.Mesh(new THREE.CylinderGeometry(6, 7, 8, 10), dark); base.castShadow = true; nz.add(base);
    var pitch = new THREE.Group(); pitch.position.y = 4; nz.add(pitch);
    var barrel = new THREE.Mesh(new THREE.CylinderGeometry(2.4, 3, 24, 8).rotateZ(-Math.PI / 2).translate(12, 0, 0), lam(0xd4a63a));
    barrel.castShadow = true; pitch.add(barrel);
    var tip = new THREE.Mesh(new THREE.CylinderGeometry(3.6, 2.4, 5, 8).rotateZ(-Math.PI / 2).translate(25, 0, 0), lam(0xe6c25a));
    pitch.add(tip);
    scene.add(nz);
    M.nozzle = nz; M.nozzlePitch = pitch;

    // ---- refill arrow above truck
    var arrow = new THREE.Mesh(new THREE.ConeGeometry(9, 26, 8).rotateZ(-Math.PI / 2),
      new THREE.MeshLambertMaterial({ color: 0x3aa0ff, emissive: 0x0a3a70 }));
    arrow.visible = false; scene.add(arrow);
    M.arrow = arrow;
  }

  function updateVehicles(state, dt) {
    var t = state.truck, tr = state.trailer, sp = state.spray, tank = state.tank;
    M.truck.position.set(t.x, 0, t.y);
    M.truck.rotation.y = -t.a;
    fx.wheelSpin -= t.v * dt / 10;
    for (var i = 0; i < 4; i++) {
      var w = M.truckWheels[i];
      w.wheel.rotation.z = fx.wheelSpin;
      if (i < 2) w.pivot.rotation.y = -t.steer * 0.5;
    }
    M.tailMat.emissive.setHex(t.v < -5 ? 0xffffff : (t.throttle < 0 && t.v > 5 ? 0xff2020 : 0x550000));
    M.trailer.position.set(tr.x, 0, tr.y);
    M.trailer.rotation.y = -tr.a;
    for (var j = 0; j < 2; j++) M.trailerWheels[j].wheel.rotation.z = fx.wheelSpin;

    var fill = tank.cap > 0 ? Math.max(0, Math.min(1, tank.water / tank.cap)) : 0;
    var hgt = Math.max(0.3, fill * 29);
    M.water.scale.y = hgt;
    M.water.position.y = 19.5 + hgt / 2;
    M.water.visible = fill > 0.002;
    M.waterMat.color.setHex(fill < 0.2 ? 0xff6b5a : 0x2f8fff);

    // nozzle swivel
    var dx = sp.hitX - sp.nozX, dy = sp.hitY - sp.nozY, d = Math.sqrt(dx * dx + dy * dy);
    M.nozzle.position.set(sp.nozX, 51, sp.nozY);
    if (d > 1) M.nozzle.rotation.y = -Math.atan2(dy, dx);
    M.nozzlePitch.rotation.z = 0.15 + 0.55 * Math.min(1, d / Math.max(1, sp.range));

    // refill arrow
    var show = state.phase === 'playing' && fill < 0.25 && !tank.near;
    M.arrow.visible = show;
    if (show) {
      var best = null, bd = 1e12;
      for (var k = 0; k < state.stations.length; k++) {
        var s = state.stations[k], ex = s.x - t.x, ey = s.y - t.y, dd = ex * ex + ey * ey;
        if (dd < bd) { bd = dd; best = s; }
      }
      M.arrow.position.set(t.x, 95 + Math.sin(T * 5) * 6, t.y);
      M.arrow.rotation.y = -Math.atan2(best.y - t.y, best.x - t.x);
    }
  }

  // ---------------------------------------------------------------- fx
  function dotTexture() {
    var c = document.createElement('canvas'); c.width = c.height = 64;
    var g = c.getContext('2d');
    var gr = g.createRadialGradient(32, 32, 0, 32, 32, 32);
    gr.addColorStop(0, 'rgba(255,255,255,1)'); gr.addColorStop(0.45, 'rgba(255,255,255,0.9)'); gr.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = gr; g.fillRect(0, 0, 64, 64);
    var tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    return tex;
  }
  function makePoints(max, size, color, vertexColors) {
    var geo = new THREE.BufferGeometry();
    var pos = new THREE.BufferAttribute(new Float32Array(max * 3), 3);
    pos.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('position', pos);
    if (vertexColors) {
      var col = new THREE.BufferAttribute(new Float32Array(max * 3), 3);
      col.setUsage(THREE.DynamicDrawUsage);
      geo.setAttribute('color', col);
    }
    geo.setDrawRange(0, 0);
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(C.WORLD_W / 2, 0, C.WORLD_H / 2), 1e5);
    var mat = new THREE.PointsMaterial({ size: size, map: M.dot, color: color, transparent: true, depthWrite: false,
      vertexColors: !!vertexColors, opacity: 0.95 });
    var p = new THREE.Points(geo, mat);
    p.frustumCulled = false;
    scene.add(p);
    return { points: p, pos: pos, col: vertexColors ? geo.getAttribute('color') : null, max: max };
  }

  function buildFx() {
    M.dot = dotTexture();
    M.drops = makePoints(1400, 9, 0x9fd8ff, false);
    M.splash = makePoints(1600, 6, 0xffffff, true);

    var ringMat = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.35, depthWrite: false });
    M.rangeRing = new THREE.Mesh(new THREE.RingGeometry(0.985, 1, 96).rotateX(-Math.PI / 2), ringMat);
    scene.add(M.rangeRing);

    M.reticles = [];
    for (var i = 0; i < 3; i++) {
      var g = new THREE.Group();
      var mat = new THREE.MeshBasicMaterial({ color: 0x7fd4ff, transparent: true, opacity: 0.9, depthWrite: false });
      var ring = new THREE.Mesh(new THREE.RingGeometry(0.88, 1, 48).rotateX(-Math.PI / 2), mat);
      g.add(ring);
      var fill = new THREE.Mesh(new THREE.CircleGeometry(1, 40).rotateX(-Math.PI / 2),
        new THREE.MeshBasicMaterial({ color: 0x7fd4ff, transparent: true, opacity: 0.12, depthWrite: false }));
      g.add(fill);
      var cm = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.95, depthWrite: false });
      var c1 = new THREE.Mesh(new THREE.PlaneGeometry(18, 2.5).rotateX(-Math.PI / 2), cm);
      var c2 = new THREE.Mesh(new THREE.PlaneGeometry(2.5, 18).rotateX(-Math.PI / 2), cm);
      c1.position.y = 0.3; c2.position.y = 0.3;
      g.add(c1); g.add(c2);
      var pulse = new THREE.Mesh(new THREE.RingGeometry(0.92, 1, 48).rotateX(-Math.PI / 2),
        new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.5, depthWrite: false }));
      g.add(pulse);
      g.renderOrder = 5;
      scene.add(g);
      M.reticles.push({ group: g, ring: ring, fill: fill, pulse: pulse, mat: mat });
    }

    M.trackMax = 1800;
    M.tracks = new THREE.InstancedMesh(new THREE.PlaneGeometry(6, 9).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({ color: 0x3a2412, transparent: true, opacity: 0.28, depthWrite: false }), M.trackMax);
    dummy.position.set(0, -100, 0); dummy.scale.set(0.001, 0.001, 0.001); dummy.rotation.set(0, 0, 0); dummy.updateMatrix();
    for (var k = 0; k < M.trackMax; k++) M.tracks.setMatrixAt(k, dummy.matrix);
    M.tracks.frustumCulled = false;
    scene.add(M.tracks);
  }

  function clearTracks() {
    dummy.position.set(0, -100, 0); dummy.scale.set(0.001, 0.001, 0.001); dummy.rotation.set(0, 0, 0); dummy.updateMatrix();
    for (var k = 0; k < M.trackMax; k++) M.tracks.setMatrixAt(k, dummy.matrix);
    M.tracks.instanceMatrix.needsUpdate = true;
    fx.lastWheels = null;
  }

  function wheelPoints(t, tr) {
    var ca = Math.cos(t.a), sa = Math.sin(t.a), cb = Math.cos(tr.a), sb = Math.sin(tr.a);
    return [
      { x: t.x - ca * 24 - sa * 19, y: t.y - sa * 24 + ca * 19, a: t.a },
      { x: t.x - ca * 24 + sa * 19, y: t.y - sa * 24 - ca * 19, a: t.a },
      { x: tr.x - sb * 23, y: tr.y + cb * 23, a: tr.a },
      { x: tr.x + sb * 23, y: tr.y - cb * 23, a: tr.a }
    ];
  }
  function inField(x, y) { return x > C.FIELD_X && x < C.FIELD_X + C.FIELD_W && y > C.FIELD_Y && y < C.FIELD_Y + C.FIELD_H; }

  function updateTracks(state) {
    var wp = wheelPoints(state.truck, state.trailer);
    if (fx.lastWheels) {
      var dx = wp[0].x - fx.lastWheels[0].x, dy = wp[0].y - fx.lastWheels[0].y, dd = dx * dx + dy * dy;
      if (dd > 200 * 200) fx.lastWheels = null;
      else if (dd > 64) {
        for (var w = 0; w < 4; w++) {
          var p = wp[w];
          dummy.position.set(p.x, inField(p.x, p.y) ? 10 : 0.8, p.y);
          dummy.rotation.set(0, -p.a + Math.PI / 2, 0); dummy.scale.set(1, 1, 1); dummy.updateMatrix();
          M.tracks.setMatrixAt(fx.trackIdx, dummy.matrix);
          fx.trackIdx = (fx.trackIdx + 1) % M.trackMax;
        }
        M.tracks.instanceMatrix.needsUpdate = true;
        fx.lastWheels = wp;
      }
    }
    if (!fx.lastWheels) fx.lastWheels = wp;
  }

  var NOZ_H = 58;
  function spawnSplash(x, y, z, vx, vy, vz, life, r, g, b) {
    if (fx.splash.length >= M.splash.max) fx.splash.shift();
    fx.splash.push({ x: x, y: y, z: z, vx: vx, vy: vy, vz: vz, t: 0, life: life, r: r, g: g, b: b });
  }

  function updateParticles(state, dt) {
    var sp = state.spray;
    var playing = state.phase === 'playing' && !state.paused;
    var i;
    if (playing && sp.on && dt > 0) {
      fx.spawnAcc += dt * 110 * sp.hits.length;
      while (fx.spawnAcc >= 1) {
        fx.spawnAcc -= 1;
        var h = sp.hits[Math.floor(Math.random() * sp.hits.length)];
        var ang = Math.random() * Math.PI * 2, rad = Math.sqrt(Math.random()) * sp.radius * 0.7;
        var ex = h.x + Math.cos(ang) * rad, ey = h.y + Math.sin(ang) * rad;
        var dx = ex - sp.nozX, dy = ey - sp.nozY, d = Math.sqrt(dx * dx + dy * dy);
        if (fx.drops.length >= M.drops.max) fx.drops.shift();
        fx.drops.push({ sx: sp.nozX + dx / (d || 1) * 26, sy: sp.nozY + dy / (d || 1) * 26, ex: ex, ey: ey, t: 0,
          dur: 0.28 + d / 800, h: 20 + d * 0.3 });
      }
    } else fx.spawnAcc = 0;

    if (playing && sp.sputter && Math.random() < dt * 12) {
      for (var q = 0; q < 3; q++) spawnSplash(sp.nozX, sp.nozY, NOZ_H, (Math.random() - 0.5) * 60, (Math.random() - 0.5) * 60, 60 + Math.random() * 40, 0.5, 0.7, 0.85, 1);
    }
    if (playing && sp.drip && dt > 0) {
      fx.dripAcc += dt * 30;
      while (fx.dripAcc >= 1) {
        fx.dripAcc -= 1;
        spawnSplash(state.trailer.x + (Math.random() - 0.5) * 30, state.trailer.y + (Math.random() - 0.5) * 30, 14, 0, 0, -20, 0.4, 0.6, 0.85, 1);
      }
    }

    var dp = M.drops.pos.array, n = 0;
    for (i = fx.drops.length - 1; i >= 0; i--) {
      var p = fx.drops[i];
      p.t += dt / p.dur;
      if (p.t >= 1) {
        if (Math.random() < 0.4) {
          var a = Math.random() * Math.PI * 2, v = 30 + Math.random() * 80;
          spawnSplash(p.ex, p.ey, 8, Math.cos(a) * v, Math.sin(a) * v, 90 + Math.random() * 90, 0.55, 0.75, 0.9, 1);
        }
        fx.drops.splice(i, 1);
      }
    }
    for (i = 0; i < fx.drops.length; i++) {
      var d0 = fx.drops[i], tt = d0.t;
      dp[n * 3] = lerp(d0.sx, d0.ex, tt);
      dp[n * 3 + 1] = lerp(NOZ_H, 6, tt) + 4 * d0.h * tt * (1 - tt);
      dp[n * 3 + 2] = lerp(d0.sy, d0.ey, tt);
      n++;
    }
    M.drops.points.geometry.setDrawRange(0, n);
    M.drops.pos.needsUpdate = true;

    var sp2 = M.splash.pos.array, sc = M.splash.col.array, m = 0;
    for (i = fx.splash.length - 1; i >= 0; i--) {
      var s = fx.splash[i];
      s.t += dt; s.x += s.vx * dt; s.y += s.vy * dt; s.vz -= 380 * dt; s.z += s.vz * dt;
      if (s.z < 6) { s.z = 6; s.vz = 0; s.vx *= 0.8; s.vy *= 0.8; }
      if (s.t > s.life) fx.splash.splice(i, 1);
    }
    for (i = 0; i < fx.splash.length; i++) {
      var s2 = fx.splash[i], fade = 1 - s2.t / s2.life;
      sp2[m * 3] = s2.x; sp2[m * 3 + 1] = s2.z; sp2[m * 3 + 2] = s2.y;
      sc[m * 3] = s2.r * fade; sc[m * 3 + 1] = s2.g * fade; sc[m * 3 + 2] = s2.b * fade;
      m++;
    }
    M.splash.points.geometry.setDrawRange(0, m);
    M.splash.pos.needsUpdate = true; M.splash.col.needsUpdate = true;
  }

  function updateAim(state) {
    var sp = state.spray, playing = state.phase === 'playing';
    M.rangeRing.visible = playing;
    M.rangeRing.position.set(sp.nozX, 12, sp.nozY);
    M.rangeRing.scale.set(sp.range, 1, sp.range);
    var empty = state.tank.water <= 0.0001;
    for (var i = 0; i < M.reticles.length; i++) {
      var r = M.reticles[i], h = sp.hits[i];
      r.group.visible = playing && !!h;
      if (!h) continue;
      r.group.position.set(h.x, 12, h.y);
      r.ring.scale.set(sp.radius, 1, sp.radius);
      r.fill.scale.set(sp.radius, 1, sp.radius);
      r.mat.color.setHex(empty ? 0xff5a50 : 0x7fd4ff);
      r.fill.material.color.setHex(empty ? 0xff5a50 : 0x7fd4ff);
      var pr = (T * 2.5) % 1;
      r.pulse.visible = sp.on;
      r.pulse.scale.set(sp.radius * (0.3 + pr * 0.7), 1, sp.radius * (0.3 + pr * 0.7));
      r.pulse.material.opacity = 0.6 * (1 - pr);
    }
    // stations
    for (var k = 0; k < M.stationRings.length; k++) {
      var s = M.stationRings[k];
      var dx = s.x - state.trailer.x, dy = s.y - state.trailer.y, inR = dx * dx + dy * dy < s.r * s.r;
      s.ring.material.opacity = inR ? 0.95 : 0.55 + Math.sin(T * 3) * 0.15;
      s.disc.material.opacity = inR ? 0.25 : 0.1;
      if (state.tank.refilling && inR) {
        var p2 = (T * 1.5) % 1, rad = 20 + p2 * (s.r - 20);
        s.pulse.scale.set(rad, 1, rad); s.pulse.material.opacity = 0.8 * (1 - p2);
      } else s.pulse.material.opacity = 0;
    }
  }

  // ---------------------------------------------------------------- DOM overlays (popups, banners, countdown)
  function buildDom() {
    fxLayer = document.createElement('div'); fxLayer.id = 'fx-layer';
    document.body.appendChild(fxLayer);
    bannerEl = document.createElement('div'); bannerEl.className = 'banner'; fxLayer.appendChild(bannerEl);
    countEl = document.createElement('div'); countEl.className = 'countdown'; fxLayer.appendChild(countEl);
  }

  function onEvents(evts) {
    if (!evts || !renderer) return;
    for (var i = 0; i < evts.length; i++) {
      var e = evts[i];
      if (e.type === 'pay') {
        var el = document.createElement('div');
        el.className = 'popup' + (e.bonus ? ' bonus' : '');
        el.innerHTML = '+' + fmtMoney(e.amount) + (e.combo >= 3 ? '<small>x' + e.combo + '</small>' : '');
        fxLayer.appendChild(el);
        fx.pops.push({ el: el, x: e.x, y: e.y, t: 0, life: e.bonus ? 1.6 : 1.1 });
        if (fx.pops.length > 45) { var old = fx.pops.shift(); old.el.remove(); }
        var nS = e.bonus ? 26 : 10;
        for (var k = 0; k < nS; k++) {
          var a = Math.random() * Math.PI * 2, v = 20 + Math.random() * 60;
          if (e.bonus) spawnSplash(e.x, e.y, 10, Math.cos(a) * v, Math.sin(a) * v, 120 + Math.random() * 120, 0.9, 1, 0.85, 0.2);
          else spawnSplash(e.x, e.y, 10, Math.cos(a) * v, Math.sin(a) * v, 90 + Math.random() * 100, 0.7, 0.6, 1, 0.45);
        }
      } else if (e.type === 'roundStart') {
        fx.drops = []; fx.splash = [];
        fx.pops.forEach(function (p) { p.el.remove(); }); fx.pops = [];
        clearTracks();
        camReady = false;
      } else if (e.type === 'go') banner('GO!', '#ffe066', 0.9, false);
      else if (e.type === 'clear') banner('FIELD CLEARED!', '#9ff06a', 2.2, false);
      else if (e.type === 'comboEnd') banner(e.count + 'x COMBO!', '#ffb347', 1.0, true);
      else if (e.type === 'refillFull') banner('TANK FULL', '#8fd3ff', 0.9, true);
    }
  }
  function banner(text, color, life, small) { fx.banners.push({ text: text, color: color, life: life, small: small, t: 0 }); }

  function updateDom(state, dt) {
    for (var i = fx.pops.length - 1; i >= 0; i--) {
      var p = fx.pops[i];
      p.t += dt;
      var q = p.t / p.life;
      if (q >= 1) { p.el.remove(); fx.pops.splice(i, 1); continue; }
      tmpV.set(p.x, 30 + q * 50, p.y).project(camera);
      if (tmpV.z > 1) { p.el.style.opacity = 0; continue; }
      var sx = (tmpV.x + 1) / 2 * W, sy = (1 - tmpV.y) / 2 * H;
      var sc = q < 0.15 ? 0.6 + q / 0.15 * 0.6 : 1.2 - Math.min(0.2, q - 0.15);
      p.el.style.transform = 'translate(' + sx.toFixed(1) + 'px,' + sy.toFixed(1) + 'px) translate(-50%,-50%) scale(' + sc.toFixed(3) + ')';
      p.el.style.opacity = q > 0.7 ? (1 - (q - 0.7) / 0.3).toFixed(2) : '1';
    }
    // banners: show newest
    var b = null;
    for (var j = fx.banners.length - 1; j >= 0; j--) {
      fx.banners[j].t += dt;
      if (fx.banners[j].t > fx.banners[j].life) fx.banners.splice(j, 1);
    }
    if (fx.banners.length) b = fx.banners[fx.banners.length - 1];
    if (b) {
      var qb = b.t / b.life;
      if (bannerEl.textContent !== b.text) bannerEl.textContent = b.text;
      bannerEl.style.color = b.color;
      bannerEl.className = 'banner show' + (b.small ? ' small' : '');
      bannerEl.style.opacity = qb > 0.7 ? (1 - (qb - 0.7) / 0.3).toFixed(2) : '1';
      bannerEl.style.transform = 'translate(-50%,-50%) scale(' + (qb < 0.15 ? 0.7 + qb / 0.15 * 0.3 : 1).toFixed(3) + ')';
    } else if (bannerEl.className !== 'banner') bannerEl.className = 'banner';

    if (state.phase === 'playing' && state.countdown > 0) {
      var nC = Math.ceil(state.countdown), k2 = nC - state.countdown;
      countEl.innerHTML = nC + '<small>Round ' + state.round + '</small>';
      countEl.style.display = 'block';
      countEl.style.transform = 'translate(-50%,-50%) scale(' + (1.5 - k2 * 0.5).toFixed(3) + ')';
    } else countEl.style.display = 'none';
  }

  // ---------------------------------------------------------------- camera
  function updateCamera(state, dt) {
    var t = state.truck, tr = state.trailer, range = state.spray.range || 200;
    var tx, tz, yawT, back, height;
    if (state.phase === 'menu') {
      var ang = T * 0.08;
      tx = C.WORLD_W / 2; tz = C.WORLD_H / 2;
      camTarget.set(tx, 0, tz);
      camera.position.set(tx + Math.cos(ang) * 1500, 900, tz + Math.sin(ang) * 1100);
      camera.lookAt(camTarget);
      camReady = false;
      return;
    }
    tx = t.x * 0.55 + tr.x * 0.45; tz = t.y * 0.55 + tr.y * 0.45;
    if (camMode === 'chase') {
      yawT = t.a;
      tx += Math.cos(t.a) * 50; tz += Math.sin(t.a) * 50;
      back = 230 + range * 0.85; height = 280 + range * 0.95;
    } else {
      yawT = -Math.PI / 2;
      back = 300 + range * 0.4; height = 1050 + range * 0.8;
    }
    if (!camReady) {
      camYaw = yawT; camTarget.set(tx, 0, tz);
    } else {
      // lagged yaw follow, slower at low speed so it doesn't whip around when turning on the spot
      var spd = Math.min(1, Math.abs(t.v) / 150);
      var ky = 1 - Math.exp(-dt * (0.6 + 1.4 * spd));
      camYaw = wrap(camYaw + wrap(yawT - camYaw) * (camMode === 'chase' ? ky : 1 - Math.exp(-dt * 4)));
      var kt = 1 - Math.exp(-dt * 5);
      camTarget.x += (tx - camTarget.x) * kt; camTarget.z += (tz - camTarget.z) * kt;
    }
    var desired = new THREE.Vector3(camTarget.x - Math.cos(camYaw) * back, height, camTarget.z - Math.sin(camYaw) * back);
    if (!camReady) camPos.copy(desired);
    else camPos.lerp(desired, 1 - Math.exp(-dt * 4));
    camReady = true;
    camera.position.copy(camPos);
    camera.lookAt(camTarget);
  }

  // ---------------------------------------------------------------- main draw
  function draw(state, view) {
    if (!renderer) return;
    var dt = state.paused ? 0 : Math.min(0.1, (view && view.dt) || 0);
    T += dt;
    updateTiles(state);
    updateVehicles(state, dt);
    if (state.phase === 'playing') updateTracks(state);
    updateParticles(state, dt);
    updateAim(state);
    updateCamera(state, (view && view.dt) || 0);
    if (M.pondWater) M.pondWater.material.color.setHSL(0.58, 0.65, 0.48 + Math.sin(T * 2) * 0.03);

    var f = new THREE.Vector3(); camera.getWorldDirection(f);
    var L = Math.sqrt(f.x * f.x + f.z * f.z) || 1;
    camInfo.forward.x = f.x / L; camInfo.forward.y = f.z / L;

    sun.position.set(camTarget.x + 400, 1000, camTarget.z + 250);
    sun.target.position.set(camTarget.x, 0, camTarget.z);
    renderer.render(scene, camera);
    updateDom(state, dt);
  }

  SOD.Render = {
    available: function () { return true; },
    init: init,
    resize: resize,
    draw: draw,
    onEvents: onEvents,
    camInfo: camInfo,
    toggleCamera: function () { camMode = camMode === 'chase' ? 'overview' : 'chase'; camReady = camReady && true; return camMode; },
    getCameraMode: function () { return camMode; }
  };
})();
