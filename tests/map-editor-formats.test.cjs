'use strict';
// The map editor's file formats (#414): .gat, .gnd and .rsw read and written
// back byte for byte, .rsm models read the way roBrowser reads them, and the
// pictures and names around them. A writer that is off by one field makes a
// map the client or the server silently refuses, so these compare bytes.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { pathToFileURL } = require('node:url');
// A file URL: import() takes no bare Windows paths.
const lib = name => import(pathToFileURL(path.join(__dirname, '..', 'tools', 'map-editor', 'lib', name)).href);
const EXAMPLE = path.join(__dirname, '..', 'examples', 'mods', 'custom-map', 'data');
const read = f => new Uint8Array(fs.readFileSync(f));

test('the example island writes back byte for byte', async () => {
	const { readGat, writeGat } = await lib('gat.js');
	const { readGnd, writeGnd } = await lib('gnd.js');
	const { readRsw, writeRsw } = await lib('rsw.js');
	const { equalBytes } = await lib('binary.js');
	for (const [ext, r, w] of [['gat', readGat, writeGat], ['gnd', readGnd, writeGnd], ['rsw', readRsw, writeRsw]]) {
		const bytes = read(path.join(EXAMPLE, `ro_isle.${ext}`));
		assert.ok(equalBytes(w(r(bytes)), bytes), `ro_isle.${ext}`);
	}
});

// Official maps cannot be committed (they are Gravity's). Point
// MAP_EDITOR_SAMPLES at a folder of .gat/.gnd/.rsw files from a client to run
// the same check over them: every version from .rsw 1.9 to 2.6 and .gnd 1.7
// to 1.9 has been through it.
test('official maps write back byte for byte (MAP_EDITOR_SAMPLES)', { skip: !process.env.MAP_EDITOR_SAMPLES }, async () => {
	const { readGat, writeGat } = await lib('gat.js');
	const { readGnd, writeGnd } = await lib('gnd.js');
	const { readRsw, writeRsw } = await lib('rsw.js');
	const { equalBytes } = await lib('binary.js');
	const dir = process.env.MAP_EDITOR_SAMPLES;
	let n = 0;
	for (const f of fs.readdirSync(dir)) {
		const bytes = read(path.join(dir, f));
		if (bytes.length < 16) continue;
		const pair = { '.gat': [readGat, writeGat], '.gnd': [readGnd, writeGnd], '.rsw': [readRsw, writeRsw] }[path.extname(f)];
		if (!pair) continue;
		assert.ok(equalBytes(pair[1](pair[0](bytes)), bytes), f);
		n++;
	}
	assert.ok(n > 0, 'no samples found');
});

test('a new map survives a write and a read', async () => {
	const { createMap, mapFiles, openMap } = await lib('map.js');
	const { equalBytes } = await lib('binary.js');
	const doc = createMap({ name: 'fmt_test', width: 30, height: 22 });
	assert.equal(doc.gat.width, 30);
	assert.equal(doc.gnd.width, 15, 'the ground is half the cells');
	const files = mapFiles(doc);
	const again = openMap({ name: 'fmt_test', gat: files['fmt_test.gat'], gnd: files['fmt_test.gnd'], rsw: files['fmt_test.rsw'] });
	const twice = mapFiles(again);
	for (const k of Object.keys(files)) assert.ok(equalBytes(files[k], twice[k]), k);
	assert.equal(again.rsw.files.gnd, 'fmt_test.gnd');
	assert.equal(again.rsw.version.join('.'), '2.1', 'new maps keep the water in the .rsw, where the map cache reads it');
	assert.equal(again.gnd.version.join('.'), '1.7');
});

