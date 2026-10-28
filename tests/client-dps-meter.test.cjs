'use strict';
// The combat:damage event (patches/client/ExtensionRuntime.mjs, fed from the
// damage packets by ExtensionBridge.mjs) and the dps-meter mod's arithmetic.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const runtimeModule = import('../patches/client/ExtensionRuntime.mjs');
const meterModule = import('../registry/mods/dps-meter/client/index.js');

test('hitDamage reads attack and skill packets the way the client draws them', async () => {
    const { hitDamage } = await runtimeModule;
    assert.equal(hitDamage({ action: 0, damage: 120, leftDamage: 30 }), 150, 'dual wield adds the off hand');
    assert.equal(hitDamage({ action: 10, damage: 400 }), 400, 'a critical, leftDamage absent');
    assert.equal(hitDamage({ action: 8, damage: 260, leftDamage: 0 }), 260, 'a double attack is one total');
    assert.equal(hitDamage({ action: 1, damage: 0 }), 0, 'picking up an item is not a hit');
    assert.equal(hitDamage({ action: 2, damage: 5 }), 0, 'sitting is not a hit');
    assert.equal(hitDamage({ action: 0, damage: 0 }), 0, 'a miss');
    assert.equal(hitDamage({ SKID: 5, damage: 900, action: 6 }, { skill: true }), 900, 'a skill counts whatever its action');
    assert.equal(hitDamage({ SKID: 28, damage: -300 }, { skill: true }), 0, 'never negative');
    assert.equal(hitDamage(null), 0);
});

test('combat:damage fans out frozen hits, drops bad ones, and stops at disposal', async () => {
    const { createRuntime } = await runtimeModule;
    const runtime = createRuntime();
    const scope = runtime.scope('dps-meter');
    const seen = [];
    scope.api.on('combat:damage', hit => seen.push(hit));
    runtime.damage({ source: 1, target: 2, amount: 50, skill: 0, own: true });
    runtime.damage({ source: 1, target: 2, amount: 0, own: true });
    runtime.damage({ source: 1, target: 2, amount: '50' });
    runtime.damage(undefined);
    runtime.damage({ source: 3, target: 2, amount: 7, skill: 5, own: 'yes' });
    assert.deepEqual(seen.map(h => ({ ...h })), [
        { source: 1, target: 2, amount: 50, skill: 0, own: true, by: 'me', name: '' },
        { source: 3, target: 2, amount: 7, skill: 5, own: false, by: 'other', name: '' },
    ]);
    assert.equal(Object.isFrozen(seen[0]), true);
    scope.dispose();
    runtime.damage({ source: 1, target: 2, amount: 50, own: true });
    assert.equal(seen.length, 2, 'a disposed scope hears nothing more');
});

test('the meter counts a fight until it goes idle, then starts a new one', async () => {
    const { createMeter } = await meterModule;
    const meter = createMeter({ idleMs: 5000 });
    assert.deepEqual(meter.read(0), { active: false, dps: 0, fightDamage: 0, fightSeconds: 0, total: 0, biggest: 0, hits: 0, sources: [] });

    meter.hit(100, 0);
    let r = meter.read(0);
    assert.equal(r.dps, 100, 'one hit is spread over at least a second');
    meter.hit(300, 1000);
    meter.hit(200, 2000);
    r = meter.read(2000);
    assert.equal(r.active, true);
    assert.equal(r.fightDamage, 600);
    assert.equal(r.dps, 300);
    assert.equal(r.biggest, 300);
    assert.equal(r.hits, 3);
    assert.equal(meter.read(4000).dps, 150, 'the clock runs while the fight is on');

    r = meter.read(7001);
    assert.equal(r.active, false, 'five seconds without a hit ends the fight');
    assert.equal(r.dps, 300, 'and its DPS stops at the last hit');

    meter.hit(50, 10000);
    r = meter.read(10000);
    assert.equal(r.fightDamage, 50, 'the next hit starts a new fight');
    assert.equal(r.total, 650, 'total carries on');
    assert.equal(r.biggest, 300);

    meter.hit(0, 10100);
    meter.hit(NaN, 10100);
    assert.equal(meter.read(10100).hits, 4, 'zero and bad amounts are ignored');

    meter.reset();
    assert.deepEqual(meter.read(10100), { active: false, dps: 0, fightDamage: 0, fightSeconds: 0, total: 0, biggest: 0, hits: 0, sources: [] });
});

test('combat:damage says whose hit it was, and names only the player\'s side', async () => {
    const { createRuntime } = await runtimeModule;
    const runtime = createRuntime();
    const seen = [];
    runtime.scope('dps-meter').api.on('combat:damage', hit => seen.push({ ...hit }));
    runtime.damage({ source: 9, target: 2, amount: 40, by: 'party', name: 'Aria' });
    runtime.damage({ source: 8, target: 2, amount: 30, by: 'homun', name: 'x'.repeat(60) });
    runtime.damage({ source: 7, target: 2, amount: 20, by: 'other', name: 'Stranger' });
    runtime.damage({ source: 1, target: 2, amount: 10, by: 'me', own: false });
    runtime.damage({ source: 6, target: 2, amount: 5, by: 'boss' });
    assert.deepEqual(seen.map(h => [h.by, h.name, h.own]), [
        ['party', 'Aria', false],
        ['homun', 'x'.repeat(40), false],
        ['other', '', false],
        ['me', '', true],
        ['other', '', false],
    ]);
});

test('the meter splits a fight by source, biggest total first, over one clock', async () => {
    const { createMeter, sourceLabel, SIDE_SOURCES, OWN_SOURCES } = await meterModule;
    const meter = createMeter({ idleMs: 5000 });
    meter.hit(100, 0, 'me', 'You');
    meter.hit(300, 1000, 9, 'Aria');
    meter.hit(100, 2000, 'me', 'You');
    const r = meter.read(2000);
    assert.equal(r.fightDamage, 500, 'the total is everyone together');
    assert.equal(r.dps, 250);
    assert.deepEqual(r.sources, [
        { key: 9, label: 'Aria', fightDamage: 300, dps: 150, total: 300 },
        { key: 'me', label: 'You', fightDamage: 200, dps: 100, total: 200 },
    ]);
    meter.hit(50, 9000, 'me', 'You');
    const next = meter.read(9000);
    assert.equal(next.sources.find(s => s.key === 9).fightDamage, 0, 'a new fight starts everyone at zero');
    assert.equal(next.sources.find(s => s.key === 9).total, 300, 'totals carry on');
    meter.reset();
    assert.deepEqual(meter.read(9000).sources, []);

    assert.equal(sourceLabel({ by: 'me', name: 'ignored' }), 'You');
    assert.equal(sourceLabel({ by: 'party', name: 'Aria' }), 'Aria');
    assert.equal(sourceLabel({ by: 'homun', name: '' }), 'Homunculus');
    assert.equal(SIDE_SOURCES.has('party') && !SIDE_SOURCES.has('other'), true, 'strangers never count');
    assert.deepEqual([...OWN_SOURCES], ['me'], 'the only-me setting');
});
