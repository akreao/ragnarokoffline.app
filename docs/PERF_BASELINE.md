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

## Loading over a remote connection

A browser player on another machine loads everything from the host's asset
server. That is the Rust `robrowser-remoteclient`, which serves the page, the
files it extracts from the GRFs, and the WebSocket-to-TCP game proxy. On a
LAN, the browser talks plain HTTP/1.1 to `<host>:3338`. Over the internet
("friends"), the path is browser → Cloudflare → `cloudflared` → the app's
Node gateway on `:3339` → the Rust server
([FRIENDS_SHARING.md](FRIENDS_SHARING.md)). The client is same-origin
(`remoteClient: '/'`, and the socket proxy is built from `location.host`), so
it fetches every file by path over HTTP. It never reads a GRF, and makes no
range requests.

### How it was measured

`scripts/netshape.cjs` is a TCP proxy in front of the asset server. It models
one bottleneck link: a shared FIFO in each direction, half the RTT each way,
and one RTT for each new connection's handshake. Because the client is
same-origin, pointing the browser at the proxy shapes everything: the page,
the map worker's fetches, BGM and the game socket. A curl check matched the
model: TTFB 204 ms, and 13.15 MB in 10.5 s at 10 Mbps / 100 ms.

`scripts/perf-load.cjs` runs each profile in a fresh browser profile, so
nothing is cached at the start. It records every request (`ROTEST_NETLOG=1`)
and splits them by phase.

```sh
node scripts/perf-load.cjs --profiles local,50/40,10/100
```

This measures the LAN/direct path. The friends gateway was not in the loop,
because it needs an invitation session. What it changes is noted from its
code below.

### Results (cold; each run logs in to Prontera)

| Phase | Local | 50 Mbps / 40 ms | 10 Mbps / 100 ms |
|---|---|---|---|
| Page to login window | 2.0 s | 3.0 s | **7.6 s** |
| Login to character select | 0.6 s | 0.9 s | 1.5 s |
| Character select to playable (Prontera) | 6.3 s | 11.0 s | **25.4 s** |
| Warp to iz_dun05, first visit | 1.9 s | 3.4 s | 9.4 s |
| Warp to pay_fild02, first visit | 1.6 s | 2.5 s | 5.5 s |
| Reload, warm HTTP and file cache, to login | 1.4 s | 1.8 s | 2.8 s |

| Phase (10/100) | Requests | Bytes | Max in flight | Median TTFB | Time with one request in flight |
|---|---|---|---|---|---|
| Startup | 38 | 5.9 MB | 14 | 201 ms | 71% |
| Character select to playable | 913 | 14.8 MB | **466** | **1543 ms** | 1% |
| Warp iz_dun05 | 237 | 9.1 MB | 42 | 125 ms | 16% |
| Warp pay_fild02 | 83 | 2.6 MB | 7 | 115 ms | 15% |

What the requests show:

- **Entering the game is a burst of about 960 requests (19 MB).** 505 of
  them are UI textures (`data/texture/유저인터페이스/`): the art for windows
  the player has not opened, preloaded on entry. That is `basic_interface`
  122, cash shop 40, navigation 40, menu icons 49, lapine 26, bank 25,
  refining 19, achievements 17 and so on. Another 167 are Prontera's map
  textures, 52 are `.lub` tables (4.2 MB, including `itemInfo_client.lub`
  1.3 MB), and `itemInfo.lua` (0.9 MB) is fetched alongside the `.lub`.
  `worldmap.jpg` (1.3 MB) comes at entry too. Over HTTP/1.1 the browser opens
  six connections per origin, so up to 466 requests wait in its queue and the
  median request waits 1.5 s for its first byte. At 10/100 that phase is 23 s
  of transfer.
