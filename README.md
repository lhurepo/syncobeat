# SyncoBeat 🥭

A Chrome extension (Manifest V3) that embeds a precision metronome into YouTube, for drummers practicing along with tutorials.

## Install

1. Open `chrome://extensions`, enable **Developer mode**.
2. **Load unpacked** → select this folder.
3. Open a YouTube video and click the SyncoBeat icon. (Tabs opened before installing need a reload.)

## Modes

- **Auto** — the click phase-locks to the video timeline (beat 0 at 0:00) and follows play, pause, seeking, playback-rate changes, and buffering. It pauses automatically during ads.
- **Manual** — the video is ignored. Press the start/stop hotkey (default **B**) on the YouTube page, on beat 1 of the song, to start the click; press again to stop. The popup's **Start/Stop** button does the same.
- **Manual + Lock** — while the manual click is running, press the lock hotkey (default **V**, or the popup's **Lock to video** button) to anchor the click to the video at its current phase and beat number. Once locked, the click survives seeks, pauses, and speed changes — it always comes back on *your* beat 1.

## Features

- Tempo 20–300 BPM: slider, ±1 nudge, ½×/2× buttons, **tap tempo**, click-to-type on the big number, and up to 8 saved presets.
- Meters 2/4 – 7/8 with optional **subdivision clicks** (8ths, triplets, 16ths) at reduced volume.
- Movable **accent** (or none), with a live beat-dot display synced to the audible click.
- Four synthesized click sounds (no audio assets): original beep, woodblock, clave, soft sine.
- **Click offset** trim (±200 ms) to compensate perceived latency — useful on Bluetooth headphones.
- Settings sync instantly to every open YouTube tab (single source of truth in `chrome.storage.local`).
- **Per-video memory** — once you tweak the tempo, meter, accent, subdivision, or click offset on a video, that video remembers them and restores them when you come back (last 50 videos; untouched videos are never stored).

## Engineering notes

- **Scheduling** follows the look-ahead pattern (Web Audio events scheduled ahead of a JS timer). Hidden tabs get their timers throttled to ≥1 s by Chrome, so on `visibilitychange` the scheduler switches to a multi-second buffered look-ahead — the click stays rock-solid when you tab away.
- Every pending click is **cancellable** (tracked and detached from the graph), so pauses, seeks, and tempo changes silence already-buffered clicks instead of letting them ring out.
- A **drift corrector** measures the click's phase against the video clock (a separate clock domain) every 500 ms and snaps back when the error exceeds 25 ms twice in a row.
- A `DynamicsCompressor` limiter after the master gain keeps the hot click (+6 dB headroom) from clipping harshly.
- The popup is the **single writer** of settings; content scripts react to `storage.onChanged`. Live playback state is pushed to the popup over a `Port` (no polling), with beat ticks emitted at the *audible* time, not the schedule time.

## Tests

Zero-dependency smoke tests run the content script in a Node `vm` sandbox with fake Web Audio / DOM / chrome APIs and a virtual clock:

```sh
node tests/run.js
```
