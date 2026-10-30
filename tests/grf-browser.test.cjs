'use strict';
// The GRF browser (Settings -> Tools): the conversions between the client's
// files and PNG-ready pictures (tools/grf-browser/formats.js), and the host
// side that copies files into mods and keeps the PNGs being edited
// (electron/grf-browser.js).

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const TOOLS_DIR = path.join(__dirname, '..', 'tools');
const load = rel => import(pathToFileURL(path.join(TOOLS_DIR, rel)).href);
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'grf-browser-'));

/** A sprite with two palette frames and one RGBA frame. */
function sampleSprite() {
	const palette = new Uint8Array(1024);
	palette.set([255, 0, 255, 0], 0);
	palette.set([200, 10, 10, 0], 4);
	palette.set([10, 200, 10, 0], 8);
	palette.set([10, 10, 200, 0], 12);
	return {
		indexed: 2,
		palette,
		frames: [
			{ rgba: false, w: 2, h: 2, data: Uint8Array.from([0, 1, 2, 3]) },
			{ rgba: false, w: 3, h: 1, data: Uint8Array.from([3, 3, 0]) },
			// A, B, G, R, bottom row first: one opaque red pixel over a half-transparent blue one.
			{ rgba: true, w: 1, h: 2, data: Uint8Array.from([128, 255, 0, 0, 255, 0, 0, 255]) },
		],
	};
}

test('a written sprite reads back the same, frames, kinds and palette', async () => {
	const { writeSpr } = await load('grf-browser/formats.js');
	const { readSpr } = await load('map-editor/lib/sprite.js');
	const spr = sampleSprite();
	const back = readSpr(writeSpr(spr));
	assert.equal(back.indexed, 2);
	assert.equal(back.frames.length, 3);
	assert.deepEqual([...back.frames[0].data], [0, 1, 2, 3]);
	assert.deepEqual([...back.frames[1].data], [3, 3, 0]);
	assert.equal(back.frames[2].rgba, true);
	assert.deepEqual([...back.frames[2].data], [...spr.frames[2].data]);
	assert.deepEqual([...back.palette], [...spr.palette]);
});

test('frames come out as RGBA pictures, the background transparent, RGBA frames the right way up', async () => {
	const { frameToImage } = await load('grf-browser/formats.js');
	const spr = sampleSprite();
	const a = frameToImage(spr, 0);
	assert.deepEqual([...a.data.slice(0, 8)], [0, 0, 0, 0, 200, 10, 10, 255]);
	const c = frameToImage(spr, 2);
	// The top row is the second stored one: red, opaque.
	assert.deepEqual([...c.data.slice(0, 4)], [255, 0, 0, 255]);
	assert.deepEqual([...c.data.slice(4, 8)], [0, 0, 255, 128]);
});

test('an edited frame keeps the sprite\'s palette, taking the nearest colour, and other frames are untouched', async () => {
	const { frameToImage, rebuildSprite } = await load('grf-browser/formats.js');
	const spr = sampleSprite();
	const img = frameToImage(spr, 0);
	// Paint the transparent pixel nearly green, and make the red one see-through.
	img.data.set([20, 190, 20, 255], 0);
	img.data.set([200, 10, 10, 10], 4);
	const out = rebuildSprite(spr, new Map([[0, img]]));
	assert.equal(out.changed, 1);
	assert.equal(out.inexact, 1);
	assert.deepEqual([...out.spr.frames[0].data], [2, 0, 2, 3]);
	assert.deepEqual([...out.spr.frames[1].data], [3, 3, 0]);
	assert.deepEqual([...out.spr.palette], [...spr.palette]);
});

test('an edited frame may change size, and RGBA frames go back as RGBA', async () => {
	const { frameToImage, rebuildSprite, writeSpr } = await load('grf-browser/formats.js');
	const { readSpr } = await load('map-editor/lib/sprite.js');
	const spr = sampleSprite();
	const wide = { width: 4, height: 1, data: new Uint8ClampedArray([10, 10, 200, 255, 0, 0, 0, 0, 10, 200, 10, 255, 200, 10, 10, 255]) };
	const rgba = frameToImage(spr, 2);
	rgba.data.set([0, 255, 0, 255], 0);
	const back = readSpr(writeSpr(rebuildSprite(spr, new Map([[1, wide], [2, rgba]])).spr));
	assert.equal(back.frames[1].w, 4);
	assert.deepEqual([...back.frames[1].data], [3, 0, 2, 1]);
	assert.deepEqual([...frameToImage(back, 2).data.slice(0, 4)], [0, 255, 0, 255]);
});

