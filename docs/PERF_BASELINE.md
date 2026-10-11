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
5. **Uncapped dungeon windows show occasional 50–180 ms hitches**: up to 11 in
   10 s on iz_dun02 and iz_dun05, even with no entities near. They do not
   appear capped, throttled, or on the field. GC or compositor stalls at
   1500 fps are the likely cause. Check this before treating it as a real
   player stutter.

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
