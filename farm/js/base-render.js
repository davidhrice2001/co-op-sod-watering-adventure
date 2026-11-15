/* Sod Farm - HOME BASE renderer (three.js r160 global build).  Attaches to window.SOD.BaseRender
 * Only READS state. Holds derived/transient things only (meshes, particles, popups), diffed by cell index and
 * value, so a brand-new (deserialized) state object every frame is fine. Sim (x, y) -> three (x, 0, y);
 * sim angle a -> rotation.y = -a. Cell tops sit at y = TOP (2).
 *
 *   SOD.BaseRender.init(canvas) -> bool      (false if THREE missing or WebGL fails)
 *   SOD.BaseRender.resize(w, h)              (CSS pixels; devicePixelRatio capped at 2)
 *   SOD.BaseRender.draw(state, view)         view = {dt, cameraMode:'overview'|'chase', hover:null|{c,r,kind,ok,w,h},
 *                                                   showPipes, tool, localAim:null|{x,y}}
 *   SOD.BaseRender.onEvents(events)
 *   SOD.BaseRender.camInfo = {screenToGround(sx,sy)->{x,y}|null, worldToScreen(x,y,h)->{x,y,visible}, forward:{x,y}}
 *   SOD.BaseRender.panBy(dxWorld, dyWorld)   overview camera target shift in sim world units
 *   SOD.BaseRender.zoomBy(factor)            factor > 1 zooms IN (camera distance / factor), < 1 zooms out
 *   SOD.BaseRender.recenter()                overview back to the owned land, default zoom
 */