test('every .rsw version keeps its own fields', async () => {
	const { createRsw, writeRsw, readRsw, OBJECT } = await lib('rsw.js');
	const { equalBytes } = await lib('binary.js');
	const model = { type: OBJECT.MODEL, name: 'tree', animType: 0, animSpeed: 1, blockType: 0, file: 'a\\b.rsm', node: '', position: [1, -2, 3], rotation: [0, 45, 0], scale: [1, 1, 1] };
	const light = { type: OBJECT.LIGHT, name: 'lamp', position: [0, -10, 0], colorBits: [0x3f800000, 0x3f000000, 0], range: 40 };
	const sound = { type: OBJECT.SOUND, name: 's', file: 'x.wav', position: [0, 0, 0], volume: 0.8, width: 10, height: 10, range: 100, cycle: 4 };
	const effect = { type: OBJECT.EFFECT, name: 'e', position: [0, 0, 0], id: 47, delay: 0.1, param: [1, 0, 0, 0] };
	for (const [version, build] of [[[1, 9], 0], [[2, 1], 0], [[2, 2], 0], [[2, 5], 36], [[2, 6], 214], [[2, 6], 100]]) {
		const rsw = { ...createRsw('v'), version, buildNumber: build, objects: [{ ...model, unknownByte: 0 }, light, sound, effect] };
		if (version[0] === 2 && version[1] >= 6) rsw.water = null;
		const bytes = writeRsw(rsw);
		const back = readRsw(bytes);
		assert.equal(back.objects.length, 4, version.join('.'));
		assert.equal(back.objects[0].file, 'a\\b.rsm');
		assert.deepEqual(back.objects[0].rotation, [0, 45, 0]);
		assert.equal(back.objects[3].id, 47);
		assert.ok(equalBytes(writeRsw(back), bytes), `rsw ${version.join('.')} build ${build}`);
	}
});

test('.gnd 1.8 and 1.9 carry their water', async () => {
	const { createGnd, writeGnd, readGnd } = await lib('gnd.js');
	const { equalBytes } = await lib('binary.js');
	for (const minor of [8, 9]) {
		const g = { ...createGnd(4, 4), version: [1, minor], water: { level: -5, type: 2, waveHeight: 1, waveSpeed: 2, wavePitch: 50, animSpeed: 3, splitWidth: 2, splitHeight: 1, zones: [] } };
		if (minor === 9) g.water.zones = [{ level: -5, type: 2, waveHeight: 1, waveSpeed: 2, wavePitch: 50, animSpeed: 3 }, { level: -6, type: 3, waveHeight: 1, waveSpeed: 2, wavePitch: 50, animSpeed: 3 }];
		const bytes = writeGnd(g);
		const back = readGnd(bytes);
		assert.equal(back.water.type, 2);
		if (minor === 9) assert.equal(back.water.zones[1].type, 3);
		assert.ok(equalBytes(writeGnd(back), bytes));
	}
});

test('a texture name written back keeps the padding official files carry', async () => {
	const { Writer, Reader } = await lib('binary.js');
	const raw = new Uint8Array(12).fill(0);
	raw.set([0x61, 0x62, 0x63, 0, 0x7a, 0x7a], 0); // "abc", NUL, then leftovers
	const w = new Writer();
	w.str('abc', 12, raw);
	assert.deepEqual(Array.from(w.result()), Array.from(raw), 'unchanged text keeps its leftover bytes');
	const w2 = new Writer();
	w2.str('abd', 12, raw);
	assert.equal(new Reader(w2.result()).str(12), 'abd');
	assert.equal(w2.result()[4], 0, 'changed text is padded clean');
});

test('Korean file names round trip through CP949', async () => {
	const { encodeName, decodeName } = await lib('cp949.js');
	for (const name of ['필드바닥\\prt_초원01.bmp', '프론테라\\분수대.rsm', '유저인터페이스\\map\\x.bmp', 'plain.bmp']) {
		const bin = encodeName(name);
		assert.ok([...bin].every(c => c.charCodeAt(0) < 256), 'a binary string');
		assert.equal(decodeName(bin), name);
	}
	assert.throws(() => encodeName('emoji 🙂'), /CP949/);
});

