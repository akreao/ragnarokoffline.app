// .gnd: the ground the client draws. One cube per two server cells.
//
//   "GRGN", major, minor, width u32, height u32, zoom f32
//   textures:  count u32, name length u32 (80), names
//   lightmaps: count, per-cell x, per-cell y, cell size (i32 each), then
//              count * 8*8*(1+3) bytes: 64 shadow bytes, 64 RGB triples
//   tiles:     count u32; each u1..u4 v1..v4 (f32), texture u16, lightmap
//              u16, colour BGRA
//   cubes:     width*height of: four corner heights (f32), then the tile
//              on top, on the north face and on the east face (i32, -1 none)
//   1.8+:      water (level, type, wave height/speed/pitch, anim speed,
//              split w/h); 1.9+: a water zone per split
//
// Read as roBrowser's Loaders/Ground.js reads it (versions 1.7 to 1.9), and
// written back byte for byte. Heights stay in file units (positive down; the
// renderer divides by 5, as roBrowser does).
//
// A lightmap is NOT a brightness: it is 64 bytes of shadow (255 = lit) then
// 64 RGB triples of light *added* on top. Fill one with 0xff and the ground
// renders as a white sheet. LIGHTMAP_PLAIN is the neutral one.

import { Reader, Writer } from './binary.js';

export const LIGHTMAP_SIZE = 256; // 8*8 shadow + 8*8*3 colour

/** A neutral lightmap: fully lit, no added colour. */
export function plainLightmap() {
	const lm = new Uint8Array(LIGHTMAP_SIZE);
	lm.fill(255, 0, 64);
	return lm;
}

export function readGnd(bytes) {
	const r = new Reader(bytes);
	const magic = r.str(4);
	if (magic !== 'GRGN') throw new Error(`not a .gnd file (starts "${magic}")`);
	const major = r.u8v(), minor = r.u8v();
	const version = major + minor / 10;
	if (version < 1.7) throw new Error(`.gnd version ${major}.${minor} is older than the client reads (1.7 to 1.9)`);
	const width = r.u32(), height = r.u32();
	const zoom = r.f32();
	if (!width || !height || width > 2048 || height > 2048) throw new Error(`impossible .gnd size ${width}x${height}`);

	const textureCount = r.u32();
	const nameLength = r.u32();
	const textures = [];
	const textureFields = [];
	for (let i = 0; i < textureCount; i++) {
		const raw = r.field(nameLength);
		textureFields.push(raw);
		let s = '';
		for (const c of raw) { if (c === 0) break; s += String.fromCharCode(c); }
		textures.push(s);
	}

	const lmCount = r.i32();
	const lmPerX = r.i32(), lmPerY = r.i32(), lmSize = r.i32();
	const perCell = lmPerX * lmPerY * lmSize;
	const lightmaps = r.bytes(lmCount * perCell * 4);

	const tileCount = r.u32();
	const tiles = new Array(tileCount);
	for (let i = 0; i < tileCount; i++) {
		const u = [r.f32(), r.f32(), r.f32(), r.f32()];
		const v = [r.f32(), r.f32(), r.f32(), r.f32()];
		const texture = r.u16();
		const light = r.u16();
		const color = [r.u8v(), r.u8v(), r.u8v(), r.u8v()];
		tiles[i] = { u, v, texture, light, color };
	}

	const n = width * height;
	const heights = new Float32Array(n * 4);
	const up = new Int32Array(n), front = new Int32Array(n), right = new Int32Array(n);
	for (let i = 0; i < n; i++) {
		heights[i * 4] = r.f32();
		heights[i * 4 + 1] = r.f32();
		heights[i * 4 + 2] = r.f32();
		heights[i * 4 + 3] = r.f32();
		up[i] = r.i32();
		front[i] = r.i32();
		right[i] = r.i32();
	}

	let water = null;
	if (version >= 1.8) {
		water = {
			level: r.f32(), type: r.i32(), waveHeight: r.f32(), waveSpeed: r.f32(), wavePitch: r.f32(), animSpeed: r.i32(),
			splitWidth: r.i32(), splitHeight: r.i32(), zones: [],
		};
		if (version >= 1.9) {
			for (let i = 0, c = water.splitWidth * water.splitHeight; i < c; i++) {
				water.zones.push({ level: r.f32(), type: r.i32(), waveHeight: r.f32(), waveSpeed: r.f32(), wavePitch: r.f32(), animSpeed: r.i32() });
			}
		}
	}

	return {
		version: [major, minor], width, height, zoom,
		textures, textureFields, nameLength,
		lightmap: { perX: lmPerX, perY: lmPerY, size: lmSize, count: lmCount, data: lightmaps },
		tiles, heights, up, front, right, water,
		trailing: r.remaining ? r.bytes(r.remaining) : null,
	};
}

