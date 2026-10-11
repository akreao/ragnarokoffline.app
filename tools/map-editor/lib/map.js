// The map being edited: its three geometry files, the gameplay on it and its
// properties, plus the geometry helpers every tool shares.
//
// Coordinates, everywhere in the editor:
//   - a *cell* (x, y) is a .gat cell, the server's coordinate; y grows north;
//   - a *cube* (cx, cy) is a .gnd cube, two cells across: cx = x >> 1;
//   - *world* units are cells, with y (height) pointing down, as roBrowser
//     draws: a file height h is at world y = h / 5.
// The .rsw places objects relative to the map's centre in file units, so a
// model at world (wx, wz) has position [(wx - gndWidth) * 5, y, (wz - gndHeight) * 5].

import { readGat, writeGat, createGat } from './gat.js';
import { readGnd, writeGnd, createGnd, plainLightmap, LIGHTMAP_SIZE } from './gnd.js';
import { readRsw, writeRsw, createRsw, buildQuadtree, rswVersion } from './rsw.js';

export const MAX_NAME = 11;

export function checkName(name) {
	if (!/^[a-z0-9_@-]{1,11}$/.test(name || '')) {
		throw new Error(`"${name}" is not a usable map name: 1 to ${MAX_NAME} characters, lowercase letters, digits, _ and -`);
	}
	return name;
}

/** Fresh gameplay and property sections for a map. */
export function emptyGameplay() {
	return { npcs: [], warps: [], spawns: [], signboards: [], population: null, nextId: 1 };
}
export function emptyProps() {
	return { sky: null, clouds: null, weather: null, bgm: null, displayName: '', fog: null };
}

/**
 * A new map: `width` x `height` cells (rounded up to even), flat, walkable,
 * one ground texture, walled off at the edge so nobody walks off the world.
 */
export function createMap({ name, width = 80, height = 80, texture = 'BACKSIDE.BMP', height0 = 0, walls = true } = {}) {
	checkName(name);
	width = Math.max(2, Math.ceil(width / 2) * 2);
	height = Math.max(2, Math.ceil(height / 2) * 2);
	const gnd = createGnd(width / 2, height / 2, [texture]);
	gnd.heights.fill(height0);
	const gat = createGat(width, height, 0);
	gat.heights.fill(height0);
	if (walls) {
		for (let x = 0; x < width; x++) { gat.types[x] = 1; gat.types[(height - 1) * width + x] = 1; }
		for (let y = 0; y < height; y++) { gat.types[y * width] = 1; gat.types[y * width + width - 1] = 1; }
	}
	const rsw = createRsw(name);
	const doc = { name, gat, gnd, rsw, gameplay: emptyGameplay(), props: emptyProps(), source: { kind: 'new' } };
	refreshQuadtree(doc);
	return doc;
}

/** A map from its three files (Uint8Arrays). `gat` may be missing: it is derived. */
export function openMap({ name, gat, gnd, rsw, source }) {
	const g = readGnd(gnd);
	const w = rsw ? readRsw(rsw) : createRsw(name);
	const doc = {
		name, gnd: g, rsw: w,
		gat: gat ? readGat(gat) : null,
		gameplay: emptyGameplay(), props: emptyProps(),
		source: source || { kind: 'files' },
	};
	if (!doc.gat) { doc.gat = createGat(g.width * 2, g.height * 2); syncGat(doc); }
	if (doc.gat.width !== g.width * 2 || doc.gat.height !== g.height * 2) {
		doc.warnings = [`${name}.gat is ${doc.gat.width}x${doc.gat.height} but the ground is ${g.width}x${g.height} cubes (${g.width * 2}x${g.height * 2} cells)`];
	}
	return doc;
}

/** The three files, as bytes, named as they go in a mod's data/. */
export function mapFiles(doc) {
	doc.rsw.files.gnd = doc.rsw.files.gnd || `${doc.name}.gnd`;
	doc.rsw.files.gat = doc.rsw.files.gat || `${doc.name}.gat`;
	return {
		[`${doc.name}.gat`]: writeGat(doc.gat),
		[`${doc.name}.gnd`]: writeGnd(doc.gnd),
		[`${doc.name}.rsw`]: writeRsw(doc.rsw),
	};
}

