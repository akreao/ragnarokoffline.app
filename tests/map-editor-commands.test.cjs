'use strict';
// The map editor's commands (#414): every edit a person, the CLI or an MCP
// client makes. They run in Node exactly as they run in the page.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { pathToFileURL } = require('node:url');
// A file URL: import() takes no bare Windows paths.
const lib = name => import(pathToFileURL(path.join(__dirname, '..', 'tools', 'map-editor', 'lib', name)).href);

async function fresh(opts = {}) {
	const { createMap } = await lib('map.js');
	const { runCommand } = await lib('commands.js');
	const { History } = await lib('history.js');
	const doc = createMap({ name: 'cmd_test', width: 40, height: 40, ...opts });
	const history = new History(doc);
	const run = (cmd, args) => runCommand(doc, cmd, args, history).result;
	return { doc, history, run };
}

const cell = (doc, x, y) => doc.gat.types[y * doc.gat.width + x];

test('a new map is walkable inside a blocked edge', async () => {
	const { doc } = await fresh();
	assert.equal(cell(doc, 0, 0), 1);
	assert.equal(cell(doc, 39, 20), 1);
	assert.equal(cell(doc, 20, 20), 0);
	const { createMap } = await lib('map.js');
	assert.equal(createMap({ name: 'odd', width: 31, height: 9 }).gat.width, 32, 'rounded up to whole cubes');
	assert.throws(() => createMap({ name: 'much_too_long_name' }), /11 characters/);
});

test('raise lifts the ground up (negative in the file) and keeps it walkable when gentle', async () => {
	const { doc, run } = await fresh();
	const { groundHeight } = await lib('map.js');
	run('terrain.brush', { tool: 'raise', x: 20, y: 20, radius: 8, strength: 1 });
	assert.ok(groundHeight(doc, 20, 20) < -0.9, 'one cell up is -1 in world units, -5 in the file');
	assert.equal(run('terrain.height', { x: 20, y: 20 }).type, 0);
	assert.ok(run('terrain.height', { x: 20, y: 20 }).height > 0.9);
});

test('a plateau is a cliff: faces on its sides, blocked along its edge', async () => {
	const { doc, run } = await fresh();
	run('terrain.rect', { x0: 10, y0: 10, x1: 19, y1: 19, op: 'set', height: 4 });
	const g = doc.gnd;
	// The cube west of the plateau has an east face; the one south of it a north face.
	assert.ok(g.right[5 * g.width + 4] >= 0, 'east face on the western neighbour');
	assert.ok(g.front[4 * g.width + 6] >= 0, 'north face on the southern neighbour');
	assert.equal(cell(doc, 15, 15), 0, 'the top is walkable');
	assert.equal(cell(doc, 10, 15), 1, 'its edge is blocked: rAthena\'s paths ignore height');
	assert.equal(cell(doc, 9, 15), 1, 'and so is the foot of the cliff');
	assert.equal(cell(doc, 5, 15), 0);
});

test('painting splits a shared tile rather than repainting every cube using it', async () => {
	const { doc, run } = await fresh();
	const g = doc.gnd;
	// Make two cubes share one tile, as official maps do.
	g.up[1] = g.up[0];
	run('texture.paint', { texture: 'other.bmp', x0: 0, y0: 0, x1: 1, y1: 1, span: 1 });
	assert.equal(g.textures.length, 2);
	assert.notEqual(g.up[0], g.up[1], 'the painted cube got its own tile');
	assert.equal(g.tiles[g.up[0]].texture, 1);
	assert.equal(g.tiles[g.up[1]].texture, 0, 'the other cube kept the old texture');
});

test('changing the water leaves hand-made walkability alone', async () => {
	const { doc, run } = await fresh();
	doc.gat.types[20 * 40 + 20] = 5; // a cliff cell, as an official map has
	run('terrain.brush', { tool: 'lower', x: 30, y: 30, radius: 4, strength: 2, sync: false });
	run('water.set', { level: -0.5 });
	assert.equal(cell(doc, 20, 20), 5, 'not walkable ground: untouched');
	assert.equal(cell(doc, 0, 0), 1, 'the edge stays blocked');
	assert.equal(cell(doc, 15, 15), 0, 'dry ground stays ground');
	// The lowered pit: walkable ground under the water line is walkable water.
	const { syncGat } = await lib('map.js');
	syncGat(doc, { x0: 26, y0: 26, x1: 34, y1: 34 });
	assert.equal(cell(doc, 30, 30), 3);
});

test('models are placed on the ground, moved, copied between maps and removed', async () => {
	const a = await fresh();
	a.run('terrain.brush', { tool: 'set', x: 20, y: 20, radius: 6, height: 2, falloff: 'hard' });
	const { index } = a.run('model.add', { file: '프론테라/분수대.rsm', x: 20, y: 20 });
	const o = a.doc.rsw.objects[index];
	assert.ok(Math.abs(o.position[1] - -10) < 0.01, 'stands on ground two cells up');
	const { decodeName } = await lib('cp949.js');
	assert.equal(decodeName(o.file), '프론테라\\분수대.rsm', 'written in CP949 with backslashes');
	a.run('object.move', { indexes: [index], dx: 3, dy: -2 });
	const { rswToCell } = await lib('commands.js');
	const c = rswToCell(a.doc, o.position);
	assert.ok(Math.abs(c.x - 23) < 0.01 && Math.abs(c.y - 18) < 0.01);
	const clip = a.run('object.copy', { indexes: [index] });
	const b = await fresh({ name: 'other' });
	const pasted = b.run('object.paste', { clip, x: 10, y: 10 });
	assert.equal(b.doc.rsw.objects.length, 1);
	assert.equal(b.doc.rsw.objects[pasted.indexes[0]].file, o.file);
	a.run('object.remove', { indexes: [index] });
	assert.equal(a.doc.rsw.objects.length, 0);
});

