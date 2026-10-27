'use strict';
// Discord Rich Presence: the IPC framing, what the status says, the
// connection's behaviour against a fake Discord, and the game page's reporter.
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const { socketPaths, encode, decode, buildActivity, createPresence, MIN_GAP_MS } = require('../electron/discord-presence');

test('frames round-trip, and a partial frame waits for the rest', () => {
  const a = encode(1, { cmd: 'SET_ACTIVITY', n: 1 });
  const b = encode(3, { ping: true });
  const both = Buffer.concat([a, b]);
  const first = decode(both.subarray(0, a.length + 5));
  assert.deepEqual(first.frames, [{ op: 1, data: { cmd: 'SET_ACTIVITY', n: 1 } }]);
  assert.equal(first.rest.length, 5);
  const second = decode(Buffer.concat([first.rest, both.subarray(a.length + 5)]));
  assert.deepEqual(second.frames, [{ op: 3, data: { ping: true } }]);
  assert.equal(second.rest.length, 0);
});

test('Linux looks in XDG_RUNTIME_DIR, then the Flatpak and Snap folders', () => {
  const paths = socketPaths({ platform: 'linux', env: { XDG_RUNTIME_DIR: '/run/user/1000' } });
  assert.equal(paths[0], '/run/user/1000/discord-ipc-0');
  assert.ok(paths.includes('/run/user/1000/app/com.discordapp.Discord/discord-ipc-0'));
  assert.ok(paths.includes('/run/user/1000/snap.discord/discord-ipc-0'));
  assert.ok(paths.includes('/tmp/discord-ipc-9'));
  assert.equal(new Set(paths).size, paths.length);
  assert.equal(socketPaths({ platform: 'win32', env: {} })[0], '\\\\?\\pipe\\discord-ipc-0');
});

const STATE = { map: 'prontera', mapName: 'Prontera', name: 'Steve', job: 4013, baseLevel: 99, jobLevel: 50, partySize: 3 };
const jobName = id => ({ 4013: 'Assassin Cross' })[id] || '';

test('the status shows job and level, and only what the player allowed', () => {
  const all = buildActivity(STATE, { name: true, map: true, party: true }, { jobName, startedAt: 1000, joined: false });
  assert.equal(all.details, 'Steve · Lv 99/50 Assassin Cross');
  assert.equal(all.state, 'Prontera · In a party');
  assert.deepEqual(all.party, { size: [3, 12] });
  assert.deepEqual(all.timestamps, { start: 1000 });
  assert.equal(all.assets.large_image, 'logo');

  const none = buildActivity(STATE, { name: false, map: false, party: false }, { jobName });
  assert.equal(none.details, 'Lv 99/50 Assassin Cross');
  assert.equal(none.state, undefined);
  assert.equal(none.party, undefined);
  assert.ok(!JSON.stringify(none).includes('Steve'));
  assert.ok(!JSON.stringify(none).includes('rontera'));

  assert.equal(buildActivity(null, {}, { joined: true }).details, 'Choosing a character');
  assert.match(buildActivity(null, {}, { joined: true }).assets.large_text, /friend/);
});

test('a map name that is not plain text falls back to the map id', () => {
  const a = buildActivity({ ...STATE, mapName: 'ÇÁ·ÐÅ×¶ó' }, { map: true }, { jobName });
  assert.equal(a.state, 'prontera');
  // Discord refuses fields over 128 characters.
  const long = buildActivity({ ...STATE, name: 'x'.repeat(24), job: 4013 }, { name: true }, { jobName: () => 'y'.repeat(200) });
  assert.ok(long.details.length <= 128);
});

function fakeDiscord() {
  const sockets = [];
  const connect = p => {
    const s = new EventEmitter();
    s.path = p;
    s.written = [];
    s.write = buf => { s.written.push(...decode(buf).frames); return true; };
    s.destroy = () => {};
    s.end = () => {};
    sockets.push(s);
    process.nextTick(() => (p === 'good' ? s.emit('connect') : s.emit('error', new Error('ENOENT'))));
    return s;
  };
  return { sockets, connect };
}
const tick = () => new Promise(r => setImmediate(r));