/**
 * Give the map a new name (saving an official map as a new one): the .rsw's
 * file references follow, keeping the rest of the map as it was.
 */
export function renameMap(doc, name) {
	checkName(name);
	doc.name = name;
	doc.rsw.files.gnd = `${name}.gnd`;
	doc.rsw.files.gat = `${name}.gat`;
	if (doc.rsw.fileFields) { delete doc.rsw.fileFields.gnd; delete doc.rsw.fileFields.gat; }
	for (const list of [doc.gameplay.npcs, doc.gameplay.warps, doc.gameplay.spawns, doc.gameplay.signboards]) {
		for (const item of list) if (item.map) item.map = name;
	}
}

// ---- Ground geometry

export const cellsWide = doc => doc.gat.width;
export const cellsHigh = doc => doc.gat.height;

export function cubeIndex(doc, cx, cy) {
	if (cx < 0 || cy < 0 || cx >= doc.gnd.width || cy >= doc.gnd.height) return -1;
	return cy * doc.gnd.width + cx;
}

/**
 * The ground's height (world units, down) at a point in cells, from the
 * cube under it, bilinear over its four corners as the mesh is drawn.
 */
export function groundHeight(doc, x, y) {
	const g = doc.gnd;
	const fx = x / 2, fy = y / 2;
	const cx = Math.min(g.width - 1, Math.max(0, Math.floor(fx)));
	const cy = Math.min(g.height - 1, Math.max(0, Math.floor(fy)));
	const u = Math.min(1, Math.max(0, fx - cx)), v = Math.min(1, Math.max(0, fy - cy));
	const i = (cy * g.width + cx) * 4;
	const h = g.heights;
	const top = h[i] * (1 - u) + h[i + 1] * u;
	const bottom = h[i + 2] * (1 - u) + h[i + 3] * u;
	return (top * (1 - v) + bottom * v) / 5;
}

/** The .gat cell's own height (world units), the centre of its four corners. */
export function cellHeight(doc, x, y) {
	const i = (y * doc.gat.width + x) * 4;
	const h = doc.gat.heights;
	return (h[i] + h[i + 1] + h[i + 2] + h[i + 3]) / 20;
}

export function waterLevel(doc) {
	const w = doc.rsw.water || doc.gnd.water;
	return w ? w.level : null;
}

export function setWater(doc, values) {
	if (rswVersion(doc.rsw) >= 2.6) {
		// 2.6 keeps the water in the .gnd (1.8+); make sure it has a place for it.
		if (doc.gnd.version[0] + doc.gnd.version[1] / 10 < 1.8) doc.gnd.version = [1, 8];
		doc.gnd.water = { ...(doc.gnd.water || { level: 0, type: 0, waveHeight: 1, waveSpeed: 2, wavePitch: 50, animSpeed: 3, splitWidth: 1, splitHeight: 1, zones: [] }), ...values };
		doc.gnd.water.zones = (doc.gnd.water.zones || []).map(z => ({ ...z, ...values }));
	} else {
		doc.rsw.water = { ...(doc.rsw.water || { level: 0, type: 0, waveHeight: 1, waveSpeed: 2, wavePitch: 50, animSpeed: 3 }), ...values };
		if (doc.gnd.water) doc.gnd.water = { ...doc.gnd.water, ...values };
	}
}

export function getWater(doc) {
	return rswVersion(doc.rsw) >= 2.6 ? doc.gnd.water : doc.rsw.water || doc.gnd.water;
}

/**
 * Walkability from the ground, for cells in the rectangle (all when omitted):
 * each .gat cell takes its four corner heights from the cube it is a quarter
 * of, and its type from the ground -- walkable when gentle, blocked when steep,
 * blocked where there is no ground or where it meets a cliff (rAthena's path
 * search ignores heights, so a cliff a player could walk off has to be
 * blocked) -- and walkable water below the water line, as rAthena works it out
 * itself. Cells the author painted by hand (`doc.gatLocked`) keep their type,
 * and a blocked cell on the map's outer edge stays blocked.
 *
 * `slope` is the largest height difference across a cell, in world units
 * (cells are 1 across), that still walks.
 */
