/* Home base HTML/CSS UI: menu, pause, top bar, panels, hotbar, cursor tip, toasts, hints, equipment.
 *   SOD.BaseUI.TOOLS                  tool list (id, key code, action for BaseSim.canDo, paint)
 *   init(handlers)  handlers: onNewGame, onContinue, onResume, onPause, onMute, onQuit, onTool(id),
 *                   onSeedType(t), onSell(n), onBuyEquip(id), onToggleEquip()
 *   setScreen('menu'|'game'), showPause(bool), setMenuSave(save|null), setEquipOpen(bool)
 *   update(state, ui)  ui = {tool, seedType, hover (canDo result + label) | null, mouse, cameraMode, muted}
 *   toast(text, kind), onEvents(events), startHints(), reasonText(reason)
 */
(function () {
  'use strict';
  var SOD = (window.SOD = window.SOD || {});
  var Sim = SOD.BaseSim;
  var HINT_KEY = 'sodFarm.hints.v1';

  var TOOLS = [
    { id: 'hose', key: '1', code: 'Digit1', name: 'Hose', ico: '💧', info: 'Aim with the mouse, hold Left Click to spray. Water plots to keep them growing.' },
    { id: 'till', key: '2', code: 'Digit2', name: 'Till', ico: '⛏️', action: 'till', paint: true, info: 'Turn owned grass into dirt. Click or drag.' },
    { id: 'seed', key: '3', code: 'Digit3', name: 'Seed', ico: '🌱', action: 'seed', paint: true, info: 'Plant sod on tilled dirt. Press 3 again to switch sod type.' },
    { id: 'harvest', key: '4', code: 'Digit4', name: 'Harvest', ico: '✂️', action: 'harvest', paint: true, info: 'Cut ready (golden) sod into rolls. Needs storage space.' },
    { id: 'pipe', key: '5', code: 'Digit5', name: 'Pipe', ico: '➕', action: 'pipe', paint: true, info: Sim.BUILDINGS.pipe.desc + ' Drag to lay a run.' },
    { id: 'pump', key: '6', code: 'Digit6', name: 'Pump', ico: '⛽', action: 'pump', info: Sim.BUILDINGS.pump.desc },
    { id: 'tank', key: '7', code: 'Digit7', name: 'Tank', ico: '🛢️', action: 'tank', info: Sim.BUILDINGS.tank.desc },
    { id: 'sprinkler', key: '8', code: 'Digit8', name: 'Sprinkler', ico: '⛲', action: 'sprinkler', info: Sim.BUILDINGS.sprinkler.desc },
    { id: 'fill', key: '9', code: 'Digit9', name: 'Fill Stn', ico: '🚰', action: 'fill', info: Sim.BUILDINGS.fill.desc },
    { id: 'rack', key: '0', code: 'Digit0', name: 'Rack', ico: '📦', action: 'rack', info: Sim.BUILDINGS.rack.desc },
    { id: 'demolish', key: '-', code: 'Minus', name: 'Demolish', ico: '🔨', action: 'demolish', info: 'Remove the top layer: structure, then pipe, then plot/dirt. Refunds half.' },
    { id: 'land', key: '=', code: 'Equal', name: 'Buy Land', ico: '🗺️', action: 'land', info: 'Buy a 4x4 parcel next to land you own.' }
  ];
  var REASONS = {
    bounds: 'Outside the farm', unowned: 'Not your land (Buy Land: =)', kind: 'Can’t do that',
    occupied: 'Something is already here', plot: 'Can’t build on a sod plot', vehicle: 'The truck is in the way',
    notGrass: 'Only on grass', notDirt: 'Till it first', notReady: 'Not ready to harvest',
    full: 'Storage full: sell sod or build a rack', nothing: 'Nothing to remove', money: 'Not enough money',
    notBuyable: 'Must border land you own', owned: 'You already own this'
  };

  var h = {}, $ = function (id) { return document.getElementById(id); };
  var els = {}, toolBtns = {}, slow = 0, lastKeys = {}, equipOpen = false, hintIdx = -1;

  function money(n) { return (n < 0 ? '-$' : '$') + Math.abs(Math.round(n)).toLocaleString(); }
  function clockText(ck) {
    var mins = Math.floor(ck.t * 24 * 60), hh = Math.floor(mins / 60), mm = mins % 60;
    var ap = hh < 12 ? 'AM' : 'PM', h12 = hh % 12 || 12;
    return 'Day ' + ck.day + ' · ' + h12 + ':' + (mm < 10 ? '0' : '') + mm + ' ' + ap;
  }
  function setText(el, s) { if (el.textContent !== s) el.textContent = s; }
  function setHTML(key, el, s) { if (lastKeys[key] !== s) { lastKeys[key] = s; el.innerHTML = s; } }

  // in-page two-click confirm: first click arms (relabels) for 4 s, second click confirms
  var armT = {};
  function confirmClick(b, label) {
    clearTimeout(armT[b.id]);
    if (b.dataset.armed) { b.textContent = b.dataset.armed; delete b.dataset.armed; b.classList.remove('armed'); return true; }
    b.dataset.armed = b.textContent; b.textContent = label; b.classList.add('armed');
    armT[b.id] = setTimeout(function () { if (b.dataset.armed) { b.textContent = b.dataset.armed; delete b.dataset.armed; b.classList.remove('armed'); } }, 4000);
    return false;
  }

  function init(handlers) {
    h = handlers || {};
    ['hud', 'menu', 'pause', 'equip', 'hotbar', 'seed-pick', 'tool-info', 'tip', 'toasts', 'hud-money', 'hud-clock',
      'hud-inv', 'btn-sell1', 'btn-sellall', 'hud-tank-fill', 'hud-tank-text', 'farm-body', 'water-body', 'hud-cam',
      'btn-mute', 'equip-list', 'equip-money', 'hint', 'hint-step', 'hint-text', 'hint-next', 'save-info',
      'btn-continue', 'btn-new'].forEach(function (id) { els[id] = $(id); });

    TOOLS.forEach(function (t) {
      var b = document.createElement('button');
      b.className = 'tool'; b.title = t.name + ' (' + t.key + ')';
      b.innerHTML = '<span class="t-key">' + t.key + '</span><span class="t-ico">' + t.ico + '</span>' +
        '<span class="t-name">' + t.name + '</span><span class="t-cost"></span>';
      b.addEventListener('click', function () { b.blur(); h.onTool && h.onTool(t.id); });
      els.hotbar.appendChild(b);
      toolBtns[t.id] = { b: b, cost: b.querySelector('.t-cost') };
    });
    Sim.SOD_TYPES.forEach(function (st, k) {
      var b = document.createElement('button');
      b.className = 'seed-opt'; b.dataset.k = k;
      b.innerHTML = st.name + '<small>seed $' + st.seedCost + ' · sells $' + st.price + ' · ' +
        Math.round(st.grow) + 's · thirst x' + st.thirst + '</small>';
      b.addEventListener('click', function () { b.blur(); h.onSeedType && h.onSeedType(k); });
      els['seed-pick'].appendChild(b);
    });

    els['btn-new'].addEventListener('click', function () {
      if (!els['btn-continue'].classList.contains('hidden') && !confirmClick(els['btn-new'], 'Overwrite save?')) return;
      h.onNewGame && h.onNewGame();
    });
    els['btn-continue'].addEventListener('click', function () { h.onContinue && h.onContinue(); });
    $('btn-resume').addEventListener('click', function () { h.onResume && h.onResume(); });
    $('btn-pause-mute').addEventListener('click', function () { h.onMute && h.onMute(); });
    $('btn-quit').addEventListener('click', function () { h.onQuit && h.onQuit(); });
    $('btn-pause').addEventListener('click', function () { this.blur(); h.onPause && h.onPause(); });
    els['btn-mute'].addEventListener('click', function () { this.blur(); h.onMute && h.onMute(); });
    $('btn-equip').addEventListener('click', function () { this.blur(); h.onToggleEquip && h.onToggleEquip(); });
    $('equip-close').addEventListener('click', function () { h.onToggleEquip && h.onToggleEquip(); });
    els['btn-sell1'].addEventListener('click', function () { this.blur(); h.onSell && h.onSell(1); });
    els['btn-sellall'].addEventListener('click', function () { this.blur(); h.onSell && h.onSell(Infinity); });
    els['equip-list'].addEventListener('click', function (e) {
      var b = e.target.closest('button[data-eq]');
      if (b) { b.blur(); h.onBuyEquip && h.onBuyEquip(b.dataset.eq); }
    });
    els['hint-next'].addEventListener('click', function () { showHint(hintIdx + 1); });
    $('hint-skip').addEventListener('click', function () { showHint(99); });
  }

  function setScreen(s) {
    els.menu.classList.toggle('hidden', s !== 'menu');
    els.hud.classList.toggle('hidden', s !== 'game');
    if (s !== 'game') { setEquipOpen(false); showPause(false); }
  }
  function showPause(on) { els.pause.classList.toggle('hidden', !on); }
  function setMenuSave(save) {
    els['btn-continue'].classList.toggle('hidden', !save);
    els['save-info'].textContent = save ? ('Saved farm: Day ' + save.clock.day + ' · ' + money(save.money)) : '';
  }
  function setEquipOpen(on) { equipOpen = !!on; els.equip.classList.toggle('hidden', !equipOpen); lastKeys.equip = ''; }

  // ---------------------------------------------------------------- toasts
  function toast(text, kind) {
    var box = els.toasts;
    // merge identical consecutive toasts
    var lastEl = box.lastElementChild;
    if (lastEl && lastEl.dataset.text === text && !lastEl.classList.contains('fade')) {
      var n = (+lastEl.dataset.n || 1) + 1; lastEl.dataset.n = n;
      lastEl.textContent = text + ' x' + n;
      clearTimeout(lastEl._t); lastEl._t = setTimeout(fade.bind(null, lastEl), 2600);
      return;
    }
    var d = document.createElement('div');
    d.className = 'toast ' + (kind || ''); d.textContent = text; d.dataset.text = text;
    box.appendChild(d);
    while (box.children.length > 4) box.removeChild(box.firstElementChild);
    d._t = setTimeout(fade.bind(null, d), 2600);
  }
  function fade(d) { d.classList.add('fade'); setTimeout(function () { if (d.parentNode) d.parentNode.removeChild(d); }, 450); }

  var readyT = 0;
  function onEvents(evts) {
    for (var i = 0; i < evts.length; i++) {
      var e = evts[i];
      if (e.type === 'sold' || e.type === 'demolished' && e.refund) bumpMoney();
      switch (e.type) {
        case 'plotDied': toast('A plot dried out and died!', 'bad'); break;
        case 'tankEmpty': toast('A water tank ran dry', 'warn'); break;
        case 'plotReady':
          if (performance.now() - readyT > 8000) { readyT = performance.now(); toast('Sod ready to harvest!', 'info'); }
          break;
        case 'refillFull': toast('Trailer tank full', 'info'); break;
        case 'newDay': toast('Day ' + e.day, 'info'); break;
        case 'sold': toast('Sold ' + e.n + ' roll' + (e.n > 1 ? 's' : '') + ' +' + money(e.amount)); break;
        case 'landBought': toast('Land bought for ' + money(e.cost)); break;
        case 'equipBought':
          var eq = Sim.EQUIP.filter(function (q) { return q.id === e.id; })[0];
          toast((eq ? eq.name : e.id) + ' upgraded to Lv ' + e.level);
          break;
        default: break;
      }
    }
  }

  // ---------------------------------------------------------------- hints
  var HINTS = [
    'Pick <b>Seed</b> (<kbd>3</kbd>) and click the brown tilled dirt to plant sod.',
    'Plots need water. <b>P1</b> drives the truck close, <b>P2</b> aims the hose with the mouse and holds <b>Left Click</b>. Refill the trailer by parking at the <b>Fill Station</b>.',
    'When sod turns golden it’s ready: use <b>Harvest</b> (<kbd>4</kbd>) to cut it into rolls.',
    'Sell rolls with the <b>Sell</b> buttons in the top bar.',
    'Automate: place a <b>Sprinkler</b> (<kbd>8</kbd>) in the middle of your plots and drag <b>Pipe</b> (<kbd>5</kbd>) from the tank to it.'
  ];
  function hintsDone() { try { return localStorage.getItem(HINT_KEY) === 'done'; } catch (e) { return false; } }
  function showHint(k) {
    hintIdx = k;
    if (k >= HINTS.length) {
      els.hint.classList.add('hidden');
      try { localStorage.setItem(HINT_KEY, 'done'); } catch (e) { /* ignore */ }
      return;
    }
    els.hint.classList.remove('hidden');
    els['hint-step'].textContent = 'Tip ' + (k + 1) + ' / ' + HINTS.length;
    els['hint-text'].innerHTML = HINTS[k];
    els['hint-next'].textContent = k === HINTS.length - 1 ? 'Got it' : 'Next';
  }
  function startHints() { if (!hintsDone()) showHint(0); else els.hint.classList.add('hidden'); }

  // ---------------------------------------------------------------- per-frame update
  function toolCost(state, t, seedType) {
    if (!t.action || t.id === 'harvest') return '';
    if (t.id === 'demolish') return 'refund';
    if (t.id === 'seed') return '$' + Sim.costOf(state, 'seed', seedType);
    return '$' + Sim.costOf(state, t.action === 'land' ? 'land' : t.action);
  }

  function farmSummary(state) {
    var growing = 0, ready = 0, thirsty = 0, dry = 0, ST = Sim.SOD_TYPES, dryMin = Sim.C.DRY;
    for (var i = 0; i < state.ground.length; i++) {
      if (state.ground[i] !== 2) continue;
      if (state.growth[i] >= 1) ready++; else growing++;
      var T = ST[state.sodType[i]] || ST[0];
      if (state.moist[i] < dryMin) dry++;
      else if (state.moist[i] < T.minMoist) thirsty++;
    }
    var s = '<div class="row">Growing <b>' + growing + '</b></div><div class="row">Ready <b>' + ready + '</b></div>' +
      '<div class="row">Thirsty <b>' + (thirsty + dry) + '</b></div>';
    if (dry) s += '<div class="warn bad">' + dry + ' plot' + (dry > 1 ? 's are' : ' is') + ' drying out!</div>';
    else if (thirsty) s += '<div class="warn">' + thirsty + ' plot' + (thirsty > 1 ? 's' : '') + ' too dry to grow</div>';
    else if (!growing && !ready) s += '<div class="muted">No plots yet: till and seed some.</div>';
    return s;
  }

  function waterSummary(state) {
    var nets = Sim.networkInfo(state).filter(function (n) { return n.pumps + n.tanks + n.sprinklers + n.fills > 0; });
    var s = '', L = 'ABCDEFGHIJ';
    nets.forEach(function (n, k) {
      var pct = n.capacity > 0 ? Math.round(100 * n.stored / n.capacity) : 0;
      s += '<div class="net"><div class="net-name">Network ' + (L[k] || k + 1) + ' <span class="muted">' +
        n.pumps + 'P · ' + n.tanks + 'T · ' + n.sprinklers + 'S · ' + n.fills + 'F</span></div>' +
        '<div class="row">Pumps in <b>+' + n.inflow.toFixed(1) + ' L/s</b></div>' +
        '<div class="row">Demand <b>' + n.demand.toFixed(1) + ' L/s</b></div>';
      if (n.capacity > 0) s += '<div class="row">Stored <b>' + Math.round(n.stored) + ' / ' + n.capacity + ' L</b></div>' +
        '<div class="bar"><div style="width:' + pct + '%"></div></div>';
      var deficit = n.demand - n.inflow;
      if (n.demand > 0.01 && n.supplied < n.demand - 0.01) s += '<div class="warn bad">' + (n.capacity > 0 ? 'Tank empty! ' : '') + 'Demand exceeds supply</div>';
      else if (deficit > 0.01 && n.capacity > 0) s += '<div class="warn">Draining: empty in ~' + Math.ceil(n.stored / deficit) + ' s</div>';
      else if (!n.pumps) s += '<div class="warn">No pump: nothing refills this network</div>';
      else if (!n.capacity && n.demand < 0.01 && n.sprinklers + n.fills === 0) s += '<div class="muted">Add a tank to store water</div>';
      else s += '<div class="ok">Supply OK</div>';
      s += '</div>';
    });
    var loose = 0;
    for (var i = 0; i < state.struct.length; i++) { var c = state.struct[i]; if (c && c !== 5 && state.net.cell[i] < 0) loose++; }
    if (loose) s += '<div class="warn">' + loose + ' structure' + (loose > 1 ? 's' : '') + ' not connected to pipe</div>';
    return s || '<div class="muted">No water network</div>';
  }

  function equipHTML(state) {
    var fmt = {
      engine: function (st) { return Math.round(st.speed) + ' top speed'; },
      tank: function (st) { return Math.round(st.tankCap) + ' L'; },
      flow: function (st) { return st.flow + ' L/s'; },
      range: function (st) { return Math.round(st.range) + ' reach'; }
    };
    return Sim.equipInfo(state).map(function (e) {
      var f = fmt[e.id] || function () { return ''; };
      return '<div class="eq-card' + (e.afford ? ' afford' : '') + '"><div class="eq-top"><span class="eq-name">' + e.name +
        '</span><span class="eq-lvl">Lv ' + e.level + ' / ' + e.max + '</span></div><div class="eq-desc">' + e.desc + '</div>' +
        '<div class="eq-val">' + f(e.cur) + (e.next ? ' → <span class="next">' + f(e.next) + '</span>' : ' (max)') + '</div>' +
        '<button class="mini-btn" data-eq="' + e.id + '"' + (e.afford ? '' : ' disabled') + '>' +
        (e.maxed ? 'Maxed' : 'Upgrade ' + money(e.cost)) + '</button></div>';
    }).join('');
  }

  function update(state, ui, dt) {
    var tool = TOOLS.filter(function (t) { return t.id === ui.tool; })[0] || TOOLS[0];
    // cursor tip (every frame)
    var tip = els.tip, hv = ui.hover;
    if (hv && tool.action && ui.mouse.inside) {
      var line = hv.ok
        ? '<span class="yes">' + hv.label + '</span>' + (hv.cost ? ' ' + money(hv.cost) : '') + (hv.refund ? ' refund ' + money(hv.refund) : '')
        : '<span class="no">✖ ' + reasonText(hv.reason) + '</span>' + (hv.cost && hv.reason === 'money' ? ' (' + money(hv.cost) + ')' : '');
      setHTML('tip', tip, line);
      tip.classList.remove('hidden');
      var x = ui.mouse.x + 18, y = ui.mouse.y + 18;
      if (x + tip.offsetWidth > window.innerWidth - 6) x = ui.mouse.x - tip.offsetWidth - 10;
      if (y + tip.offsetHeight > window.innerHeight - 6) y = ui.mouse.y - tip.offsetHeight - 10;
      tip.style.transform = 'translate(' + x + 'px,' + y + 'px)';
    } else tip.classList.add('hidden');

    // top bar tank gauge (every frame, cheap)
    var tk = state.tank, pct = tk.cap > 0 ? tk.water / tk.cap : 0;
    els['hud-tank-fill'].style.width = (pct * 100).toFixed(1) + '%';
    els['hud-tank-fill'].className = tk.refilling ? 'refill' : (pct < 0.2 ? 'low' : '');
    setText(els['hud-tank-text'], tk.refilling ? 'Refilling ' + Math.round(tk.water) + ' L' : Math.round(tk.water) + ' / ' + Math.round(tk.cap) + ' L');

    slow -= dt;
    if (slow > 0) return;
    slow = 0.2;
    var st = Sim.getStats(state);
    setText(els['hud-money'], money(state.money));
    setText(els['hud-clock'], clockText(state.clock));
    setText(els['hud-inv'], 'Sod ' + st.invTotal + ' / ' + st.invCap);
    els['hud-inv'].parentNode.classList.toggle('full', st.invTotal >= st.invCap);
    var price1 = 0, priceAll = 0, got = false;
    state.inv.forEach(function (n, k) { if (n > 0) { if (!got) { price1 = Sim.SOD_TYPES[k].price; got = true; } priceAll += n * Sim.SOD_TYPES[k].price; } });
    els['btn-sell1'].disabled = els['btn-sellall'].disabled = !st.invTotal;
    els['btn-sell1'].textContent = 'Sell 1' + (got ? ' $' + price1 : '');
    els['btn-sellall'].textContent = 'Sell all' + (got ? ' $' + priceAll : '');
    els['btn-sell1'].title = 'Wholesale: ' + Sim.SOD_TYPES.map(function (t) { return t.name + ' $' + t.price; }).join(', ');
    setText(els['hud-cam'], 'C: Camera (' + ui.cameraMode + ')');
    setText(els['btn-mute'], ui.muted ? 'Sound: Off' : 'Sound: On');

    TOOLS.forEach(function (t) {
      var tb = toolBtns[t.id], c = toolCost(state, t, ui.seedType);
      setText(tb.cost, c);
      tb.b.classList.toggle('sel', t.id === tool.id);
      var n = c.charAt(0) === '$' ? +c.slice(1) : 0;
      tb.b.classList.toggle('poor', n > state.money);
    });
    els['seed-pick'].classList.toggle('hidden', tool.id !== 'seed');
    var opts = els['seed-pick'].children;
    for (var k = 0; k < opts.length; k++) opts[k].classList.toggle('sel', k === ui.seedType);
    var info = tool.info;
    if (tool.id === 'seed') info = Sim.SOD_TYPES[ui.seedType].name + ': ' + info;
    if (tool.id !== 'hose') info += ' · Right Click / Esc: back to hose';
    setText(els['tool-info'], info);

    setHTML('farm', els['farm-body'], farmSummary(state));
    setHTML('water', els['water-body'], waterSummary(state));
    if (equipOpen) {
      setText(els['equip-money'], money(state.money));
      setHTML('equip', els['equip-list'], equipHTML(state));
    }
  }

  function bumpMoney() {
    var m = els['hud-money'];
    m.classList.remove('bump'); void m.offsetWidth; m.classList.add('bump');
    setTimeout(function () { m.classList.remove('bump'); }, 120);
    slow = 0;
  }

  function reasonText(r) { return REASONS[r] || r || 'Can’t do that'; }

  SOD.BaseUI = {
    TOOLS: TOOLS,
    init: init, setScreen: setScreen, showPause: showPause, setMenuSave: setMenuSave,
    setEquipOpen: setEquipOpen, isEquipOpen: function () { return equipOpen; },
    update: update, toast: toast, onEvents: onEvents, startHints: startHints, reasonText: reasonText,
    refresh: function () { slow = 0; }
  };
})();
