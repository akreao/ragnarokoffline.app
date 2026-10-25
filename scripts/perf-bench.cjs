#!/usr/bin/env node
// perf-bench -- the client performance baseline, through scripts/rotest.
//
// Measures, in a throwaway rotest world (never the player's save):
//   - cold startup: page load to the login window, in a fresh browser profile
//   - map load: setMap to the first frame, cold (first visit) and warm (revisit)
//   - frame time (avg/p50/p95/p99/max), CPU work per frame and draw calls per
//     frame on fixed scenes, with the occluder fade off, dither and alpha.
//
// It needs the client's opt-in probe (src/Core/PerfProbe.js in the
// roBrowserLegacy fork, read through scripts/perf-probe.cjs) in the world's
// client build, and a world that is up
// (`scripts/rotest world up`). It restarts the rotest daemon itself, with the
// probe on and, unless --capped, no vsync or frame cap, so a frame's time is
// what it costs rather than the 60 Hz tick.
//
//   node scripts/perf-bench.cjs [--secs 10] [--cold 3] [--capped] [--size 1920x1080]
//                               [--scenes iz_dun00,pay_fild02] [--out artifacts/perf]
//                               [--cpu-throttle 4] [--headed] [--fps N]
//
// --fps sets the client's own limiter (Graphics fpslimit; 0 is none, vsync
// only). It defaults to 60 with --capped and 0 without.
//
// Prints a Markdown summary and writes the raw numbers as JSON beside it.
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { PERF, withPerf } = require('./perf-probe.cjs');

const repo = path.resolve(__dirname, '..');
const argv = process.argv.slice(2);
const flag = (name, fallback) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : fallback; };
const SECS = Number(flag('--secs', 10));
const COLD = Number(flag('--cold', 3));
const CAPPED = argv.includes('--capped');
const SIZE = flag('--size', '1920x1080');
const OUT = path.resolve(flag('--out', path.join(repo, 'artifacts/perf')));
const THROTTLE = Number(flag('--cpu-throttle', 1));
const HEADED = argv.includes('--headed');
const FPS = Number(flag('--fps', CAPPED ? 60 : 0));
const FADES = ['off', 'dither', 'alpha'];

// Fixed cells, each one a warp has landed on, so a rerun sees the same view.
// pay_fild02 is the pre-renewal wolf field; renewal has none there, so the
// pack is spawned, the same size every run.
const SCENES = [
    { name: 'iz_dun00', map: 'iz_dun00', x: 45, y: 218 },
    { name: 'iz_dun01', map: 'iz_dun01', x: 185, y: 62 },
    { name: 'iz_dun02', map: 'iz_dun02', x: 185, y: 211 },
    { name: 'iz_dun03', map: 'iz_dun03', x: 59, y: 51 },
    { name: 'iz_dun04', map: 'iz_dun04', x: 153, y: 220 },
    { name: 'iz_dun05', map: 'iz_dun05', x: 199, y: 114 },
    { name: 'pay_fild02+60 wolves', map: 'pay_fild02', x: 151, y: 156, setup: ['@monster 1013 60'] },
    { name: 'pay_fild02+200 wolves', map: 'pay_fild02', x: 151, y: 156, setup: ['@monster 1013 200'] },
].filter(s => !flag('--scenes') || flag('--scenes').split(',').includes(s.map));

const env = { ...process.env, ROTEST_PERF: '1', ROTEST_UNCAPPED: CAPPED ? '0' : '1', ROTEST_CPU_THROTTLE: String(THROTTLE) };
function rotest(...args) {
    const r = spawnSync(process.execPath, [path.join(repo, 'scripts/rotest.cjs'), ...args], { env, encoding: 'utf8', maxBuffer: 64 << 20 });
    let out;
    try { out = JSON.parse(r.stdout); } catch { out = { raw: r.stdout, stderr: r.stderr }; }
    if (r.status !== 0 && !out.ok && out.result === undefined) throw new Error(`rotest ${args.join(' ')}: ${r.stdout}${r.stderr}`);
    return out;
}
const evaluate = js => {
    const out = rotest('eval', js);
    if (out.error) throw new Error(out.error);
    return out.result;
};
const sleep = ms => new Promise(r => setTimeout(r, ms));
const log = (...a) => console.error(new Date().toISOString().slice(11, 19), ...a);

