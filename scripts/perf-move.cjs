#!/usr/bin/env node
// perf-move -- how movement looks: rubber banding, speed wobble and the delay
// between a click and the character moving, for the player and for monsters,
// with the server local or behind a simulated network.
//
//   node scripts/perf-move.cjs [--rtt 0,100,200] [--scenarios click,retarget,wander,chase]
//                              [--secs 20] [--headed] [--label base] [--out artifacts/perf]
//
// A recorder in the page samples every entity's drawn position once a frame,
// after the frame's render callbacks, and counts:
//   - snaps: a frame where something moved more than 0.3 cells and more than
//     2.5x what its walk speed allows in that frame (fast moves, warps and
//     first sightings excluded);
//   - wobble: walking frames whose speed is off its walk speed by more than
//     25% (p10/p90 of the speed ratio too);
//   - reversals: walking frames that move against the previous frame;
//   - click to motion: REQUEST_MOVE sent to the first frame the player moves;
//   - click to reply: REQUEST_MOVE sent to ZC_NOTIFY_PLAYERMOVE handled.
//
// --rtt 0 talks to the world directly; any other value puts
// scripts/netshape.cjs (100 Mbps) in front of it with that round trip.
// Needs the rotest world up; restarts the daemon itself.
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

const repo = path.resolve(__dirname, '..');
const argv = process.argv.slice(2);
const flag = (name, fallback) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : fallback; };
const RTTS = flag('--rtt', '0,100,200').split(',').map(Number);
const SCENARIOS = flag('--scenarios', 'click,retarget,wander,chase').split(',');
const SECS = Number(flag('--secs', 20));
const HEADED = argv.includes('--headed');
const LABEL = flag('--label', 'run');
const OUT = path.resolve(flag('--out', path.join(repo, 'artifacts/perf')));
const SHAPER_PORT = Number(flag('--shaper-port', 13401));
const MAP = ['pay_fild02', 151, 156];

let env = { ...process.env };
const node = (...args) => spawnSync(process.execPath, [path.join(repo, 'scripts/rotest.cjs'), ...args], { env, encoding: 'utf8', maxBuffer: 64 << 20 });
const rotest = (...args) => { const r = node(...args); try { return JSON.parse(r.stdout); } catch { return { raw: r.stdout, stderr: r.stderr }; } };
const evaluate = js => rotest('eval', js).result;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const log = s => console.error(s);

