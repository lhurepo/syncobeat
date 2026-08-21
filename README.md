# SyncoBeat 🥭

A Chrome extension (Manifest V3) that embeds a precision metronome and an A/B practice looper into YouTube, for drummers practicing along with tutorials.

## Install

1. Open `chrome://extensions`, enable **Developer mode**.
2. **Load unpacked** → select this folder.
3. Open a YouTube video and click the SyncoBeat icon. (Tabs opened before installing need a reload.)

## Modes

- **Auto** — the click phase-locks to the video timeline (beat 0 at 0:00) and follows play, pause, seeking, playback-rate changes, and buffering. It pauses automatically during ads.
- **Manual** — the video is ignored. Press the start/stop hotkey (default **B**) on the YouTube page, on beat 1 of the song, to start the click; press again to stop. The popup's **Start/Stop** button does the same.
- **Manual + Lock** — while the manual click is running, press the lock hotkey (default **V**, or the popup's **Lock to video** button) to anchor the click to the video at its current phase and beat number. Once locked, the click survives seeks, pauses, and speed changes — it always comes back on *your* beat 1.

## Practice loop

Replaying one fill or phrase with `J`/`L` never lands in the same place twice. Mark the passage instead:

- Press **G** at the start of the passage — sets the **in** point.
- Press **G** again at the end — sets the **out** point, and the video starts looping that stretch. It keeps looping until you clear it.
- Press **G** a third time to drop a new in point and start over.
- Press **H** at any time to jump straight back to the in point. This works with only an in point set, which is the fastest workflow of all: mark the spot once, then hit **H** whenever you want another pass.
- Press **Shift+G** to clear the loop.

The mark and replay keys are both rebindable in the popup, and both work in Auto *and* Manual mode — and regardless of the metronome's master switch, since looping a passage has nothing to do with whether a click is sounding. Because SyncoBeat anchors its beat grid in video time, a loop wrap brings the click back on *the same beat number* — the accent lands where it did on the previous pass.

Guard rails: marking the end before the start swaps the two points instead of erroring; a span under 350 ms is refused rather than machine-gunning seeks; scrubbing outside the loop leaves you there (the loop re-arms when the playhead returns on its own); and marks are cleared when you navigate to another video.

## On-screen info

Loop and lock state is readable on the player itself, so you never have to open the popup mid-practice:

- **Confirmations** — a brief pill in the lower-left on every hotkey press: in/out set, loop off, click on/off, beat lock on/off. Presses that can't do anything (no video, loop too short, click not running) say why instead of failing silently.
- **Status chip** — a small always-there chip in the top-right while a loop or a beat lock is active, showing the loop range and a lock silhouette. It fades to a ghost when idle and vanishes entirely when nothing is active — except while a loop is running, when it stays readable.
- **Loop progress ring** — while looping, the chip's own border *is* the progress bar: an orange arc sweeps clockwise around the pill as the passage plays and resets on each wrap, so you can see the next repeat coming. With only an in point set, the border stays a plain static outline.
- **Progress-bar markers** — the loop range drawn as a tinted band on YouTube's own scrub bar, with ticks at the in and out points. `pointer-events: none` throughout, so scrubbing, hover previews, and chapter markers all keep working.

Turn the whole layer off with **On-screen info** in the popup.

## Hotkeys

| Key | Action | Mode |
|---|---|---|
| **B** | Start / stop the click | Manual |
| **V** | Beat lock on / off | Manual (while running) |
| **G** | Set in → set out → new in | Auto & Manual |
| **Shift+G** | Clear the loop | Auto & Manual |
| **H** | Replay from the in point | Auto & Manual |

There are four rebindable slots (Shift+G is a modifier on the mark key, not a slot of its own). The capture UI refuses keys YouTube itself uses (`K` `J` `L` `M` `F` `T` `C` `I` `O` `N` `P` `A` `S` `D` `W`, digits, arrows, space…) and keys already bound to another SyncoBeat slot, so you can't create a silent clash.

## Features

- Tempo 20–300 BPM: slider, ±1 nudge, ½×/2× buttons, **tap tempo**, click-to-type on the big number, and up to 8 saved presets.
- Meters 2/4 – 7/8 with optional **subdivision clicks** (8ths, triplets, 16ths) at reduced volume.
- Movable **accent** (or none), with a live beat-dot display synced to the audible click.
- Four synthesized click sounds (no audio assets): original beep, woodblock, clave, soft sine.
- **Click offset** trim (±200 ms on the slider) to compensate perceived latency — useful on Bluetooth headphones.
- Settings sync instantly to every open YouTube tab (single source of truth in `chrome.storage.local`).
- **Dark / light / system theme** for the popup. The on-page overlay stays dark in all three — it sits over video, where a light surface would be unreadable.
- **A/B practice loop** with on-page markers and hotkeys (see above).
- **Per-video memory** — once you tweak the tempo, meter, accent, subdivision, or click offset on a video, that video remembers them and restores them when you come back (last 50 videos; untouched videos are never stored).

## Settings

All state lives in `chrome.storage.local`. Defaults are seeded by `background.js` on install and on update, so a new setting gets its default for existing users without clobbering anything they changed.

| Key | Default | Notes |
|---|---|---|
| `bpm` | `120` | 20–300 |
| `sig` | `4` | 2–7 |
| `subdivision` | `1` | 1 = off, 2/3/4 = 8ths / triplets / 16ths |
| `barOffset` | `0` | moves the accent within the bar |
| `accentEnabled` | `true` | |
| `volume` | `0.8` | 0–1 |
| `syncOffsetMs` | `0` | ±200 on the slider (±500 accepted) |
| `enabled` | `true` | master mute; does **not** disable looping |
| `clickSound` | `'original'` | `original` \| `woodblock` \| `clave` \| `softsine` |
| `mode` | `'auto'` | `auto` \| `manual` |
| `hotkey` | `'KeyB'` | start/stop |
| `lockHotkey` | `'KeyV'` | beat lock |
| `loopMarkHotkey` | `'KeyG'` | mark cycle (Shift clears) |
| `loopJumpHotkey` | `'KeyH'` | replay from in point |
| `overlayEnabled` | `true` | on-page confirmations, chip, bar markers |
| `theme` | `'system'` | `system` \| `dark` \| `light` (popup only) |
| `presets` | `[60, 90, 120, 160]` | up to 8 |

`videoMemory` is written separately by the content script (never the popup) and holds the per-video snapshots.

Loop marks and lock state are deliberately **never** persisted: a mark is a video-time offset that means nothing on another video, and a lock is only meaningful for the session in which the user tapped beat 1.

## Engineering notes

- **Scheduling** follows the look-ahead pattern (Web Audio events scheduled ahead of a JS timer). Hidden tabs get their timers throttled to ≥1 s by Chrome, so on `visibilitychange` the scheduler switches to a multi-second buffered look-ahead — the click stays rock-solid when you tab away.
- Every pending click is **cancellable** (tracked and detached from the graph), so pauses, seeks, and tempo changes silence already-buffered clicks instead of letting them ring out.
- A **drift corrector** measures the click's phase against the video clock (a separate clock domain) every 500 ms and snaps back when the error exceeds 25 ms twice in a row.
- A `DynamicsCompressor` limiter after the master gain keeps the hot click (+6 dB headroom) from clipping harshly.
- The popup's typography is **two families and one 5-step scale**, declared as tokens in `:root`: `--font-ui` for everything, `--font-mono` reserved for values read as data (tempo, timecodes, key bindings) where tabular digits matter. No component sets a raw `font-size` or `font-weight`.
- The popup is the **single writer** of settings; content scripts react to `storage.onChanged`. Live playback state is pushed to the popup over a `Port` (no polling), with beat ticks emitted at the *audible* time, not the schedule time.
- **Loop wrapping** watches `timeupdate` (≈4 Hz) as a coarse trigger, plus a `requestAnimationFrame` poll that runs while a loop is armed, so the wrap lands within a frame instead of up to 250 ms late. It wraps ~12 ms early (`LOOP_LEAD`), since a seek is never instant. The wrap is a bare `currentTime` assignment — no pause — and an in-flight guard prevents re-entrant seeks, backed by a 1.5 s watchdog in case `seeked` is never delivered (a dropped event would otherwise wedge the loop off permanently). Loop marks are session-only, and the loop's listeners are attached only while a mark exists.
- The **loop progress ring** is one element with two stacked backgrounds: a `conic-gradient` on the border box and a solid fill clipped to the padding box, so the swept arc shows only in the 3 px border gutter. A single custom property (`--p`) changes per frame — rounded to whole percent, so a frame that changes nothing doesn't re-parse the gradient — driven from the loop's existing `requestAnimationFrame` poll rather than a timer of its own.
- The **page overlay** lives in two closed shadow roots — one inside `#movie_player`, one inside `.ytp-progress-bar` — so YouTube's stylesheet can't reach our styles and ours can't leak out. A `MutationObserver` re-mounts them when YouTube rebuilds its player chrome (navigation, fullscreen, theater mode).

## Development

### Tests

97 zero-dependency smoke tests run the content script in a Node `vm` sandbox with fake Web Audio / DOM / chrome APIs and a virtual clock:

```sh
node tests/run.js
```

They cover the beat grid and accent placement, lock behaviour across seeks and rate changes, hidden-tab buffering, drift correction, ads, the port protocol, per-video memory, and the practice loop — including wrap timing, the B-before-A swap, the too-short refusal, not yanking the user back after they scrub away, recovery from a dropped `seeked` event, and that a wrap leaves the click phase-correct.

The fake DOM is deliberately minimal, which has limits: it models `children` as a plain array where a browser gives an `HTMLCollection`, so a few overlay behaviours are only verifiable in a real browser. Loading the extension unpacked and watching the player is still the final check for anything visual.

### Icons

The toolbar icon is generated from `icons/syncobeatlogo.svg`. Regenerate the three PNG sizes with:

```sh
sips -s format png icons/syncobeatlogo.svg --out /tmp/logo.png
sips -Z 128 /tmp/logo.png --out icons/icon128.png
sips -Z 48  /tmp/logo.png --out icons/icon48.png
sips -Z 16  /tmp/logo.png --out icons/icon16.png
```

The logo uses the same two brand values as the UI — a mango gradient ground (`#FFC657` → `#F07A12`) with dark ink (`#1A1408`) for the metronome, sticks, and beat flare.
