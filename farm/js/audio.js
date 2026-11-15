/* Home base audio: everything synthesized with WebAudio (adapted from the root js/audio.js).
 *   SOD.Audio.update(state, live)  continuous sounds (engine, hose hiss, refill gurgle)
 *   SOD.Audio.onEvents(events)     one-shots from BaseSim events
 *   SOD.Audio.fail()               short "nope" for a refused action
 *   setMuted / toggleMute / isMuted
 */
(function () {
  'use strict';
  var SOD = (window.SOD = window.SOD || {});
  var MUTE_KEY = 'sodFarm.muted';

  var ac = null, master = null, noiseBuf = null;
  var hissG, hissF, refG, engG, engO1, engO2, engF;
  var muted = false, last = {};
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

    var n1 = ac.createBufferSource(); n1.buffer = noiseBuf; n1.loop = true;
    hissF = ac.createBiquadFilter(); hissF.type = 'bandpass'; hissF.frequency.value = 3200; hissF.Q.value = 0.6;
    hissG = ac.createGain(); hissG.gain.value = 0;
    n1.connect(hissF); hissF.connect(hissG); hissG.connect(master); n1.start();

    var n2 = ac.createBufferSource(); n2.buffer = noiseBuf; n2.loop = true; n2.playbackRate.value = 0.7;
    var rf = ac.createBiquadFilter(); rf.type = 'lowpass'; rf.frequency.value = 500; rf.Q.value = 8;
    var lfo = ac.createOscillator(); lfo.frequency.value = 7;
    var lfoG = ac.createGain(); lfoG.gain.value = 250;
    lfo.connect(lfoG); lfoG.connect(rf.frequency); lfo.start();
    refG = ac.createGain(); refG.gain.value = 0;
    n2.connect(rf); rf.connect(refG); refG.connect(master); n2.start();

    engO1 = ac.createOscillator(); engO1.type = 'sawtooth'; engO1.frequency.value = 50;
    engO2 = ac.createOscillator(); engO2.type = 'square'; engO2.frequency.value = 25;
    engF = ac.createBiquadFilter(); engF.type = 'lowpass'; engF.frequency.value = 320;
    engG = ac.createGain(); engG.gain.value = 0;
    var o2g = ac.createGain(); o2g.gain.value = 0.5;
    engO1.connect(engF); engO2.connect(o2g); o2g.connect(engF); engF.connect(engG); engG.connect(master);
    engO1.start(); engO2.start();
  }

  function tone(freq, start, dur, type, vol, slideTo) {
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
  function noise(start, dur, freq, vol, q) {
    var s = ac.createBufferSource(); s.buffer = noiseBuf;
    var f = ac.createBiquadFilter(); f.type = 'bandpass'; f.frequency.value = freq; f.Q.value = q || 1.2;
    var g = ac.createGain();
    g.gain.setValueAtTime(vol, start);
    g.gain.exponentialRampToValueAtTime(0.0001, start + dur);
    s.connect(f); f.connect(g); g.connect(master);
    s.start(start, Math.random()); s.stop(start + dur + 0.05);
  }
  // rate-limit per sound so drag-painting doesn't machine-gun
  function ok(name, gap) { var t = ac.currentTime; if (t - (last[name] || -9) < gap) return false; last[name] = t; return true; }

  function onEvents(evts) {
    if (!ac || !evts || !evts.length) return;
    var t = ac.currentTime;
    for (var i = 0; i < evts.length; i++) {
      var e = evts[i];
      switch (e.type) {
        case 'built':
          if (!ok('built', 0.06)) break;
          if (e.kind === 'pipe') { tone(220, t, 0.08, 'square', 0.06, 160); noise(t, 0.05, 2500, 0.08); }
          else { tone(140, t, 0.18, 'sine', 0.3, 70); noise(t, 0.12, 400, 0.3); tone(880, t + 0.08, 0.12, 'triangle', 0.06); }
          break;
        case 'demolished':
          if (!ok('demo', 0.06)) break;
          noise(t, 0.2, 900, 0.3, 0.8); tone(180, t, 0.2, 'sawtooth', 0.06, 90);
          break;
        case 'tilled': if (ok('till', 0.05)) noise(t, 0.1, 1200, 0.22, 2); break;
        case 'seeded': if (ok('seed', 0.05)) { noise(t, 0.06, 6000, 0.08); tone(660, t, 0.06, 'triangle', 0.05); } break;
        case 'harvested':
          if (!ok('harv', 0.05)) break;
          tone(500, t, 0.1, 'sine', 0.2, 900); noise(t, 0.05, 3000, 0.1);
          break;
        case 'sold':
          tone(1200, t, 0.08, 'square', 0.07); tone(1600, t + 0.07, 0.25, 'square', 0.07); noise(t + 0.05, 0.15, 5000, 0.08);
          break;
        case 'plotReady': if (ok('ready', 0.3)) { tone(880, t, 0.15, 'sine', 0.12); tone(1320, t + 0.06, 0.2, 'triangle', 0.08); } break;
        case 'plotDied': if (ok('died', 0.4)) tone(330, t, 0.45, 'triangle', 0.16, 160); break;
        case 'tankEmpty': if (ok('tankE', 1)) { tone(440, t, 0.15, 'square', 0.06); tone(330, t + 0.16, 0.25, 'square', 0.06); } break;
        case 'landBought': case 'equipBought':
          [523, 659, 784, 1047].forEach(function (fr, k) { tone(fr, t + k * 0.08, 0.25, 'triangle', 0.15); });
          break;
        case 'newDay': [392, 523].forEach(function (fr, k) { tone(fr, t + k * 0.14, 0.4, 'sine', 0.1); }); break;
        case 'sputter':
          if (!ok('sput', 0.2)) break;
          noise(t, 0.09, 700, 0.25); noise(t + 0.13, 0.07, 500, 0.18);
          break;
        case 'refillStart': tone(300, t, 0.15, 'sine', 0.1, 500); break;
        case 'refillFull': tone(660, t, 0.1, 'sine', 0.14); tone(990, t + 0.1, 0.18, 'sine', 0.14); break;
        default: break;
      }
    }
  }

  function fail() {
    if (!ac || !ok('fail', 0.25)) return;
    var t = ac.currentTime;
    tone(180, t, 0.12, 'square', 0.07); tone(140, t + 0.1, 0.15, 'square', 0.07);
  }

  function update(state, live) {
    if (!ac || !state) return;
    var t = ac.currentTime;
    var hiss = 0;
    if (live && state.spray.on) hiss = 0.17;
    else if (live && state.spray.sputter) hiss = Math.random() < 0.3 ? 0.08 : 0.005;
    hissG.gain.setTargetAtTime(hiss, t, 0.03);
    hissF.frequency.setTargetAtTime(2600 + Math.random() * 1200, t, 0.05);
    refG.gain.setTargetAtTime(live && state.tank.refilling ? 0.22 : 0, t, 0.08);
    var v = Math.abs(state.truck.v), thr = Math.abs(state.truck.throttle);
    var f = 38 + v * 0.2 + thr * 10;
    engO1.frequency.setTargetAtTime(f, t, 0.08);
    engO2.frequency.setTargetAtTime(f / 2, t, 0.08);
    engF.frequency.setTargetAtTime(250 + v * 0.9 + thr * 200, t, 0.1);
    engG.gain.setTargetAtTime(live ? 0.04 + 0.05 * Math.min(1, v / 300) + thr * 0.02 : 0, t, 0.1);
  }

  function setMuted(m) {
    muted = !!m;
    try { localStorage.setItem(MUTE_KEY, muted ? '1' : '0'); } catch (e) { /* ignore */ }
    if (master) master.gain.setTargetAtTime(muted ? 0 : 0.55, ac.currentTime, 0.02);
  }

  window.addEventListener('pointerdown', ensure);
  window.addEventListener('keydown', ensure);

  SOD.Audio = {
    update: update,
    onEvents: onEvents,
    fail: fail,
    setMuted: setMuted,
    toggleMute: function () { setMuted(!muted); return muted; },
    isMuted: function () { return muted; }
  };
})();