export function writeGnd(g) {
	const n = g.width * g.height;
	const w = new Writer(64 + g.textures.length * g.nameLength + g.lightmap.data.length + g.tiles.length * 40 + n * 28 + 64);
	const version = g.version[0] + g.version[1] / 10;
	w.str('GRGN', 4);
	w.u8v(g.version[0]).u8v(g.version[1]);
	w.u32(g.width).u32(g.height).f32(g.zoom);
	w.u32(g.textures.length).u32(g.nameLength);
	g.textures.forEach((name, i) => w.str(name, g.nameLength, g.textureFields && g.textureFields[i]));
	const lm = g.lightmap;
	const perCell = lm.perX * lm.perY * lm.size;
	if (lm.data.length !== lm.count * perCell * 4) throw new Error(`lightmap data is ${lm.data.length} bytes for ${lm.count} lightmaps`);
	w.i32(lm.count).i32(lm.perX).i32(lm.perY).i32(lm.size);
	w.bytes(lm.data);
	w.u32(g.tiles.length);
	for (const t of g.tiles) {
		w.f32(t.u[0]).f32(t.u[1]).f32(t.u[2]).f32(t.u[3]);
		w.f32(t.v[0]).f32(t.v[1]).f32(t.v[2]).f32(t.v[3]);
		w.u16(t.texture).u16(t.light);
		w.u8v(t.color[0]).u8v(t.color[1]).u8v(t.color[2]).u8v(t.color[3]);
	}
	for (let i = 0; i < n; i++) {
		w.f32(g.heights[i * 4]).f32(g.heights[i * 4 + 1]).f32(g.heights[i * 4 + 2]).f32(g.heights[i * 4 + 3]);
		w.i32(g.up[i]).i32(g.front[i]).i32(g.right[i]);
	}
	if (version >= 1.8) {
		const wt = g.water || defaultGndWater();
		w.f32(wt.level).i32(wt.type).f32(wt.waveHeight).f32(wt.waveSpeed).f32(wt.wavePitch).i32(wt.animSpeed);
		w.i32(wt.splitWidth).i32(wt.splitHeight);
		if (version >= 1.9) {
			const count = wt.splitWidth * wt.splitHeight;
			for (let i = 0; i < count; i++) {
				const z = wt.zones[i] || wt;
				w.f32(z.level).i32(z.type).f32(z.waveHeight).f32(z.waveSpeed).f32(z.wavePitch).i32(z.animSpeed);
			}
		}
	}
	if (g.trailing) w.bytes(g.trailing);
	return w.result();
}

export function defaultGndWater() {
	return { level: 0, type: 0, waveHeight: 1, waveSpeed: 2, wavePitch: 50, animSpeed: 3, splitWidth: 1, splitHeight: 1, zones: [] };
}

/**
 * A flat ground: every cube gets its own tile on `texture` (0) and the plain
 * lightmap. `width`/`height` are in cubes (half the .gat's cells).
 */
export function createGnd(width, height, textures = ['backside.bmp'], span = 4) {
	const n = width * height;
	const tiles = [];
	const up = new Int32Array(n), front = new Int32Array(n).fill(-1), right = new Int32Array(n).fill(-1);
	for (let i = 0; i < n; i++) {
		up[i] = tiles.length;
		tiles.push({ ...tileUV(0, false, false, span, i % width, Math.floor(i / width)), texture: 0, light: 0, color: [255, 255, 255, 255] });
	}
	return {
		version: [1, 7], width, height, zoom: 10,
		textures: textures.slice(), textureFields: null, nameLength: 80,
		lightmap: { perX: 8, perY: 8, size: 1, count: 1, data: plainLightmap() },
		tiles, heights: new Float32Array(n * 4), up, front, right, water: null, trailing: null,
	};
}

/**
 * A tile's UVs: the texture turned `rot` quarter turns and maybe mirrored,
 * and stretched over `span` x `span` cubes (official maps lay most ground
 * textures over 4x4), this cube being (cx, cy) of the map.
 */
export function tileUV(rot = 0, flipX = false, flipY = false, span = 1, cx = 0, cy = 0) {
	const s = Math.max(1, span | 0);
	const u0 = (((cx % s) + s) % s) / s, v0 = (((cy % s) + s) % s) / s, d = 1 / s;
	// Corners in file order: (x,y) (x+1,y) (x,y+1) (x+1,y+1).
	let c = [[0, 0], [1, 0], [0, 1], [1, 1]];
	if (flipX) c = c.map(([u, v]) => [1 - u, v]);
	if (flipY) c = c.map(([u, v]) => [u, 1 - v]);
	for (let i = 0; i < (rot & 3); i++) c = c.map(([u, v]) => [1 - v, u]);
	// v runs down the texture while the cube's y runs north: flip so a
	// texture reads the right way up from the default camera.
	return { u: c.map(p => u0 + p[0] * d), v: c.map(p => 1 - (v0 + p[1] * d)) };
}