test('NPC names are unique and fit rAthena\'s 24 characters', async () => {
	const { run } = await fresh();
	const one = run('npc.add', { kind: 'healer', x: 10, y: 10, name: 'Nurse' });
	const two = run('npc.add', { kind: 'healer', x: 11, y: 10, name: 'Nurse' });
	assert.equal(one.name, 'Nurse#cmd_test');
	assert.notEqual(one.name, two.name);
	const long = run('npc.add', { kind: 'sign', x: 12, y: 10, name: 'A really very long name for a sign' });
	assert.ok(long.name.length <= 24, long.name);
	assert.ok(long.name.endsWith('#cmd_test'));
	const script = run('npc.add', { kind: 'script', x: 13, y: 10, name: 'Hana' });
	assert.equal(script.fn, 'cmd_test_hana');
});

test('a two-way warp\'s way back stands beside the arrival and lands beside the portal', async () => {
	const { doc, run } = await fresh();
	const [there, back] = run('warp.add', { x: 20, y: 3, map: 'prontera', dx: 156, dy: 180, twoWay: true });
	assert.equal(there.dest.map, 'prontera');
	assert.equal(back.map, 'prontera');
	assert.notDeepEqual([back.x, back.y], [156, 180], 'not on the arrival cell');
	assert.ok(Math.abs(back.dest.y - 3) > there.ys, 'lands outside this portal');
	assert.ok(back.dest.y > 3, 'toward the middle of the map, not off its edge');
	assert.equal(doc.gameplay.external.length, 1);
});

test('commands refuse unknown and missing arguments by name', async () => {
	const { run } = await fresh();
	assert.throws(() => run('model.add', { file: 'x.rsm', x: 1, y: 1, colour: 'red' }), /no argument "colour"/);
	assert.throws(() => run('npc.add', { kind: 'shop', x: 1 }), /needs y/);
	assert.throws(() => run('no.such', {}), /no command/);
	assert.throws(() => run('npc.add', { kind: 'shop', x: 400, y: 1, name: 'x' }), /off the map/);
	assert.throws(() => run('props.set', { weather: 'hail' }), /weather must be/);
	assert.throws(() => run('props.set', { clouds: '#ffffff' }), /clouds need a sky/);
});

test('resize keeps everything where it stands on the ground', async () => {
	const { doc, run } = await fresh();
	const { index } = run('model.add', { file: 'a.rsm', x: 20, y: 20 });
	const npc = run('npc.add', { kind: 'sign', x: 21, y: 21, name: 'S' });
	const { rswToCell } = await lib('commands.js');
	run('map.resize', { width: 60, height: 40, anchor: 'w' });
	assert.equal(doc.gat.width, 60);
	assert.equal(doc.gnd.width, 30);
	const c = rswToCell(doc, doc.rsw.objects[index].position);
	assert.ok(Math.abs(c.x - 20) < 0.01, `the model is still at 20 (now ${c.x})`);
	assert.equal(doc.gameplay.npcs[0].x, 21);
	run('map.crop', { x0: 10, y0: 10, x1: 29, y1: 29 });
	assert.equal(doc.gat.width, 20);
	assert.equal(doc.gameplay.npcs[0].x, 11, 'moved with the crop');
	void npc;
});

test('undo and redo put back exactly what changed', async () => {
	const { doc, history, run } = await fresh();
	const before = doc.gnd.heights.slice();
	run('terrain.brush', { tool: 'raise', x: 20, y: 20, radius: 5, strength: 2 });
	run('npc.add', { kind: 'healer', x: 10, y: 10, name: 'N' });
	assert.equal(history.undoStack.length, 2);
	const step = history.undoStack[0];
	assert.ok(step.parts['gnd.heights'].typed.idx, 'a small brush stroke is kept as a sparse diff');
	history.undo();
	assert.equal(doc.gameplay.npcs.length, 0);
	history.undo();
	assert.deepEqual(Array.from(doc.gnd.heights), Array.from(before));
	history.redo();
	assert.notDeepEqual(Array.from(doc.gnd.heights), Array.from(before));
	history.redo();
	assert.equal(doc.gameplay.npcs.length, 1);
	// A failing command leaves no step and changes nothing.
	assert.throws(() => run('object.remove', { indexes: [5] }));
	assert.equal(history.undoStack.length, 2);
});

test('the sun direction matches roBrowser\'s', async () => {
	const { lightUniforms } = await lib('light.js');
	const l = lightUniforms({ longitude: 45, latitude: 45, diffuse: [1, 1, 1], ambient: [0.3, 0.3, 0.3], opacity: 1 });
	assert.ok(l.direction[1] < 0, 'toward the sun is up, which is -y');
	assert.ok(Math.abs(Math.hypot(...l.direction) - 1) < 1e-6);
	assert.deepEqual(l.env, [1, 1, 1]);
});
