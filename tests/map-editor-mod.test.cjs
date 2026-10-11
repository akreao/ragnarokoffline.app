'use strict';
// The map editor's gameplay layer and its mod (#414): rAthena script read and
// written, the generated block that never touches the author's own code, the
// files a save writes, the checks before one, lightmap baking and minimaps.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { pathToFileURL } = require('node:url');
// A file URL: import() takes no bare Windows paths.
const lib = name => import(pathToFileURL(path.join(__dirname, '..', 'tools', 'map-editor', 'lib', name)).href);

const HAND = `// My island
my_isle,40,44,4\tscript\tKeeper#mi\t4_M_SAGE_A,{
\tmes "[Keeper]";
\tmes "A { brace } in a string, and } in a comment"; // }
\tif (Zeny > 0) { mes "rich"; }
\tclose;
}
my_isle,10,10,4\tshop\tTools#mi\t4_M_01,501:-1,502:100
my_isle,5,5,0\twarp\tout#mi\t1,1,prontera,156,180
my_isle,0,0,0,0\tmonster\tPoring\t1002,10,5000,0,0
my_isle,20,20,4\tduplicate(Tools#mi)\tTools2#mi\t4_M_01
-\tscript\tFloating#mi\t-1,{ end; }
function\tscript\tmy_fn\t{ end; }
prontera,150,150,4\tscript\tElsewhere\t4_M_01,{ end; }
`;

test('every kind of line on a map is read, braces in strings and comments included', async () => {
	const { readGameplay } = await lib('script.js');
	const g = readGameplay('my_isle', { 'npc/hand.txt': HAND });
	assert.deepEqual(g.npcs.map(n => n.kind), ['script', 'shop', 'duplicate']);
	assert.equal(g.warps.length, 1);
	assert.equal(g.warps[0].dest.map, 'prontera');
	assert.equal(g.spawns[0].mob, 1002);
	assert.equal(g.npcs[1].items[1].price, 100);
	assert.ok(g.npcs.every(n => n.handwritten && n.file === 'npc/hand.txt'));
	assert.match(g.npcs[0].body, /close;/, 'the whole body, past the braces in its string');
});