test('a new palette is built from the pictures, and every palette frame is mapped onto it', async () => {
	const { rebuildSprite, frameToImage } = await load('grf-browser/formats.js');
	const spr = sampleSprite();
	const purple = { width: 1, height: 1, data: new Uint8ClampedArray([120, 0, 160, 255]) };
	const out = rebuildSprite(spr, new Map([[0, purple]]), { newPalette: true });
	assert.deepEqual([...out.spr.palette.slice(0, 4)], [255, 0, 255, 0]);
	assert.deepEqual([...frameToImage(out.spr, 0).data], [120, 0, 160, 255]);
	// The frame nobody edited still looks as it did.
	assert.deepEqual([...frameToImage(out.spr, 1).data], [...frameToImage(spr, 1).data]);
});

test('a palette goes out as a grid of squares and comes back from any size of it', async () => {
	const { paletteToImage, imageToPalette, encodeTga } = await load('grf-browser/formats.js');
	const { decodeTga } = await load('map-editor/lib/image.js');
	const pal = new Uint8Array(1024);
	for (let i = 0; i < 256; i++) pal.set([i, 255 - i, (i * 7) & 255, 0], i * 4);
	assert.deepEqual([...imageToPalette(paletteToImage(pal, 8))], [...pal]);
	assert.deepEqual([...imageToPalette(paletteToImage(pal, 3))], [...pal]);
	// And a picture through TGA.
	const img = paletteToImage(pal, 1);
	img.data[3] = 0;
	assert.deepEqual([...decodeTga(encodeTga(img)).data], [...img.data]);
});

test('an action file\'s frame delays are read', async () => {
	const { readAct } = await load('map-editor/lib/sprite.js');
	const out = [];
	const u8 = (...v) => out.push(...v);
	const i32 = v => { const b = Buffer.alloc(4); b.writeInt32LE(v); out.push(...b); };
	const f32 = v => { const b = Buffer.alloc(4); b.writeFloatLE(v); out.push(...b); };
	u8(0x41, 0x43, 5, 2, 2, 0); // 'AC', version 2.5, two actions
	u8(...new Array(10).fill(0));
	for (let a = 0; a < 2; a++) { i32(1); u8(...new Array(32).fill(0)); i32(0); i32(-1); i32(0); }
	i32(0); // no sounds
	f32(6); f32(2.5);
	assert.deepEqual(readAct(Uint8Array.from(out)).delays, [6, 2.5]);
});

test('names: a GRF path as a mod path, and as a folder for its PNGs', async () => {
	const { modPath, workName, fileKind } = await load('grf-browser/formats.js');
	assert.equal(modPath('data\\sprite\\몬스터\\poring.spr'), 'data/sprite/몬스터/poring.spr');
	assert.equal(workName('data\\sprite\\몬스터\\poring.spr'), 'sprite_몬스터_poring.spr');
	assert.equal(fileKind('data\\palette\\몸\\a.PAL'), 'palette');
	assert.equal(fileKind('data\\texture\\a.tga'), 'image');
});

function bridge(state, { files = {}, list = [] } = {}) {
	const opened = [];
	const { createGrfBrowser } = require('../electron/grf-browser');
	const route = createGrfBrowser({
		stateDir: () => state,
		assetBase: () => 'http://assets.invalid',
		log: () => {},
		openPath: async dir => { opened.push(dir); return ''; },
		fetch: async url => {
			const rel = decodeURIComponent(new URL(url).pathname.slice(1));
			if (rel === 'list-files') return new Response(JSON.stringify(list));
			if (rel in files) return new Response(files[rel]);
			return new Response('no', { status: 404 });
		},
	});
	const call = async (name, body, query = '') => {
		const url = new URL(`ro-tool://grf-browser/${name}${query}`);
		const request = new Request('http://x.invalid/', body ? { method: 'POST', body: JSON.stringify(body) } : {});
		const res = await route(name, url, request);
		return { status: res.status, body: res.headers.get('content-type').includes('json') ? await res.json() : Buffer.from(await res.arrayBuffer()) };
	};
	return { call, opened };
}