// The page side. Installed once per page; start() clears the counters.
const RECORDER = `(() => {
  if (window.__mv) return 'already';
  const { Renderer, EntityManager, Session, Network, Entity, PACKET } = roAgent.modules;
  const isMove = p => p instanceof PACKET.CZ.REQUEST_MOVE || (PACKET.CZ.REQUEST_MOVE2 && p instanceof PACKET.CZ.REQUEST_MOVE2);
  const st = { on: false };
  const reset = () => Object.assign(st, { frames: 0, walkFrames: 0, ratios: [], snaps: { player: [], others: [] },
    reversals: { player: 0, others: 0 }, wobble: { player: 0, others: 0 }, walkFramesBy: { player: 0, others: 0 },
    clicks: [], seen: new Map(), lastFrame: 0 });
  reset();
  const origSend = Network.sendPacket.bind(Network);
  Network.sendPacket = function (pkt) {
    try {
      if (st.on && pkt && isMove(pkt)) {
        const me = Session.Entity;
        st.clicks.push({ at: Date.now(), from: [me.position[0], me.position[1]], dest: [pkt.dest[0], pkt.dest[1]], moved: null, reply: null });
      }
    } catch (e) {}
    return origSend.apply(null, arguments);
  };
  const wrapPlayer = () => {
    const me = Session.Entity;
    if (!me || me.__mvWrapped) return;
    const orig = me.walkTo;
    me.walkTo = function () {
      const c = st.clicks.length && st.clicks[st.clicks.length - 1];
      if (st.on && c && c.reply == null) c.reply = Date.now() - c.at;
      return orig.apply(this, arguments);
    };
    me.__mvWrapped = true;
  };
  function sample(tick) {
    if (!st.on) return;
    wrapPlayer();
    const now = Date.now();
    st.frames++;
    const me = Session.Entity;
    const visit = (e) => {
      if (!e || !e.position || !e.walk) return;
      const isMe = e === me;
      if (!isMe && e.objecttype !== Entity.TYPE_MOB && e.objecttype !== Entity.TYPE_PC) return;
      const who = isMe ? 'player' : 'others';
      const x = e.position[0], y = e.position[1];
      const prev = st.seen.get(e.GID);
      st.seen.set(e.GID, { x, y, t: now, dx: prev ? x - prev.x : 0, dy: prev ? y - prev.y : 0 });
      if (!prev || now <= prev.t) return;
      const dt = now - prev.t;
      if (dt > 100) return; // a stalled frame says nothing about movement
      const dx = x - prev.x, dy = y - prev.y, d = Math.hypot(dx, dy);
      if (d > 16 || e.isFastMoving) return;
      const speed = e.walk.speed || 150;
      const expected = dt / speed;
      if (d > 0.3 && d > 2.5 * expected) st.snaps[who].push({ d: Math.round(d * 100) / 100, gid: e.GID, at: now });
      const walking = e.action === e.ACTION.WALK && e.walk.total > 0;
      if (walking && d > 0.0001) {
        st.walkFramesBy[who]++;
        const r = d / expected;
        if (st.ratios.length < 200000) st.ratios.push(r);
        if (r < 0.75 || r > 1.25) st.wobble[who]++;
        if (prev.dx * dx + prev.dy * dy < 0 && Math.hypot(prev.dx, prev.dy) > 0.001) st.reversals[who]++;
      }
      if (isMe) {
        for (const c of st.clicks) if (c.moved == null && d > 0.001 && now >= c.at) c.moved = now - c.at;
      }
    };
    visit(me);
    EntityManager.forEach(visit);
  }
  Renderer.renderCallbacks.push(sample);
  const pct = (a, p) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); return Math.round(s[Math.min(s.length - 1, Math.floor(p * s.length))] * 100) / 100; };
  window.__mv = {
    start() { reset(); st.on = true; return true; },
    stop() { st.on = false; return true; },
    summary() {
      const moved = st.clicks.map(c => c.moved).filter(v => v != null);
      const reply = st.clicks.map(c => c.reply).filter(v => v != null);
      const sn = w => ({ count: st.snaps[w].length, cells: Math.round(st.snaps[w].reduce((s, x) => s + x.d, 0) * 10) / 10, max: st.snaps[w].reduce((m, x) => Math.max(m, x.d), 0) });
      const share = (n, w) => st.walkFramesBy[w] ? Math.round(1000 * n / st.walkFramesBy[w]) / 10 : null;
      return {
        frames: st.frames, ping: Session.ping && Session.ping.value,
        walkFrames: st.walkFramesBy,
        snaps: { player: sn('player'), others: sn('others') },
        wobblePct: { player: share(st.wobble.player, 'player'), others: share(st.wobble.others, 'others') },
        reversals: st.reversals,
        speedRatio: { p10: pct(st.ratios, 0.1), p50: pct(st.ratios, 0.5), p90: pct(st.ratios, 0.9) },
        clicks: st.clicks.length,
        clickToMotionMs: { p50: pct(moved, 0.5), p90: pct(moved, 0.9), n: moved.length },
        clickToReplyMs: { p50: pct(reply, 0.5), p90: pct(reply, 0.9), n: reply.length },
      };
    },
  };
  return 'installed';
})()`;

function project(x, y) { return evaluate(`roAgent.project(${x}, ${y})`); }
function me() { return evaluate('[Math.round(roAgent.modules.Session.Entity.position[0]), Math.round(roAgent.modules.Session.Entity.position[1])]'); }

// Directions to walk in, so every run takes the same steps.
const RING = [[6, 0], [0, 6], [-6, 0], [0, -6], [5, 5], [-5, -5], [5, -5], [-5, 5]];

