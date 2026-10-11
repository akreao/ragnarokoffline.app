#!/usr/bin/env node
// perf-trace -- a Chrome performance trace over a scripted stretch of play, for
// finding what a slow frame is.
//
// Plays, in a throwaway rotest world (never the player's save): warp into
// iz_dun05, walk it, spawn monsters, open and close windows, warp to
// pay_fild02, spawn a wolf pack, walk, cast skills with effects into it, and
// warp back. Every step is a performance.mark ('step:<name>') in the trace,
// and every frame over 33 ms is a 'roPerf slow frame' measure, from the
// client's opt-in PerfProbe. scripts/perf-trace-analyze.py reads the result.
//
//   node scripts/perf-trace.cjs [--headed] [--capped] [--short] [--out artifacts/perf/trace-<stamp>.json]
//
// --short stops after walking iz_dun05: uncapped, Chrome's trace buffer fills
// within a minute and the rest would not be recorded.
//
// It restarts the rotest daemon with the probe on (and, unless --capped, no
// vsync or frame cap), so `rotest world up` must be done.
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const repo = path.resolve(__dirname, '..');
const argv = process.argv.slice(2);
const flag = (name, fallback) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : fallback; };
const HEADED = argv.includes('--headed');
const CAPPED = argv.includes('--capped');
const SHORT = argv.includes('--short');
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const OUT = path.resolve(flag('--out', path.join(repo, 'artifacts/perf', `trace-${HEADED ? 'headed' : 'headless'}-${CAPPED ? 'capped' : 'uncapped'}-${stamp}.json`)));

const env = { ...process.env, ROTEST_PERF: '1', ROTEST_UNCAPPED: CAPPED ? '0' : '1' };
const node = (...args) => spawnSync(process.execPath, [path.join(repo, 'scripts/rotest.cjs'), ...args], { env, encoding: 'utf8', maxBuffer: 64 << 20 });
function rotest(...args) {
    const r = node(...args);
    let out;
    try { out = JSON.parse(r.stdout); } catch { out = { raw: r.stdout, stderr: r.stderr }; }
    return out;
}
const evaluate = js => rotest('eval', js).result;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const log = (...a) => console.error(new Date().toISOString().slice(11, 19), ...a);

const steps = [];
function step(name) {
    const t = evaluate(`(performance.mark('step:${name}'), performance.now())`);
    steps.push({ name, t });
    log('step', name);
}

// Walk a loop of cells around (x, y); a cell the client cannot reach is skipped.
function walkAround(x, y, r) {
    for (const [dx, dy] of [[r, 0], [r, r], [0, r], [-r, r], [-r, 0], [-r, -r], [0, -r], [r, -r], [0, 0]]) {
        rotest('walk', String(x + dx), String(y + dy));
    }
}

async function main() {
    rotest('stop');
    for (let i = 0; i < 30 && node('status').status === 0; i++) await sleep(500);
    rotest('start', '--size', '1920x1080', ...(HEADED ? ['--headed'] : []));
    for (let i = 0; i < 120 && !(evaluate('window.roPerf && window.roPerf.marks.login') > 0); i++) await sleep(500);
    rotest('login');
    rotest('char', '0');
    for (const cmd of ['@alive', '@baselvl 99', '@joblvl 50', '@allskill', '@heal']) rotest('gm', cmd);
    if (!(evaluate('roAgent.modules.Session.Entity._effectState') & 0x40)) rotest('gm', '@hide');
    rotest('gm', '@warp prontera 150 180');
    evaluate(`(roAgent.modules.GraphicsSettings.fpslimit = ${CAPPED ? 60 : 0}, roAgent.modules.GraphicsSettings.occluderFade = 'off')`);
    await sleep(2000);

    evaluate('roPerf.reset()');
    rotest('trace', 'start');
    await sleep(500);

    step('warp iz_dun05');
    rotest('gm', '@warp iz_dun05 199 114');
    rotest('camera', 'zoom', '125', 'pitch', '230', 'yaw', '0');
    step('idle iz_dun05');
    await sleep(3000);
    step('walk iz_dun05');
    walkAround(199, 114, 6);
    if (!SHORT) await rest();
    step('end');
    await finish();
}

async function rest() {
    step('spawn monsters iz_dun05');
    for (const mob of ['1264 8', '1065 8', '1068 6']) rotest('gm', `@monster ${mob}`);
    await sleep(4000);
    step('windows');
    for (const key of ['Alt+E', 'Alt+S', 'Alt+A', 'Alt+Q', 'Alt+E', 'Alt+S', 'Alt+A', 'Alt+Q']) rotest('key', key);
    step('killmonster iz_dun05');
    rotest('gm', '@killmonster');
    await sleep(2000);

    step('warp pay_fild02');
    rotest('gm', '@warp pay_fild02 151 156');
    step('spawn wolves');
    rotest('gm', '@monster 1013 60');
    await sleep(3000);
    step('walk pay_fild02');
    walkAround(151, 156, 8);
    step('skills');
    rotest('gm', '@hide'); // visible, so the skills land
    for (const [id, lv] of [[19, 10], [14, 10], [20, 10], [17, 10], [13, 10], [11, 10]]) {
        rotest('skill', String(id), String(lv), '--target', 'nearest', '--quick');
        await sleep(1500);
    }
    rotest('skill', '21', '10', '--cell', '155', '156', '--quick'); // Thunderstorm
    await sleep(3000);
    rotest('gm', '@heal');
    rotest('gm', '@hide');
    step('killmonster pay_fild02');
    rotest('gm', '@killmonster');
    await sleep(2000);
    step('warp iz_dun05 warm');
    rotest('gm', '@warp iz_dun05 199 114');
    await sleep(3000);
}

async function finish() {
    const traced = rotest('trace', 'stop', OUT);
    const slow = evaluate('roPerf.slowFrames()');
    const stats = evaluate('(() => { const s = roPerf.stats(); delete s.marks; return s; })()');
    const meta = { headed: HEADED, capped: CAPPED, short: SHORT, trace: traced.file, bytes: traced.bytes, dataLoss: traced.dataLossOccurred, steps, slow, stats };
    fs.writeFileSync(OUT.replace(/\.json$/, '.meta.json'), JSON.stringify(meta, null, 2));
    log(`trace ${traced.file} (${Math.round((traced.bytes || 0) / 1048576)} MB${traced.dataLossOccurred ? ', BUFFER FILLED: later events lost' : ''}), ${slow.length} slow frames`);
    console.log(OUT);
}

main().catch(e => { console.error(e.stack || e.message); process.exitCode = 1; });
