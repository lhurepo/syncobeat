// SyncoBeat content script — Web Audio metronome for YouTube.
//
// Architecture:
//   settings — user preferences mirrored from chrome.storage.local. The popup
//              is the ONLY writer; this script reads once at startup and then
//              reacts to storage.onChanged (which also keeps every open
//              YouTube tab consistent, not just the active one).
//   runtime  — transport/scheduling state owned by this script and never
//              persisted: isPlaying, lock, beat grid, scheduled clicks.
//   port     — the popup drives runtime over a long-lived Port
//              ('MANUAL_TOGGLE', 'TOGGLE_LOCK'); state snapshots and per-beat
//              ticks are pushed back for the popup UI.
//
// Modes:
//   auto          — click phase-locks to the video timeline (beat 0 at t=0);
//                   follows play/pause/seek/rate/buffering and pauses in ads.
//   manual        — free-running; a page hotkey starts the click on the tap.
//   manual+locked — a second hotkey anchors the running click to the video
//                   clock, preserving its exact phase and beat numbering.
//
// Practice loop (mode-independent):
//   One hotkey cycles A → B → new A; a second jumps back to A on demand. With
//   both marks set the video loops [A,B] until cleared. Wraps are plain
//   currentTime assignments, so the existing seek path re-anchors the click —
//   a loop in auto/locked mode always comes back on the same beat number.
//
// Page overlay:
//   A shadow-DOM layer injected into the player shows transient toasts, a
//   persistent loop/lock chip, and an [A,B] band on YouTube's progress bar, so
//   loop and lock state are readable without opening the popup.