/** A minimal RSM 1.4 model: one node, one triangle, one texture. */
function tinyRsm() {
	const parts = [];
	const buf = [];
	const u8 = v => buf.push(v & 255);
	const i32 = v => { const b = Buffer.alloc(4); b.writeInt32LE(v); buf.push(...b); };
	const f32 = v => { const b = Buffer.alloc(4); b.writeFloatLE(v); buf.push(...b); };
	const str = (s, n) => { const b = Buffer.alloc(n); b.write(s, 'latin1'); buf.push(...b); };
	const u16 = v => { const b = Buffer.alloc(2); b.writeUInt16LE(v); buf.push(...b); };
	str('GRSM', 4); u8(1); u8(4); i32(0); i32(1); u8(255);
	for (let i = 0; i < 16; i++) u8(0);
	i32(1); str('tex.bmp', 40); // textures
	str('main', 40); // main node name
	i32(1); // nodes
	str('main', 40); str('', 40);
	i32(1); i32(0); // node textures
	for (const v of [1, 0, 0, 0, 1, 0, 0, 0, 1]) f32(v); // mat3
	f32(0); f32(0); f32(0); // offset
	f32(0); f32(0); f32(0); f32(0); f32(0); f32(1); f32(0); f32(1); f32(1); f32(1); // pos, rotangle, axis, scale
	i32(3); for (const v of [[0, 0, 0], [10, 0, 0], [0, -10, 0]]) v.forEach(f32);
	i32(3); for (let i = 0; i < 3; i++) { i32(0); f32(i / 2); f32(i / 3); }
	i32(1); u16(0); u16(1); u16(2); u16(0); u16(1); u16(2); u16(0); u16(0); i32(0); i32(0);
	i32(0); // scale keyframes (1.6+ only, but harmless here: read as rot count 0)
	i32(0); // rot keyframes
	i32(0); // pos keyframes (<1.6)
	i32(0); // volume boxes
	void parts;
	return new Uint8Array(buf);
}

test('a model is read and compiled into one mesh per texture', async () => {
	const { readRsm, compileModel, instanceMatrix } = await lib('rsm.js');
	const model = readRsm(tinyRsm());
	assert.equal(model.nodes.length, 1);
	assert.equal(model.textures[0], 'tex.bmp');
	const { meshes, box } = compileModel(model);
	assert.equal(meshes.length, 1);
	assert.equal(meshes[0].data.length, 27, 'three vertices of nine floats');
	// Models stand on the origin, centred, up being -y (roBrowser's compile).
	assert.ok(Math.abs(box.max[1]) < 1e-5, 'the model stands on y = 0');
	const m = instanceMatrix(model, { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] }, 20, 30);
	assert.equal(m[12], 20, 'placed relative to the map centre');
	assert.equal(m[14], 30);
});

test('BMP pictures round trip, magenta is transparent and does not bleed', async () => {
	const { encodeBmp, decodeImage } = await lib('image.js');
	const img = { width: 3, height: 2, data: new Uint8ClampedArray([255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 10, 20, 30, 255, 40, 50, 60, 255, 70, 80, 90, 0]) };
	const back = decodeImage(encodeBmp(img));
	assert.equal(back.width, 3);
	assert.deepEqual(Array.from(back.data.slice(0, 12)), [255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255]);
	// The last pixel was written magenta; it reads back transparent, its colour
	// taken from its neighbours rather than pink.
	assert.equal(back.data[23], 0);
	assert.notDeepEqual(Array.from(back.data.slice(20, 23)), [255, 0, 255]);
});

test('PNG screenshots from Node are valid', async () => {
	const { encodePng } = await lib('image.js');
	const png = encodePng({ width: 2, height: 2, data: new Uint8ClampedArray(16).fill(200) });
	assert.deepEqual(Array.from(png.slice(0, 8)), [137, 80, 78, 71, 13, 10, 26, 10]);
	assert.ok(Buffer.from(png).includes(Buffer.from('IEND')));
});
