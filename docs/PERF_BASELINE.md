# Client performance baseline

The numbers later performance changes are compared against. They were taken
on 2026-10-11 with `scripts/perf-bench.cjs` (see
[AGENT_TESTING.md](AGENT_TESTING.md#measuring-performance)), in a throwaway
rotest world, on:

- client: roBrowserLegacy `7b3a5aba` (the `config/VENDOR_PINS` pin) plus the
  PerfProbe commit
  ([akreao/roBrowserLegacy#21](https://github.com/akreao/roBrowserLegacy/pull/21)),
  with the app's client patches applied;
- headless Chromium (Playwright) through ANGLE on an NVIDIA RTX 3060, at
  1920×1080, on Arch Linux;
- a renewal world, as `tester`, hidden with `@hide` so monsters leave it alone,
  using the stock camera (zoom 125, pitch 230, yaw 0).

## How to rerun

```sh
scripts/rotest world up
node scripts/perf-bench.cjs                                            # uncapped, every scene
node scripts/perf-bench.cjs --capped --scenes iz_dun05,pay_fild02      # at 60 fps, as a player sees it
node scripts/perf-bench.cjs --cpu-throttle 4 --scenes iz_dun05,pay_fild02
```

The world's client has to include the probe. Until the PR above is in a pin,
build it from the `perf-probe` branch:

1. Copy the tree somewhere.
2. Run `scripts/patch-client.sh` on the copy, with `RAGNAROK_ROBROWSER_DIR`
   pointing at it.
3. Run `npm run build:all`, then `scripts/patch-bundle.sh <copy>/dist/Web`.
4. Copy `dist/Web` over `artifacts/agent-world/runtime/vendor/roBrowserLegacy/dist/Web`.

Each run writes a Markdown table and the raw JSON to `artifacts/perf/`.

**Read these as relative numbers.** This GPU is fast enough that every scene
takes about 1 ms. The 60 fps capped run shows only that nothing drops a frame
here. The uncapped and 4× CPU-throttled runs are the ones a change will move.

## Startup

| | Normal | CPU 4× throttled |
|---|---|---|
| Page load to login window, cold profile (median of 3) | **2025 ms** (2017–2058) | 4194 ms |
| Login to character select | 603 ms | 771 ms |
| Character select to playable (includes the first map load) | **5706 ms** | 12449 ms |

Startup is bound by the main thread: it doubles under a 4× throttle.
Character select to playable is the biggest wait a player sees. It takes 5.7 s,
and only about 2 s of that is loading the map.

## Map load (`setMap` to the first frame drawn)

| Map | Cold (first visit) | Warm (revisit) |
|---|---|---|
| iz_dun00 | 1663 ms | 1406 ms |
| iz_dun01 | 1634 ms | 1282 ms |
| iz_dun02 | 1540 ms | 1376 ms |
| iz_dun03 | 1642 ms | 1266 ms |
| iz_dun04 | 1510 ms | 1300 ms |
| iz_dun05 | 1833 ms | 1383 ms |
| pay_fild02 | 1335 ms | 1302 ms |

A warm load is only 10–25% faster than a cold one, so fetching files is not
where the time goes. A 4× main-thread throttle barely moves it either
(iz_dun05 1963/1484 ms), so most of the work runs in the map-loading worker
or the GPU upload, not on the main thread. Every map costs about 1.3 s even
when fully cached.

## Frame time

The heaviest Byalan floor is **iz_dun05**: the most draw calls and the lowest
uncapped FPS. Wolves on pay_fild02 are spawned (`@monster 1013 60` / `200`),
since renewal has none on Payon fields.

### Uncapped (ms per frame; work = CPU time inside the render loop)

| Scene | Fade | FPS | Frame avg | p95 | p99 | Work avg | Work p99 | Draws/frame | Hitches >50 ms | Entities |
|---|---|---|---|---|---|---|---|---|---|---|
| iz_dun00 | off | 1573 | 0.64 | 0.8 | 1.1 | 0.12 | 0.3 | 35 | 0 | 2 |
| iz_dun01 | off | 1889 | 0.53 | 1.2 | 1.7 | 0.23 | 1.3 | 34 | 1 | 4 |
| iz_dun02 | off | 1660 | 0.60 | 1.1 | 1.6 | 0.30 | 1.1 | 46 | 8 | 5 |
| iz_dun03 | off | 1670 | 0.60 | 1.4 | 2.1 | 0.30 | 1.7 | 70 | 4 | 1 |
| iz_dun04 | off | 1552 | 0.64 | 1.4 | 2.3 | 0.34 | 1.7 | 89 | 2 | 3 |
| **iz_dun05** | off | 1492 | 0.67 | 1.6 | 2.5 | 0.37 | 2.0 | 108 | 9 | 0 |
| iz_dun05 | dither | 1485 | 0.67 | 1.7 | 2.8 | 0.35 | 2.2 | 108 | 11 | 0 |
| iz_dun05 | alpha | 1530 | 0.65 | 1.6 | 2.5 | 0.33 | 1.9 | 108 | 11 | 0 |
| pay_fild02 + 60 wolves | off | 1433 | 0.70 | 0.9 | 1.3 | 0.37 | 0.7 | 153 | 0 | 56 |
| pay_fild02 + 60 wolves | dither | 1542 | 0.65 | 0.9 | 1.2 | 0.33 | 0.6 | 135 | 0 | 41 |
| pay_fild02 + 60 wolves | alpha | 1669 | 0.60 | 0.8 | 1.0 | 0.28 | 0.5 | 145 | 0 | 37 |
| pay_fild02 + 200 wolves | off | 961 | 1.04 | 1.3 | 1.6 | 0.71 | 1.0 | 282 | 0 | 106 |
| pay_fild02 + 200 wolves | dither | 1064 | 0.94 | 1.2 | 1.5 | 0.61 | 0.9 | 255 | 0 | 97 |
| pay_fild02 + 200 wolves | alpha | 1110 | 0.90 | 1.2 | 1.5 | 0.57 | 0.9 | 259 | 0 | 93 |

The dither and alpha rows for iz_dun00–04 are within noise of the off rows.
They are in the raw JSON.

### CPU throttled 4× (uncapped)

| Scene | Fade | FPS | Frame avg | p99 | Work avg | Work p99 | Draws/frame | Entities |
|---|---|---|---|---|---|---|---|---|
| iz_dun05 | off | 502 | 1.99 | 7.5 | 0.70 | 5.7 | 108 | 0 |
| iz_dun05 | dither | 498 | 2.01 | 7.2 | 0.73 | 5.6 | 163 | 0 |
| iz_dun05 | alpha | 484 | 2.07 | 7.4 | 0.76 | 5.6 | 163 | 0 |
| pay_fild02 + 60 wolves | off | 326 | 3.06 | 7.0 | 1.59 | 3.0 | 152 | 55 |
| pay_fild02 + 200 wolves | off | 187 | 5.34 | 11.2 | 3.45 | 5.4 | 292 | 118 |
| pay_fild02 + 200 wolves | alpha | 214 | 4.67 | 10.4 | 2.86 | 4.6 | 298 | 95 |

### Capped at 60 fps

Every scene and fade mode held 59.9–60 fps, with p99 at 16.8 ms and no
hitches. The draw counts are the useful part:

| Scene | Fade off | Dither | Alpha |
|---|---|---|---|
| iz_dun05 draws/frame (vertices) | 102 (323k) | 203 (518k) | 203 (518k) |
| pay_fild02 + 60 wolves draws | 152 | 159 | 178 |
| pay_fild02 + 200 wolves draws | 280 | 291 | 299 |

## What the baseline says

1. **Entities are what makes a map heavy.** On the same field, 200 wolves cost
   about twice the CPU time of 60: 3.45 ms against 1.59 ms per frame at 4×
   throttle, and 5.3 ms frames. Each wolf on screen adds about 2.5 draw calls
   (152 → 282 draws for about 50 more entities near), since body, shadow and
   the rest are drawn one call at a time. A batched sprite path
   is the obvious lever for crowded maps.
2. **The occluder fade doubles the dungeon's draw calls at 60 fps.** On
   iz_dun05 it goes from 102 to 203 draws and from 323k to 518k vertices per
   frame, in both dither and alpha. The occlusion query re-draws the models
   every frame it can. Uncapped, the queries are still pending on most frames,
   so the cost hides there (108 draws in every mode). Its CPU cost is small
   here (about 0.03 ms), but on a GPU-bound machine it is the setting most
   likely to matter. The fade showed no FPS difference at the stock camera,
   where nothing covers the player.
3. **Map load is about 1.3 s even from cache**, and most of it is not network
   and not the main thread. Profile the map worker and the GPU upload next.
4. **Character select to playable takes 5.7 s**, of which the map is about
   2 s. The other 3.7 s is unexplained, and it is the longest wait in startup.
5. **The uncapped dungeon windows have 50–180 ms "hitches".** These turned
   out to be a headless artifact, not stutter. See
   [What the hitches are](#what-the-hitches-are-traces).

## What the hitches are (traces)

Steven sees FPS drops that come and go rather than a steady low rate. To find
out what they are, `scripts/perf-trace.cjs` plays a scripted stretch under a
Chrome trace: warp into iz_dun05, walk it, spawn Merman, Strouf and Hydra, open
and close four windows, warp to pay_fild02, spawn 60 wolves, walk, cast six
bolts and Thunderstorm into them, then warp back. The trace has JS sampling,
GC, GPU and the timeline. The client's PerfProbe logs every frame over 33 ms
and marks it in the trace as a `roPerf slow frame` measure.
`scripts/perf-trace-analyze.py` then says, for each one, what ran on the main
thread, the workers, the GPU process and the compositor, and which game
functions the CPU samples landed in.

```sh
node scripts/perf-trace.cjs --headed --capped    # a real window at 60 fps; the one that counts
node scripts/perf-trace.cjs --capped             # headless
node scripts/perf-trace.cjs --short              # headless uncapped; Chrome's trace buffer fills in about 20 s
python3 scripts/perf-trace-analyze.py artifacts/perf/trace-<...>.json
```

### Slow frames over the same 75 s of play

| Run | Frames >33 ms | Of which >50 ms | Where |
|---|---|---|---|
| Headed, 60 fps cap, on Steven's 75 Hz monitor | **4** | 2 | the first frame after each warp, plus the tracer starting |
| Headless, 60 fps cap | 57 | 3 | 51 single missed vsyncs (33–38 ms), map warps, one GC |
| Headless, uncapped (step 1 bench) | 13–16 per 10 s on iz_dun05 | 7–12 | idle, with nothing near |

The **uncapped headless hitches in the step 1 tables are not stutter.** Each
one is a whole multiple of about 17.6 ms (2.0×, 3.0×, 4.0× … 15×), and the
frame itself does at most 4 ms of work. Headless Chromium's frame scheduler is
holding frames back. They do not appear capped or headed. The 51 headless
capped frames of 33–38 ms are one missed synthetic vsync each, with the main
thread 3–4 ms busy. They do not appear headed either.

### What players actually get

1. **The 60 fps cap judders on any monitor faster than 60 Hz.** Steven's
   display is 1920×1080 at 74.97 Hz. The client's default `fpslimit` is 60
   (`Preferences/Graphics.js`), and the app does not change it. The limiter in
   `Renderer._render` can only skip whole vsyncs, so at 75 Hz it shows one
   frame in four for two vsyncs. Frame times alternate between 13.3 and
   26.7 ms. Measured on iz_dun05, headed:

   | Headed, 75 Hz | FPS | Frame p50 | p95 | max |
   |---|---|---|---|---|
   | `fpslimit` 60 (default) | 59.9 | 13.4 ms | **26.7 ms** | 26.8 ms |
   | `fpslimit` off (vsync only) | 74.9 | 13.3 ms | 13.4 ms | 13.5 ms |

   A quarter of all frames are twice as long as the rest, all the time, on
   every map. That is uneven motion, not a low frame rate, and it matches "FPS
   drops that aren't consistent". 144 and 165 Hz monitors get the same kind of
   uneven pacing.

2. **The first frames after a warp stall for 40–90 ms.** In every warp window
   (headed and headless), most of the JS samples are in
   `PostProcess.createFramebuffer`, which blocks on
   `GLES2Implementation::CheckFramebufferStatus`: 27–32 ms waiting on the GPU
   process. `compileShader`/`createShaderProgram`, `createWorldMapView` and
   texture `removeMagenta` take the rest. The cause is in `MapRenderer`'s
   `onMapComplete`: `registerPostProcessModules(gl)` runs on every map load
   and re-inits every post-process module, enabled or not (Bloom, Blur, FXAA,
   CAS, Cartoon, Vibrance, VerticalFlip, Blind, Upsampling). Each one compiles
   its shaders and builds a framebuffer that ends in a synchronous
   `checkFramebufferStatus`.

3. **One GC pause** of 33 ms (`V8.GCIncrementalMarking`) while 60 wolves
   spawned. It was the only GC-attributed slow frame in the run.

No slow frame came from shader compiles mid-play, sync file reads, layout or
image decode on first sight of a sprite. Image decode shows up only inside
warp frames (5–16 ms).

### Where the main thread's time goes during play

These are CPU samples over the whole headless capped run. The main thread was
busy 7% of the time at 60 fps on this machine, so these are shares of a small
total. They are what a slower machine runs out of first.

| Share of main-thread JS | Function | Source |
|---|---|---|
| 20.1% incl., 16.0% self | `updateModelBuffer` → `transformAndWrite` | `Renderer/Map/AnimatedModels.js` |
| 14.8% | `_renderEntity` / `_renderElement` (sprites, per entity) | `Renderer/Entity/EntityRender.js` |
| 6.1% | `checkScrollbars` | `UI/GUIComponent.js` `_setupScrollbars` |
| 5.5% | garbage collector | |
| 2.3% / 1.5% | `isTexture` / `checkFramebufferStatus` (synchronous GL queries) | `PostProcess.js` |
| 2.0% | `console.log` | packet logging, wrapped by the test hook |

- **Animated models are transformed on the CPU.** On every step of a model's
  animation, `updateModelBuffer` re-transforms every face of every node of
  every instance, recomputes each face normal from vertices that never change,
  then re-uploads the whole buffer with `bufferSubData`. It does this for
  nodes that do not move (`_isStatic`) too. Byalan is full of animated models.
- **`checkScrollbars` runs on any style or class change in a window.** A
  MutationObserver on each window's subtree reacts to every `style`/`class`
  attribute change by walking all of the window's descendants and calling
  `getComputedStyle` on each, which forces a style recalc. A window that
  updates a style every frame (bars, cooldowns, counters) pays that every
  frame.
- `console.log` of every received packet costs more here because the test
  harness wraps it. In the shipped app it is cheaper, but the client still
  formats and logs each packet.

The map-loading worker, over the same run, spent 22.6% of its busy time in
`saveFile` (writing what it downloaded to the browser's file cache: Blob,
`createWriter`, `getDirectory`). Building the ground (`GND.compile`) took
16.6% and model smooth normals (`calcNormal_SMOOTH`) 9.6%. This is part of why
map loads take about 1.3 s even from cache.

## Caveats

- Wolves wander off between windows: entities near fall from 56 to 37 across
  off → dither → alpha. The fade comparison on pay_fild02 is therefore
  confounded by the order the modes run in. Respawn the pack, or interleave
  the modes, before reading a fade difference there.
- `--cpu-throttle` slows only the page's main thread, not the GPU and
  probably not workers. It stands in for a slow CPU, not a slow GPU.
- Headless Chromium is not the Electron app. Absolute numbers will differ
  there, but the comparisons between runs hold.
- No population-engine players were present: the test world's towns hold
  only NPCs. Spawned wolves are the stand-in for a crowd.
- Rubber banding is not measured here. It needs the network side (`roAgent.net`)
  and is its own step.
