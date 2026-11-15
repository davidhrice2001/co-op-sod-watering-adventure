/* Audio: all sounds synthesized with WebAudio. Driven from state (continuous sounds) and events (one-shots). */
(function () {
  'use strict';
  var SOD = (window.SOD = window.SOD || {});
  var MUTE_KEY = 'sodWatering.muted';

  var ac = null, master = null, noiseBuf = null;
  var hissG, hissF, refG, engG, engO1, engO2, engF;
  var muted = false, lastDing = 0, lastSput = 0;
  try { muted = localStorage.getItem(MUTE_KEY) === '1'; } catch (e) { /* ignore */ }

  function ensure() {
    if (ac) { if (ac.state === 'suspended') ac.resume(); return; }
    var AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    ac = new AC();
    master = ac.createGain();
    master.gain.value = muted ? 0 : 0.55;
    var comp = ac.createDynamicsCompressor();
    master.connect(comp); comp.connect(ac.destination);

    noiseBuf = ac.createBuffer(1, ac.sampleRate * 2, ac.sampleRate);
    var d = noiseBuf.getChannelData(0);
    for (var i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;

    // spray hiss
    var n1 = ac.createBufferSource(); n1.buffer = noiseBuf; n1.loop = true;
    hissF = ac.createBiquadFilter(); hissF.type = 'bandpass'; hissF.frequency.value = 3200; hissF.Q.value = 0.6;
    hissG = ac.createGain(); hissG.gain.value = 0;
    n1.connect(hissF); hissF.connect(hissG); hissG.connect(master); n1.start();

    // refill gurgle
    var n2 = ac.createBufferSource(); n2.buffer = noiseBuf; n2.loop = true; n2.playbackRate.value = 0.7;
    var rf = ac.createBiquadFilter(); rf.type = 'lowpass'; rf.frequency.value = 500; rf.Q.value = 8;
    var lfo = ac.createOscillator(); lfo.frequency.value = 7;
    var lfoG = ac.createGain(); lfoG.gain.value = 250;
    lfo.connect(lfoG); lfoG.connect(rf.frequency); lfo.start();
    refG = ac.createGain(); refG.gain.value = 0;
    n2.connect(rf); rf.connect(refG); refG.connect(master); n2.start();

    // engine
    engO1 = ac.createOscillator(); engO1.type = 'sawtooth'; engO1.frequency.value = 50;
    engO2 = ac.createOscillator(); engO2.type = 'square'; engO2.frequency.value = 25;
    engF = ac.createBiquadFilter(); engF.type = 'lowpass'; engF.frequency.value = 320;
    engG = ac.createGain(); engG.gain.value = 0;
    var o2g = ac.createGain(); o2g.gain.value = 0.5;
    engO1.connect(engF); engO2.connect(o2g); o2g.connect(engF); engF.connect(engG); engG.connect(master);
    engO1.start(); engO2.start();
  }

  function tone(freq, start, dur, type, vol, slideTo) {
    if (!ac) return;
    var o = ac.createOscillator(), g = ac.createGain();
    o.type = type || 'sine';
    o.frequency.setValueAtTime(freq, start);
    if (slideTo) o.frequency.exponentialRampToValueAtTime(slideTo, start + dur);
    g.gain.setValueAtTime(0.0001, start);
    g.gain.exponentialRampToValueAtTime(vol || 0.2, start + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, start + dur);
    o.connect(g); g.connect(master);
    o.start(start); o.stop(start + dur + 0.05);
  }
  function noiseBurst(start, dur, freq, vol) {
    if (!ac) return;
    var s = ac.createBufferSource(); s.buffer = noiseBuf;
    var f = ac.createBiquadFilter(); f.type = 'bandpass'; f.frequency.value = freq; f.Q.value = 1.2;
    var g = ac.createGain();
    g.gain.setValueAtTime(vol, start);
    g.gain.exponentialRampToValueAtTime(0.0001, start + dur);
    s.connect(f); f.connect(g); g.connect(master);
    s.start(start, Math.random()); s.stop(start + dur + 0.05);
  }

  var SCALE = [0, 2, 4, 7, 9, 12, 14, 16, 19, 21, 24, 26, 28, 31];

  function onEvents(evts) {
    if (!ac || !evts || !evts.length) return;
    var t = ac.currentTime;
    for (var i = 0; i < evts.length; i++) {
      var e = evts[i];
      switch (e.type) {
        case 'pay':
          if (t - lastDing < 0.045) break;
          lastDing = t;
          var semi = SCALE[Math.min(SCALE.length - 1, Math.max(0, e.combo - 1) >> 1)];
          var f = 880 * Math.pow(2, semi / 12);
          tone(f, t, 0.18, 'sine', 0.16);
          tone(f * 1.5, t + 0.04, 0.22, 'triangle', 0.09);
          if (e.bonus) { tone(f * 2, t + 0.08, 0.25, 'sine', 0.12); tone(f * 2.5, t + 0.14, 0.3, 'sine', 0.1); }
          break;
        case 'sputter':
          if (t - lastSput < 0.2) break; lastSput = t;
          noiseBurst(t, 0.09, 700, 0.25); noiseBurst(t + 0.13, 0.07, 500, 0.18);
          break;
        case 'buy':
          tone(1200, t, 0.08, 'square', 0.07); tone(1600, t + 0.07, 0.25, 'square', 0.07);
          noiseBurst(t + 0.05, 0.15, 5000, 0.08);
          break;
        case 'count': tone(520, t, 0.15, 'triangle', 0.2); break;
        case 'go': tone(1040, t, 0.35, 'triangle', 0.22); break;
        case 'tick': tone(1400, t, 0.05, 'square', 0.06); break;
        case 'refillStart': tone(300, t, 0.15, 'sine', 0.1, 500); break;
        case 'refillFull': tone(660, t, 0.1, 'sine', 0.14); tone(990, t + 0.1, 0.18, 'sine', 0.14); break;
        case 'comboEnd': tone(500, t, 0.25, 'triangle', 0.08, 300); break;
        case 'roundEnd':
          [523, 659, 784, 1047].forEach(function (fr, k) { tone(fr, t + k * 0.12, 0.3, 'triangle', 0.18); });
          break;
        case 'clear':
          [784, 988, 1175, 1568, 1976].forEach(function (fr, k) {
            tone(fr, t + 0.55 + k * 0.09, 0.4, 'square', 0.06); tone(fr / 2, t + 0.55 + k * 0.09, 0.4, 'triangle', 0.1);
          });
          break;
        default: break;
      }
    }
  }

  function update(state, dt) {
    if (!ac) return;
    var t = ac.currentTime;
    var live = state && state.phase === 'playing' && !state.paused;
    var hiss = 0;
    if (live && state.spray.on) hiss = 0.17;
    else if (live && state.spray.sputter) hiss = Math.random() < 0.3 ? 0.08 : 0.005;
    hissG.gain.setTargetAtTime(hiss, t, 0.03);
    hissF.frequency.setTargetAtTime(2600 + Math.random() * 1200, t, 0.05);

    refG.gain.setTargetAtTime(live && state.tank.refilling ? 0.22 : 0, t, 0.08);

    var v = state ? Math.abs(state.truck.v) : 0;
    var thr = state ? Math.abs(state.truck.throttle) : 0;
    var showEngine = state && (state.phase === 'playing' || state.phase === 'roundEnd') && !state.paused;
    var f = 38 + v * 0.2 + thr * 10;
    engO1.frequency.setTargetAtTime(f, t, 0.08);
    engO2.frequency.setTargetAtTime(f / 2, t, 0.08);
    engF.frequency.setTargetAtTime(250 + v * 0.9 + thr * 200, t, 0.1);
    engG.gain.setTargetAtTime(showEngine ? 0.05 + 0.05 * Math.min(1, v / 300) + thr * 0.02 : 0, t, 0.1);
  }

  function setMuted(m) {
    muted = !!m;
    try { localStorage.setItem(MUTE_KEY, muted ? '1' : '0'); } catch (e) { /* ignore */ }
    if (master) master.gain.setTargetAtTime(muted ? 0 : 0.55, ac.currentTime, 0.02);
  }

  function unlock() { ensure(); }
  window.addEventListener('pointerdown', unlock);
  window.addEventListener('keydown', unlock);

  SOD.Audio = {
    update: update,
    onEvents: onEvents,
    setMuted: setMuted,
    toggleMute: function () { setMuted(!muted); return muted; },
    isMuted: function () { return muted; }
  };
})();
