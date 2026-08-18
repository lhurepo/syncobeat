// SyncoBeat smoke tests — runs content.js inside a Node `vm` sandbox with a
// virtual clock, fake Web Audio, fake DOM, and fake chrome APIs.
// Zero dependencies:  node tests/run.js

'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SOURCE = fs.readFileSync(path.join(__dirname, '..', 'content.js'), 'utf8');

// --- Harness -----------------------------------------------------------------
function createHarness() {
  const h = {};
  let now = 0; // virtual ms
  let timerId = 1;
  let timers = [];

  const fakeSetTimeout = (fn, ms) => {
    const id = timerId++;
    timers.push({ id, at: now + Math.max(0, ms || 0), fn });
    return id;
  };
  const fakeClearTimeout = (id) => { timers = timers.filter((t) => t.id !== id); };

  h.flush = (ms) => {
    const end = now + ms;
    for (;;) {
      const due = timers.filter((t) => t.at <= end).sort((a, b) => a.at - b.at)[0];
      if (!due) break;
      timers = timers.filter((t) => t !== due);
      now = Math.max(now, due.at);
      due.fn();
    }
    now = end;
  };
  h.now = () => now;

  // Fake Web Audio: log every oscillator start; cancellation shows up as a
  // disconnect() on the click's envelope gain before its start time.
  const oscLog = [];
  class FakeParam {
    constructor(v) { this.value = v; }
    setValueAtTime() {}
    exponentialRampToValueAtTime() {}
  }
  class FakeNode {
    constructor() { this._out = null; this._disconnected = false; }
    connect(t) { this._out = t; return t; }
    disconnect() { this._disconnected = true; }
  }
  class FakeGain extends FakeNode {
    constructor() { super(); this.gain = new FakeParam(1); }
  }
  class FakeOsc extends FakeNode {
    constructor() { super(); this.type = 'sine'; this.frequency = new FakeParam(440); }
    start(when) { oscLog.push({ when, node: this }); }
    stop() {}
  }
  class FakeBufferSource extends FakeNode {
    constructor() { super(); this.buffer = null; }
    start() {}
    stop() {}
  }
  class FakeCompressor extends FakeNode {
    constructor() {
      super();
      for (const k of ['threshold', 'knee', 'ratio', 'attack', 'release']) this[k] = new FakeParam(0);
    }
  }
  class FakeAudioContext {
    constructor() { this.state = 'running'; this.sampleRate = 48000; this.destination = new FakeNode(); this.onstatechange = null; }
    get currentTime() { return now / 1000; }
    resume() { return Promise.resolve(); }
    createGain() { return new FakeGain(); }
    createOscillator() { return new FakeOsc(); }
    createBufferSource() { return new FakeBufferSource(); }
    createDynamicsCompressor() { return new FakeCompressor(); }
    createBuffer(ch, len) { return { getChannelData: () => new Float32Array(len) }; }
  }

  // clicks(): {when, freq, canceled} for the 'original' voice (1 osc/click).
  h.clicks = () => oscLog.map((e) => ({
    when: e.when,
    freq: e.node.frequency.value,
    canceled: !!(e.node._out && e.node._out._disconnected)
  }));

  // Fake video whose clock advances with the virtual clock while playing.
  const listeners = {};
  const video = {
    _base: 0, _rate: 1, _playing: false, _wallStart: 0,
    driftBias: 0,
    ended: false, seeking: false, readyState: 4,
    closest: () => null,
    get currentTime() {
      return this._playing
        ? this._base + (now / 1000 - this._wallStart) * this._rate + this.driftBias
        : this._base;
    },
    set currentTime(v) { this._base = v; this._wallStart = now / 1000; },
    get paused() { return !this._playing; },
    get playbackRate() { return this._rate; },
    set playbackRate(v) { this._base = this.currentTime; this._wallStart = now / 1000; this._rate = v; },
    addEventListener(ev, fn) { (listeners[ev] = listeners[ev] || []).push(fn); },
    removeEventListener(ev, fn) { if (listeners[ev]) listeners[ev] = listeners[ev].filter((f) => f !== fn); },
    emit(ev) { for (const fn of (listeners[ev] || []).slice()) fn(); },
    play() { this._playing = true; this._wallStart = now / 1000; this.emit('play'); },
    pause() { this._base = this.currentTime; this._playing = false; this.emit('pause'); },
    seekTo(v) { this.emit('seeking'); this.currentTime = v; this.emit('seeked'); }
  };
  h.video = video;

  const player = {
    _classes: new Set(),
    classList: { contains: (c) => player._classes.has(c) }
  };
  h.player = player;

  const moInstances = [];
  class FakeMutationObserver {
    constructor(cb) { this.cb = cb; this.target = null; moInstances.push(this); }
    observe(target) { this.target = target; }
    disconnect() { this.target = null; }
  }
  h.setAdShowing = (on) => {
    if (on) player._classes.add('ad-showing');
    else player._classes.delete('ad-showing');
    for (const mo of moInstances) if (mo.target === player) mo.cb();
  };

  const docListeners = {};
  const document = {
    hidden: false,
    visibilityState: 'visible',
    documentElement: {},
    querySelector: (sel) => (sel.includes('html5-main-video') ? video : null),
    getElementById: (id) => (id === 'movie_player' ? player : null),
    contains: () => true,
    addEventListener(ev, fn) { (docListeners[ev] = docListeners[ev] || []).push(fn); },
    removeEventListener() {}
  };
  h.document = document;
  h.emitDoc = (ev) => { for (const fn of (docListeners[ev] || []).slice()) fn({}); };

  const winListeners = {};
  const window = {
    location: { pathname: '/watch', search: '?v=vid-a', href: 'https://www.youtube.com/watch?v=vid-a' },
    AudioContext: FakeAudioContext,
    addEventListener(ev, fn) { (winListeners[ev] = winListeners[ev] || []).push(fn); },
    removeEventListener() {}
  };
  h.window = window;

  h.keydown = (code) => {
    let stopped = false;
    const ev = {
      code, repeat: false, ctrlKey: false, altKey: false, metaKey: false,
      target: { tagName: 'BODY', isContentEditable: false },
      preventDefault() {}, stopPropagation() {},
      stopImmediatePropagation() { stopped = true; }
    };
    for (const fn of (winListeners.keydown || []).slice()) { fn(ev); if (stopped) return; }
    for (const fn of (docListeners.keydown || []).slice()) { fn(ev); if (stopped) return; }
  };

  // Fake chrome: promise-based storage.local + onChanged, onConnect capture.
  const storageData = {};
  const storageListeners = [];
  let onConnectHandler = null;
  const chrome = {
    storage: {
      local: {
        get: async () => ({ ...storageData }),
        set: async (obj) => {
          const changes = {};
          for (const k of Object.keys(obj)) {
            changes[k] = { oldValue: storageData[k], newValue: obj[k] };
            storageData[k] = obj[k];
          }
          for (const fn of storageListeners) fn(changes, 'local');
        }
      },
      onChanged: { addListener: (fn) => storageListeners.push(fn) }
    },
    runtime: {
      onConnect: { addListener: (fn) => { onConnectHandler = fn; } },
      lastError: undefined
    }
  };
  h.setStorage = (obj) => chrome.storage.local.set(obj);
  h.storage = storageData;

  h.portMessages = [];
  h.connectPort = () => {
    const msgFns = [];
    const port = {
      name: 'syncobeat',
      onMessage: { addListener: (fn) => msgFns.push(fn) },
      onDisconnect: { addListener: () => {} },
      postMessage: (m) => h.portMessages.push(m),
      disconnect: () => {}
    };
    onConnectHandler(port);
    return { send: (m) => msgFns.forEach((fn) => fn(m)) };
  };

  const sandbox = {
    window, document, chrome,
    MutationObserver: FakeMutationObserver,
    setTimeout: fakeSetTimeout,
    clearTimeout: fakeClearTimeout,
    performance: { now: () => now },
    console
  };
  vm.createContext(sandbox);
  vm.runInContext(SOURCE, sandbox, { filename: 'content.js' });
  h.state = () => sandbox.window.__syncoBeatTest.getState();
  return h;
}