test('the generated block reads back as the same objects, and leaves the rest of the file alone', async () => {
	const { replaceBlock, readGameplay } = await lib('script.js');
	const gameplay = {
		npcs: [
			{ id: 'npc-1', kind: 'healer', x: 10, y: 12, dir: 4, name: 'Nurse#mi', sprite: '4_F_NURSE' },
			{ id: 'npc-2', kind: 'warper', x: 12, y: 12, dir: 6, name: 'Guide#mi', sprite: '4_M_01', destinations: [{ map: 'prontera', x: 156, y: 191, label: 'Prontera' }] },
			{ id: 'npc-3', kind: 'shop', x: 14, y: 12, dir: 4, name: 'Tools#mi2', sprite: '4_M_01', items: [{ id: 501, price: -1 }] },
			{ id: 'npc-4', kind: 'script', x: 16, y: 12, dir: 4, name: 'Hana#mi', sprite: '4_F_01', fn: 'my_isle_hana', touch: { xs: 2, ys: 2 } },
			{ id: 'npc-5', kind: 'sign', x: 18, y: 12, dir: 4, name: 'Sign#mi', sprite: '4_BOARD3', text: 'Hello\nWorld' },
		],
		warps: [{ id: 'warp-6', kind: 'warp', x: 2, y: 2, xs: 1, ys: 1, name: 'w#mi', dest: { map: 'alberta', x: 190, y: 140 } }],
		spawns: [{ id: 'spawn-7', kind: 'monster', x: 30, y: 30, xs: 5, ys: 5, name: '--en--', mob: 'PORING', amount: 9, delay1: 5000, delay2: 0 }],
	};
	const before = '// mine, above\n\n';
	const text = replaceBlock(before + 'after();\n', 'my_isle', gameplay);
	assert.ok(text.startsWith(before), 'text above the block is kept');
	assert.ok(text.includes('after();'), 'text outside the block is kept');
	const back = readGameplay('my_isle', { 'npc/my_isle.txt': text });
	assert.deepEqual(back.npcs.map(n => n.kind), ['healer', 'warper', 'shop', 'script', 'sign']);
	assert.equal(back.npcs[1].destinations[0].map, 'prontera');
	assert.equal(back.npcs[4].text, 'Hello\nWorld');
	assert.deepEqual(back.npcs[3].touch, { xs: 2, ys: 2 });
	assert.ok(back.npcs.every(n => !n.handwritten), 'the block\'s own entries are the editor\'s');
	assert.equal(back.spawns[0].mob, 'PORING');
	// Regenerating gives the same text: saving twice changes nothing.
	assert.equal(replaceBlock(text, 'my_isle', back), text);
	assert.match(text, /my_isle,16,12,4\tscript\tHana#mi\t4_F_01,2,2,\{/);
	assert.match(text, /callfunc "my_isle_hana";/);
});

test('a hand-written NPC is moved by rewriting its first line only', async () => {
	const { readGameplay, rewriteHeader } = await lib('script.js');
	const g = readGameplay('my_isle', { 'npc/hand.txt': HAND });
	const keeper = g.npcs[0];
	const out = rewriteHeader(HAND, { ...keeper, x: 30, y: 31, dir: 2, sprite: '4_F_KAFRA1' }).text;
	assert.match(out, /^my_isle,30,31,2\tscript\tKeeper#mi\t4_F_KAFRA1,\{$/m);
	assert.equal(out.replace(/^my_isle,30,31.*$/m, ''), HAND.replace(/^my_isle,40,44.*$/m, ''), 'nothing else changed');
});

test('signboards round trip, other maps\' rows kept', async () => {
	const { parseSignboards, writeSignboards } = await lib('script.js');
	const rows = [{ map: 'a', x: 1, y: 2, height: 0, type: 1, icon: 'information\\over_kafra.bmp', caption: '', color: '' }, { map: 'b', x: 3, y: 4, height: 10, type: 3, icon: 'information\\over_nmtrade.bmp', caption: 'Buying', color: '#0x00FFFFFF' }];
	const back = parseSignboards(writeSignboards(rows));
	assert.equal(back.length, 2);
	assert.equal(back[0].icon, 'information\\over_kafra.bmp');
	assert.equal(back[1].caption, 'Buying');
});

async function islandDoc() {
	const { createMap } = await lib('map.js');
	const { runCommand } = await lib('commands.js');
	const doc = createMap({ name: 'my_isle', width: 40, height: 40 });
	const run = (c, a) => runCommand(doc, c, a).result;
	return { doc, run };
}

test('a save writes the whole mod, and a second save keeps the author\'s dialogue', async () => {
	const { buildModFiles, attachProject } = await lib('project.js');
	const { doc, run } = await islandDoc();
	run('npc.add', { kind: 'script', x: 20, y: 20, name: 'Hana', sprite: '4_F_01' });
	run('signboard.set', { x: 20, y: 20, icon: 'information\\over_guide.bmp' });
	run('population.set', { profile: 'combat_pve_low', category: 'Fields', count: 5 });
	run('props.set', { sky: '0.4,0.6,0.8', bgm: '08.mp3' });
	const project = {
		mod: 'isle', scripts: {},
		manifest: { name: 'isle', version: '2.0.0', author: 'me', custom: true, requires: { app: '>=1.0.6' }, maps: { other_map: { weather: 'snow' } } },
		signboards: 'SignBoardList = {\n\t{ "other_map", 1, 1, 0, 1, "information\\\\over_kafra.bmp" },\n}\n',
		population: 'Header:\n  Type: POPULATION_SPAWN_DB\n  Version: 1\n\nBody:\n  - Profile: novice_default\n    TownsAdd:\n      - other_map\n',
	};
	const built = buildModFiles(doc, project, { minimap: new Uint8Array([1]) });
	const names = Object.keys(built.files).sort();
	for (const f of ['data/my_isle.gat', 'data/my_isle.gnd', 'data/my_isle.rsw', 'data/texture/ui/map/my_isle.bmp', 'npc/my_isle.txt', 'npc/my_isle_dialogue.txt', 'data/luafiles514/lua files/SignBoardList.lub', 'db/population_spawn.yml', 'mod.json']) assert.ok(names.includes(f), f);
	const manifest = JSON.parse(built.files['mod.json'].text);
	assert.equal(manifest.version, '2.0.0', 'the author\'s fields are kept');
	assert.equal(manifest.custom, true);
	assert.deepEqual(manifest.maps.other_map, { weather: 'snow' }, 'other maps\' entries are kept');
	assert.deepEqual(manifest.maps.my_isle, { sky: [0.4, 0.6, 0.8], bgm: '08.mp3' });
	assert.equal(manifest.requires.app, '>=1.5.1', '"maps" needs 1.5.1');
	assert.match(built.files['data/luafiles514/lua files/SignBoardList.lub'].text, /other_map/);
	assert.match(built.files['data/luafiles514/lua files/SignBoardList.lub'].text, /"my_isle", 20, 20/);
	const pop = built.files['db/population_spawn.yml'].text;
	assert.match(pop, /novice_default/, 'other profiles are kept');
	assert.match(pop, /FieldsAdd:\n {6}- my_isle\n {4}FieldsPopulationAdd: 5/);
	const dialogue = built.files['npc/my_isle_dialogue.txt'].text;
	assert.match(dialogue, /function\tscript\tmy_isle_hana\t\{/);

	// The author edits the dialogue; the next save must not add it again or touch it.
	const edited = dialogue.replace('Hello there!', 'Welcome to my island.');
	const saved = { ...project, scripts: { 'npc/my_isle.txt': built.files['npc/my_isle.txt'].text, 'npc/my_isle_dialogue.txt': edited }, manifest };
	const { openMap, mapFiles } = await lib('map.js');
	const files = mapFiles(doc);
	const reopened = attachProject(openMap({ name: 'my_isle', gat: files['my_isle.gat'], gnd: files['my_isle.gnd'], rsw: files['my_isle.rsw'] }), saved);
	assert.equal(reopened.gameplay.npcs[0].fn, 'my_isle_hana');
	assert.equal(reopened.props.bgm, '08.mp3');
	const again = buildModFiles(reopened, saved, {});
	assert.equal(again.files['npc/my_isle_dialogue.txt'], undefined, 'the dialogue file is not rewritten');
	assert.equal(again.files['npc/my_isle.txt'], undefined, 'an unchanged block is not rewritten');
});

test('a map with no sky, weather or music leaves no "maps" entry (the server refuses an empty one)', async () => {
	const { mergeManifest } = await lib('project.js');
	const { doc } = await islandDoc();
	const m = mergeManifest({ name: 'x', maps: { my_isle: { sky: [1, 1, 1] } } }, 'x', doc);
	assert.equal(m.maps, undefined);
});

test('the checks catch the mistakes that break a map', async () => {
	const { validate } = await lib('validate.js');
	const { doc, run } = await islandDoc();
	run('gat.paint', { type: 1, x0: 10, y0: 10, x1: 12, y1: 12 });
	run('warp.add', { x: 5, y: 5, map: 'my_isle', dx: 11, dy: 11 });
	run('warp.add', { x: 30, y: 30, map: 'my_isle', dx: 5, dy: 5 });
	run('spawn.add', { mob: 99999, amount: 3, x: 20, y: 20, xs: 2, ys: 2 });
	const issues = await validate(doc, { mobs: new Set(['1002', 'PORING']), exists: async p => !p.includes('missing'), maps: new Set(['my_isle']) });
	const codes = issues.map(i => i.code);
	for (const c of ['warp-lands-blocked', 'warp-loop', 'unknown-mob', 'no-way-in']) assert.ok(codes.includes(c), `${c} in ${codes.join(',')}`);
	doc.name = 'a_name_too_long';
	assert.ok((await validate(doc)).some(i => i.code === 'name' && i.level === 'error'));
	doc.name = 'my_isle';
	doc.gnd.textures.push('missing.bmp');
	const files = await validate(doc, { exists: async p => !p.includes('missing') });
	assert.ok(files.some(i => i.code === 'missing-file' && i.message.includes('missing.bmp')));
});

test('unreachable ground is found from where players arrive', async () => {
	const { validate } = await lib('validate.js');
	const { doc, run } = await islandDoc();
	run('gat.paint', { type: 1, x0: 20, y0: 0, x1: 20, y1: 39 }); // a wall down the middle
	const issues = await validate(doc, { testPoint: { x: 5, y: 5 }, incoming: [{ from: 'prontera', x: 5, y: 6 }] });
	const lost = issues.find(i => i.code === 'unreachable');
	assert.ok(lost, 'the far half cannot be reached');
	assert.ok(lost.at.x > 20);
});

test('baking shadows the ground behind a box from the sun, and point lights add their colour', async () => {
	const { bakeLightmaps, lightmapProblems } = await lib('lightmap.js');
	const { doc, run } = await islandDoc();
	doc.rsw.light = { longitude: 0, latitude: 60, diffuse: [1, 1, 1], ambient: [0.3, 0.3, 0.3], opacity: 1 };
	run('light.add', { x: 5, y: 5, color: '#ff0000', range: 4, height: 2 });
	// A wall standing 6 units tall across the map at z = 20 (world units, y down).
	const tris = new Float32Array([0, 0, 20, 40, 0, 20, 40, -6, 20, 0, 0, 20, 40, -6, 20, 0, -6, 20]);
	bakeLightmaps(doc, { occluders: tris, shadows: true, lights: true });
	const g = doc.gnd, lm = g.lightmap.data;
	const shade = (cx, cy) => lm[g.tiles[g.up[cy * g.width + cx]].light * 256 + 3 * 8 + 3];
	const red = (cx, cy) => lm[g.tiles[g.up[cy * g.width + cx]].light * 256 + 64 + (3 * 8 + 3) * 3];
	// latitude 60 from the south: the shadow falls on the far (north) side of the wall.
	const north = shade(10, 11), south = shade(10, 8);
	assert.ok(north < south, `shadowed ${north} < lit ${south}`);
	assert.ok(red(2, 2) > 50, 'the red light reaches the cube under it');
	assert.equal(red(15, 15), 0, 'and not the far side of the map');
	assert.deepEqual(lightmapProblems(doc), []);
	assert.ok(g.lightmap.count < g.tiles.length, 'identical lightmaps are shared');
});

test('a white-sheet lightmap is caught', async () => {
	const { lightmapProblems } = await lib('lightmap.js');
	const { doc } = await islandDoc();
	doc.gnd.lightmap.data.fill(255);
	assert.match(lightmapProblems(doc)[0], /white sheet/);
});

test('the software minimap draws the map from above, north up', async () => {
	const { renderMinimap } = await lib('minimap.js');
	const { doc, run } = await islandDoc();
	run('texture.paint', { texture: 'red.bmp', x0: 0, y0: 30, x1: 39, y1: 39 });
	const red = { width: 2, height: 2, data: new Uint8ClampedArray([255, 0, 0, 255, 255, 0, 0, 255, 255, 0, 0, 255, 255, 0, 0, 255]) };
	const img = renderMinimap(doc, new Map([[doc.gnd.textures[1], red]]), { size: 64 });
	assert.equal(img.width, 64);
	const top = img.data[(4 * 64 + 32) * 4], bottom = img.data[(60 * 64 + 32) * 4 + 1];
	assert.ok(top > 100 && img.data[(4 * 64 + 32) * 4 + 1] < 60, 'the north (red) is at the top');
	assert.ok(bottom > 0, 'the south is the default ground');
});

test('the example mod\'s hand-written script opens as markers', async () => {
	const { readGameplay } = await lib('script.js');
	const text = fs.readFileSync(path.join(__dirname, '..', 'examples', 'mods', 'custom-map', 'npc', 'isle.txt'), 'utf8');
	const g = readGameplay('ro_isle', { 'npc/isle.txt': text });
	assert.equal(g.npcs.length, 1);
	assert.equal(g.warps.length, 1);
	assert.equal(g.spawns.length, 2);
});