(function () {
  'use strict';
  var SOD = (window.SOD = window.SOD || {});

  var TOP = 2, T = 0;
  var S, C, TILE, COLS, ROWS, N;           // sim module + constants (set in init)
  var renderer = null, scene, camera, sun, hemi, canvasEl, layer;
  var W = 800, H = 600;
  var dummy, tmpColor, tmpV, tmpV2;
  var M = {}, GEO = {}, MAT = {};
  var cells = null;                          // per-cell derived caches (plain arrays of numbers)
  var structs = [];                          // per-cell structure objects
  var ghosts = {};
  var fx = { drops: [], small: [], big: [], pops: [], spawnAcc: 0, lastWheels: null, trackIdx: 0, wheelSpin: 0 };
  var last = { truckX: 0, truckY: 0, trailerX: 0, trailerY: 0, rackX: null, rackY: 0, tankPos: {} };
  var cam = { ready: false, pos: null, target: null, yaw: 0, panX: 0, panY: 0, dist: 900, defDist: 900,
    centred: false, ownCX: 560, ownCY: 560, ownSize: 320 };
  var OV_PITCH = 0.95; // radians above horizon for the overview camera

  var camInfo = {
    forward: { x: 0, y: -1 },
    screenToGround: function (sx, sy) {
      if (!camera) return null;
      tmpV.set(sx / W * 2 - 1, -(sy / H) * 2 + 1, 0.5).unproject(camera);
      tmpV.sub(camera.position).normalize();
      if (tmpV.y > -0.01) return null;
      var t = (TOP - camera.position.y) / tmpV.y;
      return { x: camera.position.x + tmpV.x * t, y: camera.position.z + tmpV.z * t };
    },
    worldToScreen: function (x, y, h) {
      if (!camera) return { x: 0, y: 0, visible: false };
      tmpV2.set(x, h || 0, y).project(camera);
      return { x: (tmpV2.x + 1) / 2 * W, y: (1 - tmpV2.y) / 2 * H,
        visible: tmpV2.z < 1 && tmpV2.x > -1.1 && tmpV2.x < 1.1 && tmpV2.y > -1.1 && tmpV2.y < 1.1 };
    }
  };

  // ---------------------------------------------------------------- utils
  function lcg(seed) { var s = seed >>> 0; return function () { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; }; }
  function hash(n) { var x = Math.sin(n * 127.1 + 311.7) * 43758.5453; return x - Math.floor(x); }
  function lerp(a, b, t) { return a + (b - a) * t; }
  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
  function mix(c1, c2, t) { return [lerp(c1[0], c2[0], t), lerp(c1[1], c2[1], t), lerp(c1[2], c2[2], t)]; }
  function wrap(a) { while (a > Math.PI) a -= Math.PI * 2; while (a < -Math.PI) a += Math.PI * 2; return a; }
  function setRGB(arr) { tmpColor.setRGB(arr[0] / 255, arr[1] / 255, arr[2] / 255, THREE.SRGBColorSpace); return tmpColor; }
  function fmtMoney(n) { return '$' + Math.round(Math.abs(n)).toLocaleString('en-US'); }
  function num(v, d) { return typeof v === 'number' && isFinite(v) ? v : d; }
  function cx(c) { return (c + 0.5) * TILE; }

  function geo(key, make) { return GEO[key] || (GEO[key] = make()); }
  function gBox(w, h, d) { return geo('b' + w + ',' + h + ',' + d, function () { return new THREE.BoxGeometry(w, h, d); }); }
  function gCyl(rt, rb, h, s) { return geo('c' + rt + ',' + rb + ',' + h + ',' + s, function () { return new THREE.CylinderGeometry(rt, rb, h, s); }); }
  function lam(hex, extra) {
    var key = hex + (extra ? JSON.stringify(extra) : '');
    if (MAT[key]) return MAT[key];
    var o = { color: hex };
    if (extra) for (var k in extra) o[k] = extra[k];
    return (MAT[key] = new THREE.MeshLambertMaterial(o));
  }
  function mesh(g, mat, x, y, z, parent, shadow) {
    var m = new THREE.Mesh(g, mat);
    m.position.set(x || 0, y || 0, z || 0);
    if (shadow !== false) m.castShadow = true;
    if (parent) parent.add(m);
    return m;
  }
  function box(w, h, d, mat, x, y, z, parent, shadow) { return mesh(gBox(w, h, d), mat, x, y, z, parent, shadow); }
  var HIDE = null;
  function hideMatrix() {
    if (!HIDE) HIDE = new THREE.Matrix4().compose(new THREE.Vector3(0, -500, 0), new THREE.Quaternion(), new THREE.Vector3(0.001, 0.001, 0.001));
    return HIDE;
  }
  function instanced(g, mat, count, colors) {
    var im = new THREE.InstancedMesh(g, mat, count);
    var hm = hideMatrix();
    for (var i = 0; i < count; i++) im.setMatrixAt(i, hm);
    if (colors) { tmpColor.setRGB(1, 1, 1); for (var j = 0; j < count; j++) im.setColorAt(j, tmpColor); }
    im.frustumCulled = false;
    scene.add(im);
    return im;
  }

  // ---------------------------------------------------------------- init
  function init(canvas) {
    if (renderer) return true;
    if (typeof THREE === 'undefined' || !SOD.BaseSim) return false;
    try {
      renderer = new THREE.WebGLRenderer({ canvas: canvas, antialias: true, powerPreference: 'high-performance' });
    } catch (e) { renderer = null; return false; }
    if (!renderer.getContext()) { renderer = null; return false; }
    S = SOD.BaseSim; C = S.C; TILE = C.TILE; COLS = C.COLS; ROWS = C.ROWS; N = COLS * ROWS;
    dummy = new THREE.Object3D(); tmpColor = new THREE.Color(); tmpV = new THREE.Vector3(); tmpV2 = new THREE.Vector3();
    cam.pos = new THREE.Vector3(); cam.target = new THREE.Vector3();
    canvasEl = canvas;
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFShadowMap;
    scene = new THREE.Scene();
    scene.background = new THREE.Color(0xa8dcff);
    scene.fog = new THREE.Fog(0xa8dcff, 2600, 7000);
    camera = new THREE.PerspectiveCamera(45, 1, 10, 12000);
    hemi = new THREE.HemisphereLight(0xe4f4ff, 0x5d7a3c, 1.5);
    scene.add(hemi);
    sun = new THREE.DirectionalLight(0xfff0d0, 2.3);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    var sc = sun.shadow.camera;
    sc.left = -760; sc.right = 760; sc.top = 760; sc.bottom = -760; sc.near = 50; sc.far = 3200;
    sun.shadow.bias = -0.0006; sun.shadow.normalBias = 1.5;
    scene.add(sun); scene.add(sun.target);

    cells = { key: new Array(N), owned: new Array(N), pipeKey: new Array(N), net: new Array(N) };
    for (var i = 0; i < N; i++) { cells.key[i] = -1; cells.owned[i] = -1; cells.pipeKey[i] = -1; cells.net[i] = -2; structs[i] = null; }

    buildWorld();
    buildCells();
    buildPipes();
    buildVehicles();
    buildFx();
    buildOverlay();
    buildDom(canvas);
    resize(canvas.clientWidth || W, canvas.clientHeight || H);
    return true;
  }

  function resize(w, h) {
    W = Math.max(1, w | 0); H = Math.max(1, h | 0);
    if (!renderer) return;
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.setSize(W, H, false);
    camera.aspect = W / H;
    camera.updateProjectionMatrix();
    placeLayer();
  }
  function placeLayer() {
    if (!layer || !canvasEl) return;
    layer.style.left = canvasEl.offsetLeft + 'px'; layer.style.top = canvasEl.offsetTop + 'px';
    layer.style.width = W + 'px'; layer.style.height = H + 'px';
  }

  // ---------------------------------------------------------------- world / scenery
  function buildWorld() {
    var R = lcg(9001), WW = C.WORLD_W, WH = C.WORLD_H;
    var g = mesh(new THREE.PlaneGeometry(WW + 12000, WH + 12000).rotateX(-Math.PI / 2), lam(0x6a8c42), WW / 2, -0.5, WH / 2, scene, false);
    g.receiveShadow = true;
    // dark soil skirt under the grid so its edge reads
    box(WW + 12, 3, WH + 12, lam(0x5b4a30), WW / 2, -0.6, WH / 2, scene, false);

    // road leaving the property to the east (the exit to job sites)
    var roadZ = WH * 0.57;
    var road = mesh(new THREE.PlaneGeometry(6000, 64).rotateX(-Math.PI / 2), lam(0xb99a6c), WW + 3000, 0.2, roadZ, scene, false);
    road.receiveShadow = true;
    var stripe = new THREE.InstancedMesh(gBox(40, 0.4, 4), lam(0xf4e7b0), 60);
    for (var s = 0; s < 60; s++) { dummy.position.set(WW + 60 + s * 100, 0.5, roadZ); dummy.rotation.set(0, 0, 0); dummy.scale.set(1, 1, 1); dummy.updateMatrix(); stripe.setMatrixAt(s, dummy.matrix); }
    scene.add(stripe);
    // gate posts + mailbox where the road meets the grid
    box(8, 46, 8, lam(0x7a5230), WW + 30, 23, roadZ - 42, scene);
    box(8, 46, 8, lam(0x7a5230), WW + 30, 23, roadZ + 42, scene);
    box(6, 6, 92, lam(0x7a5230), WW + 30, 46, roadZ, scene);
    box(4, 26, 4, lam(0x6b6b6b), WW + 60, 13, roadZ - 46, scene);
    box(12, 10, 8, lam(0x3b6fb0), WW + 60, 30, roadZ - 46, scene);
    // gravel driveway north to the farmhouse
    var drive = mesh(new THREE.PlaneGeometry(56, 300).rotateX(-Math.PI / 2), lam(0xc4ad84), WW * 0.42, 0.15, -150, scene, false);
    drive.receiveShadow = true;

    addHouse(WW * 0.30, -240, 0, 0xf2e2c4, 0xb5483a);
    addBarn(WW * 0.68, -260);

    // trees around the property (outside the grid), keep the road and buildings clear
    var trees = [];
    for (var i = 0; i < 220 && trees.length < 170; i++) {
      var side = Math.floor(R() * 4), along = R(), out = 70 + R() * 900, tx, tz;
      if (side === 0) { tx = -900 + along * (WW + 1800); tz = -out; }
      else if (side === 1) { tx = -900 + along * (WW + 1800); tz = WH + out; }
      else if (side === 2) { tx = -out; tz = along * WH; }
      else { tx = WW + out; tz = along * WH; }
      if (Math.abs(tz - roadZ) < 90 && tx > WW) continue;
      if (tz < 0 && tz > -460 && tx > WW * 0.1 && tx < WW * 0.95) continue;
      trees.push([tx, tz, 0.7 + R() * 0.9, R()]);
    }
    var trunk = new THREE.InstancedMesh(gCyl(5, 7, 34, 6), lam(0x7a5230), trees.length);
    var crown = new THREE.InstancedMesh(new THREE.IcosahedronGeometry(30, 0), lam(0xffffff, { flatShading: true }), trees.length);
    trees.forEach(function (t, k) {
      var sc = t[2];
      dummy.position.set(t[0], 17 * sc, t[1]); dummy.scale.set(sc, sc, sc); dummy.rotation.set(0, t[3] * 6, 0); dummy.updateMatrix();
      trunk.setMatrixAt(k, dummy.matrix);
      dummy.position.set(t[0], 56 * sc, t[1]); dummy.scale.set(sc, sc * 1.15, sc); dummy.updateMatrix();
      crown.setMatrixAt(k, dummy.matrix);
      tmpColor.setRGB(0.22 + t[3] * 0.12, 0.46 + t[3] * 0.15, 0.17, THREE.SRGBColorSpace);
      crown.setColorAt(k, tmpColor);
    });
    trunk.castShadow = true; crown.castShadow = true;
    scene.add(trunk); scene.add(crown);
  }
  function addHouse(x, z, rot, wall, roof) {
    var g = new THREE.Group();
    box(170, 90, 130, lam(wall), 0, 45, 0, g);
    var r = mesh(new THREE.ConeGeometry(130, 70, 4), lam(roof, { flatShading: true }), 0, 125, 0, g);
    r.rotation.y = Math.PI / 4; r.scale.set(1, 1, 0.8);
    var dark = lam(0x5a3a22), glass = lam(0x9fd0ef, { emissive: 0x223344 });
    box(26, 46, 4, dark, 0, 23, 66, g);
    box(30, 26, 4, glass, -52, 54, 66, g); box(30, 26, 4, glass, 52, 54, 66, g);
    box(18, 40, 18, lam(0x8a6a5a), 50, 140, -20, g);
    box(190, 6, 40, lam(0xd8c9a8), 0, 3, 86, g, false); // porch
    g.position.set(x, 0, z); g.rotation.y = rot;
    scene.add(g);
  }
  function addBarn(x, z) {
    var g = new THREE.Group();
    box(220, 110, 150, lam(0xb8352b), 0, 55, 0, g);
    var roof = mesh(new THREE.CylinderGeometry(80, 80, 224, 4, 1, false, 0, Math.PI).rotateZ(Math.PI / 2), lam(0x5a5f66, { flatShading: true }), 0, 110, 0, g);
    roof.scale.set(1, 0.6, 1);
    box(70, 80, 4, lam(0xf2efe6), 0, 40, 76, g);
    mesh(gCyl(36, 36, 200, 16), lam(0xc9ccd1), 160, 100, 0, g);
    mesh(new THREE.SphereGeometry(36, 16, 8, 0, Math.PI * 2, 0, Math.PI / 2), lam(0x9aa0a8), 160, 200, 0, g);
    g.position.set(x, 0, z);
    scene.add(g);
  }

  // ---------------------------------------------------------------- cells
  function buildCells() {
    M.tiles = instanced(gBox(TILE, 4, TILE), lam(0xffffff), N, true);
    M.tiles.receiveShadow = true;
    M.turf = instanced(gBox(TILE - 5, 1, TILE - 5).translate(0, 0.5, 0), lam(0xffffff), N, true);
    M.turf.receiveShadow = true;
    M.blades = instanced(new THREE.ConeGeometry(2.2, 9, 4).translate(0, 4.5, 0), lam(0xffffff, { flatShading: true }), N * 5, true);
    M.wild = instanced(new THREE.ConeGeometry(2.6, 9, 4).translate(0, 4.5, 0), lam(0x86a24e, { flatShading: true }), N * 3, false);
    M.ready = instanced(new THREE.OctahedronGeometry(5.5), lam(0xffd23a, { emissive: 0x7a5200 }), N, false);
    M.ready.count = 0; M.ready.castShadow = true;
    M.readyRing = instanced(new THREE.RingGeometry(15, 18, 28).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({ color: 0xfff2a0, transparent: true, opacity: 0.65, depthWrite: false }), N, false);
    M.readyRing.count = 0;
    // fence around owned land
    M.fenceMax = 700;
    M.rails = instanced(gBox(TILE, 3, 2.5), lam(0xf1e6cc), M.fenceMax * 2, false); M.rails.castShadow = true;
    M.posts = instanced(gBox(5, 22, 5), lam(0xe8dcbc), M.fenceMax, false); M.posts.castShadow = true;
    // land-parcel outlines (land tool)
    M.parcelLines = instanced(gBox(1, 1, 1), new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.8, depthWrite: false }), 49 * 4, true);
    M.parcelLines.renderOrder = 6; M.parcelLines.visible = false;
    M.parcelSig = '';
  }

  var C_OWN_A = [118, 178, 76], C_OWN_B = [108, 168, 70], C_WILD = [128, 146, 80];
  var C_DIRT_DRY = [160, 112, 66], C_DIRT_WET = [86, 56, 34];
  var C_SPROUT = [150, 196, 82], C_GROWN = [70, 150, 50], C_GROWN_BLUE = [58, 136, 92];
  var C_DRY = [168, 160, 74], C_SICK = [204, 174, 92], C_LUSH_A = [74, 178, 58], C_LUSH_B = [64, 164, 54];

  function q(v, n) { return Math.round(clamp(num(v, 0), 0, 1) * n); }

  function updateCells(state) {
    var g = state.ground, own = state.owned;
    var tileC = false, tileM = false, turfC = false, turfM = false, bladeC = false, bladeM = false, wildM = false, ownChanged = false;
    for (var i = 0; i < N; i++) {
      var gr = g[i] | 0, o = own[i] | 0, grow = num(state.growth[i], 0), moist = num(state.moist[i], 0), hl = num(state.health[i], 1);
      var st = state.sodType[i] | 0;
      var key = gr * 1e7 + o * 1e6 + (st + 1) * 1e5 + q(grow, 20) * 1e3 + q(moist, 10) * 10 + q(hl, 9);
      if (cells.owned[i] !== o) {
        ownChanged = true;
        var c0 = i % COLS, r0 = (i - c0) / COLS;
        for (var k = 0; k < 3; k++) {
          if (!o && k < 2) {
            var s = 0.7 + hash(i * 7 + k) * 0.8;
            dummy.position.set(cx(c0) + (hash(i * 3 + k) - 0.5) * 32, TOP, cx(r0) + (hash(i * 5 + k + 0.3) - 0.5) * 32);
            dummy.scale.set(s, s, s); dummy.rotation.set((hash(i + k) - 0.5) * 0.4, hash(i + k * 2) * 3, 0); dummy.updateMatrix();
            M.wild.setMatrixAt(i * 3 + k, dummy.matrix);
          } else M.wild.setMatrixAt(i * 3 + k, hideMatrix());
        }
        wildM = true;
        cells.owned[i] = o;
      }
      if (cells.key[i] === key) continue;
      cells.key[i] = key;
      var c = i % COLS, r = (i - c) / COLS, x = cx(c), z = cx(r), col, inset = 1;
      if (gr === 0) {
        if (o) col = (c % 2 === 0) ? C_OWN_A : C_OWN_B;
        else { var v = hash(i * 1.7) * 0.12 - 0.06; col = [C_WILD[0] * (1 + v), C_WILD[1] * (1 + v), C_WILD[2] * (1 + v)]; }
      } else {
        col = mix(C_DIRT_DRY, C_DIRT_WET, Math.pow(clamp(moist, 0, 1), 0.7));
        inset = 0.95;
      }
      M.tiles.setColorAt(i, setRGB(col)); tileC = true;
      dummy.position.set(x, 0, z); dummy.rotation.set(0, 0, 0); dummy.scale.set(inset, 1, inset); dummy.updateMatrix();
      M.tiles.setMatrixAt(i, dummy.matrix); tileM = true;

      // turf + blades
      if (gr === 2) {
        var ready = grow >= 0.999;
        var tcol;
        if (ready) tcol = ((c + r) % 2 === 0) ? C_LUSH_A : C_LUSH_B;
        else tcol = mix(C_SPROUT, st === 1 ? C_GROWN_BLUE : C_GROWN, Math.pow(grow, 0.8));
        if (ready && st === 1) tcol = mix(tcol, C_GROWN_BLUE, 0.5);
        var dryness = clamp((0.3 - moist) / 0.3, 0, 1);
        tcol = mix(tcol, C_DRY, dryness * 0.55);
        var wet = clamp(moist, 0, 1) * 0.14;
        tcol = [tcol[0] * (1 - wet), tcol[1] * (1 - wet * 0.6), tcol[2] * (1 - wet * 0.4)];
        tcol = mix(tcol, C_SICK, (1 - clamp(hl, 0, 1)) * 0.85);
        var th = ready ? 6 : 0.4 + grow * 4.6, sxz = ready ? 1 : 0.25 + 0.75 * Math.pow(grow, 0.7);
        M.turf.setColorAt(i, setRGB(tcol)); turfC = true;
        dummy.position.set(x, TOP, z); dummy.rotation.set(0, 0, 0); dummy.scale.set(sxz, th, sxz); dummy.updateMatrix();
        M.turf.setMatrixAt(i, dummy.matrix); turfM = true;
        var bcol = mix(tcol, [210, 240, 120], 0.18);
        for (var b = 0; b < 5; b++) {
          var bs = ready ? 0.7 + hash(i * 5 + b) * 0.4 : 0.35 + grow * 0.8;
          var spread = ready ? 30 : 12 + grow * 18;
          dummy.position.set(x + (hash(i * 11 + b) - 0.5) * spread, TOP + th * 0.7, z + (hash(i * 13 + b + 0.5) - 0.5) * spread);
          dummy.rotation.set((hash(i + b * 3) - 0.5) * 0.5, hash(i * 2 + b) * 3, (hash(i + b * 5) - 0.5) * 0.5);
          dummy.scale.set(bs, bs * (hl < 0.4 ? 0.6 : 1), bs); dummy.updateMatrix();
          M.blades.setMatrixAt(i * 5 + b, dummy.matrix);
          M.blades.setColorAt(i * 5 + b, setRGB(bcol));
        }
        bladeC = bladeM = true;
      } else {
        M.turf.setMatrixAt(i, hideMatrix()); turfM = true;
        for (var b2 = 0; b2 < 5; b2++) M.blades.setMatrixAt(i * 5 + b2, hideMatrix());
        bladeM = true;
      }
    }
    if (tileC) M.tiles.instanceColor.needsUpdate = true;
    if (tileM) M.tiles.instanceMatrix.needsUpdate = true;
    if (turfC) M.turf.instanceColor.needsUpdate = true;
    if (turfM) M.turf.instanceMatrix.needsUpdate = true;
    if (bladeC) M.blades.instanceColor.needsUpdate = true;
    if (bladeM) M.blades.instanceMatrix.needsUpdate = true;
    if (wildM) M.wild.instanceMatrix.needsUpdate = true;
    if (ownChanged) { rebuildFence(state); ownExtent(state); }

    // ready markers (bob + pulse ring) - per frame, ready cells only
    var n = 0;
    for (var j = 0; j < N; j++) {
      if (g[j] !== 2 || num(state.growth[j], 0) < 0.999) continue;
      var cc = j % COLS, rr = (j - cc) / COLS, ph = T * 2.4 + j * 0.7;
      dummy.position.set(cx(cc), TOP + 22 + Math.sin(ph) * 4, cx(rr)); dummy.rotation.set(0, T * 2 + j, 0); dummy.scale.set(1, 1.4, 1); dummy.updateMatrix();
      M.ready.setMatrixAt(n, dummy.matrix);
      var p = ((T * 0.8 + hash(j)) % 1);
      dummy.position.set(cx(cc), TOP + 6.5, cx(rr)); dummy.rotation.set(0, 0, 0); dummy.scale.set(0.5 + p * 0.8, 1, 0.5 + p * 0.8); dummy.updateMatrix();
      M.readyRing.setMatrixAt(n, dummy.matrix);
      n++;
    }
    M.ready.count = n; M.readyRing.count = n;
    M.ready.instanceMatrix.needsUpdate = true; M.readyRing.instanceMatrix.needsUpdate = true;
  }

  function ownedAt(state, c, r) { return c >= 0 && r >= 0 && c < COLS && r < ROWS && state.owned[r * COLS + c] === 1; }
  function rebuildFence(state) {
    var edges = 0, posts = {}, pc = 0, hm = hideMatrix(), i;
    function post(x, z) {
      var k = x + ',' + z;
      if (posts[k] || pc >= M.fenceMax) return;
      posts[k] = 1;
      dummy.position.set(x, TOP + 11, z); dummy.rotation.set(0, 0, 0); dummy.scale.set(1, 1, 1); dummy.updateMatrix();
      M.posts.setMatrixAt(pc++, dummy.matrix);
    }
    function edge(x0, z0, x1, z1) {
      if (edges >= M.fenceMax) return;
      var mx = (x0 + x1) / 2, mz = (z0 + z1) / 2, rot = x0 === x1 ? Math.PI / 2 : 0;
      for (var h = 0; h < 2; h++) {
        dummy.position.set(mx, TOP + 8 + h * 10, mz); dummy.rotation.set(0, rot, 0); dummy.scale.set(1, 1, 1); dummy.updateMatrix();
        M.rails.setMatrixAt(edges * 2 + h, dummy.matrix);
      }
      edges++;
      post(x0, z0); post(x1, z1);
    }
    for (var r = 0; r < ROWS; r++) for (var c = 0; c < COLS; c++) {
      if (!ownedAt(state, c, r)) continue;
      var x0 = c * TILE, z0 = r * TILE, x1 = x0 + TILE, z1 = z0 + TILE;
      if (!ownedAt(state, c, r - 1)) edge(x0, z0, x1, z0);
      if (!ownedAt(state, c, r + 1)) edge(x0, z1, x1, z1);
      if (!ownedAt(state, c - 1, r)) edge(x0, z0, x0, z1);
      if (!ownedAt(state, c + 1, r)) edge(x1, z0, x1, z1);
    }
    for (i = edges * 2; i < M.fenceMax * 2; i++) M.rails.setMatrixAt(i, hm);
    for (i = pc; i < M.fenceMax; i++) M.posts.setMatrixAt(i, hm);
    M.rails.instanceMatrix.needsUpdate = true; M.posts.instanceMatrix.needsUpdate = true;
    M.parcelSig = '';
  }
  function ownExtent(state) {
    var c0 = 1e9, c1 = -1, r0 = 1e9, r1 = -1;
    for (var i = 0; i < N; i++) if (state.owned[i] === 1) {
      var c = i % COLS, r = (i - c) / COLS;
      if (c < c0) c0 = c; if (c > c1) c1 = c; if (r < r0) r0 = r; if (r > r1) r1 = r;
    }
    if (c1 < 0) { c0 = 0; c1 = COLS - 1; r0 = 0; r1 = ROWS - 1; }
    cam.ownCX = (c0 + c1 + 1) / 2 * TILE; cam.ownCY = (r0 + r1 + 1) / 2 * TILE;
    cam.ownSize = Math.max(c1 - c0 + 1, r1 - r0 + 1) * TILE;
    cam.defDist = clamp((cam.ownSize + 260) / (2 * Math.tan(camera.fov * Math.PI / 360)) * 0.95, 320, 2400);
    if (!cam.centred) { cam.centred = true; recenter(); }
  }

  function updateParcels(state, show) {
    M.parcelLines.visible = show;
    if (!show) return;
    var parcels = S.landParcels(state);
    var sig = '';
    for (var p = 0; p < parcels.length; p++) sig += parcels[p].owned ? 'o' : parcels[p].buyable ? 'b' : '-';
    if (sig === M.parcelSig) return;
    M.parcelSig = sig;
    var n = 0, hm = hideMatrix();
    for (var k = 0; k < parcels.length; k++) {
      var pa = parcels[k];
      if (pa.owned) continue;
      var x0 = pa.c0 * TILE + 4, x1 = (pa.c1 + 1) * TILE - 4, z0 = pa.r0 * TILE + 4, z1 = (pa.r1 + 1) * TILE - 4;
      var w = pa.buyable ? 3 : 1.6;
      var col = pa.buyable ? [255, 226, 90] : [235, 240, 230];
      var segs = [[(x0 + x1) / 2, z0, x1 - x0, w], [(x0 + x1) / 2, z1, x1 - x0, w], [x0, (z0 + z1) / 2, w, z1 - z0], [x1, (z0 + z1) / 2, w, z1 - z0]];
      for (var s = 0; s < 4; s++) {
        dummy.position.set(segs[s][0], TOP + 1.2, segs[s][1]); dummy.rotation.set(0, 0, 0); dummy.scale.set(segs[s][2], 0.6, segs[s][3]); dummy.updateMatrix();
        M.parcelLines.setMatrixAt(n, dummy.matrix);
        M.parcelLines.setColorAt(n, setRGB(pa.buyable ? col : mix(col, [120, 140, 100], 0.4)));
        n++;
      }
    }
    for (var j = n; j < 49 * 4; j++) M.parcelLines.setMatrixAt(j, hm);
    M.parcelLines.instanceMatrix.needsUpdate = true;
    if (M.parcelLines.instanceColor) M.parcelLines.instanceColor.needsUpdate = true;
  }

  // ---------------------------------------------------------------- pipes + network tint
  function buildPipes() {
    M.pipeMat = lam(0x8a96a3);
    M.pipeXray = new THREE.MeshBasicMaterial({ color: 0x4fc3ff, transparent: true, opacity: 0.95, depthTest: false, depthWrite: false });
    M.hubs = instanced(gCyl(4.2, 4.2, 4.5, 10), M.pipeMat, N, false);
    M.arms = instanced(gBox(TILE / 2, 3.2, 3.2).translate(TILE / 4, 0, 0), M.pipeMat, N * 4, false);
    M.tint = instanced(new THREE.PlaneGeometry(TILE - 3, TILE - 3).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.42, depthWrite: false }), N, true);
    M.tint.renderOrder = 3;
  }
  function connects(state, i) { var s = state.struct[i] | 0; return state.pipe[i] === 1 || (s >= 1 && s <= 4); }
  var NET_HUES = [0.06, 0.86, 0.74, 0.0, 0.62, 0.94, 0.12, 0.8];
  function netColor(id) { tmpColor.setHSL(NET_HUES[((id % 8) + 8) % 8], 0.9, 0.45); return tmpColor; }

  function updatePipes(state, showPipes) {
    var dirty = false, netDirty = false, i;
    var ncell = (state.net && state.net.cell) || [];
    for (i = 0; i < N; i++) {
      var pk = (state.pipe[i] === 1 ? 1 : 0) * 8 + (state.struct[i] | 0);
      if (cells.pipeKey[i] !== pk) { cells.pipeKey[i] = pk; dirty = true; }
      var nc = typeof ncell[i] === 'number' ? ncell[i] : -1;
      if (cells.net[i] !== nc) { cells.net[i] = nc; netDirty = true; }
    }
    if (dirty) {
      var hm = hideMatrix(), dirs = [[1, 0], [0, 1], [-1, 0], [0, -1]];
      for (i = 0; i < N; i++) {
        var c = i % COLS, r = (i - c) / COLS, has = state.pipe[i] === 1;
        if (has) {
          dummy.position.set(cx(c), TOP + 0.6, cx(r)); dummy.rotation.set(0, 0, 0); dummy.scale.set(1, 1, 1); dummy.updateMatrix();
          M.hubs.setMatrixAt(i, dummy.matrix);
        } else M.hubs.setMatrixAt(i, hm);
        for (var d = 0; d < 4; d++) {
          var nc2 = c + dirs[d][0], nr = r + dirs[d][1], j = nr * COLS + nc2, on = false;
          if (has && nc2 >= 0 && nr >= 0 && nc2 < COLS && nr < ROWS) on = connects(state, j);
          // a structure next to a pipe also gets an arm from its side so the joint reads from both ends
          if (!has && !on && (state.struct[i] | 0) >= 1 && (state.struct[i] | 0) <= 4 && nc2 >= 0 && nr >= 0 && nc2 < COLS && nr < ROWS) on = state.pipe[j] === 1;
          if (on) {
            dummy.position.set(cx(c), TOP + 0.6, cx(r)); dummy.rotation.set(0, -Math.atan2(dirs[d][1], dirs[d][0]), 0); dummy.scale.set(1, 1, 1); dummy.updateMatrix();
            M.arms.setMatrixAt(i * 4 + d, dummy.matrix);
          } else M.arms.setMatrixAt(i * 4 + d, hm);
        }
      }
      M.hubs.instanceMatrix.needsUpdate = true; M.arms.instanceMatrix.needsUpdate = true;
    }
    if (netDirty) {
      var hm2 = hideMatrix();
      for (i = 0; i < N; i++) {
        if (cells.net[i] >= 0) {
          var c3 = i % COLS, r3 = (i - c3) / COLS;
          dummy.position.set(cx(c3), TOP + 0.9, cx(r3)); dummy.rotation.set(0, 0, 0); dummy.scale.set(1, 1, 1); dummy.updateMatrix();
          M.tint.setMatrixAt(i, dummy.matrix);
          M.tint.setColorAt(i, netColor(cells.net[i]));
        } else M.tint.setMatrixAt(i, hm2);
      }
      M.tint.instanceMatrix.needsUpdate = true; M.tint.instanceColor.needsUpdate = true;
    }
    var mat = showPipes ? M.pipeXray : M.pipeMat;
    if (M.hubs.material !== mat) { M.hubs.material = mat; M.arms.material = mat; }
    M.hubs.renderOrder = M.arms.renderOrder = showPipes ? 8 : 0;
    M.hubs.castShadow = M.arms.castShadow = !showPipes;
    M.tint.visible = !!showPipes;
    if (showPipes) M.pipeXray.color.setHSL(0.55, 0.9, 0.6 + Math.sin(T * 4) * 0.08);
  }

  // ---------------------------------------------------------------- structures
  function waterMat() { return new THREE.MeshLambertMaterial({ color: 0x2f8fff, emissive: 0x0a2a55, transparent: true, opacity: 0.9 }); }
  var shellMat = null;
  function getShell() {
    return shellMat || (shellMat = new THREE.MeshPhongMaterial({ color: 0xeaf6ff, transparent: true, opacity: 0.33, shininess: 90, depthWrite: false, side: THREE.DoubleSide }));
  }

  // each builder: (m) -> obj ; m(hexOrRole) returns a material. Ghosts pass a function returning the ghost material.
  var BUILD = {
    pump: function (m) {
      var g = new THREE.Group(), o = { g: g };
      box(34, 3, 34, m(0xb8b2a6), 0, 1.5, 0, g);
      mesh(gCyl(6, 6, 10, 10), m(0x6d7480), -9, 7, 6, g);
      box(12, 11, 14, m(0x2f6fb5), 9, 8.5, 6, g);
      box(3, 28, 3, m(0x50565e), 0, 16, -8, g); box(3, 28, 3, m(0x50565e), 0, 16, -2, g);
      var beam = new THREE.Group(); beam.position.set(0, 30, -5); g.add(beam);
      box(36, 4, 5, m(0xe0a62a), 0, 0, 0, beam);
      box(5, 12, 6, m(0xe0a62a), -18, -4, 0, beam);
      box(8, 8, 7, m(0x3a3a3e), 16, -2, 0, beam);
      o.beam = beam;
      return o;
    },
    tank: function (m, ghost) {
      var g = new THREE.Group(), o = { g: g };
      box(34, 3, 34, m(0xb8b2a6), 0, 1.5, 0, g);
      mesh(gCyl(17, 17, 42, 18), ghost ? m() : getShell(), 0, 24, 0, g, false);
      var w = mesh(gCyl(15.5, 15.5, 1, 18), ghost ? m() : waterMat(), 0, 3.5, 0, g, false);
      mesh(new THREE.ConeGeometry(18, 9, 18), m(0xc9ced4), 0, 49.5, 0, g);
      box(2, 44, 6, m(0x50565e), 17.5, 24, 0, g);
      mesh(gCyl(17.6, 17.6, 2, 18), m(0x8c949e), 0, 4, 0, g); mesh(gCyl(17.6, 17.6, 2, 18), m(0x8c949e), 0, 44, 0, g);
      o.water = ghost ? null : w;
      o.own = ghost ? [] : [w.material];
      return o;
    },
    sprinkler: function (m) {
      var g = new THREE.Group(), o = { g: g };
      box(8, 4, 8, m(0x3d8a3d), 0, 2, 0, g);
      mesh(gCyl(2, 2, 12, 8), m(0x7f8790), 0, 10, 0, g);
      var head = new THREE.Group(); head.position.y = 17; g.add(head);
      mesh(gCyl(4.5, 4.5, 4, 10), m(0xd4a63a), 0, 0, 0, head);
      box(11, 2, 2, m(0xd4a63a), 6, 1, 0, head);
      o.head = head;
      return o;
    },
    fill: function (m, ghost) {
      var g = new THREE.Group(), o = { g: g };
      box(34, 2, 34, m(0xa8a8a0), 0, 1, 0, g);
      mesh(gCyl(4.5, 4.5, 46, 10), m(0x2f6fb5), -10, 23, 0, g);
      box(30, 4, 4, m(0x2f6fb5), 4, 44, 0, g);
      mesh(gCyl(2.5, 2.5, 9, 8), m(0x3a3a3e), 17, 38, 0, g);
      box(3, 16, 3, m(0xf2b928), 12, 8, 12, g); box(12, 8, 1.5, m(0xf2b928), 12, 18, 12, g);
      var R = S.BUILDINGS.fill.radius;
      var ringM = ghost ? m() : new THREE.MeshBasicMaterial({ color: 0x3aa0ff, transparent: true, opacity: 0.6, depthWrite: false });
      var discM = ghost ? m() : new THREE.MeshBasicMaterial({ color: 0x3aa0ff, transparent: true, opacity: 0.08, depthWrite: false });
      var pulseM = ghost ? m() : new THREE.MeshBasicMaterial({ color: 0xbfe6ff, transparent: true, opacity: 0, depthWrite: false });
      o.ring = mesh(geo('fring', function () { return new THREE.RingGeometry(R - 5, R, 64).rotateX(-Math.PI / 2); }), ringM, 0, 1.4, 0, g, false);
      o.disc = mesh(geo('fdisc', function () { return new THREE.CircleGeometry(R - 5, 48).rotateX(-Math.PI / 2); }), discM, 0, 1.2, 0, g, false);
      o.pulse = mesh(geo('fpulse', function () { return new THREE.RingGeometry(0.92, 1, 48).rotateX(-Math.PI / 2); }), pulseM, 0, 1.6, 0, g, false);
      o.ring.renderOrder = o.disc.renderOrder = o.pulse.renderOrder = 2;
      if (ghost) o.disc.visible = o.pulse.visible = false;
      o.own = ghost ? [] : [ringM, discM, pulseM];
      return o;
    },
    rack: function (m, ghost) {
      var g = new THREE.Group(), o = { g: g, pallets: [] };
      var up = m(0xe0702a), beam = m(0x2f5fa8);
      [[-16, -10], [16, -10], [-16, 10], [16, 10]].forEach(function (p) { box(3, 42, 3, up, p[0], 21, p[1], g); });
      for (var lv = 0; lv < 3; lv++) { box(36, 2, 3, beam, 0, 2 + lv * 14, -10, g); box(36, 2, 3, beam, 0, 2 + lv * 14, 10, g); }
      box(36, 1, 22, beam, 0, 42, 0, g);
      if (!ghost) {
        geo('roll', function () { return new THREE.CylinderGeometry(3.6, 3.6, 15, 8).rotateX(Math.PI / 2); });
        for (var k = 0; k < 6; k++) {
          var lvl = Math.floor(k / 2), px = (k % 2) ? 8 : -8;
          var pg = new THREE.Group(); pg.position.set(px, 3 + lvl * 14, 0);
          box(14, 2, 18, lam(0xb88a55), 0, 1, 0, pg);
          for (var rr = 0; rr < 3; rr++) mesh(GEO.roll, lam(rr === 1 ? 0x4f8f3a : 0x5c9b42), -4.5 + rr * 4.5, 5.6, 0, pg);
          mesh(GEO.roll, lam(0x55963e), -2.2, 11.5, 0, pg); mesh(GEO.roll, lam(0x55963e), 2.2, 11.5, 0, pg);
          g.add(pg); o.pallets.push(pg);
        }
      }
      return o;
    }
  };
  var KINDS = ['', 'pump', 'tank', 'sprinkler', 'fill', 'rack'];

  function warnTexture() {
    var c = document.createElement('canvas'); c.width = c.height = 64;
    var x = c.getContext('2d');
    x.fillStyle = '#ffcf3a'; x.strokeStyle = '#3a2a00'; x.lineWidth = 5; x.lineJoin = 'round';
    x.beginPath(); x.moveTo(32, 5); x.lineTo(60, 57); x.lineTo(4, 57); x.closePath(); x.fill(); x.stroke();
    x.fillStyle = '#3a2a00'; x.font = 'bold 36px sans-serif'; x.textAlign = 'center'; x.fillText('!', 32, 52);
    var t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace;
    return t;
  }

  function makeStruct(code, i) {
    var kind = KINDS[code];
    if (!kind || !BUILD[kind]) return null;
    var o = BUILD[kind](function (hex) { return lam(hex); }, false);
    o.code = code; o.kind = kind;
    var c = i % COLS, r = (i - c) / COLS;
    o.g.position.set(cx(c), TOP, cx(r));
    o.g.traverse(function (ch) { if (ch.isMesh && ch.castShadow) ch.receiveShadow = true; });
    if (code !== 5) {
      o.warn = new THREE.Sprite(M.warnMat); o.warn.scale.set(16, 16, 1); o.warn.position.set(0, 66, 0); o.warn.renderOrder = 9;
      o.g.add(o.warn);
    }
    o.sprAcc = 0;
    scene.add(o.g);
    return o;
  }
  function killStruct(o) {
    scene.remove(o.g);
    if (o.own) o.own.forEach(function (m) { m.dispose(); });
  }

  function updateStructs(state, dt, nets) {
    var ncell = (state.net && state.net.cell) || [];
    var invTotal = 0, inv = state.inv || [];
    for (var a = 0; a < inv.length; a++) invTotal += num(inv[a], 0);
    var invCap = 0;
    try { invCap = S.getStats(state).invCap; } catch (e) { invCap = 0; }
    var invFrac = invCap > 0 ? clamp(invTotal / invCap, 0, 1) : 0;
    var tankCap = S.BUILDINGS.tank.cap, fillR = S.BUILDINGS.fill.radius;
    last.rackX = null; last.tankPos = {};
    var rackN = 0;
    for (var i = 0; i < N; i++) {
      var code = state.struct[i] | 0, o = structs[i];
      if (o && o.code !== code) { killStruct(o); o = structs[i] = null; }
      if (!o && code) o = structs[i] = makeStruct(code, i);
      if (!o) continue;
      var c = i % COLS, r = (i - c) / COLS, x = cx(c), z = cx(r);
      var nid = typeof ncell[i] === 'number' ? ncell[i] : -1, n = nid >= 0 ? nets[nid] : null;
      if (o.warn) {
        o.warn.visible = nid < 0;
        if (nid < 0) o.warn.position.y = 66 + Math.sin(T * 4 + i) * 3;
      }
      if (o.kind === 'pump') {
        var pumping = !!n && (n.cap - n.stored > 0.5 || n.supplied > 0.001 || (n.tanks.length === 0 && n.demand > 0));
        o.phase = (o.phase || 0) + (pumping ? dt * 3.2 : 0);
        o.beam.rotation.z = Math.sin(o.phase) * 0.32;
      } else if (o.kind === 'tank') {
        var frac = clamp(num(state.tankW[i], 0) / tankCap, 0, 1), h = Math.max(0.3, frac * 39);
        o.water.scale.y = h; o.water.position.y = 3.5 + h / 2; o.water.visible = frac > 0.003;
        o.water.material.color.setHex(frac < 0.15 ? 0xff7a5a : 0x2f8fff);
        if (n) last.tankPos[nid] = { x: x, y: z };
      } else if (o.kind === 'sprinkler') {
        var on = 0;
        if (n) { var k = n.sprinklers.indexOf(i); if (k >= 0) on = num(n.sprOn[k], 0); }
        var thirsty = false, cov = S.sprinklerCells(state, i);
        for (var cc = 0; cc < cov.length; cc++) if (state.ground[cov[cc]] === 2 && num(state.moist[cov[cc]], 1) < C.SMART_FULL) { thirsty = true; break; }
        if (on > 0) {
          o.head.rotation.y += dt * 4;
          o.sprAcc += dt * 70 * on;
          while (o.sprAcc >= 1) {
            o.sprAcc -= 1;
            var ang = Math.random() * Math.PI * 2, d = 20 + Math.random() * 46, fl = 0.55;
            spawn(fx.small, x, z, TOP + 19, Math.cos(ang) * d / fl, Math.sin(ang) * d / fl, 95 + Math.random() * 20, 0.9, 0.62, 0.86, 1);
          }
        } else if (thirsty && dt > 0) {
          // dry sputter: wants water but gets none
          o.head.rotation.y += dt * (Math.sin(T * 7 + i) > 0.6 ? 6 : 0);
          if (Math.random() < dt * 4) for (var s = 0; s < 3; s++)
            spawn(fx.small, x, z, TOP + 19, (Math.random() - 0.5) * 40, (Math.random() - 0.5) * 40, 50 + Math.random() * 30, 0.4, 0.75, 0.68, 0.55);
        }
      } else if (o.kind === 'fill') {
        var dx = x - state.trailer.x, dy = z - state.trailer.y, inR = dx * dx + dy * dy < fillR * fillR;
        o.ring.material.opacity = inR ? 0.95 : 0.45 + Math.sin(T * 3 + i) * 0.12;
        o.disc.material.opacity = inR ? 0.22 : 0.07;
        if (state.tank.refilling && inR) {
          var p2 = (T * 1.5) % 1, rad = 20 + p2 * (fillR - 20);
          o.pulse.scale.set(rad, 1, rad); o.pulse.material.opacity = 0.85 * (1 - p2);
        } else o.pulse.material.opacity = 0;
      } else if (o.kind === 'rack') {
        var shown = Math.round(invFrac * 6);
        for (var pi = 0; pi < 6; pi++) o.pallets[pi].visible = pi < shown;
        if (last.rackX === null) { last.rackX = x; last.rackY = z; }
        rackN++;
      }
    }
  }

  // ---------------------------------------------------------------- hover / ghosts
  function buildOverlay() {
    M.warnMat = new THREE.SpriteMaterial({ map: warnTexture(), depthTest: false, transparent: true });
    M.ghostMat = new THREE.MeshBasicMaterial({ color: 0x5dff7a, transparent: true, opacity: 0.45, depthWrite: false });
    M.hlMat = new THREE.MeshBasicMaterial({ color: 0x5dff7a, transparent: true, opacity: 0.28, depthWrite: false, depthTest: false });
    M.hl = mesh(new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2), M.hlMat, 0, TOP + 1, 0, scene, false);
    M.hl.renderOrder = 7; M.hl.visible = false;
    var pts = [-0.5, 0, -0.5, 0.5, 0, -0.5, 0.5, 0, 0.5, -0.5, 0, 0.5];
    var lg = new THREE.BufferGeometry(); lg.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
    M.hlLineMat = new THREE.LineBasicMaterial({ color: 0x5dff7a, transparent: true, opacity: 0.95, depthTest: false });
    M.hlLine = new THREE.LineLoop(lg, M.hlLineMat); M.hlLine.renderOrder = 7; M.hlLine.visible = false; scene.add(M.hlLine);
    M.cover = instanced(new THREE.PlaneGeometry(TILE - 4, TILE - 4).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({ color: 0x4fc3ff, transparent: true, opacity: 0.3, depthWrite: false, depthTest: false }), 32, false);
    M.cover.renderOrder = 7; M.cover.count = 0;
    // local aim cursor (mouse player's aim point)
    M.aimDot = mesh(new THREE.RingGeometry(5, 7.5, 24).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.8, depthWrite: false, depthTest: false }), 0, TOP + 12, 0, scene, false);
    M.aimDot.renderOrder = 9; M.aimDot.visible = false;
  }
  function ghostFor(kind) {
    if (ghosts[kind] !== undefined) return ghosts[kind];
    var o = null;
    if (BUILD[kind]) o = BUILD[kind](function () { return M.ghostMat; }, true);
    else if (kind === 'pipe') {
      var g = new THREE.Group();
      mesh(gCyl(5, 5, 6, 10), M.ghostMat, 0, 1, 0, g, false);
      box(TILE - 6, 4, 4, M.ghostMat, 0, 1, 0, g, false); box(4, 4, TILE - 6, M.ghostMat, 0, 1, 0, g, false);
      o = { g: g };
    }
    if (o) {
      o.g.traverse(function (ch) { if (ch.isMesh) { ch.castShadow = false; ch.renderOrder = 8; } });
      o.g.visible = false; scene.add(o.g);
    }
    return (ghosts[kind] = o);
  }

  function updateHover(state, view) {
    var hv = view && view.hover;
    for (var k in ghosts) if (ghosts[k]) ghosts[k].g.visible = false;
    M.cover.count = 0;
    if (!hv || typeof hv.c !== 'number' || typeof hv.r !== 'number') { M.hl.visible = M.hlLine.visible = false; return; }
    var w = Math.max(1, num(hv.w, 1)), h = Math.max(1, num(hv.h, 1));
    var x = (hv.c + w / 2) * TILE, z = (hv.r + h / 2) * TILE;
    var col = hv.ok ? 0x5dff7a : 0xff5a4a;
    M.hlMat.color.setHex(col); M.hlLineMat.color.setHex(col); M.ghostMat.color.setHex(col);
    M.hlMat.opacity = 0.22 + Math.sin(T * 6) * 0.06;
    M.hl.visible = M.hlLine.visible = true;
    var lift = hv.kind === 'land' ? 1.5 : 9;
    M.hl.position.set(x, TOP + lift, z); M.hl.scale.set(w * TILE - 2, 1, h * TILE - 2);
    M.hlLine.position.set(x, TOP + lift + 0.2, z); M.hlLine.scale.set(w * TILE - 2, 1, h * TILE - 2);
    var gh = hv.kind ? ghostFor(hv.kind) : null;
    if (gh) { gh.g.visible = true; gh.g.position.set(x, TOP + (hv.kind === 'pipe' ? 1 : 0), z); }
    if (hv.kind === 'sprinkler' && hv.c >= 0 && hv.r >= 0 && hv.c < COLS && hv.r < ROWS) {
      var cov = S.sprinklerCells(state, hv.r * COLS + hv.c), n = 0;
      for (var j = 0; j < cov.length && n < 32; j++) {
        var c = cov[j] % COLS, r = (cov[j] - c) / COLS;
        dummy.position.set(cx(c), TOP + 9, cx(r)); dummy.rotation.set(0, 0, 0); dummy.scale.set(1, 1, 1); dummy.updateMatrix();
        M.cover.setMatrixAt(n++, dummy.matrix);
      }
      M.cover.count = n; M.cover.instanceMatrix.needsUpdate = true;
    }
  }

  // ---------------------------------------------------------------- vehicles (ported from root render.js)
  function wheel(parent, x, y, z) {
    var pivot = new THREE.Group(); pivot.position.set(x, y, z);
    var w = mesh(M.wheelGeo, M.tireMat, 0, 0, 0, null, true);
    var hub = mesh(M.hubGeo, M.hubMat, 0, 0, z > 0 ? 4.2 : -4.2, w, false);
    mesh(gBox(12, 2.5, 1), M.hubMat, 0, 0, z > 0 ? 4.6 : -4.6, w, false);
    pivot.add(w); parent.add(pivot);
    return { pivot: pivot, wheel: w, hub: hub };
  }
  function buildVehicles() {
    M.wheelGeo = new THREE.CylinderGeometry(10, 10, 8, 14).rotateX(Math.PI / 2);
    M.hubGeo = new THREE.CylinderGeometry(5, 5, 1, 10).rotateX(Math.PI / 2);
    M.tireMat = lam(0x1f1f22); M.hubMat = lam(0xc8ccd2);
    var t = new THREE.Group();
    var red = lam(0xd93a2b), redL = lam(0xef5a44), redD = lam(0xa82a1f), glass = lam(0x23415e, { emissive: 0x0a1520 });
    var grey = lam(0x9aa0a6), dark = lam(0x3a3a3e);
    box(74, 12, 36, red, 0, 18, 0, t); box(24, 8, 34, redL, 25, 28, 0, t); box(26, 22, 34, red, 1, 35, 0, t);
    box(27, 11, 35, glass, 1, 38, 0, t); box(26, 3, 34, redD, 1, 47, 0, t); box(4, 10, 32, glass, 13.5, 38, 0, t);
    box(30, 9, 3, red, -22, 28, 16.5, t); box(30, 9, 3, red, -22, 28, -16.5, t); box(3, 9, 36, red, -36, 28, 0, t);
    box(28, 1, 30, lam(0x5a2a22), -22, 24.5, 0, t, false);
    box(4, 6, 38, grey, 38, 16, 0, t); box(3, 6, 38, dark, -38, 16, 0, t);
    box(2, 4, 8, lam(0xfff6b0, { emissive: 0x887a30 }), 37.5, 23, 12, t, false);
    box(2, 4, 8, lam(0xfff6b0, { emissive: 0x887a30 }), 37.5, 23, -12, t, false);
    M.tailMat = new THREE.MeshLambertMaterial({ color: 0xff3030, emissive: 0x550000 });
    box(2, 4, 6, M.tailMat, -38, 26, 13, t, false); box(2, 4, 6, M.tailMat, -38, 26, -13, t, false);
    box(4, 4, 4, dark, 8, 40, 19, t); box(4, 4, 4, dark, 8, 40, -19, t);
    box(10, 3, 30, lam(0xffd34d, { emissive: 0x443300 }), -2, 50, 0, t, false);
    M.truckWheels = [wheel(t, 24, 10, 19), wheel(t, 24, 10, -19), wheel(t, -24, 10, 19), wheel(t, -24, 10, -19)];
    scene.add(t); M.truck = t;

    var tr = new THREE.Group(), frame = lam(0x4a5058);
    box(58, 5, 40, frame, -2, 14, 0, tr); box(32, 4, 4, frame, 42, 14, 0, tr); box(6, 6, 6, dark, 56, 14, 0, tr);
    box(10, 14, 18, lam(0xf2b928), 21, 23, 0, tr);
    box(4, 18, 3, frame, -16, 26, 17, tr); box(4, 18, 3, frame, -16, 26, -17, tr);
    box(4, 18, 3, frame, 8, 26, 17, tr); box(4, 18, 3, frame, 8, 26, -17, tr);
    var tankMat = new THREE.MeshPhongMaterial({ color: 0xeaf6ff, transparent: true, opacity: 0.32, shininess: 90, depthWrite: false, side: THREE.DoubleSide });
    mesh(new THREE.CylinderGeometry(16, 16, 46, 20).rotateZ(Math.PI / 2), tankMat, -4, 34, 0, tr, false);
    M.waterMat = new THREE.MeshLambertMaterial({ color: 0x2f8fff, transparent: true, opacity: 0.85, emissive: 0x0a2a55 });
    M.water = mesh(new THREE.BoxGeometry(43, 1, 24), M.waterMat, -4, 20, 0, tr, false);
    M.trailerWheels = [wheel(tr, 0, 10, 23), wheel(tr, 0, 10, -23)];
    scene.add(tr); M.trailer = tr;

    var nz = new THREE.Group();
    mesh(new THREE.CylinderGeometry(6, 7, 8, 10), dark, 0, 0, 0, nz);
    var pitch = new THREE.Group(); pitch.position.y = 4; nz.add(pitch);
    mesh(new THREE.CylinderGeometry(2.4, 3, 24, 8).rotateZ(-Math.PI / 2).translate(12, 0, 0), lam(0xd4a63a), 0, 0, 0, pitch);
    mesh(new THREE.CylinderGeometry(3.6, 2.4, 5, 8).rotateZ(-Math.PI / 2).translate(25, 0, 0), lam(0xe6c25a), 0, 0, 0, pitch, false);
    scene.add(nz); M.nozzle = nz; M.nozzlePitch = pitch;
  }
  function updateVehicles(state, dt) {
    var t = state.truck, tr = state.trailer, sp = state.spray, tank = state.tank;
    M.truck.position.set(t.x, 0, t.y); M.truck.rotation.y = -t.a;
    fx.wheelSpin -= num(t.v, 0) * dt / 10;
    for (var i = 0; i < 4; i++) {
      M.truckWheels[i].wheel.rotation.z = fx.wheelSpin;
      if (i < 2) M.truckWheels[i].pivot.rotation.y = -num(t.steer, 0) * 0.5;
    }
    M.tailMat.emissive.setHex(t.v < -5 ? 0xffffff : (t.throttle < 0 && t.v > 5 ? 0xff2020 : 0x550000));
    M.trailer.position.set(tr.x, 0, tr.y); M.trailer.rotation.y = -tr.a;
    for (var j = 0; j < 2; j++) M.trailerWheels[j].wheel.rotation.z = fx.wheelSpin;
    var fill = tank.cap > 0 ? clamp(tank.water / tank.cap, 0, 1) : 0, hgt = Math.max(0.3, fill * 29);
    M.water.scale.y = hgt; M.water.position.y = 19.5 + hgt / 2; M.water.visible = fill > 0.002;
    M.waterMat.color.setHex(fill < 0.2 ? 0xff6b5a : 0x2f8fff);
    var dx = sp.hitX - sp.nozX, dy = sp.hitY - sp.nozY, d = Math.sqrt(dx * dx + dy * dy);
    M.nozzle.position.set(sp.nozX, 51, sp.nozY);
    if (d > 1) M.nozzle.rotation.y = -Math.atan2(dy, dx);
    M.nozzlePitch.rotation.z = 0.15 + 0.55 * Math.min(1, d / Math.max(1, sp.range));
    last.truckX = t.x; last.truckY = t.y; last.trailerX = tr.x; last.trailerY = tr.y;
  }

  // ---------------------------------------------------------------- fx
  function dotTexture() {
    var c = document.createElement('canvas'); c.width = c.height = 64;
    var g = c.getContext('2d'), gr = g.createRadialGradient(32, 32, 0, 32, 32, 32);
    gr.addColorStop(0, 'rgba(255,255,255,1)'); gr.addColorStop(0.45, 'rgba(255,255,255,0.9)'); gr.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = gr; g.fillRect(0, 0, 64, 64);
    var tex = new THREE.CanvasTexture(c); tex.colorSpace = THREE.SRGBColorSpace;
    return tex;
  }
  function makePoints(max, size, color, vertexColors) {
    var geo2 = new THREE.BufferGeometry();
    var pos = new THREE.BufferAttribute(new Float32Array(max * 3), 3); pos.setUsage(THREE.DynamicDrawUsage);
    geo2.setAttribute('position', pos);
    var col = null;
    if (vertexColors) { col = new THREE.BufferAttribute(new Float32Array(max * 3), 3); col.setUsage(THREE.DynamicDrawUsage); geo2.setAttribute('color', col); }
    geo2.setDrawRange(0, 0);
    var mat = new THREE.PointsMaterial({ size: size, map: M.dot, color: color, transparent: true, depthWrite: false, vertexColors: !!vertexColors, opacity: 0.95 });
    var p = new THREE.Points(geo2, mat); p.frustumCulled = false; scene.add(p);
    return { points: p, pos: pos, col: col, max: max };
  }
  function buildFx() {
    M.dot = dotTexture();
    M.drops = makePoints(1400, 9, 0x9fd8ff, false);
    M.small = makePoints(2400, 6, 0xffffff, true);
    M.big = makePoints(600, 16, 0xffffff, true);
    fx.small.sys = M.small; fx.big.sys = M.big;
    M.rangeRing = mesh(new THREE.RingGeometry(0.985, 1, 96).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.35, depthWrite: false }), 0, 0, 0, scene, false);
    var g = new THREE.Group(), mat = new THREE.MeshBasicMaterial({ color: 0x7fd4ff, transparent: true, opacity: 0.9, depthWrite: false });
    var ring = mesh(new THREE.RingGeometry(0.88, 1, 48).rotateX(-Math.PI / 2), mat, 0, 0, 0, g, false);
    var fill = mesh(new THREE.CircleGeometry(1, 40).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: 0x7fd4ff, transparent: true, opacity: 0.12, depthWrite: false }), 0, 0, 0, g, false);
    var cm = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.95, depthWrite: false });
    mesh(new THREE.PlaneGeometry(18, 2.5).rotateX(-Math.PI / 2), cm, 0, 0.3, 0, g, false);
    mesh(new THREE.PlaneGeometry(2.5, 18).rotateX(-Math.PI / 2), cm, 0, 0.3, 0, g, false);
    var pulse = mesh(new THREE.RingGeometry(0.92, 1, 48).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.5, depthWrite: false }), 0, 0, 0, g, false);
    g.renderOrder = 5; scene.add(g);
    M.ret = { group: g, ring: ring, fill: fill, pulse: pulse, mat: mat };
    M.trackMax = 1800;
    M.tracks = instanced(new THREE.PlaneGeometry(6, 9).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({ color: 0x3a2412, transparent: true, opacity: 0.26, depthWrite: false }), M.trackMax, false);
  }
  function spawn(list, x, y, z, vx, vy, vz, life, r, g, b) {
    if (list.length >= list.sys.max) list.shift();
    list.push({ x: x, y: y, z: z, vx: vx, vy: vy, vz: vz, t: 0, life: life, r: r, g: g, b: b });
  }
  function puff(x, y, n, r, g, b, up) {
    for (var k = 0; k < n; k++) {
      var a = Math.random() * Math.PI * 2, v = 15 + Math.random() * 45;
      spawn(fx.big, x + Math.cos(a) * 8, y + Math.sin(a) * 8, TOP + 6, Math.cos(a) * v, Math.sin(a) * v, (up || 60) + Math.random() * 50, 0.7 + Math.random() * 0.3, r, g, b);
    }
  }
  function sparkle(x, y, n) {
    for (var k = 0; k < n; k++) {
      var a = Math.random() * Math.PI * 2, v = 10 + Math.random() * 40;
      spawn(fx.small, x, y, TOP + 12, Math.cos(a) * v, Math.sin(a) * v, 120 + Math.random() * 120, 0.9, 1, 0.88, 0.3);
    }
  }
  function surfaceY(state, x, y) {
    var c = Math.floor(x / TILE), r = Math.floor(y / TILE);
    if (c < 0 || r < 0 || c >= COLS || r >= ROWS) return 0.8;
    var i = r * COLS + c;
    if (state.ground[i] === 2) return TOP + (num(state.growth[i], 0) >= 0.999 ? 6 : 0.4 + num(state.growth[i], 0) * 4.6) + 0.3;
    return TOP + 0.4;
  }
  function updateTracks(state) {
    var t = state.truck, tr = state.trailer;
    var ca = Math.cos(t.a), sa = Math.sin(t.a), cb = Math.cos(tr.a), sb = Math.sin(tr.a);
    var wp = [
      { x: t.x - ca * 24 - sa * 19, y: t.y - sa * 24 + ca * 19, a: t.a }, { x: t.x - ca * 24 + sa * 19, y: t.y - sa * 24 - ca * 19, a: t.a },
      { x: tr.x - sb * 23, y: tr.y + cb * 23, a: tr.a }, { x: tr.x + sb * 23, y: tr.y - cb * 23, a: tr.a }];
    if (fx.lastWheels) {
      var dx = wp[0].x - fx.lastWheels[0].x, dy = wp[0].y - fx.lastWheels[0].y, dd = dx * dx + dy * dy;
      if (dd > 200 * 200) fx.lastWheels = null;
      else if (dd > 64) {
        for (var w = 0; w < 4; w++) {
          var p = wp[w];
          dummy.position.set(p.x, surfaceY(state, p.x, p.y), p.y); dummy.rotation.set(0, -p.a + Math.PI / 2, 0); dummy.scale.set(1, 1, 1); dummy.updateMatrix();
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
  function updateParticles(state, dt) {
    var sp = state.spray, i;
    if (sp.on && dt > 0) {
      fx.spawnAcc += dt * 140;
      while (fx.spawnAcc >= 1) {
        fx.spawnAcc -= 1;
        var ang = Math.random() * Math.PI * 2, rad = Math.sqrt(Math.random()) * sp.radius * 0.7;
        var ex = sp.hitX + Math.cos(ang) * rad, ey = sp.hitY + Math.sin(ang) * rad;
        var dx = ex - sp.nozX, dy = ey - sp.nozY, d = Math.sqrt(dx * dx + dy * dy);
        if (fx.drops.length >= M.drops.max) fx.drops.shift();
        fx.drops.push({ sx: sp.nozX + dx / (d || 1) * 26, sy: sp.nozY + dy / (d || 1) * 26, ex: ex, ey: ey, t: 0, dur: 0.28 + d / 800, h: 20 + d * 0.3 });
      }
    } else fx.spawnAcc = 0;
    if (sp.sputter && dt > 0 && Math.random() < dt * 12)
      for (var qq = 0; qq < 3; qq++) spawn(fx.small, sp.nozX, sp.nozY, NOZ_H, (Math.random() - 0.5) * 60, (Math.random() - 0.5) * 60, 60 + Math.random() * 40, 0.5, 0.7, 0.85, 1);

    var dp = M.drops.pos.array, n = 0;
    for (i = fx.drops.length - 1; i >= 0; i--) {
      var p = fx.drops[i];
      p.t += dt / p.dur;
      if (p.t >= 1) {
        if (Math.random() < 0.4) {
          var a = Math.random() * Math.PI * 2, v = 30 + Math.random() * 80;
          spawn(fx.small, p.ex, p.ey, 8, Math.cos(a) * v, Math.sin(a) * v, 90 + Math.random() * 90, 0.55, 0.75, 0.9, 1);
        }
        fx.drops.splice(i, 1);
      }
    }
    for (i = 0; i < fx.drops.length; i++) {
      var d0 = fx.drops[i], tt = d0.t;
      dp[n * 3] = lerp(d0.sx, d0.ex, tt); dp[n * 3 + 1] = lerp(NOZ_H, 6, tt) + 4 * d0.h * tt * (1 - tt); dp[n * 3 + 2] = lerp(d0.sy, d0.ey, tt);
      n++;
    }
    M.drops.points.geometry.setDrawRange(0, n);
    M.drops.pos.needsUpdate = true;
    stepPoints(fx.small, dt); stepPoints(fx.big, dt);
  }
  function stepPoints(list, dt) {
    var sys = list.sys, pa = sys.pos.array, ca = sys.col.array, m = 0, i;
    for (i = list.length - 1; i >= 0; i--) {
      var s = list[i];
      s.t += dt; s.x += s.vx * dt; s.y += s.vy * dt; s.vz -= 380 * dt; s.z += s.vz * dt;
      if (s.z < TOP + 2) { s.z = TOP + 2; s.vz = 0; s.vx *= 0.8; s.vy *= 0.8; }
      if (s.t > s.life) list.splice(i, 1);
    }
    for (i = 0; i < list.length; i++) {
      var s2 = list[i], fade = 1 - s2.t / s2.life;
      pa[m * 3] = s2.x; pa[m * 3 + 1] = s2.z; pa[m * 3 + 2] = s2.y;
      ca[m * 3] = s2.r * fade; ca[m * 3 + 1] = s2.g * fade; ca[m * 3 + 2] = s2.b * fade;
      m++;
    }
    sys.points.geometry.setDrawRange(0, m);
    sys.pos.needsUpdate = true; sys.col.needsUpdate = true;
  }
  function updateAim(state, view) {
    var sp = state.spray;
    M.rangeRing.position.set(sp.nozX, TOP + 10, sp.nozY);
    M.rangeRing.scale.set(Math.max(1, sp.range), 1, Math.max(1, sp.range));
    var empty = state.tank.water <= 0.0001, r = M.ret, rad = Math.max(1, sp.radius);
    r.group.position.set(sp.hitX, TOP + 10, sp.hitY);
    r.ring.scale.set(rad, 1, rad); r.fill.scale.set(rad, 1, rad);
    r.mat.color.setHex(empty ? 0xff5a50 : 0x7fd4ff); r.fill.material.color.setHex(empty ? 0xff5a50 : 0x7fd4ff);
    var pr = (T * 2.5) % 1;
    r.pulse.visible = !!sp.on;
    r.pulse.scale.set(rad * (0.3 + pr * 0.7), 1, rad * (0.3 + pr * 0.7)); r.pulse.material.opacity = 0.6 * (1 - pr);
    var la = view && view.localAim;
    M.aimDot.visible = !!(la && typeof la.x === 'number' && typeof la.y === 'number');
    if (M.aimDot.visible) M.aimDot.position.set(la.x, TOP + 11, la.y);
  }

  // ---------------------------------------------------------------- DOM floating text
  function buildDom(canvas) {
    layer = document.createElement('div');
    layer.className = 'base-render-fx';
    layer.style.cssText = 'position:absolute;left:0;top:0;width:100%;height:100%;pointer-events:none;overflow:hidden;z-index:5;';
    (canvas.parentNode || document.body).appendChild(layer);
  }
  function popup(text, x, y, color, life, size, h) {
    if (!layer || typeof x !== 'number' || typeof y !== 'number' || !isFinite(x) || !isFinite(y)) return;
    var el = document.createElement('div');
    el.textContent = text;
    el.style.cssText = 'position:absolute;left:0;top:0;white-space:nowrap;font:800 ' + (size || 20) +
      'px/1 system-ui,-apple-system,Segoe UI,sans-serif;color:' + color + ';text-shadow:0 2px 0 rgba(0,0,0,.55),0 0 6px rgba(0,0,0,.35);will-change:transform,opacity;opacity:0;';
    layer.appendChild(el);
    fx.pops.push({ el: el, x: x, y: y, t: 0, life: life || 1.2, h: h || 30 });
    if (fx.pops.length > 40) { var old = fx.pops.shift(); old.el.remove(); }
  }
  function updateDom(dt) {
    for (var i = fx.pops.length - 1; i >= 0; i--) {
      var p = fx.pops[i];
      p.t += dt;
      var qn = p.t / p.life;
      if (qn >= 1) { p.el.remove(); fx.pops.splice(i, 1); continue; }
      tmpV.set(p.x, p.h + qn * 50, p.y).project(camera);
      if (tmpV.z > 1) { p.el.style.opacity = 0; continue; }
      var sx = (tmpV.x + 1) / 2 * W, sy = (1 - tmpV.y) / 2 * H;
      var sc = qn < 0.15 ? 0.6 + qn / 0.15 * 0.6 : 1.2 - Math.min(0.2, qn - 0.15);
      p.el.style.transform = 'translate(' + sx.toFixed(1) + 'px,' + sy.toFixed(1) + 'px) translate(-50%,-50%) scale(' + sc.toFixed(3) + ')';
      p.el.style.opacity = qn > 0.7 ? (1 - (qn - 0.7) / 0.3).toFixed(2) : '1';
    }
  }

  function onEvents(evts) {
    if (!evts || !renderer) return;
    for (var i = 0; i < evts.length; i++) {
      var e = evts[i];
      if (!e || typeof e.type !== 'string') continue;
      var x = num(e.x, NaN), y = num(e.y, NaN), has = isFinite(x) && isFinite(y);
      switch (e.type) {
        case 'sold': {
          var sx = last.rackX !== null ? last.rackX : last.truckX, sy = last.rackX !== null ? last.rackY : last.truckY;
          if (has) { sx = x; sy = y; }
          popup('+' + fmtMoney(num(e.amount, 0)), sx, sy, '#7dff6a', 1.6, 26, 50);
          for (var k = 0; k < 24; k++) { var a = Math.random() * Math.PI * 2, v = 20 + Math.random() * 60; spawn(fx.small, sx, sy, TOP + 20, Math.cos(a) * v, Math.sin(a) * v, 140 + Math.random() * 120, 1, 1, 0.85, 0.2); }
          break;
        }
        case 'built':
          if (has) { puff(x, y, 14, 0.85, 0.8, 0.7); if (e.cost > 0) popup('-' + fmtMoney(e.cost), x, y, '#ffb4a8', 1.0, 16, 40); }
          break;
        case 'demolished':
          if (has) { puff(x, y, 16, 0.6, 0.55, 0.5); if (e.refund > 0) popup('+' + fmtMoney(e.refund), x, y, '#9dff8a', 1.0, 16, 40); }
          break;
        case 'tilled': if (has) puff(x, y, 9, 0.55, 0.38, 0.22, 40); break;
        case 'seeded': if (has) { puff(x, y, 6, 0.5, 0.75, 0.3, 30); sparkle(x, y, 4); } break;
        case 'harvested': if (has) { puff(x, y, 10, 0.4, 0.75, 0.3); popup('+1 roll', x, y, '#c8ff8a', 1.0, 16, 30); } break;
        case 'plotReady': if (has) sparkle(x, y, 18); break;
        case 'plotDied': if (has) { puff(x, y, 12, 0.75, 0.65, 0.35, 30); popup('wilted', x, y, '#ffd07a', 1.3, 15, 24); } break;
        case 'landBought': {
          var lx = x, ly = y;
          if (!has && typeof e.id === 'number') { var P = C.PARCEL; lx = ((e.id % C.PCOLS) * P + P / 2) * TILE; ly = (Math.floor(e.id / C.PCOLS) * P + P / 2) * TILE; }
          popup('Land bought!', lx, ly, '#ffe27a', 1.8, 24, 40);
          if (isFinite(lx)) for (var q2 = 0; q2 < 4; q2++) puff(lx + (Math.random() - 0.5) * 120, ly + (Math.random() - 0.5) * 120, 6, 0.9, 0.85, 0.6);
          break;
        }
        case 'equipBought': popup('Upgraded!', last.truckX, last.truckY, '#8fd3ff', 1.4, 20, 70); break;
        case 'refillFull': popup('Tank full', last.trailerX, last.trailerY, '#8fd3ff', 1.1, 18, 60); break;
        case 'tankEmpty': { var tp = last.tankPos[e.net]; if (tp) popup('Tank empty!', tp.x, tp.y, '#ff9a7a', 1.6, 18, 60); break; }
        case 'sputter':
          if (has) for (var s3 = 0; s3 < 4; s3++) spawn(fx.small, x, y, NOZ_H, (Math.random() - 0.5) * 60, (Math.random() - 0.5) * 60, 60 + Math.random() * 40, 0.5, 0.7, 0.85, 1);
          break;
        default: break;
      }
    }
  }

  // ---------------------------------------------------------------- camera
  function recenter() { cam.panX = cam.ownCX; cam.panY = cam.ownCY + TILE * 0.5; cam.dist = cam.defDist; }
  function panBy(dx, dy) {
    cam.panX = clamp(cam.panX + num(dx, 0), -200, C.WORLD_W + 200);
    cam.panY = clamp(cam.panY + num(dy, 0), -200, C.WORLD_H + 200);
  }
  function zoomBy(f) { f = num(f, 1); if (f > 0) cam.dist = clamp(cam.dist / f, 260, 2600); }

  function updateCamera(state, view, rdt) {
    var mode = view && view.cameraMode === 'chase' ? 'chase' : 'overview';
    var t = state.truck, tr = state.trailer, range = state.spray.range || 200;
    var tx, tz, px, py, pz;
    if (mode === 'chase') {
      tx = t.x * 0.55 + tr.x * 0.45 + Math.cos(t.a) * 50; tz = t.y * 0.55 + tr.y * 0.45 + Math.sin(t.a) * 50;
      var spd = Math.min(1, Math.abs(t.v) / 150);
      if (!cam.ready || cam.mode !== 'chase') cam.yaw = t.a;
      cam.yaw = wrap(cam.yaw + wrap(t.a - cam.yaw) * (1 - Math.exp(-rdt * (0.6 + 1.4 * spd))));
      var back = 230 + range * 0.85, height = 280 + range * 0.95;
      px = tx - Math.cos(cam.yaw) * back; py = height; pz = tz - Math.sin(cam.yaw) * back;
    } else {
      tx = cam.panX; tz = cam.panY;
      px = tx; py = cam.dist * Math.sin(OV_PITCH); pz = tz + cam.dist * Math.cos(OV_PITCH);
      cam.yaw = -Math.PI / 2; // keep yaw sensible for switching back to chase
    }
    if (!cam.ready) { cam.pos.set(px, py, pz); cam.target.set(tx, 0, tz); cam.ready = true; }
    else {
      var k = 1 - Math.exp(-rdt * (mode === 'chase' ? 4 : 7)), kt = 1 - Math.exp(-rdt * (mode === 'chase' ? 5 : 9));
      cam.pos.x += (px - cam.pos.x) * k; cam.pos.y += (py - cam.pos.y) * k; cam.pos.z += (pz - cam.pos.z) * k;
      cam.target.x += (tx - cam.target.x) * kt; cam.target.z += (tz - cam.target.z) * kt;
    }
    cam.mode = mode;
    camera.position.copy(cam.pos);
    camera.lookAt(cam.target);
    // range ring / reticle readable in overview, subtle in chase
    M.rangeRing.material.opacity = mode === 'chase' ? 0.35 : 0.5;
  }

  // ---------------------------------------------------------------- lighting by day clock
  var SKY_DAY = new THREE.Color(0xa8dcff), SKY_DUSK = new THREE.Color(0xf4b88a), SKY_NIGHT = new THREE.Color(0x3d4f78);
  var SUN_DAY = new THREE.Color(0xfff0d0), SUN_LOW = new THREE.Color(0xffa860), tmpSky = new THREE.Color();
  function updateLight(state) {
    var t = num(state.clock && state.clock.t, 0.4);
    var elev = Math.sin((t - 0.25) * Math.PI * 2); // -1 midnight .. 1 noon
    var day = clamp((elev + 0.15) / 0.45, 0, 1), low = clamp(1 - Math.abs(elev) / 0.35, 0, 1);
    sun.intensity = 0.5 + 1.9 * day;
    sun.color.copy(SUN_DAY).lerp(SUN_LOW, low * 0.8);
    hemi.intensity = 0.85 + 0.75 * day;
    hemi.color.setHex(day > 0.5 ? 0xe4f4ff : 0xb8c4ee);
    tmpSky.copy(SKY_NIGHT).lerp(SKY_DAY, day).lerp(SKY_DUSK, low * 0.45);
    scene.background.copy(tmpSky); scene.fog.color.copy(tmpSky);
    var az = (t - 0.25) * Math.PI * 2, ct = cam.target;
    sun.position.set(ct.x - Math.cos(az) * 700, 350 + 750 * Math.max(0.2, elev), ct.z + 420);
    sun.target.position.set(ct.x, 0, ct.z);
  }

  // ---------------------------------------------------------------- draw
  function draw(state, view) {
    if (!renderer || !state || !state.ground) return;
    view = view || {};
    var rdt = Math.min(0.1, Math.max(0, num(view.dt, 0)));
    var dt = state.paused ? 0 : rdt;
    T += dt;
    if (!cam.centred) ownExtent(state);
    var nets = {};
    var list = (state.net && state.net.list) || [];
    for (var i = 0; i < list.length; i++) nets[list[i].id] = list[i];
    updateCells(state);
    updateParcels(state, view.tool === 'land' || !!(view.hover && view.hover.kind === 'land'));
    updatePipes(state, !!view.showPipes);
    updateStructs(state, dt, nets);
    updateVehicles(state, dt);
    updateTracks(state);
    updateParticles(state, dt);
    updateAim(state, view);
    updateHover(state, view);
    updateCamera(state, view, rdt);
    updateLight(state);
    var f = tmpV; camera.getWorldDirection(f);
    var L = Math.sqrt(f.x * f.x + f.z * f.z) || 1;
    camInfo.forward.x = f.x / L; camInfo.forward.y = f.z / L;
    renderer.render(scene, camera);
    updateDom(rdt);
  }

  SOD.BaseRender = {
    init: init, resize: resize, draw: draw, onEvents: onEvents, camInfo: camInfo,
    panBy: panBy, zoomBy: zoomBy, recenter: recenter
  };
})();