(() => {
  if (window.__syncoBeatLoaded) return;
  window.__syncoBeatLoaded = true;

  const PORT_NAME = 'syncobeat';

  // Scheduling profiles. Foreground uses a tight look-ahead so tempo/seek
  // changes react fast. Hidden tabs get their timers throttled to >=1s by
  // Chrome, so we buffer several seconds of clicks ahead instead — Web Audio
  // fires them sample-accurately regardless of JS timer jitter.
  const FOREGROUND = { lookahead: 0.12, intervalMs: 25 };
  const HIDDEN = { lookahead: 3.2, intervalMs: 500 };
  const CATCHUP_GAP = 1.0;        // scheduler stalled longer than this → re-anchor, don't burst-fire missed beats
  const DRIFT_TOLERANCE = 0.025;  // seconds of phase error vs the video clock before snapping back
  const DRIFT_STRIKES = 2;        // consecutive bad checks required (filters currentTime jitter spikes)
  const DRIFT_CHECK_INTERVAL = 0.5;
  const SUB_LEVEL = 0.35;         // subdivision click level relative to the main beat
  // Headroom above the slider's 0–1 range: 100% drives the click ~6 dB hot so
  // it cuts through the video. The limiter below catches the peaks.
  const OUTPUT_GAIN = 2.0;

  // --- Practice loop tuning ---
  const LOOP_MIN_SPAN = 0.35;     // shortest allowed A→B span; below this the loop would machine-gun seeks
  const LOOP_LEAD = 0.012;        // wrap this early — a seek is never instant, and landing late clips the phrase
  const LOOP_REENTRY_EPS = 0.05;  // slack when deciding the playhead is back inside [A,B]
  const WRAP_WATCHDOG_MS = 1500;  // release the in-flight-seek guard if 'seeked' never arrives

  const CLICK_SOUNDS = new Set(['original', 'woodblock', 'clave', 'softsine']);
  const TIME_SIGS = new Set([2, 3, 4, 5, 6, 7]);
  const SUBDIVISIONS = new Set([1, 2, 3, 4]);

  // Per-video memory: the musical settings worth restoring when the user
  // returns to a tutorial. Global preferences (mode, volume, click sound,
  // hotkeys) are deliberately excluded. This script is the sole writer of the
  // MEMORY_KEY entry; the popup never touches it.
  const MEMORY_KEY = 'videoMemory';
  const MEMORY_FIELDS = ['bpm', 'sig', 'subdivision', 'barOffset', 'accentEnabled', 'syncOffsetMs'];
  const MEMORY_LIMIT = 50;
  const MEMORY_SAVE_DEBOUNCE_MS = 1000;

  const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));
  const mod = (n, m) => ((n % m) + m) % m;
  const num = (v, d) => (typeof v === 'number' && isFinite(v) ? v : d);
  const str = (v, d) => (typeof v === 'string' && v.length > 0 ? v : d);

  // Defaults live in background.js (seeded on install); keep in sync.
  function sanitizeSettings(raw) {
    const r = raw || {};
    return {
      bpm: clamp(Math.round(num(r.bpm, 120)), 20, 300),
      sig: TIME_SIGS.has(r.sig) ? r.sig : 4,
      subdivision: SUBDIVISIONS.has(r.subdivision) ? r.subdivision : 1,
      barOffset: Number.isFinite(r.barOffset) ? Math.trunc(r.barOffset) : 0,
      accentEnabled: typeof r.accentEnabled === 'boolean' ? r.accentEnabled : true,
      volume: clamp(num(r.volume, 0.8), 0, 1),
      syncOffsetMs: clamp(Math.round(num(r.syncOffsetMs, 0)), -500, 500),
      enabled: typeof r.enabled === 'boolean' ? r.enabled : true,
      clickSound: CLICK_SOUNDS.has(r.clickSound) ? r.clickSound : 'original',
      mode: r.mode === 'manual' ? 'manual' : 'auto',
      hotkey: str(r.hotkey, 'KeyB'),
      lockHotkey: str(r.lockHotkey, 'KeyV'),
      loopMarkHotkey: str(r.loopMarkHotkey, 'KeyG'),
      loopJumpHotkey: str(r.loopJumpHotkey, 'KeyH'),
      overlayEnabled: typeof r.overlayEnabled === 'boolean' ? r.overlayEnabled : true
    };
  }

  let settings = sanitizeSettings({});

  const rt = {
    // Lock state and phase offset are intentionally never persisted — a lock
    // is per-session and meaningless after a reload (the video clock and the
    // user's tapped beat 1 are no longer aligned).
    locked: false,
    phaseOffset: 0,   // video-time seconds at which beat 0 lands (locked mode)
    isPlaying: false,
    currentBeat: 0,   // beat-in-bar shown by the popup, set at audible time
    beatCounter: 0,   // 1-based number of the NEXT beat to schedule
    nextNoteTime: 0,  // audio-clock time of the next unscheduled beat
    playbackRate: 1,
    video: null,
    listenersAttached: false,
    playerEl: null,
    adShowing: false,
    adObserver: null,
    ctx: null,
    master: null,
    noiseBuf: null,
    schedulerTimer: null,
    scheduled: [],    // [{when, nodes, timer}] — cancellable pending clicks
    driftStrikes: 0,
    lastDriftCheck: 0,
    lastResyncAt: 0,
    // Practice loop. Marks are video-time seconds, session-only (never
    // persisted): a mark is meaningless on another video, and restoring one
    // silently on load would surprise more than it helps.
    loopA: null,
    loopB: null,
    loopInside: false,  // playhead was inside [A,B] — only then does crossing B wrap
    wrapping: false,    // a loop seek is in flight; suppresses re-entrant triggers
    loopRaf: null,
    wrapWatchdog: null,
    loopListenersAttached: false
  };

  let port = null;
  let currentVideoId = null;
  let memorySaveTimer = null;

  // The metronome is "video-driven" — reacts to play/pause/seek/rate and uses
  // phase-locked scheduling — in auto mode, or in manual mode while locked.
  function isVideoDriven() {
    return settings.mode === 'auto' || (settings.mode === 'manual' && rt.locked);
  }

  function videoPlayingNow() {
    return !!rt.video && !rt.video.paused && !rt.video.ended;
  }

  // --- Audio engine ----------------------------------------------------------
  function ensureAudio() {
    if (!rt.ctx) {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      rt.ctx = new Ctx({ latencyHint: 'interactive' });
      rt.master = rt.ctx.createGain();
      // Safety limiter: OUTPUT_GAIN pushes clicks past unity, and accents +
      // subdivisions can overlap. A fast compressor tames the peaks without
      // dulling the transient.
      const limiter = rt.ctx.createDynamicsCompressor();
      limiter.threshold.value = -6;
      limiter.knee.value = 6;
      limiter.ratio.value = 12;
      limiter.attack.value = 0.001;
      limiter.release.value = 0.1;
      rt.master.connect(limiter);
      limiter.connect(rt.ctx.destination);
      applyVolume();
      // If the OS suspends/resumes the context, our audio clock jumped —
      // realign to the video rather than clicking from a stale grid.
      rt.ctx.onstatechange = () => {
        if (rt.ctx && rt.ctx.state === 'running' && rt.isPlaying && isVideoDriven()) {
          rebaseToVideo();
        }
      };
    }
    if (rt.ctx.state === 'suspended') {
      rt.ctx.resume().catch(() => {});
    }
  }

  function applyVolume() {
    if (rt.master) rt.master.gain.value = settings.volume * OUTPUT_GAIN;
  }

  // Dispatch to the selected click voice. All voices are synthesized and
  // return their top-level gain node(s) so a pending click can be cancelled
  // by disconnecting (sources can't be stop()ped twice, so we detach instead).
  function scheduleClick(when, accent, level) {
    if (!rt.ctx) return [];
    switch (settings.clickSound) {
      case 'woodblock': return clickWoodblock(when, accent, level);
      case 'clave':     return clickTone(when, accent ? 2500 : 2000, 0.045, 0.9, level);
      case 'softsine':  return clickTone(when, accent ? 1200 : 880, 0.07, 0.8, level);
      case 'original':
      default:          return clickTone(when, accent ? 1200 : 800, 0.06, 1.0, level);
    }
  }

  // A single decaying sine: 1 ms attack, exponential decay to silence.
  // Covers the original beep, clave, and soft sine.
  function clickTone(when, freq, decay, peak, level) {
    const ctx = rt.ctx;
    const osc = ctx.createOscillator();
    const env = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.value = freq;
    env.gain.setValueAtTime(0.0001, when);
    env.gain.exponentialRampToValueAtTime(peak * level, when + 0.001);
    env.gain.exponentialRampToValueAtTime(0.0001, when + decay);
    osc.connect(env); env.connect(rt.master);
    osc.start(when); osc.stop(when + decay + 0.02);
    return [env];
  }

  // Lazily build (and cache) a short white-noise buffer for the woodblock attack.
  function getNoiseBuf() {
    if (rt.noiseBuf) return rt.noiseBuf;
    const ctx = rt.ctx;
    const len = Math.max(1, Math.floor(ctx.sampleRate * 0.02));
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i += 1) d[i] = Math.random() * 2 - 1;
    rt.noiseBuf = buf;
    return buf;
  }

  // Woodblock: two sine partials (f and 2.1f) with a fast woody decay, plus a
  // 1.5 ms noise transient for the sharp attack "tock".
  function clickWoodblock(when, accent, level) {
    const ctx = rt.ctx;
    const f = accent ? 1800 : 1300;
    const env = ctx.createGain();
    env.connect(rt.master);
    env.gain.setValueAtTime(0.0001, when);
    env.gain.exponentialRampToValueAtTime(0.9 * level, when + 0.001);
    env.gain.exponentialRampToValueAtTime(0.0001, when + 0.05);

    const o1 = ctx.createOscillator(); o1.type = 'sine'; o1.frequency.value = f;
    const g1 = ctx.createGain(); g1.gain.value = 0.7; o1.connect(g1); g1.connect(env);
    const o2 = ctx.createOscillator(); o2.type = 'sine'; o2.frequency.value = f * 2.1;
    const g2 = ctx.createGain(); g2.gain.value = 0.3; o2.connect(g2); g2.connect(env);
    o1.start(when); o2.start(when);
    o1.stop(when + 0.07); o2.stop(when + 0.07);

    const noise = ctx.createBufferSource();
    noise.buffer = getNoiseBuf();
    const ng = ctx.createGain();
    ng.gain.setValueAtTime(0.5 * level, when);
    ng.gain.exponentialRampToValueAtTime(0.0001, when + 0.0015);
    noise.connect(ng); ng.connect(rt.master);
    noise.start(when); noise.stop(when + 0.02);
    return [env, ng];
  }

  // --- Scheduled-click registry ------------------------------------------------
  // Every pending click is tracked so pauses/seeks/tempo changes can silence
  // clicks already committed inside the look-ahead window (essential when the
  // hidden-tab profile has buffered seconds of audio ahead).
  function registerBeat(when, nodes, beatInBar) {
    const entry = { when, nodes, timer: null };
    if (beatInBar > 0 && rt.ctx) {
      // Clicks are scheduled up to a full look-ahead early; delay the visual
      // beat update so the popup dot flashes when the click is audible.
      const delayMs = Math.max(0, (when - rt.ctx.currentTime) * 1000);
      entry.timer = setTimeout(() => {
        entry.timer = null;
        rt.currentBeat = beatInBar;
        pushToPort({ type: 'beat', beat: beatInBar });
      }, delayMs);
    }
    rt.scheduled.push(entry);
  }

  function cancelScheduledFrom(t) {
    const keep = [];
    for (const entry of rt.scheduled) {
      if (entry.when >= t - 0.001) {
        for (const n of entry.nodes) {
          try { n.disconnect(); } catch (_) { /* already gone */ }
        }
        if (entry.timer) clearTimeout(entry.timer);
      } else {
        keep.push(entry);
      }
    }
    rt.scheduled = keep;
  }

  function pruneScheduled(now) {
    if (rt.scheduled.length === 0) return;
    rt.scheduled = rt.scheduled.filter((e) => e.when >= now - 0.5);
  }

  // --- Phase-lock math ---------------------------------------------------------
  // The beat grid in video time: beats land at anchor + k * beatInterval,
  // where anchor is 0 in auto mode, the user's tapped offset when locked, plus
  // the user's sync-offset trim in both cases.
  function videoGrid() {
    const rate = rt.playbackRate || 1;
    const beat = 60 / settings.bpm;
    const anchor = (settings.mode === 'manual' && rt.locked ? rt.phaseOffset : 0)
      + settings.syncOffsetMs / 1000;
    const t = rt.video.currentTime - anchor;
    const phase = mod(t, beat);
    return {
      untilNextWall: (beat - phase) / rate,
      nextCounter: Math.floor(t / beat) + 1
    };
  }

  function resyncToVideo() {
    if (!rt.video || !rt.ctx) return;
    const g = videoGrid();
    rt.nextNoteTime = rt.ctx.currentTime + g.untilNextWall;
    rt.beatCounter = g.nextCounter;
    rt.lastResyncAt = rt.ctx.currentTime;
    rt.driftStrikes = 0;
  }

  // Cancel pending clicks and realign to the video — the smooth correction
  // used for seeks, rate changes, offset changes, and drift snaps. Unlike a
  // stop/start it never touches lock state or auto-start conditions.
  function rebaseToVideo() {
    if (!rt.isPlaying || !rt.ctx || !rt.video) return;
    cancelScheduledFrom(rt.ctx.currentTime);
    resyncToVideo();
  }

  function secondsPerBeat() {
    // Playback rate only applies when the click is coupled to the video.
    const rate = isVideoDriven() ? (rt.playbackRate || 1) : 1;
    return (60 / settings.bpm) / rate;
  }

  // --- Scheduler loop ----------------------------------------------------------
  function schedulerPass() {
    if (!rt.isPlaying || !rt.ctx) return;
    const now = rt.ctx.currentTime;
    const profile = document.hidden ? HIDDEN : FOREGROUND;
    pruneScheduled(now);

    if (now - rt.nextNoteTime > CATCHUP_GAP) {
      // Timer stalled far past the buffered clicks (system sleep, heavy
      // throttling). Re-anchor instead of burst-firing every missed beat.
      if (isVideoDriven()) {
        resyncToVideo();
      } else {
        const spb = secondsPerBeat();
        const missed = Math.ceil((now - rt.nextNoteTime) / spb);
        rt.beatCounter += missed;
        rt.nextNoteTime += missed * spb;
      }
    }

    const spb = secondsPerBeat();
    while (rt.nextNoteTime < now + profile.lookahead) {
      const fireAt = Math.max(rt.nextNoteTime, now + 0.001);
      const beatIdx0 = rt.beatCounter - 1;
      const beatInBar = mod(beatIdx0, settings.sig) + 1;
      const accent = settings.accentEnabled
        && mod(beatIdx0 + settings.barOffset, settings.sig) === 0;

      registerBeat(fireAt, scheduleClick(fireAt, accent, 1), beatInBar);
      for (let k = 1; k < settings.subdivision; k += 1) {
        const at = fireAt + (spb * k) / settings.subdivision;
        registerBeat(at, scheduleClick(at, false, SUB_LEVEL), 0);
      }

      rt.nextNoteTime += spb;
      rt.beatCounter += 1;
    }

    maybeCorrectDrift(now);
    rt.schedulerTimer = setTimeout(schedulerPass, profile.intervalMs);
  }

  // The scheduler free-runs on the audio clock between resyncs, but the video
  // clock is a different clock domain and the two drift apart over long
  // sessions (worse on Bluetooth audio). Periodically measure the phase error
  // against the video and snap back when it exceeds tolerance twice in a row.
  function maybeCorrectDrift(now) {
    if (!isVideoDriven()) return;
    const v = rt.video;
    if (!v || v.paused || v.seeking || v.readyState < 2) {
      rt.driftStrikes = 0;
      return;
    }
    if (now - rt.lastDriftCheck < DRIFT_CHECK_INTERVAL) return;
    rt.lastDriftCheck = now;
    if (!document.contains(v)) { findVideo(); return; }
    if (now - rt.lastResyncAt < 0.3) return; // let a fresh resync settle

    const g = videoGrid();
    const spb = secondsPerBeat();
    // Phase-only error, folded into ±half a beat: being N whole beats ahead
    // (buffered look-ahead) must not read as drift.
    let err = (rt.nextNoteTime - (now + g.untilNextWall)) % spb;
    if (err > spb / 2) err -= spb;
    if (err < -spb / 2) err += spb;

    if (Math.abs(err) > DRIFT_TOLERANCE) {
      rt.driftStrikes += 1;
      if (rt.driftStrikes >= DRIFT_STRIKES) rebaseToVideo();
    } else {
      rt.driftStrikes = 0;
    }
  }

  // --- Transport -----------------------------------------------------------------
  function startMetronome() {
    if (!settings.enabled) return;
    if (isVideoDriven()) {
      if (!videoPlayingNow() || rt.adShowing) return;
      ensureAudio();
      resyncToVideo();
    } else {
      // Free-running manual: the toggle keypress IS beat 1.
      ensureAudio();
      rt.beatCounter = 1;
      rt.nextNoteTime = rt.ctx.currentTime;
    }
    rt.isPlaying = true;
    if (rt.schedulerTimer) clearTimeout(rt.schedulerTimer);
    schedulerPass();
    pushState();
  }

  // Halt the scheduler without disturbing lock state — used for video pauses,
  // buffering, and ads, so resuming play continues phase-correctly.
  function pauseScheduler() {
    if (rt.schedulerTimer) {
      clearTimeout(rt.schedulerTimer);
      rt.schedulerTimer = null;
    }
    if (rt.ctx) cancelScheduledFrom(rt.ctx.currentTime);
    rt.isPlaying = false;
    rt.currentBeat = 0;
    pushState();
  }

  // Full stop: scheduler off AND any lock cleared. Triggered by the user's
  // start/stop toggle or an explicit teardown (mode change, video removed).
  function stopMetronome() {
    pauseScheduler();
    if (rt.locked) {
      rt.locked = false;
      rt.phaseOffset = 0;
      syncVideoListeners();
      renderOverlay();
      pushState();
    }
  }

  // Anchor the *currently running* click to the video clock, seamlessly. The
  // click is already at the right tempo, phase, and beat number (the user
  // tapped beat 1) — locking must NOT shift any of that. We only record where
  // the live beat grid sits in video time, so a later seek/pause/play can
  // reproduce the exact same beat times AND numbers (preserving the accent),
  // then start listening for video events. We deliberately do NOT resync here
  // — that would reset nextNoteTime and double-trigger a click already
  // committed within the look-ahead window.
  function lockToVideo() {
    if (settings.mode !== 'manual' || !rt.isPlaying || !rt.video || !rt.ctx) return;
    rt.playbackRate = rt.video.playbackRate || 1;
    const beat = 60 / settings.bpm;
    const untilNext = Math.max(0, rt.nextNoteTime - rt.ctx.currentTime);
    const nextBeatVideoTime = rt.video.currentTime + untilNext * rt.playbackRate;
    // Solve for the video time of "beat 0" so videoGrid() reproduces the live
    // schedule's beat times and numbering exactly. Reduce modulo one bar to
    // keep the stored value small — a whole-bar shift changes neither the
    // phase nor the accent.
    const origin = nextBeatVideoTime - rt.beatCounter * beat - settings.syncOffsetMs / 1000;
    const bar = beat * settings.sig;
    rt.phaseOffset = mod(origin, bar);
    rt.locked = true;
    syncVideoListeners();
    renderOverlay();
    pushState();
  }

  function unlockFromVideo() {
    if (!rt.locked) return;
    rt.locked = false;
    rt.phaseOffset = 0;
    // Back to free-running: drop video listeners and just keep clicking.
    syncVideoListeners();
    renderOverlay();
    pushState();
  }

  // A BPM change invalidates a lock (it's measured in beat lengths — those
  // just changed); the user re-taps. Free-running playback keeps the grid
  // anchored on the previous beat so the tempo knob feels continuous instead
  // of restarting at beat 1.
  function onTempoChanged(prevBpm) {
    if (rt.locked) {
      rt.locked = false;
      rt.phaseOffset = 0;
      syncVideoListeners();
      renderOverlay();
    }
    if (!rt.isPlaying || !rt.ctx) return;
    if (isVideoDriven()) {
      rebaseToVideo();
      return;
    }
    const lastBeatTime = rt.nextNoteTime - 60 / prevBpm;
    rt.nextNoteTime = Math.max(rt.ctx.currentTime + 0.001, lastBeatTime + secondsPerBeat());
  }

  function applyMode() {
    // Switching semantics always stops the click; the user re-triggers.
    stopMetronome();
    syncVideoListeners();
    if (settings.mode === 'auto' && settings.enabled && videoPlayingNow() && !rt.adShowing) {
      startMetronome();
    }
    pushState();
  }

  // --- Page overlay --------------------------------------------------------------
  // Everything the user needs to read at a glance, drawn on the YouTube page
  // instead of in the popup: transient toasts for state changes, a persistent
  // chip while a loop or lock is active, and an [A,B] band on the progress bar.
  //
  // Two hosts, because they need different parents:
  //   ov.host  — absolutely positioned inside #movie_player (toasts + chip),
  //              so it rides along into fullscreen and theater mode.
  //   ov.bar   — inside .ytp-progress-bar, the only element whose width
  //              reliably maps to the video duration.
  // Both use shadow roots: YouTube's stylesheet is aggressive, and ours must
  // not leak into the page either.

  const OV_STYLE = `
    :host { all: initial; }
    /* The overlay is always dark: it sits over video, where a light surface
       would be unreadable. Only the accent is shared with the popup. */
    .layer {
      --sb-accent: #ff9a3c;
      --sb-accent-soft: #ffc657;
      --sb-surface: rgba(12, 12, 14, 0.82);
      --sb-hairline: rgba(255, 255, 255, 0.14);
      position: absolute; inset: 0; pointer-events: none;
      font-family: "YouTube Sans", Roboto, system-ui, sans-serif;
      z-index: 60;
    }
    .toasts {
      position: absolute; left: 12px; bottom: 60px;
      display: flex; flex-direction: column-reverse; gap: 6px; align-items: flex-start;
    }
    .toast {
      display: flex; align-items: center; gap: 7px;
      padding: 7px 12px; border-radius: 999px;
      background: var(--sb-surface);
      border: 1px solid var(--sb-hairline);
      box-shadow: 0 4px 18px rgba(0, 0, 0, 0.45);
      color: #f5f5f7; font-size: 13px; font-weight: 500;
      letter-spacing: 0.01em; white-space: nowrap;
      animation: toast-in 140ms ease-out;
    }
    .toast.out { animation: toast-out 220ms ease-in forwards; }
    .toast .ico {
      font-size: 13px; line-height: 1; color: var(--sb-accent);
      display: inline-flex; align-items: center;
    }
    .ico svg { width: 13px; height: 13px; display: block; fill: currentColor; }
    .toast.warn { border-color: rgba(255, 122, 89, 0.5); }
    .toast.warn .ico { color: #ff7a59; }
    /* The chip's border doubles as the loop's progress ring. Two stacked
       backgrounds in one element: a conic-gradient painted over the border box
       (the ring) and a solid fill clipped to the padding box (the pill face),
       so the swept arc shows only in the 2px border gutter. --p (0..1) is the
       only thing that changes per frame, which keeps this to a paint on the
       compositor rather than a layout pass. */
    .chip {
      --p: 0;
      --ring: var(--sb-accent);
      /* The untraversed part of the ring has to be dark enough to read as an
         empty track against bright video, but still clearly the same ring —
         too faint and the whole arc looks like it isn't there. */
      --ring-track: rgba(255, 255, 255, 0.2);
      position: absolute; right: 12px; top: 12px;
      display: none; align-items: center; gap: 8px;
      padding: 7px 13px; border-radius: 999px;
      /* 3px, not 2: at this pill size a 2px arc is a hairline that reads as no
         ring at all — the sweep is the whole point of the chip while looping. */
      border: 3px solid transparent;
      background:
        linear-gradient(var(--sb-surface), var(--sb-surface)) padding-box,
        conic-gradient(from -90deg,
          var(--ring) 0turn,
          var(--ring) calc(var(--p) * 1turn),
          var(--ring-track) calc(var(--p) * 1turn),
          var(--ring-track) 1turn) border-box;
      color: #f5f5f7; font-size: 12px; font-weight: 500;
      font-variant-numeric: tabular-nums;
      /* Lift the pill off bright video so the ring stays legible on any frame. */
      box-shadow: 0 2px 10px rgba(0, 0, 0, 0.45);
      transition: opacity 160ms ease;
    }
    /* Only a running loop sweeps. With just an in point (or a bare lock) there
       is no span to measure, so the ring stays a plain static outline. */
    .chip.static {
      border-color: rgba(255, 154, 60, 0.45);
      background: var(--sb-surface) padding-box;
    }
    .chip.show { display: flex; }
    .chip.dim { opacity: 0.28; }
    .chip .sep { width: 1px; height: 11px; background: rgba(255, 255, 255, 0.22); }
    .chip .loop { color: var(--sb-accent); }
    .chip .lock { color: var(--sb-accent); display: inline-flex; align-items: center; }
    .chip .lock svg { width: 12px; height: 12px; }
    @keyframes toast-in {
      from { opacity: 0; transform: translateY(6px); }
      to { opacity: 1; transform: none; }
    }
    @keyframes toast-out { to { opacity: 0; transform: translateY(-4px); } }
    @media (prefers-reduced-motion: reduce) {
      .toast, .toast.out { animation: none; }
      .toast.out { opacity: 0; }
    }
  `;

  const OV_BAR_STYLE = `
    :host { all: initial; --sb-accent: #ff9a3c; }
    .band {
      position: absolute; top: 0; bottom: 0;
      display: none; pointer-events: none;
      background: rgba(255, 154, 60, 0.3);
      box-shadow: inset 0 0 0 1px rgba(255, 154, 60, 0.45);
    }
    .band.show { display: block; }
    .tick {
      position: absolute; top: -3px; bottom: -3px; width: 2px;
      display: none; pointer-events: none;
      background: var(--sb-accent); border-radius: 1px;
      box-shadow: 0 0 5px rgba(255, 154, 60, 0.8);
    }
    .tick.show { display: block; }
  `;

  const TOAST_MS = 1500;
  const CHIP_IDLE_MS = 2600;

  const ov = {
    host: null,
    root: null,
    toasts: null,
    chip: null,
    bar: null,        // host inside .ytp-progress-bar
    barRoot: null,
    band: null,
    tickA: null,
    tickB: null,
    barEl: null,      // the .ytp-progress-bar we are parented to
    playerEl: null,   // the #movie_player we are parented to
    chipIdleTimer: null,
    ringPct: -1,
    observer: null,
    live: []          // active toast elements, newest last
  };

  function overlayOn() {
    return settings.overlayEnabled;
  }

  // Idempotent: safe to call on every navigation / player rebuild.
  function mountOverlay() {
    if (!overlayOn()) return;
    const player = document.getElementById('movie_player');
    if (player) {
      if (!ov.host || ov.playerEl !== player || !player.contains(ov.host)) {
        buildMainHost(player);
      }
    }
    mountBarHost();
    renderOverlay();
  }

  function buildMainHost(player) {
    if (ov.host && ov.host.parentNode) ov.host.remove();
    const host = document.createElement('div');
    host.className = 'syncobeat-overlay';
    // The player is positioned; inset:0 on the layer then covers the video.
    host.style.cssText = 'position:absolute;inset:0;pointer-events:none;z-index:60;';
    const root = host.attachShadow({ mode: 'closed' });
    const style = document.createElement('style');
    style.textContent = OV_STYLE;
    const layer = document.createElement('div');
    layer.className = 'layer';
    const toasts = document.createElement('div');
    toasts.className = 'toasts';
    const chip = document.createElement('div');
    chip.className = 'chip';
    layer.append(toasts, chip);
    root.append(style, layer);
    player.appendChild(host);

    ov.host = host;
    ov.root = root;
    ov.toasts = toasts;
    ov.chip = chip;
    ov.playerEl = player;
    ov.live = [];
  }

  function mountBarHost() {
    const barEl = document.querySelector('#movie_player .ytp-progress-bar');
    if (!barEl) return;
    if (ov.bar && ov.barEl === barEl && barEl.contains(ov.bar)) return;
    if (ov.bar && ov.bar.parentNode) ov.bar.remove();
    const host = document.createElement('div');
    host.className = 'syncobeat-loop-marks';
    host.style.cssText = 'position:absolute;inset:0;pointer-events:none;';
    const root = host.attachShadow({ mode: 'closed' });
    const style = document.createElement('style');
    style.textContent = OV_BAR_STYLE;
    const band = document.createElement('div');
    band.className = 'band';
    const tickA = document.createElement('div');
    tickA.className = 'tick';
    const tickB = document.createElement('div');
    tickB.className = 'tick';
    root.append(style, band, tickA, tickB);
    barEl.appendChild(host);

    ov.bar = host;
    ov.barRoot = root;
    ov.band = band;
    ov.tickA = tickA;
    ov.tickB = tickB;
    ov.barEl = barEl;
  }

  function unmountOverlay() {
    if (ov.host && ov.host.parentNode) ov.host.remove();
    if (ov.bar && ov.bar.parentNode) ov.bar.remove();
    ov.host = ov.root = ov.toasts = ov.chip = null;
    ov.bar = ov.barRoot = ov.band = ov.tickA = ov.tickB = null;
    ov.playerEl = ov.barEl = null;
    ov.live = [];
    ov.ringPct = -1;
    if (ov.chipIdleTimer) {
      clearTimeout(ov.chipIdleTimer);
      ov.chipIdleTimer = null;
    }
  }

  // Icon glyphs. Most are plain text characters, but the lock is drawn as an
  // SVG silhouette: the 🔒/🔓 emoji render in their own fixed multicolour
  // artwork, which clashed with the accent-coloured pills and looked pasted on.
  // A path inherits `fill: currentColor` from .ico and so is always on-palette.
  const SVG_NS = 'http://www.w3.org/2000/svg';

  const LOCK_PATHS = {
    // Closed shackle: a full arch sitting on the body.
    locked: 'M9 10V7.2a5 5 0 0 1 10 0V10h-2.4V7.2a2.6 2.6 0 0 0-5.2 0V10z',
    // Open shackle: the same arch, hinged up and to the right.
    unlocked: 'M10.6 10V7.2a2.6 2.6 0 0 1 5.2 0V9h2.4V7.2a5 5 0 0 0-10 0V10z'
  };

  function svgIcon(name) {
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('viewBox', '0 0 28 28');
    svg.setAttribute('aria-hidden', 'true');
    const shackle = document.createElementNS(SVG_NS, 'path');
    shackle.setAttribute('d', LOCK_PATHS[name === 'unlocked' ? 'unlocked' : 'locked']);
    const body = document.createElementNS(SVG_NS, 'rect');
    body.setAttribute('x', '6.4');
    body.setAttribute('y', '11.6');
    body.setAttribute('width', '15.2');
    body.setAttribute('height', '12');
    body.setAttribute('rx', '2.4');
    svg.append(shackle, body);
    return svg;
  }

  // `kind` is a stable id per message class: a repeat of the same kind replaces
  // its predecessor rather than stacking, so holding the jump key doesn't build
  // a tower of identical pills.
  //
  // `icon` is either a text glyph or {svg: name} for a drawn silhouette.
  function toast(kind, icon, text) {
    if (!overlayOn()) return;
    mountOverlay();
    if (!ov.toasts) return;
    for (const el of ov.live.slice()) {
      if (el.dataset.kind === kind) removeToast(el, true);
    }
    const el = document.createElement('div');
    el.className = kind.endsWith('-reject') ? 'toast warn' : 'toast';
    el.dataset.kind = kind;
    const ico = document.createElement('span');
    ico.className = 'ico';
    if (icon && icon.svg) ico.appendChild(svgIcon(icon.svg));
    else ico.textContent = icon;
    const label = document.createElement('span');
    label.textContent = text;
    el.append(ico, label);
    ov.toasts.appendChild(el);
    ov.live.push(el);
    // Keep the stack shallow — three pills is already more than anyone reads.
    while (ov.live.length > 3) removeToast(ov.live[0], true);
    el._hideTimer = setTimeout(() => removeToast(el, false), TOAST_MS);
    bumpChipVisibility();
  }

  function removeToast(el, immediate) {
    const i = ov.live.indexOf(el);
    if (i !== -1) ov.live.splice(i, 1);
    if (el._hideTimer) {
      clearTimeout(el._hideTimer);
      el._hideTimer = null;
    }
    if (immediate) {
      el.remove();
      return;
    }
    el.classList.add('out');
    setTimeout(() => el.remove(), 240);
  }

  // The chip is the answer to "is beat lock on?" without opening the popup —
  // but it must not sit over the video forever, so it fades to a ghost after a
  // few idle seconds and comes back to full opacity on any state change.
  function bumpChipVisibility() {
    if (!ov.chip) return;
    ov.chip.classList.remove('dim');
    if (ov.chipIdleTimer) clearTimeout(ov.chipIdleTimer);
    ov.chipIdleTimer = setTimeout(() => {
      ov.chipIdleTimer = null;
      // A live loop keeps the chip readable: its ring is a countdown the user
      // is actively watching, unlike a static lock badge.
      if (ov.chip && !loopArmed()) ov.chip.classList.add('dim');
    }, CHIP_IDLE_MS);
  }

  function renderOverlay() {
    if (!overlayOn()) {
      unmountOverlay();
      return;
    }
    renderChip();
    renderBarMarks();
  }

  function renderChip() {
    if (!ov.chip) return;
    const showLoop = rt.loopA !== null;
    const showLock = rt.locked;
    if (!showLoop && !showLock) {
      ov.chip.classList.remove('show');
      ov.chip.textContent = '';
      return;
    }
    ov.chip.textContent = '';
    if (showLoop) {
      const span = document.createElement('span');
      span.className = 'loop';
      span.textContent = rt.loopB !== null
        ? `⟲ ${fmtTime(rt.loopA)} → ${fmtTime(rt.loopB)}`
        : `◉ ${fmtTime(rt.loopA)}`;
      ov.chip.appendChild(span);
    }
    if (showLoop && showLock) {
      const sep = document.createElement('span');
      sep.className = 'sep';
      ov.chip.appendChild(sep);
    }
    if (showLock) {
      const span = document.createElement('span');
      span.className = 'ico lock';
      span.appendChild(svgIcon('locked'));
      ov.chip.appendChild(span);
    }
    // A measurable span drives the ring; anything else is a static outline.
    ov.chip.classList.toggle('static', !loopArmed());
    ov.chip.classList.add('show');
    updateLoopRing();
    bumpChipVisibility();
  }

  // Fraction of the way from A to B, 0..1. Called every animation frame while
  // a loop is armed, so it must stay allocation-free and cheap.
  //
  // Note the wrap at 1: the out point is set *at* the live playhead, so at that
  // instant progress is exactly 1 and the ring would paint a full circle — the
  // opposite of the "a pass is starting" reading we want. Treat a completed
  // ring as an empty one; playback is about to wrap to A anyway.
  function loopProgress() {
    if (!loopArmed() || !rt.video) return 0;
    const span = rt.loopB - rt.loopA;
    if (!(span > 0)) return 0;
    const p = (rt.video.currentTime - rt.loopA) / span;
    if (p >= 1) return 0;
    return clamp(p, 0, 1);
  }

  function updateLoopRing() {
    if (!ov.chip || !loopArmed()) return;
    // Round to whole percent: the visual difference below that is invisible,
    // and it avoids re-parsing a new gradient string on every single frame.
    const pct = Math.round(loopProgress() * 100);
    if (pct === ov.ringPct) return;
    ov.ringPct = pct;
    ov.chip.style.setProperty('--p', String(pct / 100));
  }

  // Positions are pure percentages of duration, so they survive resize,
  // theater mode, and fullscreen without recomputation.
  function renderBarMarks() {
    mountBarHost();
    if (!ov.band) return;
    const d = videoDuration();
    if (d === null || rt.loopA === null) {
      ov.band.classList.remove('show');
      ov.tickA.classList.remove('show');
      ov.tickB.classList.remove('show');
      return;
    }
    const pct = (t) => `${clamp((t / d) * 100, 0, 100)}%`;
    ov.tickA.style.left = pct(rt.loopA);
    ov.tickA.classList.add('show');
    if (rt.loopB !== null) {
      ov.band.style.left = pct(rt.loopA);
      ov.band.style.width = `${clamp(((rt.loopB - rt.loopA) / d) * 100, 0, 100)}%`;
      ov.band.classList.add('show');
      ov.tickB.style.left = pct(rt.loopB);
      ov.tickB.classList.add('show');
    } else {
      ov.band.classList.remove('show');
      ov.tickB.classList.remove('show');
    }
  }

  // YouTube rebuilds player chrome on navigation and on fullscreen changes,
  // which silently drops our hosts. Re-mount when they go missing.
  function watchOverlayHost() {
    if (ov.observer || !overlayOn()) return;
    ov.observer = new MutationObserver(() => {
      if (!overlayOn()) return;
      const hostGone = !ov.host || !ov.host.isConnected;
      const barGone = !ov.bar || !ov.bar.isConnected;
      if (hostGone || barGone) mountOverlay();
    });
    ov.observer.observe(document.documentElement, { childList: true, subtree: true });
  }

  function unwatchOverlayHost() {
    if (ov.observer) {
      ov.observer.disconnect();
      ov.observer = null;
    }
  }

  // --- Practice loop -------------------------------------------------------------
  // A/B looping over the video timeline. The mark hotkey cycles:
  //   nothing → A set → A+B set (looping) → new A set (B cleared) → ...
  // and the jump hotkey seeks to A at any time. Everything here manipulates
  // video.currentTime only; the metronome re-anchors through the normal
  // seeking/seeked path, so a wrap keeps the click phase- and beat-correct.

  function loopArmed() {
    return rt.loopA !== null && rt.loopB !== null;
  }

  function videoDuration() {
    const d = rt.video ? rt.video.duration : NaN;
    return Number.isFinite(d) && d > 0 ? d : null;
  }

  // Marks outlive neither the video element nor a navigation.
  function clearLoop(announce) {
    const had = rt.loopA !== null || rt.loopB !== null;
    rt.loopA = null;
    rt.loopB = null;
    rt.loopInside = false;
    rt.wrapping = false;
    if (rt.wrapWatchdog) {
      clearTimeout(rt.wrapWatchdog);
      rt.wrapWatchdog = null;
    }
    stopLoopPolling();
    syncLoopListeners();
    if (had && announce) toast('loop-off', '⊘', 'Loop off');
    if (had) {
      renderOverlay();
      pushState();
    }
  }

  // The single cycling entry point behind the mark hotkey.
  function cycleLoopMark() {
    if (!rt.video) {
      toast('loop-reject', '⚠', 'No video');
      return;
    }
    const t = rt.video.currentTime;
    if (!Number.isFinite(t)) return;

    if (rt.loopA === null) {
      setLoopIn(t);          // nothing marked → in point
    } else if (rt.loopB === null) {
      setLoopOut(t);         // in point set → out point, loop starts
    } else {
      setLoopIn(t);          // both set → start a fresh in point (setLoopIn drops B)
    }
  }

  function setLoopIn(t) {
    rt.loopA = Math.max(0, t);
    rt.loopB = null;
    rt.loopInside = false;
    stopLoopPolling();
    syncLoopListeners();
    toast('loop-in', '◉', `In ${fmtTime(rt.loopA)}`);
    renderOverlay();
    pushState();
  }

  function setLoopOut(t) {
    if (rt.loopA === null) return;
    let a = rt.loopA;
    let b = Math.max(0, t);
    // Marking the end first is a plausible slip, not an error — swap instead
    // of rejecting, so the user keeps the two points they actually chose.
    if (b < a) { const tmp = a; a = b; b = tmp; }
    if (b - a < LOOP_MIN_SPAN) {
      toast('loop-reject', '⚠', 'Loop too short');
      return;
    }
    rt.loopA = a;
    rt.loopB = b;
    // Setting the out point at the live playhead means the user is, by
    // definition, inside the passage they just defined — even though
    // currentTime is exactly at B, where isInsideLoop() is false by design.
    // Arming here is what makes "press G twice and it loops" work at all.
    rt.loopInside = true;
    syncLoopListeners();
    startLoopPolling();
    toast('loop-on', '⟲', `Loop ${fmtTime(a)} → ${fmtTime(b)}`);
    renderOverlay();
    pushState();
  }

  // The manual replay: jump to A. Useful with only A set, which is the
  // simplest possible workflow — mark the spot, then hammer this key.
  function jumpToLoopStart() {
    if (!rt.video) return;
    if (rt.loopA === null) {
      toast('loop-reject', '⚠', 'No in point set');
      return;
    }
    seekTo(rt.loopA);
    rt.loopInside = true;
    toast('loop-jump', '⤺', `Replay ${fmtTime(rt.loopA)}`);
  }

  function isInsideLoop(t) {
    if (!loopArmed() || !Number.isFinite(t)) return false;
    return t >= rt.loopA - LOOP_REENTRY_EPS && t < rt.loopB;
  }

  function seekTo(t) {
    if (!rt.video) return;
    const d = videoDuration();
    const target = clamp(t, 0, d === null ? t : Math.max(0, d - 0.05));
    try { rt.video.currentTime = target; } catch (_) { /* not seekable yet */ }
  }

  // Wrap back to A. Guarded by `wrapping` so a timeupdate or rAF frame landing
  // mid-seek cannot fire a second seek. The guard is normally cleared by the
  // 'seeked' handler; the watchdog releases it if that event never arrives
  // (a dropped seek would otherwise wedge the loop off permanently).
  function wrapLoop() {
    if (rt.wrapping || !loopArmed()) return;
    rt.wrapping = true;
    if (rt.wrapWatchdog) clearTimeout(rt.wrapWatchdog);
    rt.wrapWatchdog = setTimeout(() => {
      rt.wrapWatchdog = null;
      if (!rt.wrapping) return;
      rt.wrapping = false;
      if (loopArmed() && rt.video) rt.loopInside = isInsideLoop(rt.video.currentTime);
    }, WRAP_WATCHDOG_MS);
    seekTo(rt.loopA);
  }

  // Evaluated from both the coarse (timeupdate) and fine (rAF) paths.
  function checkLoopBoundary() {
    if (!loopArmed() || !rt.video || rt.wrapping) return;
    if (rt.video.seeking || rt.adShowing) return;
    const t = rt.video.currentTime;
    if (!Number.isFinite(t)) return;

    if (!rt.loopInside) {
      // The user scrubbed outside the window — never yank them back, or
      // scrubbing away from the loop becomes impossible. Re-arm only when the
      // playhead returns on its own.
      if (isInsideLoop(t)) rt.loopInside = true;
      return;
    }
    if (t >= rt.loopB - LOOP_LEAD) wrapLoop();
    else if (t < rt.loopA - LOOP_REENTRY_EPS) rt.loopInside = false;
  }

  // timeupdate fires only ~4x/s, which would overshoot B by up to 250 ms. In
  // the final stretch before B, poll every frame so the wrap lands tight.
  // Hidden tabs throttle rAF, but a hidden tab isn't being practiced along to
  // — the coarse path still loops it, just less precisely.
  function startLoopPolling() {
    if (rt.loopRaf !== null || !loopArmed()) return;
    const tick = () => {
      rt.loopRaf = null;
      if (!loopArmed()) return;
      checkLoopBoundary();
      updateLoopRing();
      if (loopArmed()) rt.loopRaf = requestAnimationFrame(tick);
    };
    rt.loopRaf = requestAnimationFrame(tick);
  }

  function stopLoopPolling() {
    if (rt.loopRaf !== null) {
      cancelAnimationFrame(rt.loopRaf);
      rt.loopRaf = null;
    }
  }

  function onLoopTimeUpdate() {
    checkLoopBoundary();
  }

  function onLoopSeeked() {
    const wasWrapping = rt.wrapping;
    rt.wrapping = false;
    if (rt.wrapWatchdog) {
      clearTimeout(rt.wrapWatchdog);
      rt.wrapWatchdog = null;
    }
    if (!loopArmed() || !rt.video) return;
    // A wrap lands inside by construction. A user seek decides membership by
    // where it landed.
    rt.loopInside = wasWrapping ? true : isInsideLoop(rt.video.currentTime);
    renderOverlay();
  }

  // Loop listeners are attached only while a mark exists — YouTube fires
  // timeupdate constantly and there is no reason to run this on every video.
  const LOOP_EVENTS = [
    ['timeupdate', onLoopTimeUpdate],
    ['seeked', onLoopSeeked],
    ['durationchange', renderOverlay],
    ['loadedmetadata', renderOverlay]
  ];

  function syncLoopListeners() {
    if (!rt.video) return;
    const shouldAttach = rt.loopA !== null;
    if (shouldAttach && !rt.loopListenersAttached) {
      for (const [ev, fn] of LOOP_EVENTS) rt.video.addEventListener(ev, fn);
      rt.loopListenersAttached = true;
    } else if (!shouldAttach && rt.loopListenersAttached) {
      for (const [ev, fn] of LOOP_EVENTS) rt.video.removeEventListener(ev, fn);
      rt.loopListenersAttached = false;
    }
  }

  function detachLoopListeners() {
    if (rt.video && rt.loopListenersAttached) {
      for (const [ev, fn] of LOOP_EVENTS) rt.video.removeEventListener(ev, fn);
    }
    rt.loopListenersAttached = false;
    stopLoopPolling();
  }

  function fmtTime(t) {
    const total = Math.max(0, Math.floor(t));
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const sec = total % 60;
    const two = (n) => String(n).padStart(2, '0');
    return h > 0 ? `${h}:${two(m)}:${two(sec)}` : `${m}:${two(sec)}`;
  }

  // --- Video binding -------------------------------------------------------------
  const VIDEO_EVENTS = [
    ['play', onPlaying],
    ['playing', onPlaying],
    ['pause', onPauseLike],
    ['ended', onPauseLike],
    ['waiting', onPauseLike],
    ['emptied', onPauseLike],
    ['seeking', onSeeking],
    ['seeked', onSeeked],
    ['ratechange', onRateChange]
  ];

  function onPlaying() {
    if (!isVideoDriven() || rt.adShowing) return;
    if (rt.isPlaying) rebaseToVideo();
    else startMetronome();
  }
  function onPauseLike() {
    if (isVideoDriven() && rt.isPlaying) pauseScheduler();
  }
  function onSeeking() {
    // Silence clicks committed inside the look-ahead while the user scrubs.
    if (isVideoDriven() && rt.isPlaying && rt.ctx) cancelScheduledFrom(rt.ctx.currentTime);
  }
  function onSeeked() {
    if (!isVideoDriven() || !rt.video) return;
    if (rt.video.paused || rt.video.ended) {
      if (rt.isPlaying) pauseScheduler();
      return;
    }
    if (rt.isPlaying) rebaseToVideo();
    else startMetronome();
  }
  function onRateChange() {
    if (!rt.video) return;
    rt.playbackRate = rt.video.playbackRate || 1;
    // Rebase rather than stop/start: keeps the lock and the beat numbering.
    if (isVideoDriven() && rt.isPlaying) rebaseToVideo();
  }

  function syncVideoListeners() {
    if (!rt.video) return;
    const shouldAttach = isVideoDriven();
    if (shouldAttach && !rt.listenersAttached) {
      for (const [ev, fn] of VIDEO_EVENTS) rt.video.addEventListener(ev, fn);
      rt.listenersAttached = true;
    } else if (!shouldAttach && rt.listenersAttached) {
      for (const [ev, fn] of VIDEO_EVENTS) rt.video.removeEventListener(ev, fn);
      rt.listenersAttached = false;
    }
  }

  function attachVideo(el) {
    if (rt.video === el) return;
    detachVideo();
    rt.video = el;
    rt.playbackRate = el.playbackRate || 1;
    syncVideoListeners();
    syncLoopListeners();
    mountOverlay();
    disarmDetection();
    if (settings.mode === 'auto' && !el.paused && !el.ended && !rt.adShowing) {
      startMetronome();
    }
    pushState();
  }

  function detachVideo() {
    if (!rt.video) return;
    if (rt.listenersAttached) {
      for (const [ev, fn] of VIDEO_EVENTS) rt.video.removeEventListener(ev, fn);
      rt.listenersAttached = false;
    }
    detachLoopListeners();
    rt.video = null;
    rt.playbackRate = 1;
    // Auto and manual+locked depend on the video; free-running manual keeps going.
    if (isVideoDriven()) stopMetronome();
    armDetection();
    pushState();
  }

  // Only bind the main player. A bare querySelector('video') also matches the
  // homepage hover-preview player, which would start the click while browsing.
  function isPreviewVideo(el) {
    return !!(el.closest && el.closest('ytd-video-preview, #video-preview'));
  }

  function findMainVideo() {
    const el = document.querySelector('#movie_player video.html5-main-video')
      || document.querySelector('video.html5-main-video')
      || document.querySelector('#movie_player video');
    if (el) return el;
    const generic = document.querySelector('video');
    if (generic && !isPreviewVideo(generic)) return generic;
    return null;
  }

  function findVideo() {
    const el = findMainVideo();
    if (el && el !== rt.video) attachVideo(el);
    else if (!el && rt.video) detachVideo();
    else if (rt.video && !document.contains(rt.video)) detachVideo();
    watchAdState();
    updateVideoContext();
  }

  // --- Per-video memory ------------------------------------------------------
  function getVideoId() {
    const { pathname, search } = window.location;
    if (pathname === '/watch') {
      const m = /[?&]v=([^&]+)/.exec(search || '');
      return m ? m[1] : null;
    }
    const s = /^\/shorts\/([^/?]+)/.exec(pathname);
    return s ? s[1] : null;
  }

  // On navigation to a remembered video, restore its snapshot by writing the
  // settings keys — the normal storage.onChanged path then applies them here,
  // in other tabs, and in the popup, exactly as if the user had set them.
  async function updateVideoContext() {
    const id = getVideoId();
    if (id === currentVideoId) return;
    currentVideoId = id;
    // Marks are video-time offsets into the *previous* video; carrying them
    // across a navigation would loop an unrelated stretch of the new one.
    clearLoop(false);
    if (!id) return;
    let memory;
    try {
      memory = (await chrome.storage.local.get(MEMORY_KEY))[MEMORY_KEY] || {};
    } catch (_) { return; }
    const entry = memory[id];
    if (!entry) return;
    if (currentVideoId !== id) return; // navigated again while reading
    const clean = sanitizeSettings({ ...settings, ...entry });
    const partial = {};
    for (const k of MEMORY_FIELDS) {
      if (clean[k] !== settings[k]) partial[k] = clean[k];
    }
    if (Object.keys(partial).length === 0) return;
    try { chrome.storage.local.set(partial); } catch (_) { /* noop */ }
  }

  // A snapshot is only ever written after the user changes a remembered
  // setting on this video (so untouched videos never accumulate entries), and
  // only from the visible tab (a background tab reacting to another tab's
  // change must not claim the snapshot for its own video).
  function scheduleMemorySave() {
    if (!currentVideoId || document.hidden) return;
    if (memorySaveTimer) clearTimeout(memorySaveTimer);
    memorySaveTimer = setTimeout(saveVideoMemory, MEMORY_SAVE_DEBOUNCE_MS);
  }

  async function saveVideoMemory() {
    memorySaveTimer = null;
    const id = currentVideoId;
    if (!id) return;
    let memory;
    try {
      memory = (await chrome.storage.local.get(MEMORY_KEY))[MEMORY_KEY] || {};
    } catch (_) { return; }
    const entry = { savedAt: Date.now() };
    for (const k of MEMORY_FIELDS) entry[k] = settings[k];
    memory[id] = entry;
    const ids = Object.keys(memory)
      .sort((a, b) => (memory[b].savedAt || 0) - (memory[a].savedAt || 0));
    for (const stale of ids.slice(MEMORY_LIMIT)) delete memory[stale];
    try { chrome.storage.local.set({ [MEMORY_KEY]: memory }); } catch (_) { /* noop */ }
  }

  // YouTube marks the player element with .ad-showing during ads. Clicking
  // over an ad is useless (and the ad runs on its own timeline), so treat ads
  // like a pause: stop while showing, resync when content resumes.
  function watchAdState() {
    const player = document.getElementById('movie_player');
    if (player === rt.playerEl) return;
    if (rt.adObserver) { rt.adObserver.disconnect(); rt.adObserver = null; }
    rt.playerEl = player;
    if (!player) { rt.adShowing = false; return; }
    const update = () => {
      const showing = player.classList.contains('ad-showing')
        || player.classList.contains('ad-interrupting');
      if (showing === rt.adShowing) return;
      rt.adShowing = showing;
      if (!isVideoDriven()) return;
      if (showing) {
        if (rt.isPlaying) pauseScheduler();
      } else if (videoPlayingNow()) {
        startMetronome();
      }
      pushState();
    };
    rt.adObserver = new MutationObserver(update);
    rt.adObserver.observe(player, { attributes: true, attributeFilter: ['class'] });
    update();
    mountOverlay();
  }

  // Detection is armed only while no video is bound — YouTube mutates the DOM
  // constantly, and running querySelector on every mutation forever is wasted
  // work once we hold the (long-lived) player element.
  let detectObserver = null;
  let detectPollTimer = null;

  function armDetection() {
    if (!detectObserver) {
      detectObserver = new MutationObserver(() => findVideo());
      detectObserver.observe(document.documentElement, { childList: true, subtree: true });
    }
    if (detectPollTimer) clearTimeout(detectPollTimer);
    let tries = 0;
    const poll = () => {
      detectPollTimer = null;
      if (rt.video) return;
      findVideo();
      if (!rt.video && tries < 40) {
        tries += 1;
        detectPollTimer = setTimeout(poll, 250);
      }
    };
    poll();
  }

  function disarmDetection() {
    if (detectObserver) {
      detectObserver.disconnect();
      detectObserver = null;
    }
    if (detectPollTimer) {
      clearTimeout(detectPollTimer);
      detectPollTimer = null;
    }
  }

  // --- Manual hotkeys --------------------------------------------------------------
  function isTypingTarget(e) {
    const t = e.target;
    if (!t) return false;
    const tn = (t.tagName || '').toUpperCase();
    if (tn === 'INPUT' || tn === 'TEXTAREA' || tn === 'SELECT') return true;
    if (t.isContentEditable) return true;
    return false;
  }

  // Suppress the page's own handling of a key we claimed. YouTube registers
  // handlers on window/document, so stopImmediatePropagation is needed to
  // truly decouple.
  function consumeKey(e) {
    e.preventDefault();
    e.stopPropagation();
    if (typeof e.stopImmediatePropagation === 'function') e.stopImmediatePropagation();
  }

  function onHotkeyDown(e) {
    if (isTypingTarget(e)) return;
    if (e.repeat) return;
    if (e.ctrlKey || e.altKey || e.metaKey) return;

    // Loop hotkeys work in BOTH modes, and regardless of settings.enabled —
    // that switch is the metronome's master mute, and looping a passage has
    // nothing to do with whether a click is sounding.
    // Shift+mark clears; plain Shift is otherwise never a bare-key shortcut,
    // so the clear costs no extra binding.
    if (e.code === settings.loopMarkHotkey) {
      consumeKey(e);
      if (e.shiftKey) clearLoop(true);
      else cycleLoopMark();
      return;
    }
    if (e.code === settings.loopJumpHotkey && !e.shiftKey) {
      consumeKey(e);
      jumpToLoopStart();
      return;
    }

    if (!settings.enabled) return;
    if (e.shiftKey) return;
    // Transport hotkeys are manual-mode only — in auto mode the video drives
    // the click and there is nothing to start, stop, or anchor.
    if (settings.mode !== 'manual') return;

    const isStart = e.code === settings.hotkey;
    const isLock = e.code === settings.lockHotkey;
    if (!isStart && !isLock) return;
    consumeKey(e);

    if (isStart) {
      const wasPlaying = rt.isPlaying;
      if (wasPlaying) stopMetronome();
      else startMetronome();
      // Report what actually happened: a start can be refused (no video
      // playing in locked/auto-driven cases), and a silent no-op is exactly
      // the confusion the overlay exists to remove.
      if (wasPlaying) toast('click-off', '♩', 'Click off');
      else if (rt.isPlaying) toast('click-on', '♩', `Click on · ${settings.bpm} · ${settings.sig}/4`);
      else toast('click-reject', '⚠', 'Play the video first');
      return;
    }
    // Lock hotkey — only meaningful while the metronome is running.
    if (!rt.isPlaying) {
      toast('lock-reject', '⚠', 'Start the click first');
      return;
    }
    if (rt.locked) {
      unlockFromVideo();
      toast('lock-off', { svg: 'unlocked' }, 'Beat lock off');
    } else {
      lockToVideo();
      if (rt.locked) toast('lock-on', { svg: 'locked' }, 'Beat lock on');
      else toast('lock-reject', '⚠', 'No video to lock to');
    }
  }

  // --- Popup port ---------------------------------------------------------------------
  function publicState() {
    const videoPresent = !!rt.video && document.contains(rt.video);
    const videoPlaying = videoPresent && !rt.video.paused && !rt.video.ended;
    // Manual+unlocked runs independently of video state; auto and
    // manual+locked are gated by it.
    const runningNow = isVideoDriven()
      ? rt.isPlaying && videoPlaying
      : rt.isPlaying;
    return {
      type: 'state',
      mode: settings.mode,
      enabled: settings.enabled,
      locked: rt.locked,
      isPlaying: runningNow,
      currentBeat: runningNow ? rt.currentBeat : 0,
      adShowing: rt.adShowing,
      videoPresent,
      videoPlaying,
      loopA: rt.loopA,
      loopB: rt.loopB
    };
  }

  function pushToPort(msg) {
    if (!port) return;
    try { port.postMessage(msg); } catch (_) { port = null; }
  }

  function pushState() {
    pushToPort(publicState());
  }

  function onPortCommand(msg) {
    if (!msg || !msg.type) return;
    if (msg.type === 'MANUAL_TOGGLE') {
      if (settings.mode !== 'manual' || !settings.enabled) return;
      if (rt.isPlaying) stopMetronome();
      else startMetronome();
    } else if (msg.type === 'TOGGLE_LOCK') {
      if (settings.mode !== 'manual' || !rt.isPlaying) return;
      if (rt.locked) unlockFromVideo();
      else lockToVideo();
    } else if (msg.type === 'LOOP_MARK') {
      cycleLoopMark();
    } else if (msg.type === 'LOOP_JUMP') {
      jumpToLoopStart();
    } else if (msg.type === 'LOOP_CLEAR') {
      clearLoop(true);
    }
  }

  // --- Settings sync (storage is the single source of truth; popup writes it) ----------
  function onStorageChanged(changes, area) {
    if (area !== 'local') return;
    const raw = { ...settings };
    for (const key of Object.keys(changes)) raw[key] = changes[key].newValue;
    const prev = settings;
    settings = sanitizeSettings(raw);

    if (prev.volume !== settings.volume) applyVolume();
    if (prev.mode !== settings.mode) {
      applyMode();
    }
    if (prev.enabled !== settings.enabled) {
      if (!settings.enabled) stopMetronome();
      else if (settings.mode === 'auto' && videoPlayingNow() && !rt.adShowing) startMetronome();
    }
    if (prev.bpm !== settings.bpm) onTempoChanged(prev.bpm);
    if (prev.syncOffsetMs !== settings.syncOffsetMs && isVideoDriven() && rt.isPlaying) {
      rebaseToVideo();
    }
    // sig / barOffset / accentEnabled / subdivision / clickSound need no
    // rescheduling — the scheduler reads them per beat.
    if (prev.overlayEnabled !== settings.overlayEnabled) {
      if (settings.overlayEnabled) {
        watchOverlayHost();
        mountOverlay();
      } else {
        unwatchOverlayHost();
        unmountOverlay();
      }
    }
    if (MEMORY_FIELDS.some((k) => prev[k] !== settings[k])) scheduleMemorySave();
    renderOverlay();
    pushState();
  }

  // --- Init ------------------------------------------------------------------------------
  async function init() {
    let stored = {};
    try { stored = await chrome.storage.local.get(null); } catch (_) { /* first run */ }
    settings = sanitizeSettings(stored);

    chrome.storage.onChanged.addListener(onStorageChanged);

    chrome.runtime.onConnect.addListener((p) => {
      if (p.name !== PORT_NAME) return;
      if (port) { try { port.disconnect(); } catch (_) { /* stale */ } }
      port = p;
      p.onMessage.addListener(onPortCommand);
      p.onDisconnect.addListener(() => { if (port === p) port = null; });
      pushState();
    });

    // Capture phase on both window and document: window fires first, ahead of
    // YouTube's own keyboard handlers; stopImmediatePropagation on a match
    // keeps the document-level copy from double-firing.
    window.addEventListener('keydown', onHotkeyDown, true);
    document.addEventListener('keydown', onHotkeyDown, true);

    // On hide, immediately buffer clicks ahead before Chrome throttles our
    // timers; on show, the next pass tightens back up on its own.
    document.addEventListener('visibilitychange', () => {
      if (rt.isPlaying && rt.schedulerTimer) {
        clearTimeout(rt.schedulerTimer);
        schedulerPass();
      }
    });

    // YouTube is a SPA — video changes arrive via soft navigation, not reload.
    document.addEventListener('yt-navigate-finish', () => findVideo());
    window.addEventListener('pageshow', () => {
      findVideo();
      if (rt.isPlaying && isVideoDriven()) rebaseToVideo();
    });

    // Fullscreen and theater-mode transitions rebuild the player chrome; the
    // MutationObserver catches most of it, but these fire reliably and cheaply.
    document.addEventListener('fullscreenchange', () => mountOverlay());
    window.addEventListener('resize', () => renderOverlay());

    watchOverlayHost();
    armDetection();
    findVideo();
  }

  // Isolated-world only (invisible to page scripts); used by tests/run.js.
  window.__syncoBeatTest = {
    getState: () => ({
      settings: { ...settings },
      isPlaying: rt.isPlaying,
      locked: rt.locked,
      phaseOffset: rt.phaseOffset,
      beatCounter: rt.beatCounter,
      nextNoteTime: rt.nextNoteTime,
      currentBeat: rt.currentBeat,
      adShowing: rt.adShowing,
      hasVideo: !!rt.video,
      loopA: rt.loopA,
      loopB: rt.loopB,
      loopInside: rt.loopInside,
      wrapping: rt.wrapping
    }),
    // Overlay text as the user would read it — asserts the visual layer
    // without needing a real DOM renderer.
    getOverlay: () => ({
      toasts: ov.live.map((el) => el.textContent),
      chip: ov.chip && ov.chip.classList.contains('show') ? ov.chip.textContent : null,
      chipShowsLock: !!(ov.chip && ov.chip.classList.contains('show')
        && Array.prototype.some.call(ov.chip.children,
          (c) => c.classList.contains('lock'))),
      toastIcons: ov.live.map((el) => {
        const ico = el.children[0];
        const svg = ico && ico.children[0];
        // A drawn glyph reports the shackle path it used, so tests can tell
        // the locked and unlocked silhouettes apart.
        return svg ? `svg:${svg.children[0].getAttribute('d')}` : (ico ? ico.textContent : '');
      }),
      band: ov.band && ov.band.classList.contains('show')
        ? { left: ov.band.style.left, width: ov.band.style.width }
        : null,
      tickA: ov.tickA && ov.tickA.classList.contains('show') ? ov.tickA.style.left : null,
      tickB: ov.tickB && ov.tickB.classList.contains('show') ? ov.tickB.style.left : null,
      // Loop progress ring: the swept fraction, and whether the chip is in its
      // static (non-sweeping) presentation.
      ring: ov.chip ? Number(ov.chip.style.getPropertyValue('--p') || 0) : null,
      ringStatic: !!(ov.chip && ov.chip.classList.contains('static')),
      chipDim: !!(ov.chip && ov.chip.classList.contains('dim'))
    })
  };

  init();
})();