async function restart() {
    rotest('stop');
    // `stop` answers before the daemon has gone, and `start` against a daemon
    // still answering takes it for running.
    for (let i = 0; i < 30 && spawnSync(process.execPath, [path.join(repo, 'scripts/rotest.cjs'), 'status'], { env }).status === 0; i++) await sleep(500);
    rotest('start', '--size', SIZE, ...(HEADED ? ['--headed'] : []));
    let probe = false;
    for (let i = 0; i < 120; i++) {
        try {
            const login = evaluate(withPerf('perf ? perf.marks.login : -1'));
            probe ||= login !== -1;
            if (login !== -1 && login !== null) return login;
        } catch { /* the page is still loading */ }
        await sleep(500);
    }
    throw new Error(probe ? 'the login window never appeared'
        : 'the perf probe never started: the world\'s client has no PerfProbe, or ROTEST_PERF did not reach it');
}

// One measured window, entirely in the page so the CLI round trips do not
// land in it.
const measure = (fade, secs) => evaluate(`(async () => {
    const perf = ${PERF};
    const g = roAgent.modules.GraphicsSettings;
    g.occluderFade = ${JSON.stringify(fade)};
    g.fpslimit = ${FPS};
    await new Promise(r => setTimeout(r, 1500));
    perf.reset();
    await new Promise(r => setTimeout(r, ${secs * 1000}));
    const s = perf.stats();
    delete s.marks;
    s.entitiesNear = roAgent.entities({ radius: 20 }).length;
    // The probe's own count includes frames past its 1000-entry log
    s.slowFrameCount = typeof s.slowFrames === 'number' ? s.slowFrames : null;
    s.slowFrames = perf.slowFrames();
    return s;
})()`);

// The newest map mark, once it is the expected map and its first frame is drawn.
async function lastMap(map) {
    for (let i = 0; i < 60; i++) {
        const m = (evaluate(withPerf('perf ? perf.marks.maps : []')) || []).at(-1);
        if (m && (!map || m.map.replace(/\.gat$/, '') === map) && m.firstFrameMs !== null) return m;
        await sleep(250);
    }
    return null;
}
const median = a => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.floor((s.length - 1) / 2)] : null; };