- **Startup is a serial chain.** The steps are `/` → `api.html` → `api.js` →
  `Config.js` → `Config.local.js` → `Online.js` → each plugin one after
  another → `ThreadEventHandler.js` → tables → single UI images. Each waits
  for the one before, so a request is alone in flight for 71% of the time.
  `Online.js` alone is 3.3 MB as sent: 2.9 s at 10 Mbps.
- **`Online.js` is 13.15 MB as built** (the Vite build has `minify: false`).
  The server gzips it at level 1, on every request, to 3.15 MB. gzip -9 would
  be 2.58 MB and brotli 1.93 MB. Minified (terser, mangle only) it is 8.1 MB,
  1.64 MB with brotli. `ThreadEventHandler.js`: 624 KB, 245 KB gzip-1, 153 KB
  brotli.
- **BGM competes with startup.** `01.mp3` (730 KB) downloads during startup,
  and each map's BGM (1.5–1.8 MB) arrives with the map. mp3 is never
  compressed.
- **Caching on the direct path works** for repeat loads. GRF files get
  `public, max-age=86400, immutable` with a content ETag. Client files get
  `max-age=0` with a weak ETag, so each one is revalidated: 304s, one RTT
  each, which is the 2.8 s warm reload at 100 ms. The generated
  `/`, `index.html` and `Config.local.js` are `no-store`.
- **No range requests anywhere** (the server has no Range support), and no
  batching. The server has a `POST /batch` endpoint, and the client has a
  `FileManager.getBatchHTTP` with 16 ms coalescing, but nothing calls it.

### What the friends gateway changes (from its code, not measured)

`electron/sharing/gateway.js` passes on only `accept`, `accept-encoding` and
`content-type`. It drops `If-None-Match`, `If-Modified-Since` and `Range`.
On the way back it keeps only `content-type`, `content-encoding` and
`content-length`, and forces `cache-control: private, no-store`. It also
opens a new TCP connection to the Rust server for each request
(`agent: false`). So **for an internet player nothing is cached by the
browser at all.** Every page load downloads `Online.js` and the rest again,
cold every time: the 7.6 s column, not the 2.8 s one. Files reach roBrowser's
own file cache (`saveFiles`, the deprecated WebKit FileSystem API) only where
that is on. Cloudflare's edge speaks HTTP/2 or 3 to the browser, so the
6-connection queue goes away there. The Quick Tunnel caps a session at 200
requests in flight, which the 466-request burst at game entry exceeds.

### Server-side costs per cold file

The Rust server reads, DES-decodes where needed and inflates the whole GRF
entry, hashes it (MD5, for the ETag), gzips it at level 1 on every response
(the compressed result is not cached), and copies it once more. With
`CLIENT_AUTOEXTRACT` it also writes the file to disk. There is no lock around
GRF reads, so requests do not serialize there. Locally the median TTFB at
game entry was 32 ms with 387 requests queued, so the server is not the
bottleneck; the round trips and bytes are.

## Proposed fixes, ranked

These are proposals only; none is implemented. They are ranked by expected
effect on what players report: slow loading for remote players, and FPS that
comes and goes.

### 1. Cut what a remote player downloads and waits for

This is the largest measured cost: 25 s from character select to playable at
10 Mbps / 100 ms, and every page load is cold for internet players. It has
three parts, each its own PR.

- **a. Load UI window art when a window first opens, not on entering the
  game** (fork, `UI/`). 505 of the about 960 requests at game entry are UI
  textures, mostly for windows that are not open. Moving them to first open
  takes about half the requests out of the burst that queues 466 deep. Based
  on that, I would expect playable at 10/100 to drop from 25 s to roughly
  12–15 s; to be measured with `perf-load.cjs`. The change is per window, in
  the component's `init`/`onAppend`, a small pattern upstream could take. The
  same goes for `worldmap.jpg` (1.3 MB, needed only when the world map opens)
  and fetching `itemInfo.lua` on top of `itemInfo_client.lub`.
