#!/usr/bin/env node
// perf-load -- how the browser client loads over a remote-looking connection.
//
// For each network profile, in a fresh browser profile (nothing cached), it
// loads the game through scripts/netshape.cjs and measures:
//   startup        page load to the login window
//   login          login to character select
//   playable       character select to in game (Prontera, where the last run logged out)
//   map <name>     a warp to a map not visited yet in this profile
//   reload         the page reloaded, so the HTTP and file caches are warm
// and, for each phase, every request: count, bytes, encoding, caching
// headers, 304s, and how many were in flight at once.
//
//   node scripts/perf-load.cjs [--profiles local,50/40,10/100] [--out artifacts/perf]
//
// A profile is <Mbps down>/<RTT ms>; `local` is the asset server direct. Needs
// `scripts/rotest world up` and a client build with PerfProbe.
//
// NETSHAPE_HEADER='X-Compact-Images: 1' and NETSHAPE_H2=1 pass --request-header
// and --h2 to netshape, to load the way an invite-link friend does. Chromium
// keeps nothing in its HTTP cache from a certificate it was told to ignore, so
// under NETSHAPE_H2 the reload phase has only roBrowser's own file cache.
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

const repo = path.resolve(__dirname, '..');
const argv = process.argv.slice(2);
const flag = (name, fallback) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : fallback; };
const PROFILES = flag('--profiles', 'local,50/40,10/100').split(',');
const OUT = path.resolve(flag('--out', path.join(repo, 'artifacts/perf')));
const SHAPER_PORT = 13400;
const MAPS = [['iz_dun05', 199, 114], ['pay_fild02', 151, 156]];

const sleep = ms => new Promise(r => setTimeout(r, ms));
const log = (...a) => console.error(new Date().toISOString().slice(11, 19), ...a);
let env = process.env;
const raw = {};
function rotest(...args) {
    const r = spawnSync(process.execPath, [path.join(repo, 'scripts/rotest.cjs'), ...args], { env, encoding: 'utf8', maxBuffer: 256 << 20 });
    try { return JSON.parse(r.stdout); } catch { return { raw: r.stdout, stderr: r.stderr, status: r.status }; }
}
const evaluate = js => rotest('eval', js).result;
const timed = (...args) => { const t = Date.now(); const out = rotest(...args); return { ms: Date.now() - t, out }; };

async function waitFor(test, ms) {
    const end = Date.now() + ms;
    while (Date.now() < end) { const v = test(); if (v) return v; await sleep(250); }
    return null;
}

// Requests in [from, to) (epoch ms), summarised.
function summarize(entries) {
    const reqs = entries.filter(e => !/^(data|blob|chrome-extension):/.test(e.url)).map(e => {
        const end = e.end >= 0 ? e.end : e.ttfb >= 0 ? e.ttfb : 0;
        return { ...e, path: new URL(e.url).pathname, t0: e.start, t1: e.start + end };
    });
    if (!reqs.length) return { requests: 0 };
    const kind = p => /^\/(data|Data)\//.test(p) ? 'data' : /\.mp3$/i.test(p) ? 'bgm' : /^\/(System|SystemEN)\//.test(p) ? 'system'
        : /\.(js|mjs|html|css|json|webmanifest)$/.test(p) || p === '/' ? 'static' : 'other';
    const byKind = {}, byExt = {}, byDir = {};
    const dir = p => { const d = decodeURIComponent(p).split('/').slice(1, -1); return '/' + d.slice(0, 3).join('/'); };
    for (const r of reqs) {
        for (const [table, key] of [[byKind, kind(r.path)], [byExt, (r.path.match(/\.([a-z0-9]+)$/i) || [, '-'])[1].toLowerCase()], [byDir, dir(r.path)]]) {
            const k = table[key] ||= { requests: 0, bytes: 0 };
            k.requests++; k.bytes += r.bodyBytes;
        }
    }
    const top = t => Object.fromEntries(Object.entries(t).sort((a, b) => b[1].requests - a[1].requests).slice(0, 12));
    // In-flight count over time: a sweep over starts and ends.
    const edges = reqs.flatMap(r => [[r.t0, 1], [r.t1, -1]]).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    let inflight = 0, max = 0, last = edges[0][0], busy = 0, one = 0, area = 0;
    for (const [t, d] of edges) {
        const dt = t - last;
        if (inflight > 0) { busy += dt; area += inflight * dt; if (inflight === 1) one += dt; }
        inflight += d; max = Math.max(max, inflight); last = t;
    }
    const span = Math.max(...reqs.map(r => r.t1)) - Math.min(...reqs.map(r => r.t0));
    const ttfb = reqs.filter(r => r.ttfb >= 0).map(r => r.ttfb).sort((a, b) => a - b);
    return {
        requests: reqs.length, bytes: reqs.reduce((s, r) => s + r.bodyBytes, 0), byKind, byExt: top(byExt), byDir: top(byDir),
        notModified: reqs.filter(r => r.status === 304).length, failed: reqs.filter(r => r.failed || r.status >= 400).length,
        compressed: reqs.filter(r => r.encoding).length, ranged: reqs.filter(r => r.range || r.status === 206).length,
        cacheControl: [...new Set(reqs.map(r => r.cache))], withEtag: reqs.filter(r => r.etag).length,
        spanMs: Math.round(span), busyMs: Math.round(busy), idleMs: Math.round(span - busy),
        maxInFlight: max, meanInFlight: busy ? Math.round((area / busy) * 10) / 10 : 0, oneInFlightShare: busy ? Math.round((one / busy) * 100) : 0,
        ttfbMedianMs: ttfb.length ? Math.round(ttfb[Math.floor(ttfb.length / 2)]) : null,
        largest: reqs.sort((a, b) => b.bodyBytes - a.bodyBytes).slice(0, 6).map(r => `${r.path} ${Math.round(r.bodyBytes / 1024)} KB`),
    };
}

