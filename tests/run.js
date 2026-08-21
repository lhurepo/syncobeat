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

  // --- Minimal element model -------------------------------------------------
  // Enough DOM for the overlay layer: children, classList, style, dataset,
  // textContent, and closed shadow roots. Not a spec implementation — just the
  // surface content.js actually touches.
  class FakeEl {
    constructor(tag) {
      this.tagName = (tag || 'div').toUpperCase();
      this.children = [];
      this.parentNode = null;
      this.shadowRoot = null;
      this._props = {};
      this.style = {
        cssText: '',
        setProperty: (k, v) => { this._props[k] = String(v); },
        getPropertyValue: (k) => this._props[k] || ''
      };
      this.dataset = {};
      this.attrs = {};
      this._text = '';
      this._classes = new Set();
      this.classList = {
        add: (...c) => c.forEach((x) => this._classes.add(x)),
        remove: (...c) => c.forEach((x) => this._classes.delete(x)),
        contains: (c) => this._classes.has(c),
        toggle: (c, on) => {
          const want = on === undefined ? !this._classes.has(c) : !!on;
          if (want) this._classes.add(c);
          else this._classes.delete(c);
          return want;
        }
      };
    }
    get className() { return [...this._classes].join(' '); }
    set className(v) {
      this._classes = new Set(String(v).split(/\s+/).filter(Boolean));
    }
    // textContent = '' is used as "remove all children"; reading it
    // concatenates descendants, as the real thing does.
    get textContent() {
      if (this.children.length === 0) return this._text;
      return this.children.map((c) => c.textContent).join('');
    }
    set textContent(v) {
      this.children.forEach((c) => { c.parentNode = null; });
      this.children = [];
      this._text = String(v);
    }
    get isConnected() {
      let n = this;
      while (n.parentNode) n = n.parentNode;
      return n._isRoot === true;
    }
    appendChild(el) {
      if (el.parentNode) el.parentNode.removeChild(el);
      el.parentNode = this;
      this.children.push(el);
      return el;
    }
    append(...els) { els.forEach((e) => this.appendChild(e)); }
    removeChild(el) {
      this.children = this.children.filter((c) => c !== el);
      if (el.parentNode === this) el.parentNode = null;
      return el;
    }
    remove() { if (this.parentNode) this.parentNode.removeChild(this); }
    attachShadow() {
      const root = new FakeEl('#shadow');
      root.parentNode = this;
      this.shadowRoot = root;
      return root;
    }
    contains(el) {
      if (el === this) return true;
      for (const c of this.children) if (c.contains(el)) return true;
      return this.shadowRoot ? this.shadowRoot.contains(el) : false;
    }
    setAttribute(k, v) { this.attrs[k] = String(v); }
    getAttribute(k) { return Object.prototype.hasOwnProperty.call(this.attrs, k) ? this.attrs[k] : null; }
    querySelector() { return null; }
  }
  h.FakeEl = FakeEl;

  // Fake video whose clock advances with the virtual clock while playing.
  const listeners = {};
  const video = {
    _base: 0, _rate: 1, _playing: false, _wallStart: 0,
    driftBias: 0,
    duration: 600,
    ended: false, seeking: false, readyState: 4,
    closest: () => null,
    get currentTime() {
      return this._playing
        ? this._base + (now / 1000 - this._wallStart) * this._rate + this.driftBias
        : this._base;
    },
    set currentTime(v) {
      this._base = v;
      this._wallStart = now / 1000;
      // A real element fires seeking then (asynchronously) seeked. Firing both
      // synchronously is enough for these tests and keeps the clock exact.
      // `swallowSeeked` models a browser that drops the completion event.
      this.emit('seeking');
      if (!this.swallowSeeked) this.emit('seeked');
    },
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

  // Advance the virtual clock while firing timeupdate ~4x/s, as a real player
  // does. The loop's coarse path depends on it; the fine rAF path runs off
  // h.flush()'s timers either way.
  h.playFor = (ms) => {
    const step = 250;
    for (let done = 0; done < ms; done += step) {
      h.flush(Math.min(step, ms - done));
      video.emit('timeupdate');
    }
  };

  const moInstances = [];
  class FakeMutationObserver {
    constructor(cb) { this.cb = cb; this.target = null; moInstances.push(this); }
    observe(target) { this.target = target; }
    disconnect() { this.target = null; }
  }

  // #movie_player, holding a .ytp-progress-bar — the two mount points the
  // overlay needs. Rebuilt by h.rebuildPlayerChrome() to model YouTube
  // swapping its chrome out from under us.
  let player;
  let progressBar;
  const buildPlayer = () => {
    player = new FakeEl('div');
    player.className = 'html5-video-player';
    progressBar = new FakeEl('div');
    progressBar.className = 'ytp-progress-bar';
    player.appendChild(progressBar);
    h.player = player;
    h.progressBar = progressBar;
  };
  buildPlayer();
  h.rebuildPlayerChrome = () => {
    buildPlayer();
    for (const mo of moInstances) if (mo.target === document.documentElement) mo.cb();
  };

  h.setAdShowing = (on) => {
    if (on) player.classList.add('ad-showing');
    else player.classList.remove('ad-showing');
    for (const mo of moInstances) if (mo.target === player) mo.cb();
  };

  const docListeners = {};
  const docRoot = new FakeEl('html');
  docRoot._isRoot = true;
  const document = {
    hidden: false,
    visibilityState: 'visible',
    documentElement: docRoot,
    createElement: (tag) => new FakeEl(tag),
    createElementNS: (ns, tag) => new FakeEl(tag),
    querySelector: (sel) => {
      if (sel.includes('html5-main-video')) return video;
      if (sel.includes('ytp-progress-bar')) return progressBar;
      return null;
    },
    getElementById: (id) => (id === 'movie_player' ? player : null),
    // rt.video lives outside our element tree; the real check is
    // document.contains(video), which is always true in these tests.
    contains: (el) => (el === video ? true : docRoot.contains(el)),
    addEventListener(ev, fn) { (docListeners[ev] = docListeners[ev] || []).push(fn); },
    removeEventListener() {}
  };
  // The player hangs off the document root so isConnected works for the
  // overlay hosts mounted inside it.
  docRoot.appendChild(player);
  const reparentPlayer = h.rebuildPlayerChrome;
  h.rebuildPlayerChrome = () => {
    docRoot.children = [];
    reparentPlayer();
    docRoot.appendChild(player);
    for (const mo of moInstances) if (mo.target === docRoot) mo.cb();
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
  h.emitWin = (ev) => { for (const fn of (winListeners[ev] || []).slice()) fn({}); };

  // requestAnimationFrame on the virtual clock (~60 fps) so the loop's fine
  // polling path is exercised by h.flush().
  let rafId = 1;
  const rafs = new Map();
  const fakeRaf = (fn) => {
    const id = rafId++;
    const t = fakeSetTimeout(() => { rafs.delete(id); fn(now); }, 16);
    rafs.set(id, t);
    return id;
  };
  const fakeCancelRaf = (id) => {
    const t = rafs.get(id);
    if (t !== undefined) { fakeClearTimeout(t); rafs.delete(id); }
  };

  h.keydown = (code, mods) => {
    let stopped = false;
    const m = mods || {};
    const ev = {
      code,
      repeat: !!m.repeat,
      ctrlKey: !!m.ctrlKey,
      altKey: !!m.altKey,
      metaKey: !!m.metaKey,
      shiftKey: !!m.shiftKey,
      target: m.target || { tagName: 'BODY', isContentEditable: false },
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
    requestAnimationFrame: fakeRaf,
    cancelAnimationFrame: fakeCancelRaf,
    performance: { now: () => now },
    console
  };
  vm.createContext(sandbox);
  vm.runInContext(SOURCE, sandbox, { filename: 'content.js' });
  h.state = () => sandbox.window.__syncoBeatTest.getState();
  h.overlay = () => sandbox.window.__syncoBeatTest.getOverlay();
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

  // ---- Practice loop (A/B) -------------------------------------------------------
  {
    console.log('practice loop');
    const h = createHarness();
    await settle();
    h.video.play();
    h.flush(300);

    // The mark hotkey cycles: nothing → A → A+B → new A.
    h.video.currentTime = 30;
    h.keydown('KeyG');
    check('mark sets the in point', h.state().loopA === 30 && h.state().loopB === null,
      `A=${h.state().loopA} B=${h.state().loopB}`);
    check('in point announced on screen', h.overlay().toasts.some((t) => t.includes('0:30')),
      JSON.stringify(h.overlay().toasts));
    check('in point drawn on the progress bar', h.overlay().tickA === '5%' && h.overlay().band === null,
      `tickA=${h.overlay().tickA}`);

    h.playFor(2000);
    h.keydown('KeyG');
    const armed = h.state();
    check('second mark sets the out point', armed.loopA === 30 && armed.loopB > 31,
      `A=${armed.loopA} B=${armed.loopB}`);
    check('loop range drawn as a band', h.overlay().band !== null && h.overlay().tickB !== null,
      JSON.stringify(h.overlay().band));
    check('chip shows the loop range', (h.overlay().chip || '').includes('⟲'),
      String(h.overlay().chip));

    // Playing past B wraps back to A, repeatedly.
    const b = armed.loopB;
    h.playFor(3000);
    check('wraps back to the in point at B', h.video.currentTime < b,
      `t=${h.video.currentTime.toFixed(3)} B=${b.toFixed(3)}`);
    check('wrap lands close to A', Math.abs(h.video.currentTime - 30) < 1.2,
      `t=${h.video.currentTime.toFixed(3)}`);
    check('loop stays armed after wrapping', h.state().loopA === 30 && h.state().loopB === b);

    // ... and keeps looping, never running away past B.
    let maxSeen = 0;
    for (let i = 0; i < 12; i += 1) {
      h.playFor(1000);
      maxSeen = Math.max(maxSeen, h.video.currentTime);
    }
    check('never overruns the out point', maxSeen < b + 0.1,
      `max=${maxSeen.toFixed(3)} B=${b.toFixed(3)}`);
    check('still inside the loop after many passes',
      h.video.currentTime >= 29.9 && h.video.currentTime <= b + 0.05,
      `t=${h.video.currentTime.toFixed(3)}`);

    // A third mark starts a fresh in point and drops the out point.
    h.video.currentTime = 100;
    h.keydown('KeyG');
    check('third mark restarts from a new in point',
      h.state().loopA === 100 && h.state().loopB === null,
      `A=${h.state().loopA} B=${h.state().loopB}`);

    // The jump key replays from A with only an in point set.
    h.playFor(2000);
    check('playhead advanced past the in point', h.video.currentTime > 101);
    h.keydown('KeyH');
    check('jump replays from the in point', Math.abs(h.video.currentTime - 100) < 0.01,
      `t=${h.video.currentTime}`);

    // Shift+mark clears everything.
    h.keydown('KeyG', { shiftKey: true });
    check('shift+mark clears the loop', h.state().loopA === null && h.state().loopB === null);
    check('cleared loop leaves the bar clean', h.overlay().tickA === null && h.overlay().band === null);
    check('clearing is announced', h.overlay().toasts.some((t) => t.includes('Loop off')),
      JSON.stringify(h.overlay().toasts));
  }

  // ---- Loop edge cases -----------------------------------------------------------
  {
    console.log('loop edge cases');
    const h = createHarness();
    await settle();
    h.video.play();
    h.flush(300);

    // Marking the end first is a slip, not an error: the points get swapped.
    h.video.currentTime = 80;
    h.keydown('KeyG');
    h.video.currentTime = 50;
    h.keydown('KeyG');
    check('out point before in point is swapped', h.state().loopA === 50 && h.state().loopB === 80,
      `A=${h.state().loopA} B=${h.state().loopB}`);

    // A span below the minimum would machine-gun seeks — refuse it.
    h.keydown('KeyG', { shiftKey: true });
    h.video.currentTime = 200;
    h.keydown('KeyG');
    h.video.currentTime = 200.1;
    h.keydown('KeyG');
    check('too-short loop is refused', h.state().loopB === null,
      `B=${h.state().loopB}`);
    check('refusal is announced', h.overlay().toasts.some((t) => t.includes('too short')),
      JSON.stringify(h.overlay().toasts));

    // Scrubbing outside the window must not yank the user back.
    h.keydown('KeyG', { shiftKey: true });
    h.video.currentTime = 300;
    h.keydown('KeyG');
    h.playFor(2000);
    h.keydown('KeyG');
    const outB = h.state().loopB;
    h.video.currentTime = 450;      // manual seek far past B
    h.playFor(2000);
    check('manual seek outside the loop is not yanked back', h.video.currentTime > 450,
      `t=${h.video.currentTime.toFixed(3)} B=${outB.toFixed(3)}`);
    check('loop marks survive the excursion', h.state().loopA === 300 && h.state().loopB === outB);

    // Returning into the window on its own re-arms the loop.
    h.video.currentTime = 300.5;
    h.playFor(3000);
    check('re-entering the window re-arms the loop', h.video.currentTime < outB + 0.1,
      `t=${h.video.currentTime.toFixed(3)} B=${outB.toFixed(3)}`);

    // Loop keys work in auto mode (default here) AND manual mode — unlike the
    // transport keys, which are manual-only.
    await h.setStorage({ mode: 'manual' });
    h.keydown('KeyG', { shiftKey: true });
    h.video.currentTime = 120;
    h.keydown('KeyG');
    check('loop keys work in manual mode too', h.state().loopA === 120);

    // Typing in a text field must never trigger a mark.
    h.keydown('KeyG', { shiftKey: true });
    h.keydown('KeyG', { target: { tagName: 'INPUT', isContentEditable: false } });
    check('marks ignore keys typed into inputs', h.state().loopA === null);

    // Looping is independent of the metronome master switch: muting the click
    // must not disable the video loop.
    h.keydown('KeyG', { shiftKey: true });
    await h.setStorage({ enabled: false });
    h.video.currentTime = 210;
    h.keydown('KeyG');
    check('loop works with the metronome switched off', h.state().loopA === 210,
      `A=${h.state().loopA}`);
    await h.setStorage({ enabled: true });

    // Jumping with nothing marked says so rather than doing nothing silently.
    h.keydown('KeyG', { shiftKey: true });
    h.video.currentTime = 250;
    h.keydown('KeyH');
    check('replay with no in point is explained', h.overlay().toasts.some((t) => t.includes('No in point')),
      JSON.stringify(h.overlay().toasts));
    check('replay with no in point does not move the playhead',
      Math.abs(h.video.currentTime - 250) < 0.01, `t=${h.video.currentTime}`);

    // A dropped 'seeked' must not wedge the loop off forever: the watchdog
    // releases the in-flight guard and looping resumes.
    h.keydown('KeyG', { shiftKey: true });
    h.video.currentTime = 260;
    h.keydown('KeyG');
    h.playFor(2000);
    h.keydown('KeyG');
    const wdB = h.state().loopB;
    h.video.swallowSeeked = true;
    h.playFor(1500);
    check('a dropped seeked event leaves the guard set briefly', h.state().wrapping === true);
    // Stop swallowing first: otherwise the wraps that follow the watchdog's
    // release immediately re-set the guard and the assertion races.
    h.video.swallowSeeked = false;
    h.flush(2000);          // watchdog window
    check('watchdog releases the stuck seek guard', h.state().wrapping === false);
    h.video.currentTime = 260;
    h.playFor(4000);
    check('looping resumes after a dropped seeked event', h.video.currentTime < wdB + 0.1,
      `t=${h.video.currentTime.toFixed(3)} B=${wdB.toFixed(3)}`);

    // Navigating to another video invalidates the marks — video-time offsets
    // mean nothing on a different video.
    h.video.currentTime = 60;
    h.keydown('KeyG');
    check('mark set before navigating', h.state().loopA === 60);
    h.window.location.search = '?v=vid-b';
    h.emitDoc('yt-navigate-finish');
    await settle();
    check('navigation clears the loop', h.state().loopA === null && h.state().loopB === null);
  }

  // ---- Loop × metronome ----------------------------------------------------------
  {
    console.log('loop keeps the click phase-correct');
    const h = createHarness();
    await settle();
    await h.setStorage({ bpm: 120 });   // 0.5 s per beat
    h.video.play();
    h.flush(300);

    // A loop over a whole number of beats: after wrapping, the click must land
    // on the same grid phase it had before — that is the whole point of
    // anchoring the beat grid in video time.
    h.video.currentTime = 40;
    h.keydown('KeyG');
    h.video.currentTime = 44;
    h.keydown('KeyG');
    check('4-second loop armed', h.state().loopA === 40 && h.state().loopB === 44);

    const beatPhase = (v) => ((v % 0.5) + 0.5) % 0.5;
    h.video.currentTime = 40;
    h.playFor(6000);   // long enough to wrap at least once
    const st = h.state();
    const nextClickVideoTime = h.video.currentTime + (st.nextNoteTime - h.now() / 1000);
    const err = beatPhase(nextClickVideoTime);
    const folded = Math.min(err, 0.5 - err);
    check('click stays on the video beat grid across a wrap', folded < 0.02,
      `phase err=${folded.toFixed(4)}`);
    check('no runaway pending clicks after wrapping', h.state().wrapping === false);

    // Port commands drive the same cycle as the hotkeys.
    const port = h.connectPort();
    port.send({ type: 'LOOP_CLEAR' });
    check('LOOP_CLEAR clears via port', h.state().loopA === null);
    h.video.currentTime = 70;
    port.send({ type: 'LOOP_MARK' });
    check('LOOP_MARK marks via port', h.state().loopA === 70);
    h.video.currentTime = 90;
    port.send({ type: 'LOOP_JUMP' });
    check('LOOP_JUMP replays via port', Math.abs(h.video.currentTime - 70) < 0.01,
      `t=${h.video.currentTime}`);
    const snap = h.portMessages.filter((m) => m.type === 'state').pop();
    check('loop state is pushed to the popup', snap && snap.loopA === 70,
      JSON.stringify(snap && { a: snap.loopA, b: snap.loopB }));
  }

  // ---- Overlay -------------------------------------------------------------------
  {
    console.log('on-screen overlay');
    const h = createHarness();
    await settle();
    await h.setStorage({ mode: 'manual' });
    h.video.play();
    h.flush(300);

    // The transport and lock keys now confirm themselves on screen — previously
    // pressing them gave no page feedback at all.
    h.keydown('KeyB');
    check('starting the click is confirmed on screen',
      h.overlay().toasts.some((t) => t.includes('Click on')), JSON.stringify(h.overlay().toasts));
    h.flush(100);
    h.keydown('KeyV');
    check('beat lock is confirmed on screen',
      h.overlay().toasts.some((t) => t.includes('Beat lock on')), JSON.stringify(h.overlay().toasts));
    check('chip reports the lock', h.overlay().chipShowsLock === true,
      JSON.stringify(h.overlay().chip));
    check('lock glyph is a drawn silhouette, not an emoji',
      h.overlay().toastIcons.some((i) => i.startsWith('svg:')),
      JSON.stringify(h.overlay().toastIcons));
    h.keydown('KeyV');
    check('unlocking is confirmed on screen',
      h.overlay().toasts.some((t) => t.includes('Beat lock off')), JSON.stringify(h.overlay().toasts));
    check('chip clears with the lock', h.overlay().chip === null, String(h.overlay().chip));
    check('unlock uses the open-shackle silhouette',
      h.overlay().toastIcons.some((i) => i.startsWith('svg:M10.6')),
      JSON.stringify(h.overlay().toastIcons));

    // The chip's border sweeps as the loop plays: a countdown to the wrap.
    h.keydown('KeyG', { shiftKey: true });
    h.video.currentTime = 400;
    h.keydown('KeyG');
    check('a lone in point leaves the ring static', h.overlay().ringStatic === true);
    h.playFor(4000);
    h.keydown('KeyG');          // out point ~404s → a 4s loop
    check('an armed loop sweeps the ring', h.overlay().ringStatic === false);
    // Arming happens with the playhead exactly at B, where the raw fraction is
    // 1.0 — the ring must read as an empty pass starting, not a full circle.
    check('ring reads empty at arm time, not full', h.overlay().ring === 0,
      `p=${h.overlay().ring}`);
    h.video.currentTime = 400;  // back to the top of the loop
    h.playFor(250);
    const rStart = h.overlay().ring;
    h.playFor(1750);            // ~halfway through a 4s loop
    const rMid = h.overlay().ring;
    h.playFor(1500);            // near the end
    const rLate = h.overlay().ring;
    check('ring starts near empty', rStart < 0.2, `p=${rStart}`);
    check('ring is ~half way at the midpoint', rMid > 0.35 && rMid < 0.65, `p=${rMid}`);
    check('ring advances monotonically toward the wrap', rLate > rMid, `${rMid} → ${rLate}`);
    check('ring stays within 0..1', rStart >= 0 && rLate <= 1, `${rStart}..${rLate}`);

    // After wrapping it resets rather than sticking at full.
    h.playFor(1500);
    check('ring resets after the wrap', h.overlay().ring < rLate,
      `p=${h.overlay().ring} was ${rLate}`);

    // An active loop keeps the chip readable instead of dimming away.
    h.flush(4000);
    check('a live loop does not dim the chip', h.overlay().chipDim === false);
    h.keydown('KeyG', { shiftKey: true });

    // Toasts expire on their own.
    h.flush(2500);
    check('toasts fade away', h.overlay().toasts.length === 0, JSON.stringify(h.overlay().toasts));

    // Repeats of one message replace rather than stack.
    h.video.currentTime = 20;
    h.keydown('KeyG');
    h.keydown('KeyH');
    h.keydown('KeyH');
    h.keydown('KeyH');
    check('repeated presses do not stack toasts', h.overlay().toasts.length <= 2,
      JSON.stringify(h.overlay().toasts));

    // YouTube rebuilding its player chrome must not lose the overlay.
    h.rebuildPlayerChrome();
    h.flush(50);
    check('overlay remounts after YouTube rebuilds the player',
      h.overlay().tickA !== null, JSON.stringify(h.overlay()));

    // Turning the overlay off tears it down and silences the toasts.
    await h.setStorage({ overlayEnabled: false });
    h.keydown('KeyH');
    check('overlay off produces no toasts', h.overlay().toasts.length === 0,
      JSON.stringify(h.overlay().toasts));
    check('overlay off clears the chip and bar marks',
      h.overlay().chip === null && h.overlay().tickA === null);
    check('loop still works with the overlay off', h.state().loopA === 20,
      `A=${h.state().loopA}`);

    // ...and back on, it comes straight back.
    await h.setStorage({ overlayEnabled: true });
    h.flush(50);
    check('overlay restores when re-enabled', h.overlay().tickA !== null,
      JSON.stringify(h.overlay()));
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