- **b. Let the friends gateway pass caching through** (app,
  `electron/sharing/gateway.js`). Forward `If-None-Match` and the ETag, and
  for GRF assets keep `private, max-age=86400, immutable` instead of
  `no-store`. `private` still keeps Cloudflare from caching, and the
  invitation check still runs on every request. With this, a returning
  internet player's page load goes from the cold 7.6 s to about the warm
  2.8 s, and their map revisits stop re-downloading. It is our own code, so
  there is no fork cost. Also give it a keep-alive agent, instead of a new
  upstream connection per request.
- **c. Ship a smaller `Online.js`, and precompress the static files** (fork
  build config, plus the Rust server, which is ours). It is 13.15 MB unminified
  and gzipped at level 1 on every request, to 3.15 MB. Minified and
  precompressed with brotli it is 1.64 MB: 1.5 MB less, which is about 1.2 s
  of startup at 10 Mbps. Gzip or brotli computed once at build time (or cached
  in the server) also saves CPU on every response. Separately, parallelising
  the serial chain before `Online.js` (`api.html` → `api.js` → `Config.js` →
  `Config.local.js`, then the plugins one at a time) saves about 5 round
  trips: 0.5 s at 100 ms RTT.

### 2. Fix frame pacing on monitors over 60 Hz

This is the likeliest cause of FPS drops that come and go. It is about a
one-file change, and it affects every player with a 75/120/144/165 Hz
display. The client's default `fpslimit` is 60, and its limiter can only skip
whole vsyncs. At 75 Hz that makes a quarter of all frames 26.7 ms instead of
13.3 ms, on every map, all the time (measured headed on Steven's 74.97 Hz
display: p95 26.7 ms capped, 13.4 ms with the limit off).

Two possible fixes:

- Default `fpslimit` to off (vsync) in the app's config.
- Better, in the fork's `Renderer._render`: when the limit is not below the
  display's rate, do not throttle at all; and when it is below, pace to a
  whole divisor of the refresh rate instead of alternating.

The second is a general fix upstream would take. On machines that need a cap,
the cap still applies.

### 3. Stop re-initialising post-processing on every map load

This is the 40–90 ms stall on the first frames after every warp, and part of
every map load. `MapRenderer`'s `onMapComplete` calls
`registerPostProcessModules(gl)` on each load. That re-inits all nine
post-process modules, enabled or not: it compiles their shaders and builds
framebuffers, each ending in a synchronous `checkFramebufferStatus` (27–32 ms
blocked on the GPU process in the traces). Init each module once, on the
first map, and keep it across maps. Better still, init a module lazily the
first time it is enabled. FBO size changes already go through `recreateFbo`.

The change is in two upstream files (`MapRenderer.js`, `PostProcess.js`). It
is small, and could go upstream as it stands.

### Next in line

- **Animated models on the CPU:** 20% of main-thread JS during play
  (`AnimatedModels.js` `updateModelBuffer`). Precompute face normals, write
  static nodes once, and upload only the ranges that changed. A GPU path
  (node matrices as uniforms) would be the larger version. On this machine the
  time is hidden by headroom; it matters on slower CPUs, and Byalan is full of
  these models.
- **Occluder fade's occlusion query:** it doubles iz_dun05's draws at 60 fps
  (102 → 203, 323k → 518k vertices) by re-drawing every model each frame
  inside the query. Run the query on a coarse proxy (model bounding boxes)
  or every few frames. It showed no FPS cost on an RTX 3060, so its rank
  depends on how weak the target GPUs are; it is worth measuring on a laptop
  iGPU before ranking it higher.
- **`checkScrollbars`:** 6% of main-thread JS. Its MutationObserver walks
  every descendant with `getComputedStyle` on any style or class change.
  Debounce it to one check per frame, and skip nodes already handled.
- **Per-entity sprite draws:** about 2.5 draw calls for each entity on
  screen. Batching sprites is the lever for crowds, but a big change; do it
  after the above.

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