// NETSHAPE_H2=1: the shaped link is HTTPS with HTTP/2, as Cloudflare serves invite-link friends.
const H2 = process.env.NETSHAPE_H2 === '1';

async function run(profile) {
    const local = profile === 'local';
    const [mbps, rtt] = local ? [] : profile.split('/').map(Number);
    let shaper = null;
    if (!local) {
        shaper = spawn(process.execPath, [path.join(repo, 'scripts/netshape.cjs'), '--listen', String(SHAPER_PORT), '--mbps', String(mbps), '--rtt', String(rtt), ...(process.env.NETSHAPE_HEADER ? ['--request-header', process.env.NETSHAPE_HEADER] : []), ...(H2 ? ['--h2'] : [])], { stdio: 'ignore' });
        await sleep(500);
    }
    env = { ...process.env, ROTEST_PERF: '1', ROTEST_NETLOG: '1', ...(local ? {} : { ROTEST_GAME_URL: `${H2 ? 'https' : 'http'}://127.0.0.1:${SHAPER_PORT}/` }) };
    rotest('stop');
    await waitFor(() => spawnSync(process.execPath, [path.join(repo, 'scripts/rotest.cjs'), 'status'], { env }).status !== 0, 20000);
    const result = { profile, phases: {} };
    const phase = (name, extra) => {
        const entries = rotest('netlog', 'reset').entries || [];
        result.phases[name] = { ...extra, net: summarize(entries) };
        raw[`${profile} ${name}`] = entries.map(e => ({ path: decodeURIComponent(new URL(e.url).pathname), status: e.status, bytes: e.bodyBytes, start: e.start, ttfb: e.ttfb, end: e.end, encoding: e.encoding }));
        log(`${profile} ${name}: ${JSON.stringify(extra)} ${result.phases[name].net.requests} requests, ${Math.round((result.phases[name].net.bytes || 0) / 1048576 * 10) / 10} MB`);
    };
    try {
        rotest('start', '--size', '1920x1080');
        const login = await waitFor(() => { const v = evaluate('window.roPerf ? window.roPerf.marks.login : null'); return v > 0 ? v : null; }, 300000);
        phase('startup', { loginWindowMs: login });
        let t = timed('login');
        phase('login', { ms: t.ms, ok: t.out.ok !== false && !t.out.error });
        t = timed('char', '0');
        // `char` gives up after a minute; a slow link can take longer than that.
        const first = await waitFor(() => { const v = (evaluate('roPerf.marks.maps') || []).at(-1); return v && v.firstFrameMs ? v : null; }, 300000);
        t.ms = Math.max(t.ms, first ? Math.round(first.firstFrameMs) : 0);
        phase('playable', { ms: t.ms, ok: Boolean(t.out.ok), map: first && first.map, mapFirstFrameMs: first && first.firstFrameMs });
        for (const [map, x, y] of MAPS) {
            if (first && first.map.startsWith(map)) continue;
            t = timed('gm', `@warp ${map} ${x} ${y}`);
            const m = await waitFor(() => { const v = (evaluate('roPerf.marks.maps') || []).at(-1); return v && v.map.startsWith(map) && v.firstFrameMs ? v : null; }, 120000);
            phase(`map ${map}`, { ms: t.ms, firstFrameMs: m && m.firstFrameMs });
        }
        // Reload: the HTTP cache and roBrowser's own file cache are warm now.
        evaluate('setTimeout(() => location.reload(), 50)');
        await sleep(1000);
        const warm = await waitFor(() => { const v = evaluate('window.roPerf ? window.roPerf.marks.login : null'); return v > 0 ? v : null; }, 300000);
        phase('reload', { loginWindowMs: warm });
        // The next profile's first map: log out in Prontera, a busy town.
        rotest('login'); rotest('char', '0'); rotest('gm', '@warp prontera 156 191');
    } finally {
        if (shaper) shaper.kill();
    }
    return result;
}

async function main() {
    fs.mkdirSync(OUT, { recursive: true });
    const results = [];
    for (const p of PROFILES) results.push(await run(p));
    const file = path.join(OUT, `load-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
    fs.writeFileSync(file, JSON.stringify(results, null, 2));
    fs.writeFileSync(file.replace(/\.json$/, '.requests.json'), JSON.stringify(raw));
    console.log(file);
}
main().catch(e => { console.error(e.stack || e.message); process.exitCode = 1; });