export function syncGat(doc, rect = null, { slope = 1.5, types = true } = {}) {
	const gat = doc.gat, gnd = doc.gnd;
	const x0 = rect ? Math.max(0, rect.x0) : 0, y0 = rect ? Math.max(0, rect.y0) : 0;
	const x1 = rect ? Math.min(gat.width - 1, rect.x1) : gat.width - 1, y1 = rect ? Math.min(gat.height - 1, rect.y1) : gat.height - 1;
	const h = gnd.heights;
	const cornersOf = (x, y) => {
		const cx = x >> 1, cy = y >> 1;
		if (cx < 0 || cy < 0 || cx >= gnd.width || cy >= gnd.height) return null;
		const ci = (cy * gnd.width + cx) * 4;
		const fx0 = (x & 1) * 0.5, fy0 = (y & 1) * 0.5;
		const at = (u, v) => (h[ci] * (1 - u) + h[ci + 1] * u) * (1 - v) + (h[ci + 2] * (1 - u) + h[ci + 3] * u) * v;
		return [at(fx0, fy0), at(fx0 + 0.5, fy0), at(fx0, fy0 + 0.5), at(fx0 + 0.5, fy0 + 0.5)];
	};
	const limit = slope * 5;
	const water = waterLevel(doc);
	for (let y = y0; y <= y1; y++) {
		for (let x = x0; x <= x1; x++) {
			const corners = cornersOf(x, y);
			if (!corners) continue;
			const gi = (y * gat.width + x) * 4;
			gat.heights[gi] = corners[0]; gat.heights[gi + 1] = corners[1]; gat.heights[gi + 2] = corners[2]; gat.heights[gi + 3] = corners[3];
			if (!types) continue;
			const cell = y * gat.width + x;
			if (doc.gatLocked && doc.gatLocked[cell]) continue;
			const edge = x === 0 || y === 0 || x === gat.width - 1 || y === gat.height - 1;
			if (edge && gat.types[cell] === 1) continue;
			const hole = gnd.up[(y >> 1) * gnd.width + (x >> 1)] < 0;
			let steep = Math.max(...corners) - Math.min(...corners) > limit;
			// A cliff: an edge this cell shares with a neighbour, at a different height.
			if (!steep) {
				const e = cornersOf(x + 1, y), w = cornersOf(x - 1, y), n = cornersOf(x, y + 1), s = cornersOf(x, y - 1);
				steep = (e && (Math.abs(e[0] - corners[1]) > limit || Math.abs(e[2] - corners[3]) > limit))
					|| (w && (Math.abs(w[1] - corners[0]) > limit || Math.abs(w[3] - corners[2]) > limit))
					|| (n && (Math.abs(n[0] - corners[2]) > limit || Math.abs(n[1] - corners[3]) > limit))
					|| (s && (Math.abs(s[2] - corners[0]) > limit || Math.abs(s[3] - corners[1]) > limit));
			}
			let type = hole || steep ? 1 : 0;
			// rAthena's own rule (map_cache, and the supervisor's mapcache.rs):
			// walkable ground below the water line is walkable water.
			if (type === 0 && water !== null && corners[0] > water) type = 3;
			gat.types[cell] = type;
		}
	}
}

/**
 * After the water moved: walkable cells become walkable water below the line
 * and walkable ground above it. Nothing else changes, so an official map's
 * hand-made walkability survives a change of water.
 */
export function syncWater(doc) {
	const gat = doc.gat;
	const water = waterLevel(doc);
	for (let i = 0; i < gat.width * gat.height; i++) {
		const t = gat.types[i];
		if (t !== 0 && t !== 3) continue;
		if (doc.gatLocked && doc.gatLocked[i]) continue;
		gat.types[i] = water !== null && gat.heights[i * 4] > water ? 3 : 0;
	}
}