async function scenario(name) {
    rotest('gm', `@warp ${MAP[0]} ${MAP[1]} ${MAP[2]}`);
    rotest('gm', '@killmonster2');
    await sleep(1000);
    const hidden = () => (evaluate('roAgent.modules.Session.Entity._effectState') & 0x40) !== 0;
    if (name === 'chase' ? hidden() : !hidden()) rotest('gm', '@hide');
    if (name === 'wander' || name === 'chase') rotest('gm', `@monster 1013 ${name === 'chase' ? 12 : 40}`);
    await sleep(1500);
    evaluate('__mv.start()');
    const until = Date.now() + SECS * 1000;
    let i = 0;
    if (name === 'click') {
        // Click, wait for the walk to end, click the next cell.
        while (Date.now() < until) {
            const [x, y] = me(); const [ox, oy] = RING[i++ % RING.length];
            rotest('walk', String(x + ox), String(y + oy));
            await sleep(300);
        }
    } else if (name === 'retarget') {
        // Change destination every 350 ms, mid-walk, as holding the mouse does.
        while (Date.now() < until) {
            const [x, y] = me(); const [ox, oy] = RING[i++ % RING.length];
            const p = project(x + ox, y + oy);
            if (p && p.onScreen) rotest('click', String(p.x), String(p.y));
            await sleep(50);
        }
    } else if (name === 'chase') {
        // Walk back and forth so the pack keeps re-pathing, healing on the way.
        while (Date.now() < until) {
            const [x, y] = me(); const [ox, oy] = RING[i++ % 4];
            rotest('walk', String(x + ox), String(y + oy));
            if (i % 3 === 0) rotest('gm', '@heal');
        }
    } else {
        await sleep(SECS * 1000);
    }
    const s = evaluate('__mv.summary()');
    evaluate('__mv.stop()');
    rotest('gm', '@killmonster2');
    return s;
}

async function main() {
    const results = [];
    for (const rtt of RTTS) {
        let shaper = null;
        if (rtt > 0) {
            shaper = spawn(process.execPath, [path.join(repo, 'scripts/netshape.cjs'), '--listen', String(SHAPER_PORT), '--mbps', '100', '--rtt', String(rtt)], { stdio: 'ignore' });
            await sleep(500);
        }
        env = { ...process.env, ROTEST_PERF: '1', ROTEST_UNCAPPED: '0', ...(rtt > 0 ? { ROTEST_GAME_URL: `http://127.0.0.1:${SHAPER_PORT}/` } : {}) };
        try {
            rotest('stop');
            for (let i = 0; i < 40 && node('status').status === 0; i++) await sleep(500);
            rotest('start', '--size', '1920x1080', ...(HEADED ? ['--headed'] : []));
            for (let i = 0; i < 240 && !(evaluate('window.roAgent && 1') > 0); i++) await sleep(500);
            rotest('login');
            rotest('char', '0');
            rotest('gm', '@alive');
            rotest('gm', '@blvl 98');
            rotest('gm', '@allstats 99');
            evaluate('roAgent.modules.GraphicsSettings.fpslimit = 0');
            log(`rtt ${rtt}: ${evaluate(RECORDER)}`);
            // Let a pong put the ping and the server clock in place.
            await sleep(rtt > 0 ? 12000 : 3000);
            for (const name of SCENARIOS) {
                const s = await scenario(name);
                results.push({ rtt, scenario: name, ...s });
                log(JSON.stringify(results.at(-1)));
            }
        } finally {
            if (shaper) shaper.kill();
        }
    }
    rotest('stop');
    fs.mkdirSync(OUT, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const file = path.join(OUT, `move-${LABEL}-${stamp}.json`);
    fs.writeFileSync(file, JSON.stringify({ label: LABEL, headed: HEADED, results }, null, 2));
    const rows = ['| rtt | scenario | player snaps (cells) | other snaps (cells) | wobble % player / others | reversals p/o | click→move p50/p90 ms | click→reply p50 ms |', '|---|---|---|---|---|---|---|---|'];
    for (const r of results) {
        rows.push(`| ${r.rtt} | ${r.scenario} | ${r.snaps.player.count} (${r.snaps.player.cells}) | ${r.snaps.others.count} (${r.snaps.others.cells}) | ${r.wobblePct.player} / ${r.wobblePct.others} | ${r.reversals.player} / ${r.reversals.others} | ${r.clickToMotionMs.p50} / ${r.clickToMotionMs.p90} | ${r.clickToReplyMs.p50} |`);
    }
    fs.writeFileSync(file.replace(/\.json$/, '.md'), rows.join('\n') + '\n');
    console.log(rows.join('\n'));
    console.log(file);
}
main().catch(e => { console.error(e.stack || e.message); process.exitCode = 1; });