async function main() {
    fs.mkdirSync(OUT, { recursive: true });
    const result = { at: new Date().toISOString(), secs: SECS, capped: CAPPED, headed: HEADED, fpslimit: FPS, size: SIZE, cpuThrottle: THROTTLE, startup: [], scenes: [] };

    // Cold startup: every `start` is a fresh browser profile, so nothing is
    // cached, neither HTTP nor roBrowser's own file cache.
    for (let i = 0; i < COLD; i++) {
        const login = await restart();
        log(`cold start ${i + 1}/${COLD}: login window at ${login} ms`);
        result.startup.push(login);
    }
    result.gpu = evaluate(`(() => { const gl = document.createElement('canvas').getContext('webgl2');
        const e = gl.getExtension('WEBGL_debug_renderer_info'); return e ? gl.getParameter(e.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER); })()`);

    let t = Date.now();
    rotest('login');
    result.loginToCharSelectMs = Date.now() - t;
    t = Date.now();
    rotest('char', '0');
    result.charSelectToPlayableMs = Date.now() - t;
    result.firstMap = await lastMap();
    // Monsters ignore a hidden GM, so a pack stays a crowd, not a fight, and a
    // level 1 tester survives Byalan. @hide toggles and survives a relog, so
    // look first (0x40 is OPTION_INVISIBLE).
    rotest('gm', '@alive');
    if (!(evaluate('roAgent.modules.Session.Entity._effectState') & 0x40)) rotest('gm', '@hide');

    const visited = new Set();
    for (const scene of SCENES) {
        rotest('gm', `@warp ${scene.map} ${scene.x} ${scene.y}`);
        // Only a map's first visit in this profile is a cold load.
        const cold = visited.has(scene.map) ? null : await lastMap(scene.map);
        visited.add(scene.map);
        for (const cmd of scene.setup || []) rotest('gm', cmd);
        rotest('camera', 'zoom', '125', 'pitch', '230', 'yaw', '0');
        await sleep(2000);
        const runs = {};
        for (const fade of FADES) {
            runs[fade] = measure(fade, SECS);
            log(`${scene.name} fade=${fade}: ${runs[fade].fps} fps, p99 ${runs[fade].frameMs.p99} ms, ${runs[fade].drawCalls.avg} draws`);
        }
        rotest('shot', `perf-${scene.map}`);
        result.scenes.push({ ...scene, coldLoad: cold, runs });
        if (scene.setup) rotest('gm', '@killmonster');
    }

    // Warm map loads: revisit each map with its files in the client's cache.
    for (const scene of result.scenes.filter((s, i, all) => all.findIndex(o => o.map === s.map) === i)) {
        rotest('gm', '@warp prontera 150 180');
        rotest('gm', `@warp ${scene.map} ${scene.x} ${scene.y}`);
        scene.warmLoad = await lastMap(scene.map);
    }
    evaluate(`roAgent.modules.GraphicsSettings.occluderFade = 'off'`);

    // The report.
    const stamp = result.at.replace(/[:.]/g, '-');
    const file = path.join(OUT, `perf-${stamp}.json`);
    fs.writeFileSync(file, JSON.stringify(result, null, 2));
    const lines = [];
    lines.push(`GPU: ${result.gpu}; ${SIZE}; ${HEADED ? 'headed; ' : ''}${CAPPED ? 'vsync on' : 'no vsync'}, client fpslimit ${FPS || 'off'}${THROTTLE > 1 ? `; CPU throttled ${THROTTLE}x` : ''}; ${SECS} s per window`);
    lines.push('');
    lines.push(`Cold startup to login window: median ${median(result.startup)} ms (${result.startup.join(', ')})`);
    lines.push(`Login to character select: ${result.loginToCharSelectMs} ms; character select to playable: ${result.charSelectToPlayableMs} ms (first map ${result.firstMap?.map} ${result.firstMap?.firstFrameMs} ms)`);
    lines.push('');
    lines.push('| Scene | Fade | FPS | Frame avg | p95 | p99 | max | Work avg | Work p99 | Draws/frame | Hitches >50ms | Entities |');
    lines.push('|---|---|---|---|---|---|---|---|---|---|---|---|');
    for (const s of result.scenes) for (const fade of FADES) {
        const r = s.runs[fade];
        lines.push(`| ${s.name} | ${fade} | ${r.fps} | ${r.frameMs.avg} | ${r.frameMs.p95} | ${r.frameMs.p99} | ${r.frameMs.max} | ${r.workMs.avg} | ${r.workMs.p99} | ${r.drawCalls.avg} | ${r.hitches} | ${r.entitiesNear} |`);
    }
    lines.push('');
    lines.push('| Map | Cold load (ms, to first frame) | Warm load (ms, to first frame) |');
    lines.push('|---|---|---|');
    for (const s of result.scenes.filter(s => s.coldLoad)) lines.push(`| ${s.map} | ${s.coldLoad?.firstFrameMs} | ${s.warmLoad?.firstFrameMs} |`);
    lines.push('');
    lines.push(`Raw: ${path.relative(repo, file)}`);
    fs.writeFileSync(file.replace(/\.json$/, '.md'), lines.join('\n') + '\n');
    console.log(lines.join('\n'));
}

main().catch(e => { console.error(e.message); process.exitCode = 1; });