/** The bounds the .rsw records (and the quadtree covers), in file units. */
export function refreshQuadtree(doc) {
	const g = doc.gnd;
	let minY = Infinity, maxY = -Infinity;
	for (const v of g.heights) { if (v < minY) minY = v; if (v > maxY) maxY = v; }
	if (!Number.isFinite(minY)) { minY = 0; maxY = 0; }
	// Room above the ground for the models standing on it.
	for (const o of doc.rsw.objects) if (o.type === 1) { minY = Math.min(minY, o.position[1] - 200); }
	const halfW = g.width * g.zoom / 2, halfH = g.height * g.zoom / 2;
	doc.rsw.ground = { top: -Math.ceil(halfH), bottom: Math.ceil(halfH), left: -Math.ceil(halfW), right: Math.ceil(halfW) };
	if (rswVersion(doc.rsw) >= 2.1) doc.rsw.quadtree = buildQuadtree({ minX: -halfW, maxX: halfW, minZ: -halfH, maxZ: halfH, minY, maxY });
}

// ---- Tiles and lightmaps

/**
 * A tile that only this surface uses, so painting it changes nothing else.
 * Official maps share some tiles between cubes; the first edit splits them.
 */
export function ownTile(doc, surface, cubeI) {
	const g = doc.gnd;
	const key = surface === 'up' ? g.up : surface === 'front' ? g.front : g.right;
	const t = key[cubeI];
	if (t < 0) return -1;
	if (!doc._tileUse) doc._tileUse = countTileUse(g);
	if ((doc._tileUse[t] || 0) <= 1) return t;
	const copy = structuredCloneTile(g.tiles[t]);
	g.tiles.push(copy);
	doc._tileUse[t]--;
	doc._tileUse[g.tiles.length - 1] = 1;
	key[cubeI] = g.tiles.length - 1;
	return g.tiles.length - 1;
}

export function countTileUse(g) {
	const use = new Map();
	const add = t => { if (t >= 0) use.set(t, (use.get(t) || 0) + 1); };
	for (let i = 0; i < g.up.length; i++) { add(g.up[i]); add(g.front[i]); add(g.right[i]); }
	return new Proxy({}, { get: (_, k) => use.get(Number(k)) || 0, set: (_, k, v) => { use.set(Number(k), v); return true; } });
}

export function structuredCloneTile(t) {
	return { u: t.u.slice(), v: t.v.slice(), texture: t.texture, light: t.light, color: t.color.slice() };
}

/** The index of a ground texture, adding it to the .gnd's list when new. */
export function textureIndex(doc, name) {
	const g = doc.gnd;
	let i = g.textures.indexOf(name);
	if (i < 0) {
		if (name.length >= g.nameLength) throw new Error(`texture path "${name}" is longer than ${g.nameLength - 1} bytes`);
		g.textures.push(name);
		if (g.textureFields) g.textureFields.push(null);
		i = g.textures.length - 1;
	}
	return i;
}

/** A tile for a new surface: whole texture, plain lightmap (index 0 made plain if needed). */
export function newTile(doc, texture, uv = { u: [0, 1, 0, 1], v: [0, 0, 1, 1] }) {
	const g = doc.gnd;
	g.tiles.push({ u: uv.u.slice(), v: uv.v.slice(), texture, light: plainLightmapIndex(doc), color: [255, 255, 255, 255] });
	if (doc._tileUse) doc._tileUse[g.tiles.length - 1] = 0;
	return g.tiles.length - 1;
}

/** A lightmap that is fully lit with no colour, adding one when the map has none. */
export function plainLightmapIndex(doc) {
	const lm = doc.gnd.lightmap;
	if (doc._plainLight !== undefined && doc._plainLight < lm.count) return doc._plainLight;
	const plain = plainLightmap();
	for (let i = 0; i < lm.count; i++) {
		let same = true;
		for (let j = 0; j < LIGHTMAP_SIZE && same; j++) if (lm.data[i * LIGHTMAP_SIZE + j] !== plain[j]) same = false;
		if (same) { doc._plainLight = i; return i; }
	}
	const data = new Uint8Array(lm.data.length + LIGHTMAP_SIZE);
	data.set(lm.data); data.set(plain, lm.data.length);
	lm.data = data; lm.count++;
	doc._plainLight = lm.count - 1;
	return doc._plainLight;
}

/** Clear cached derived data after an undo or a reload. */
export function forgetDerived(doc) {
	delete doc._tileUse;
	delete doc._plainLight;
}