test('handshakes, waits for READY, then sets the activity; repeats are not sent', async () => {
  const d = fakeDiscord();
  let clock = 100000;
  const timers = [];
  const p = createPresence({ clientId: '123456789012345678', connect: d.connect, paths: ['missing', 'good'], now: () => clock,
    timers: { setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length; }, clearTimeout() {} } });
  p.set({ details: 'one' });
  await tick(); await tick();
  const s = d.sockets.find(x => x.path === 'good');
  assert.deepEqual(s.written[0], { op: 0, data: { v: 1, client_id: '123456789012345678' } });
  assert.equal(s.written.length, 1, 'nothing before READY');
  s.emit('data', encode(1, { cmd: 'DISPATCH', evt: 'READY', data: {} }));
  assert.equal(s.written[1].data.cmd, 'SET_ACTIVITY');
  assert.deepEqual(s.written[1].data.args.activity, { details: 'one' });
  p.set({ details: 'one' });
  assert.equal(s.written.length, 2);
  // Pings are answered.
  s.emit('data', encode(3, { x: 1 }));
  assert.deepEqual(s.written[2], { op: 4, data: { x: 1 } });
  // A change right away waits out Discord's rate limit, then goes.
  p.set({ details: 'two' });
  assert.equal(s.written.length, 3);
  const wait = timers.at(-1);
  assert.ok(wait.ms > 0 && wait.ms <= MIN_GAP_MS);
  clock += MIN_GAP_MS;
  wait.fn();
  assert.deepEqual(s.written[3].data.args.activity, { details: 'two' });
  assert.equal(p.status().connected, true);
  p.stop();
  assert.equal(s.written[4].data.args.activity, undefined, 'stop clears the status');
});

test('no application id means no connection at all', async () => {
  const d = fakeDiscord();
  const p = createPresence({ clientId: '', connect: d.connect, paths: ['good'] });
  p.set({ details: 'x' });
  await tick();
  assert.equal(d.sockets.length, 0);
});

test('the game page reports changes only, and stops when the app says no', async () => {
  const { startPresence } = await import('../patches/client/DiscordPresence.mjs');
  const calls = [];
  let state = { map: 'prontera', baseLevel: 1 };
  let poll;
  const p = startPresence({ invoke: (name, args) => { calls.push([name, args]); return Promise.resolve(true); }, read: () => state, every: fn => { poll = fn; } });
  assert.deepEqual(calls, [['presence_update', { state: { map: 'prontera', baseLevel: 1 } }]]);
  poll(); p.poke();
  assert.equal(calls.length, 1);
  state = { map: 'prontera', baseLevel: 2 };
  poll();
  assert.equal(calls.length, 2);

  const refused = [];
  const q = startPresence({ invoke: () => { refused.push(1); return Promise.reject(new Error('unknown command')); }, read: () => ({ n: refused.length }), every() {} });
  await tick();
  q.poke();
  assert.equal(refused.length, 1);

  // A browser tab has no invoke.
  assert.doesNotThrow(() => startPresence({ invoke: undefined, read: () => ({}) }).poke());
});

test('the game page may call presence_update, and Settings may turn it off', () => {
  const main = fs.readFileSync(path.join(__dirname, '..', 'electron', 'main.js'), 'utf8');
  assert.match(main, /GAME_PAGE_HANDLERS = new Set\(\[[^\]]*'presence_update'/);
  for (const key of ['discord_presence', 'discord_show_name', 'discord_show_map', 'discord_show_party']) {
    assert.match(main, new RegExp(`APP_PREFERENCES = new Set\\(\\[[^\\]]*'${key}'`));
  }
  assert.match(main, /discord_show_name: false/);
  const settings = require('../electron/settings-store');
  const os = require('node:os');
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'discord-')), 'settings.json');
  fs.writeFileSync(file, JSON.stringify({ discord_presence: 'yes' }));
  assert.throws(() => settings.read(file, {}), /Discord/);
});
