#!/usr/bin/env node
// perf-warp -- what a warp costs once the map is loaded: the gap from "map
// ready" to its first frame drawn, and the worst frames in the next 2 s.
//
//   node scripts/perf-warp.cjs [--rounds 3] [--headless] [--out artifacts/perf]
//
// Warps prontera -> iz_dun05 -> pay_fild02, `--rounds` times (the first round
// loads cold, the rest from cache), with the client's limiter off (vsync only)
// so its pacing does not mix in. Needs the rotest world up and a PerfProbe
// client; restarts the daemon itself.
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { withPerf } = require('./perf-probe.cjs');

const repo = path.resolve(__dirname, '..');
const argv = process.argv.slice(2);
const flag = (name, fallback) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : fallback; };
const ROUNDS = Number(flag('--rounds', 3));
const HEADED = !argv.includes('--headless');
const OUT = path.resolve(flag('--out', path.join(repo, 'artifacts/perf')));
const MAPS = [['prontera', 156, 191], ['iz_dun05', 199, 114], ['pay_fild02', 151, 156]];

const env = { ...process.env, ROTEST_PERF: '1', ROTEST_UNCAPPED: '0' };
const node = (...args) => spawnSync(process.execPath, [path.join(repo, 'scripts/rotest.cjs'), ...args], { env, encoding: 'utf8', maxBuffer: 64 << 20 });
const rotest = (...args) => { const r = node(...args); try { return JSON.parse(r.stdout); } catch { return { raw: r.stdout }; } };
const evaluate = js => rotest('eval', js).result;
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function main() {
    rotest('stop');
    for (let i = 0; i < 40 && node('status').status === 0; i++) await sleep(500);
    rotest('start', '--size', '1920x1080', ...(HEADED ? ['--headed'] : []));
    for (let i = 0; i < 120 && !(evaluate(withPerf('perf && perf.marks.login')) > 0); i++) await sleep(500);
    rotest('login');
    rotest('char', '0');
    rotest('gm', '@alive');
    if (!(evaluate('roAgent.modules.Session.Entity._effectState') & 0x40)) rotest('gm', '@hide');
    evaluate('roAgent.modules.GraphicsSettings.fpslimit = 0');
    rotest('gm', '@warp payon 162 233'); // start from none of the measured maps
    const build = evaluate(`(() => { const s = [...document.scripts].map(s => s.src).join(' '); return s; })()`);

    const warps = [];
    for (let round = 0; round < ROUNDS; round++) {
        for (const [map, x, y] of MAPS) {
            evaluate(withPerf('perf.reset()'));
            rotest('gm', `@warp ${map} ${x} ${y}`);
            let mark = null;
            for (let i = 0; i < 120 && !mark; i++) {
                const m = (evaluate(withPerf('perf.marks.maps')) || []).at(-1);
                if (m && m.map.startsWith(map) && m.firstFrameMs) mark = m;
                else await sleep(250);
            }
            await sleep(2000);
            const s = evaluate(withPerf('(() => { const s = perf.stats(); return { max: s.frameMs.max, p99: s.frameMs.p99, slow: perf.slowFrames() }; })()'));
            warps.push({ round, map, loadMs: mark && mark.loadMs, firstFrameGapMs: mark && Math.round((mark.firstFrameMs - mark.loadMs) * 10) / 10,
                worstFrameMs: s.max, slowFrames: s.slow.map(f => f.frameMs) });
            console.error(JSON.stringify(warps.at(-1)));
        }
    }
    fs.mkdirSync(OUT, { recursive: true });
    const file = path.join(OUT, `warp-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
    fs.writeFileSync(file, JSON.stringify({ headed: HEADED, build, warps }, null, 2));
    const median = a => { const s = a.filter(v => v != null).sort((x, y) => x - y); return s[Math.floor((s.length - 1) / 2)]; };
    console.log(JSON.stringify({ file, warps: warps.length, medianLoadMs: median(warps.map(w => w.loadMs)),
        medianFirstFrameGapMs: median(warps.map(w => w.firstFrameGapMs)), medianWorstFrameMs: median(warps.map(w => w.worstFrameMs)),
        slowFramesTotal: warps.reduce((n, w) => n + w.slowFrames.length, 0) }));
}
main().catch(e => { console.error(e.stack || e.message); process.exitCode = 1; });