const settle = () => new Promise((r) => setImmediate(() => setImmediate(() => setImmediate(r))));

// --- Test runner ----------------------------------------------------------------
let failures = 0;
function check(name, cond, detail) {
  if (cond) {
    console.log(`  ok    ${name}`);
  } else {
    failures += 1;
    console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
}
const approx = (a, b, tol = 0.003) => Math.abs(a - b) <= tol;

async function main() {
  // ---- Auto mode: phase-locked start, cadence, accent -------------------------
  {
    console.log('auto mode');
    const h = createHarness();
    await settle();
    check('video attached at init', h.state().hasVideo);
    check('not playing while video paused', !h.state().isPlaying);

    h.video.play(); // t=0, video time 0, bpm 120 → first click at +0.5
    h.flush(2600);
    const c = h.clicks().filter((x) => !x.canceled);
    check('clicks scheduled after play', c.length >= 4, `got ${c.length}`);
    check('first click on the video beat grid', approx(c[0].when, 0.5), `when=${c[0].when}`);
    check('cadence is 60/bpm', approx(c[1].when - c[0].when, 0.5));
    check('first grid beat is accented', c[0].freq === 1200, `freq=${c[0].freq}`);
    check('second beat unaccented', c[1].freq === 800, `freq=${c[1].freq}`);
    check('beat 5 accented again', c[4].freq === 1200);

    // BPM change via storage (the popup's write path) retimes smoothly.
    await h.setStorage({ bpm: 100 });
    h.flush(2000);
    const after = h.clicks().filter((x) => !x.canceled && x.when > 2.7);
    check('new cadence after storage bpm change', approx(after[1].when - after[0].when, 0.6),
      `Δ=${(after[1].when - after[0].when).toFixed(3)}`);

    // Pause cancels clicks already committed inside the look-ahead. Advance
    // in small steps until a click is scheduled but not yet audible.
    for (let i = 0; i < 100; i += 1) {
      if (h.clicks().some((x) => !x.canceled && x.when > h.now() / 1000)) break;
      h.flush(10);
    }
    const prePause = h.clicks().length;
    h.video.pause();
    check('pause cancels pending clicks', h.clicks().some((x) => x.canceled));
    h.flush(2000);
    check('no new clicks while paused', h.clicks().length === prePause);

    // Seek realigns to the video grid.
    h.video.play();
    h.flush(200);
    h.video.seekTo(10.3); // bpm 100 → beat 0.6; phase(10.3)=0.1 → next in 0.5
    const tSeek = h.now() / 1000;
    h.flush(1500);
    const postSeek = h.clicks().filter((x) => !x.canceled && x.when >= tSeek);
    check('post-seek click lands on the grid', approx(postSeek[0].when - tSeek, 0.5),
      `Δ=${(postSeek[0].when - tSeek).toFixed(3)}`);
  }

  // ---- Manual mode + lock -------------------------------------------------------
  {
    console.log('manual mode + lock');
    const h = createHarness();
    await settle();
    h.video.play();
    h.flush(300);
    await h.setStorage({ mode: 'manual' });
    check('switching to manual stops the auto click', !h.state().isPlaying);

    h.flush(100);
    const t0 = h.now() / 1000;
    h.keydown('KeyB'); // tap = beat 1, immediately
    check('hotkey starts manual click', h.state().isPlaying);
    h.flush(1300); // bpm 120 → beats at t0, +0.5, +1.0; next = t0+1.5
    const c = h.clicks().filter((x) => !x.canceled);
    check('first manual click fires on the tap', approx(c[0].when, t0, 0.005), `when=${c[0].when} t0=${t0}`);
    check('tap is beat 1 (accented)', c[0].freq === 1200);

    // Lock: anchor the running grid to the video, preserving phase + numbering.
    h.video.currentTime = 50.2;
    h.keydown('KeyV');
    check('lock hotkey locks', h.state().locked);

    // Rate change while locked: cadence halves, lock SURVIVES (regression for
    // the old restart() path that silently destroyed the lock).
    h.video.playbackRate = 2;
    h.video.emit('ratechange');
    h.flush(1200);
    check('lock survives a playback-rate change', h.state().locked);
    const fast = h.clicks().filter((x) => !x.canceled).slice(-3);
    check('cadence follows playback rate', approx(fast[2].when - fast[1].when, 0.25),
      `Δ=${(fast[2].when - fast[1].when).toFixed(3)}`);

    h.video.playbackRate = 1;
    h.video.emit('ratechange');

    // Seek while locked: clicks come back on the tapped grid (same phase mod beat).
    const beatPhase = (v) => ((v % 0.5) + 0.5) % 0.5;
    const anchorPhase = beatPhase(h.state().phaseOffset);
    h.video.seekTo(100);
    const tSeek = h.now() / 1000;
    h.flush(1500);
    const post = h.clicks().filter((x) => !x.canceled && x.when >= tSeek);
    const clickVideoTime = 100 + (post[0].when - tSeek);
    check('post-seek click lands on the locked grid', approx(beatPhase(clickVideoTime), anchorPhase, 0.005),
      `phase=${beatPhase(clickVideoTime).toFixed(3)} anchor=${anchorPhase.toFixed(3)}`);

    // Stop clears the lock.
    h.keydown('KeyB');
    check('stop hotkey stops and unlocks', !h.state().isPlaying && !h.state().locked);
  }

  // ---- Hidden-tab buffering, drift correction, ads, port ---------------------------
  {
    console.log('stability');
    const h = createHarness();
    await settle();
    h.video.play();
    h.flush(300);

    // Hidden tab: scheduler must buffer seconds ahead of a throttled timer.
    h.document.hidden = true;
    h.emitDoc('visibilitychange');
    const tHide = h.now() / 1000;
    const buffered = h.clicks().filter((x) => !x.canceled && x.when > tHide + 2.5);
    check('hidden tab buffers clicks ≥2.5s ahead', buffered.length > 0);
    h.document.hidden = false;
    h.emitDoc('visibilitychange');
    h.flush(4000);

    // Drift: skew the video clock by 60ms → corrector snaps back within ~2 checks.
    h.video.driftBias = 0.06;
    h.flush(2000);
    const st = h.state();
    const grid = ((h.video.currentTime % 0.5) + 0.5) % 0.5;
    const nextClickVideoTime = h.video.currentTime + (st.nextNoteTime - h.now() / 1000);
    const phaseErr = Math.abs(((nextClickVideoTime % 0.5) + 0.5) % 0.5);
    const folded = Math.min(phaseErr, 0.5 - phaseErr);
    check('drift corrector realigns to video clock', folded < 0.01, `err=${folded.toFixed(4)} grid=${grid.toFixed(3)}`);

    // Ads: click pauses when the player enters ad state, resumes after.
    h.setAdShowing(true);
    check('ad pauses the click', !h.state().isPlaying);
    h.setAdShowing(false);
    check('click resumes after the ad', h.state().isPlaying);

    // Port: connecting pushes a state snapshot; MANUAL_TOGGLE is rejected in auto.
    const port = h.connectPort();
    const first = h.portMessages.find((m) => m.type === 'state');
    check('port connect pushes state', !!first && first.isPlaying === true);
    await h.setStorage({ mode: 'manual' });
    port.send({ type: 'MANUAL_TOGGLE' });
    check('MANUAL_TOGGLE starts via port', h.state().isPlaying);
    port.send({ type: 'MANUAL_TOGGLE' });
    check('MANUAL_TOGGLE stops via port', !h.state().isPlaying);
  }

  // ---- Per-video memory --------------------------------------------------------
  {
    console.log('per-video memory');
    const h = createHarness();
    await settle();
    h.video.play();
    h.flush(300);

    // Changing a remembered setting snapshots it under the current video ID.
    await h.setStorage({ bpm: 90, syncOffsetMs: 40 });
    h.flush(1500); // save debounce
    await settle();
    const memA = h.storage.videoMemory && h.storage.videoMemory['vid-a'];
    check('settings change saves a snapshot for the video', !!memA && memA.bpm === 90 && memA.syncOffsetMs === 40,
      JSON.stringify(h.storage.videoMemory));

    // Navigating to a new (unremembered) video leaves settings alone…
    h.window.location.search = '?v=vid-b';
    h.emitDoc('yt-navigate-finish');
    await settle();
    check('unremembered video keeps current settings', h.state().settings.bpm === 90);

    // …and tweaks there are remembered separately.
    await h.setStorage({ bpm: 140 });
    h.flush(1500);
    await settle();
    check('second video gets its own snapshot', h.storage.videoMemory['vid-b'].bpm === 140);
    check('first snapshot untouched', h.storage.videoMemory['vid-a'].bpm === 90);

    // Returning to the first video restores its snapshot.
    h.window.location.search = '?v=vid-a';
    h.emitDoc('yt-navigate-finish');
    await settle();
    check('revisiting restores the remembered tempo', h.state().settings.bpm === 90,
      `bpm=${h.state().settings.bpm}`);
    check('revisiting restores the remembered offset', h.state().settings.syncOffsetMs === 40);
  }

  console.log(failures === 0 ? '\nAll tests passed.' : `\n${failures} test(s) FAILED.`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => { console.error(err); process.exit(1); });