test('the bridge lists the GRFs, and serves a file by its Korean path', async () => {
	const { call } = bridge(tmp(), { list: ['data\\sprite\\몬스터\\poring.spr'], files: { 'data/sprite/몬스터/poring.spr': 'SP!' } });
	assert.deepEqual((await call('files.json')).body, ['data\\sprite\\몬스터\\poring.spr']);
	assert.equal((await call('asset/data/sprite/몬스터/poring.spr')).body.toString(), 'SP!');
	assert.equal((await call('asset/data/../secret')).status, 404);
	assert.equal((await call('asset/data/nothing.bmp')).status, 404);
});

test('copying to a new mod writes the file at the client\'s path and a mod.json; never outside data/', async () => {
	const state = tmp();
	const { call } = bridge(state);
	const data = Buffer.from('picture').toString('base64');
	const out = await call('api/save', { mod: 'my-look', path: 'data/sprite/몬스터/poring.spr', data, description: 'A new Poring.' });
	assert.equal(out.status, 200);
	assert.equal(out.body.created, true);
	assert.equal(fs.readFileSync(path.join(state, 'mods', 'my-look', 'data', 'sprite', '몬스터', 'poring.spr'), 'utf8'), 'picture');
	const manifest = JSON.parse(fs.readFileSync(path.join(state, 'mods', 'my-look', 'mod.json'), 'utf8'));
	assert.equal(manifest.name, 'my-look');
	assert.equal(manifest.description, 'A new Poring.');
	// A second file leaves mod.json alone.
	assert.equal((await call('api/save', { mod: 'my-look', path: 'data/a.bmp', data })).body.created, false);
	assert.deepEqual((await call('api/mods')).body.mods.map(m => m.name), ['my-look']);
	for (const [mod, rel] of [['my-look', 'data/../../x'], ['my-look', 'npc/x.txt'], ['my-look', 'mod.json'], ['../up', 'data/a.bmp']]) {
		assert.equal((await call('api/save', { mod, path: rel, data })).status, 400, `${mod} ${rel}`);
	}
	assert.equal(fs.existsSync(path.join(state, 'x')), false);
});

test('PNGs go out to a fresh folder, which is opened, and are read back from it', async () => {
	const state = tmp();
	const { call, opened } = bridge(state);
	const png = Buffer.from('png').toString('base64');
	const out = await call('api/export', { name: 'sprite_poring.spr', files: { 'frame-000.png': png, 'frame-001.png': png, 'README.txt': png } });
	assert.equal(out.body.opened, true);
	assert.deepEqual(opened, [path.join(state, 'grf-browser', 'sprite_poring.spr')]);
	fs.writeFileSync(path.join(out.body.dir, 'frame-002.png'), 'new');
	const back = await call('api/edited', null, '?name=sprite_poring.spr');
	assert.deepEqual(Object.keys(back.body.files).sort(), ['frame-000.png', 'frame-001.png', 'frame-002.png']);
	// A second export starts clean.
	await call('api/export', { name: 'sprite_poring.spr', files: { 'frame-000.png': png } });
	assert.deepEqual(Object.keys((await call('api/edited', null, '?name=sprite_poring.spr')).body.files), ['frame-000.png']);
	assert.equal((await call('api/export', { name: '..', files: {} })).status, 400);
	assert.equal((await call('api/export', { name: 'a', files: { '../b.png': png } })).status, 400);
	assert.equal((await call('api/export', { name: 'a', files: { 'b.exe': png } })).status, 400);
});

test('the GRF browser is a tool, and its page can read the map editor\'s format code', async () => {
	const { TOOLS, createTools } = require('../electron/tools');
	const tool = TOOLS.find(t => t.id === 'grf-browser');
	assert.ok(tool);
	assert.ok(fs.existsSync(path.join(TOOLS_DIR, 'grf-browser', tool.page)));
	const tools = createTools({ stateDir: () => tmp(), runtimeDir: () => null, log: () => {}, net: { fetch: async () => new Response('', { status: 404 }) } });
	const get = name => tools.route('grf-browser', name, new URL(`ro-tool://grf-browser/${name}`), new Request('http://x.invalid/'));
	assert.equal((await get('shared/sprite.js')).status, 200);
	assert.equal((await get('formats.js')).status, 200);
	assert.equal((await get('shared/../../control-panel/sprite.js')).status, 404);
	assert.equal((await get('shared/../formats.js')).status, 404);
});
