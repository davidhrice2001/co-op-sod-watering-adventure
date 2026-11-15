/* UI: HTML overlays + HUD. Reads state, never mutates it. All actions go through callbacks
 * supplied by main (which forwards to SOD.Sim action functions, or later to the network). */
(function () {
  'use strict';
  var SOD = (window.SOD = window.SOD || {});
  var $ = function (id) { return document.getElementById(id); };
  var cb = {};
  var lastPhase = null, lastPaused = null, shopKey = '', hudCache = {}, lastMoney = null, bumpT = 0;

  function fmt(n) { return '$' + Math.round(n).toLocaleString('en-US'); }
  function setText(id, v) { if (hudCache[id] !== v) { hudCache[id] = v; $(id).textContent = v; } }

  function init(callbacks) {
    cb = callbacks || {};
    $('btn-new').onclick = function () { cb.onNewGame && cb.onNewGame(); };
    $('btn-continue').onclick = function () { cb.onContinue && cb.onContinue(); };
    $('btn-to-shop').onclick = function () { cb.onToShop && cb.onToShop(); };
    $('btn-start').onclick = function () { cb.onStartRound && cb.onStartRound(); };
    $('btn-resume').onclick = function () { cb.onResume && cb.onResume(); };
    $('btn-quit').onclick = function () { cb.onQuit && cb.onQuit(); };
    $('btn-menu-from-shop').onclick = function () { cb.onQuit && cb.onQuit(); };
    $('btn-pause-mute').onclick = function () { cb.onMute && cb.onMute(); };
    $('mute-btn').onclick = function (e) { cb.onMute && cb.onMute(); e.currentTarget.blur(); };
    $('shop-grid').addEventListener('click', function (e) {
      var b = e.target.closest('.buy-btn');
      if (b && !b.disabled && cb.onBuy) cb.onBuy(b.getAttribute('data-id'));
    });
  }

  function setMenuSave(save) {
    var cont = $('btn-continue'), info = $('save-info');
    if (save) {
      cont.classList.remove('hidden');
      info.textContent = 'Saved game: ' + save.round + ' round' + (save.round === 1 ? '' : 's') + ' done, ' + fmt(save.money) + ' in the bank';
    } else {
      cont.classList.add('hidden');
      info.textContent = '';
    }
  }

  function setMuted(m) {
    $('mute-btn').textContent = m ? 'Sound: Off' : 'Sound: On';
  }

  function showOnly(phase, paused) {
    $('menu').classList.toggle('hidden', phase !== 'menu');
    $('roundEnd').classList.toggle('hidden', phase !== 'roundEnd');
    $('shop').classList.toggle('hidden', phase !== 'shop');
    $('pause').classList.toggle('hidden', !(phase === 'playing' && paused));
    $('hud').classList.toggle('hidden', phase !== 'playing' && phase !== 'roundEnd');
  }

  function buildRoundEnd(state) {
    var r = state.lastRound;
    if (!r) return;
    $('end-title').textContent = r.cleared ? 'Field Cleared! Round ' + r.round : 'Round ' + r.round + ' Complete!';
    $('end-total').textContent = fmt(r.total);
    var rows = [
      ['Tiles watered', r.tiles + ' (' + Math.round(r.fieldPct * 100) + '% of field)'],
      ['Golden tiles', r.bonusTiles],
      ['Best combo', r.bestCombo + 'x'],
      ['Water sprayed', Math.round(r.waterUsed) + ' L'],
      ['Tile earnings', fmt(r.earned)]
    ];
    if (r.tip) rows.push(['Tip jar', '+' + fmt(r.tip)]);
    if (r.cleared) rows.push(['Field cleared bonus (' + r.timeLeft.toFixed(1) + 's early)', '+' + fmt(r.clearBonus)]);
    rows.push(['Bank balance', fmt(state.money)]);
    $('end-stats').innerHTML = rows.map(function (x, i) {
      return '<div class="end-row' + (i === rows.length - 1 ? ' hl' : '') + '"><span>' + x[0] + '</span><b>' + x[1] + '</b></div>';
    }).join('');
  }

  function buildShop(state) {
    var info = SOD.Sim.upgradeInfo(state);
    var key = state.money + '|' + info.map(function (u) { return u.level; }).join(',');
    if (key === shopKey) return;
    shopKey = key;
    $('shop-money').textContent = fmt(state.money);
    $('shop-sub').textContent = 'Next up: Round ' + (state.round + 1) + '  -  fields get thirstier (and pay more) every round';
    $('btn-start').textContent = 'Start Round ' + (state.round + 1);
    $('shop-grid').innerHTML = info.map(function (u) {
      var pips = '';
      for (var i = 0; i < u.max; i++) pips += '<span class="pip' + (i < u.level ? ' on' : '') + '"></span>';
      var val = u.maxed ? '<span class="next">' + u.cur + '</span> (MAX)'
        : u.cur + '<span class="arrow">&rarr;</span><span class="next">' + u.next + '</span>';
      var btn = u.maxed ? '<button class="buy-btn" disabled>Maxed out</button>'
        : '<button class="buy-btn" data-id="' + u.id + '"' + (u.afford ? '' : ' disabled') + '>Buy ' + fmt(u.cost) + '</button>';
      return '<div class="card' + (u.afford ? ' afford' : '') + (u.maxed ? ' maxed' : '') + '">' +
        '<div class="card-top"><span class="card-name">' + u.name + '</span><span class="card-lvl">Lv ' + u.level + '/' + u.max + '</span></div>' +
        '<div class="card-desc">' + u.desc + '</div>' +
        '<div class="pips">' + pips + '</div>' +
        '<div class="card-val">' + val + '</div>' + btn + '</div>';
    }).join('');
  }

  function updateHud(state, dt, aimMode) {
    setText('hud-round', 'Round ' + state.round);
    var tm = Math.max(0, state.timer);
    setText('hud-timer', tm < 10 ? tm.toFixed(1) : String(Math.ceil(tm)));
    var low = state.phase === 'playing' && state.countdown <= 0 && tm <= 10;
    if (hudCache.timerLow !== low) { hudCache.timerLow = low; $('hud-timer').classList.toggle('low', low); }
    setText('hud-money', fmt(state.money));
    if (lastMoney !== null && state.money > lastMoney) bumpT = 0.12;
    lastMoney = state.money;
    bumpT -= dt;
    var bump = bumpT > 0;
    if (hudCache.bump !== bump) { hudCache.bump = bump; $('hud-money').classList.toggle('bump', bump); }

    var c = state.combo;
    var active = c.count > 0;
    if (hudCache.comboActive !== active) { hudCache.comboActive = active; $('hud-combo').classList.toggle('active', active); }
    setText('combo-mult', 'x' + c.mult.toFixed(2));
    setText('combo-count', active ? 'COMBO ' + c.count : 'COMBO');
    $('combo-fill').style.width = (active ? Math.max(0, c.timer / (c.window || 1)) * 100 : 0).toFixed(1) + '%';

    var t = state.tank, f = t.cap ? t.water / t.cap : 0;
    $('tank-fill').style.width = (f * 100).toFixed(1) + '%';
    var lowT = f < 0.2;
    if (hudCache.tankLow !== lowT) { hudCache.tankLow = lowT; $('tank-fill').classList.toggle('low', lowT); }
    setText('tank-text', Math.round(t.water) + ' / ' + Math.round(t.cap) + ' L');
    var status = '', warn = false;
    if (t.refilling) status = 'Refilling...';
    else if (t.near && t.water < t.cap && Math.abs(state.truck.v) >= SOD.Sim.C.REFILL_MAX_SPEED) { status = 'Slow down to refill!'; warn = true; }
    else if (t.near && t.water >= t.cap) status = 'Tank full';
    else if (t.water <= 0.0001) { status = 'EMPTY! Drive to a REFILL circle'; warn = true; }
    else if (lowT) { status = 'Running low'; warn = true; }
    setText('tank-status', status);
    if (hudCache.tankWarn !== warn) { hudCache.tankWarn = warn; $('tank-status').classList.toggle('warn', warn); }

    var fld = state.field;
    setText('field-pct', Math.floor(fld.doneCount / fld.total * 100) + '%');
    setText('round-earned', fmt(state.roundStats.earned));
    var am = aimMode === 'keys' ? 'Arrows + R-Ctrl/Enter' : aimMode === 'pad' ? 'Gamepad' : 'Mouse';
    setText('hud-aim-mode', 'Sprayer: ' + am);
  }

  function update(state, dt, aimMode, camMode) {
    if (camMode && $('hud-cam')) setText('hud-cam', 'C: Camera (' + camMode + ')');
    if (state.phase !== lastPhase || state.paused !== lastPaused) {
      showOnly(state.phase, state.paused);
      if (state.phase === 'roundEnd' && lastPhase !== 'roundEnd') buildRoundEnd(state);
      if (state.phase === 'shop') shopKey = '';
      lastPhase = state.phase; lastPaused = state.paused;
    }
    if (state.phase === 'shop') buildShop(state);
    if (state.phase === 'playing' || state.phase === 'roundEnd') updateHud(state, dt, aimMode);
  }

  SOD.UI = { init: init, update: update, setMenuSave: setMenuSave, setMuted: setMuted };
})();
