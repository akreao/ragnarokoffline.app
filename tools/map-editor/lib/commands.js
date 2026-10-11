// Every edit the map editor can make, as a named command with typed
// arguments. The page's tools, its keyboard shortcuts, the CLI and the MCP
// tools all run these, so an agent can do anything a person can, and both
// get the same undo.
//
// A command is { group, describe, args: { name: [type, description, optional] },
// parts: [...] | (args) => [...], run(doc, args, env) }. `parts` are what it
// changes, for undo (history.js). `run` returns { result, refresh }, where
// refresh says what the view must rebuild: { ground: rect|true, gat: rect|true,
// objects, gameplay, props, textures, lightmaps, light, water, whole }.
//
// Units, for every command:
//   x, y      server cells (what /where says); y grows north
//   height    cells *up* from zero (a cell is 1 across); the files store -5x
//   radius    cells
//   angles    degrees

import { groundHeight, syncGat, syncWater, ownTile, textureIndex, newTile, plainLightmapIndex, setWater, getWater, refreshQuadtree, forgetDerived, renameMap, checkName, countTileUse } from './map.js';
import { tileUV, plainLightmap, LIGHTMAP_SIZE } from './gnd.js';
import { OBJECT, setLightColor, lightColor, NO_WATER } from './rsw.js';
import { encodeName, decodeName } from './cp949.js';
import { SPAWN_KINDS, functionName } from './script.js';

const WEATHERS = ['snow', 'rain', 'fireworks', 'leaves', 'sakura', 'cloud', 'cloud2', 'cloud3', 'cloud4', 'cloud5', 'cloud6', 'cloud7', 'cloud8'];

// ---- Helpers

const num = (v, name, def) => {
	if (v === undefined || v === null || v === '') { if (def !== undefined) return def; throw new Error(`${name} is required`); }
	const n = Number(v);
	if (!Number.isFinite(n)) throw new Error(`${name} must be a number, not ${JSON.stringify(v)}`);
	return n;
};
const int = (v, name, def) => Math.round(num(v, name, def));
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const toFile = h => -5 * h;
const fromFile = h => -h / 5;

function cellsIn(doc, a) {
	if (a.x0 !== undefined) {
		const x0 = clamp(int(Math.min(a.x0, a.x1), 'x0'), 0, doc.gat.width - 1), x1 = clamp(int(Math.max(a.x0, a.x1), 'x1'), 0, doc.gat.width - 1);
		const y0 = clamp(int(Math.min(a.y0, a.y1), 'y0'), 0, doc.gat.height - 1), y1 = clamp(int(Math.max(a.y0, a.y1), 'y1'), 0, doc.gat.height - 1);
		return { x0, y0, x1, y1, weight: () => 1 };
	}
	const x = num(a.x, 'x'), y = num(a.y, 'y'), r = Math.max(0.5, num(a.radius, 'radius', 1));
	return {
		x0: clamp(Math.floor(x - r), 0, doc.gat.width - 1), x1: clamp(Math.ceil(x + r), 0, doc.gat.width - 1),
		y0: clamp(Math.floor(y - r), 0, doc.gat.height - 1), y1: clamp(Math.ceil(y + r), 0, doc.gat.height - 1),
		weight: (px, py) => { const d = Math.hypot(px - x, py - y); return d > r ? 0 : 1; },
		cx: x, cy: y, r,
	};
}

/** The cube rectangle under a cell rectangle. */
const cubeRect = (doc, r) => ({ x0: Math.max(0, r.x0 >> 1), y0: Math.max(0, r.y0 >> 1), x1: Math.min(doc.gnd.width - 1, r.x1 >> 1), y1: Math.min(doc.gnd.height - 1, r.y1 >> 1) });

/**
 * The cube corners at a vertex of the corner grid (vx 0..width, vy 0..height):
 * [cubeIndex*4 + corner]. Neighbouring cubes keep their own copy of a shared
 * corner, which is how RO draws cliffs.
 */
function vertexCorners(g, vx, vy) {
	const out = [];
	const add = (cx, cy, c) => { if (cx >= 0 && cy >= 0 && cx < g.width && cy < g.height) out.push((cy * g.width + cx) * 4 + c); };
	add(vx, vy, 0); add(vx - 1, vy, 1); add(vx, vy - 1, 2); add(vx - 1, vy - 1, 3);
	return out;
}

function objIndexes(doc, a, type) {
	let list = a.indexes ?? a.index;
	if (list === undefined) throw new Error('which object? give index or indexes');
	if (!Array.isArray(list)) list = String(list).split(',').map(s => s.trim()).filter(Boolean);
	const out = list.map(v => int(v, 'index'));
	for (const i of out) {
		const o = doc.rsw.objects[i];
		if (!o) throw new Error(`there is no object ${i} (the map has ${doc.rsw.objects.length})`);
		if (type && o.type !== type) throw new Error(`object ${i} is not a ${Object.keys(OBJECT).find(k => OBJECT[k] === type).toLowerCase()}`);
	}
	return out;
}

/** Cell coordinates <-> .rsw position (file units, relative to the map's centre). */
export function cellToRsw(doc, x, y, h) {
	return [(x + 0.5 - doc.gnd.width) * 5, h === undefined ? groundHeight(doc, x + 0.5, y + 0.5) * 5 : toFile(h), (y + 0.5 - doc.gnd.height) * 5];
}
export function rswToCell(doc, p) {
	return { x: p[0] / 5 + doc.gnd.width - 0.5, y: p[2] / 5 + doc.gnd.height - 0.5, height: fromFile(p[1]) };
}

function describeObject(doc, o, index) {
	const c = rswToCell(doc, o.position);
	const base = { index, type: ['', 'model', 'light', 'sound', 'effect'][o.type], x: +c.x.toFixed(2), y: +c.y.toFixed(2), height: +c.height.toFixed(2), name: decodeName(o.name || '') };
	if (o.type === OBJECT.MODEL) return { ...base, file: decodeName(o.file), rotation: o.rotation.map(v => +v.toFixed(2)), scale: o.scale.map(v => +v.toFixed(3)) };
	if (o.type === OBJECT.LIGHT) return { ...base, color: lightColor(o).map(v => +v.toFixed(3)), range: o.range };
	if (o.type === OBJECT.SOUND) return { ...base, file: decodeName(o.file), volume: o.volume, range: o.range, cycle: o.cycle };
	return { ...base, effect: o.id, delay: o.delay, param: o.param };
}

function gameplayList(doc, kind) {
	if (kind === 'npc') return doc.gameplay.npcs;
	if (kind === 'warp') return doc.gameplay.warps;
	if (kind === 'spawn') return doc.gameplay.spawns;
	throw new Error(`no gameplay list ${kind}`);
}

function findGameplay(doc, id) {
	for (const [kind, list] of [['npc', doc.gameplay.npcs], ['warp', doc.gameplay.warps], ['spawn', doc.gameplay.spawns]]) {
		const i = list.findIndex(o => o.id === id);
		if (i >= 0) return { kind, list, i, obj: list[i] };
	}
	throw new Error(`there is no marker ${id}`);
}

function nextId(doc, prefix) {
	return `${prefix}-${doc.gameplay.nextId++}`;
}

// rAthena's NPC_NAME_LENGTH: 24 bytes, the #suffix included.
const NPC_NAME = 24;

function npcName(doc, name) {
	let base = String(name || 'NPC').replace(/[\t\n\r,]/g, ' ').trim() || 'NPC';
	// A unique # suffix: rAthena refuses two NPCs with the same full name.
	let [shown, suffix] = base.includes('#') ? [base.slice(0, base.indexOf('#')), base.slice(base.indexOf('#'))] : [base, `#${doc.name}`];
	const fit = (s, extra = '') => `${s.slice(0, Math.max(1, NPC_NAME - suffix.length - extra.length))}${suffix}${extra}`.slice(0, NPC_NAME);
	const taken = new Set([...doc.gameplay.npcs, ...doc.gameplay.warps].map(o => o.name));
	if (!taken.has(fit(shown))) return fit(shown);
	for (let i = 2; ; i++) if (!taken.has(fit(shown, String(i)))) return fit(shown, String(i));
}

function checkCell(doc, x, y, what = 'cell') {
	if (x < 0 || y < 0 || x >= doc.gat.width || y >= doc.gat.height) throw new Error(`${what} ${x},${y} is off the map (it is ${doc.gat.width}x${doc.gat.height})`);
}

function color3(v, name) {
	if (v === undefined || v === null) return null;
	const list = typeof v === 'string' ? (v.startsWith('#') ? [1, 3, 5].map(i => parseInt(v.slice(i, i + 2), 16) / 255) : v.split(',').map(Number)) : v;
	if (!Array.isArray(list) || list.length < 3 || list.slice(0, 3).some(c => !Number.isFinite(Number(c)))) throw new Error(`${name} must be three numbers from 0 to 1, or #rrggbb`);
	return list.slice(0, 3).map(c => clamp(Number(c), 0, 1));
}

// ---- The commands

export const COMMANDS = {
	// ---- Map
	'map.info': {
		group: 'map', describe: 'Size, textures, object counts, water, light, gameplay and properties of the open map.',
		args: {}, parts: [],
		run(doc) {
			const counts = { models: 0, lights: 0, sounds: 0, effects: 0 };
			for (const o of doc.rsw.objects) counts[['', 'models', 'lights', 'sounds', 'effects'][o.type]]++;
			const types = {};
			for (const t of doc.gat.types) types[t] = (types[t] || 0) + 1;
			return {
				result: {
					name: doc.name, cells: [doc.gat.width, doc.gat.height], cubes: [doc.gnd.width, doc.gnd.height],
					versions: { gat: doc.gat.version.join('.'), gnd: doc.gnd.version.join('.'), rsw: doc.rsw.version.join('.') },
					textures: doc.gnd.textures.map(decodeName), tiles: doc.gnd.tiles.length, lightmaps: doc.gnd.lightmap.count,
					objects: counts, cellTypes: types, water: getWater(doc), light: doc.rsw.light,
					gameplay: { npcs: doc.gameplay.npcs.length, warps: doc.gameplay.warps.length, spawns: doc.gameplay.spawns.length, signboards: doc.gameplay.signboards.length, population: doc.gameplay.population },
					props: doc.props, source: doc.source,
				},
			};
		},
	},
	'map.rename': {
		group: 'map', describe: 'Rename the map (at most 11 characters: lowercase letters, digits, _ and -). Saving an official map under a new name makes it a new map rather than an override.',
		args: { name: ['string', 'The new name'] }, parts: ['whole'],
		run(doc, a) { renameMap(doc, checkName(String(a.name).trim())); return { result: { name: doc.name }, refresh: { whole: true } }; },
	},
	'map.resize': {
		group: 'map', describe: 'Change the map\'s size in cells (rounded to even). Ground, walkability, objects and markers are kept where they are; anchor says which side stays put.',
		args: { width: ['number', 'New width in cells'], height: ['number', 'New height in cells'], anchor: ['string', 'Which part stays: center (default), sw, se, nw, ne', true], texture: ['string', 'Texture for new ground (default: the first)', true] },
		parts: ['whole'],
		run(doc, a) { resize(doc, int(a.width, 'width'), int(a.height, 'height'), a.anchor || 'center'); forgetDerived(doc); return { result: { cells: [doc.gat.width, doc.gat.height] }, refresh: { whole: true } }; },
	},
	'map.crop': {
		group: 'map', describe: 'Keep only the cells in a rectangle (x0,y0)-(x1,y1); everything else is cut off.',
		args: { x0: ['number', 'West edge'], y0: ['number', 'South edge'], x1: ['number', 'East edge'], y1: ['number', 'North edge'] },
		parts: ['whole'],
		run(doc, a) {
			const x0 = Math.floor(Math.min(a.x0, a.x1) / 2) * 2, y0 = Math.floor(Math.min(a.y0, a.y1) / 2) * 2;
			const x1 = Math.ceil((Math.max(a.x0, a.x1) + 1) / 2) * 2, y1 = Math.ceil((Math.max(a.y0, a.y1) + 1) / 2) * 2;
			crop(doc, x0, y0, x1 - x0, y1 - y0);
			forgetDerived(doc);
			return { result: { cells: [doc.gat.width, doc.gat.height] }, refresh: { whole: true } };
		},
	},

	// ---- Terrain
	'terrain.brush': {
		group: 'terrain', describe: 'Sculpt the ground with a round brush: raise, lower, smooth, flatten (to the height under the centre), set (to `height`), or noise. Walkability follows the ground unless sync is false.',
		args: {
			tool: ['string', 'raise | lower | smooth | flatten | set | noise'], x: ['number', 'Centre x'], y: ['number', 'Centre y'],
			radius: ['number', 'Radius in cells', true], strength: ['number', 'Cells per application for raise/lower/noise; 0..1 for smooth/flatten (default 1 / 0.5)', true],
			height: ['number', 'Target height for set/flatten, cells up', true], falloff: ['string', 'smooth (default) or hard', true], sync: ['boolean', 'Update walkability (default true)', true],
		},
		parts: ['gnd.heights', 'gat.heights', 'gat.types'],
		run(doc, a) { const rect = brush(doc, a); return { result: { cubes: rect }, refresh: { ground: rect } }; },
	},
	'terrain.rect': {
		group: 'terrain', describe: 'Shape a rectangle of cells at once. op set puts every cube inside at `height` with hard edges (a cliff or a plateau); raise/lower move it; smooth softens it; ramp slopes it from `height` on one side to `to` on the other.',
		args: {
			x0: ['number', 'West'], y0: ['number', 'South'], x1: ['number', 'East'], y1: ['number', 'North'],
			op: ['string', 'set | raise | lower | smooth | ramp'], height: ['number', 'Height (set, ramp start) or amount (raise/lower), cells', true],
			to: ['number', 'Ramp end height', true], direction: ['string', 'Ramp: the side where it reaches `to` -- north, south, east or west (default north)', true],
			walls: ['string', 'Texture for the cliff faces this makes (default: the ground\'s)', true], sync: ['boolean', 'Update walkability (default true)', true],
		},
		parts: ['gnd.heights', 'gnd.surfaces', 'gnd.tiles', 'gnd.textures', 'gnd.lightmap', 'gat.heights', 'gat.types'],
		run(doc, a) { const rect = terrainRect(doc, a); return { result: { cubes: rect }, refresh: { ground: rect, textures: true } }; },
	},
	'terrain.corner': {
		group: 'terrain', describe: 'Set one corner of one cube (cx, cy are cube coordinates, half the cell ones; corner 0 is south-west, 1 south-east, 2 north-west, 3 north-east). Moving one cube\'s corner and not its neighbour\'s makes a sharp edge.',
		args: { cx: ['number', 'Cube x'], cy: ['number', 'Cube y'], corner: ['number', '0..3'], height: ['number', 'Height, cells up'], linked: ['boolean', 'Move the neighbours\' copies of this corner too (default false)', true] },
		parts: ['gnd.heights', 'gat.heights', 'gat.types'],
		run(doc, a) {
			const g = doc.gnd, cx = int(a.cx, 'cx'), cy = int(a.cy, 'cy'), c = int(a.corner, 'corner');
			if (cx < 0 || cy < 0 || cx >= g.width || cy >= g.height || c < 0 || c > 3) throw new Error(`no corner ${c} on cube ${cx},${cy}`);
			const h = toFile(num(a.height, 'height'));
			if (a.linked) for (const k of vertexCorners(g, cx + (c & 1), cy + (c >> 1))) g.heights[k] = h;
			else g.heights[(cy * g.width + cx) * 4 + c] = h;
			const rect = { x0: cx - 1, y0: cy - 1, x1: cx + 1, y1: cy + 1 };
			syncGat(doc, { x0: rect.x0 * 2, y0: rect.y0 * 2, x1: rect.x1 * 2 + 1, y1: rect.y1 * 2 + 1 });
			return { result: { ok: true }, refresh: { ground: rect } };
		},
	},
	'terrain.height': {
		group: 'terrain', describe: 'The ground\'s height at a cell, in cells up, and its walkability.',
		args: { x: ['number', 'x'], y: ['number', 'y'] }, parts: [],
		run(doc, a) {
			const x = int(a.x, 'x'), y = int(a.y, 'y');
			checkCell(doc, x, y);
			return { result: { height: +fromFile(groundHeight(doc, x + 0.5, y + 0.5) * 5).toFixed(3), type: doc.gat.types[y * doc.gat.width + x] } };
		},
	},

	// ---- Ground textures
	'texture.list': {
		group: 'texture', describe: 'The ground textures this map uses (index, path under data/texture/).',
		args: {}, parts: [],
		run(doc) { return { result: doc.gnd.textures.map((t, i) => ({ index: i, path: decodeName(t) })) }; },
	},
	'texture.add': {
		group: 'texture', describe: 'Add a ground texture to the map\'s list, by its path under data/texture/ (as the texture browser shows it). Returns its index.',
		args: { path: ['string', 'e.g. 유저인터페이스/... or prontera/grass.bmp'] }, parts: ['gnd.textures'],
		run(doc, a) { const i = textureIndex(doc, encodeName(String(a.path).replace(/\//g, '\\'))); return { result: { index: i }, refresh: { textures: true } }; },
	},
	'texture.paint': {
		group: 'texture', describe: 'Paint the top of the cubes under a brush (x, y, radius) or a rectangle (x0..y1) with a ground texture. span lays one copy of the texture over span x span cubes, as official maps do with 4.',
		args: {
			texture: ['string', 'Texture index, or a path under data/texture/ (added if new)'], x: ['number', 'Brush centre x', true], y: ['number', 'Brush centre y', true], radius: ['number', 'Brush radius, cells', true],
			x0: ['number', 'Rectangle west', true], y0: ['number', 'Rectangle south', true], x1: ['number', 'Rectangle east', true], y1: ['number', 'Rectangle north', true],
			rotate: ['number', 'Quarter turns 0..3', true], flipX: ['boolean', 'Mirror east-west', true], flipY: ['boolean', 'Mirror north-south', true], span: ['number', 'Cubes per texture repeat (1, 2, 4, 8; default 4)', true],
			surface: ['string', 'top (default), walls, or both', true],
		},
		parts: ['gnd.tiles', 'gnd.surfaces', 'gnd.textures', 'gnd.lightmap'],
		run(doc, a) { const rect = paintTexture(doc, a); return { result: { cubes: rect }, refresh: { ground: rect, textures: true } }; },
	},
	'texture.color': {
		group: 'texture', describe: 'Tint the top of cubes (the tile colour the client multiplies the texture by). color is #rrggbb or 0..1 numbers.',
		args: { color: ['string', '#rrggbb'], x: ['number', 'x', true], y: ['number', 'y', true], radius: ['number', 'radius', true], x0: ['number', 'west', true], y0: ['number', 'south', true], x1: ['number', 'east', true], y1: ['number', 'north', true] },
		parts: ['gnd.tiles', 'gnd.surfaces'],
		run(doc, a) {
			const c = color3(a.color, 'color');
			const sel = cellsIn(doc, a), r = cubeRect(doc, sel), g = doc.gnd;
			for (let cy = r.y0; cy <= r.y1; cy++) for (let cx = r.x0; cx <= r.x1; cx++) {
				if (!sel.weight(cx * 2 + 1, cy * 2 + 1)) continue;
				const t = ownTile(doc, 'up', cy * g.width + cx);
				if (t >= 0) g.tiles[t].color = [Math.round(c[2] * 255), Math.round(c[1] * 255), Math.round(c[0] * 255), 255];
			}
			return { result: { cubes: r }, refresh: { ground: r } };
		},
	},
	'walls.auto': {
		group: 'texture', describe: 'Give every edge between cubes of different height a wall face, and take away walls where the ground is now level. Walls take `texture`, or the higher cube\'s ground texture.',
		args: { texture: ['string', 'Texture index or path for new walls', true], x0: ['number', 'west', true], y0: ['number', 'south', true], x1: ['number', 'east', true], y1: ['number', 'north', true] },
		parts: ['gnd.tiles', 'gnd.surfaces', 'gnd.textures', 'gnd.lightmap'],
		run(doc, a) {
			const r = a.x0 !== undefined ? cubeRect(doc, cellsIn(doc, a)) : { x0: 0, y0: 0, x1: doc.gnd.width - 1, y1: doc.gnd.height - 1 };
			const n = autoWalls(doc, r, a.texture);
			return { result: { walls: n }, refresh: { ground: r, textures: true } };
		},
	},

	// ---- Walkability
	'gat.paint': {
		group: 'gat', describe: 'Paint walkability on cells: 0 walkable, 1 blocked, 3 walkable water, 5 cliff (shoot over, cannot walk). Painted cells keep their type when the ground changes, until unlocked.',
		args: { type: ['number', '0, 1, 3 or 5'], x: ['number', 'x', true], y: ['number', 'y', true], radius: ['number', 'radius', true], x0: ['number', 'west', true], y0: ['number', 'south', true], x1: ['number', 'east', true], y1: ['number', 'north', true], unlock: ['boolean', 'Give the cells back to "follow the ground" instead', true] },
		parts: ['gat.types', 'gat.locked'],
		run(doc, a) {
			const sel = cellsIn(doc, a), gat = doc.gat;
			const type = a.unlock ? null : int(a.type, 'type');
			if (type !== null && ![0, 1, 2, 3, 4, 5, 6].includes(type)) throw new Error('type must be 0 (walkable), 1 (blocked), 3 (water) or 5 (cliff)');
			if (!doc.gatLocked || doc.gatLocked.length !== gat.width * gat.height) doc.gatLocked = new Uint8Array(gat.width * gat.height);
			else doc.gatLocked = doc.gatLocked.slice();
			let n = 0;
			for (let y = sel.y0; y <= sel.y1; y++) for (let x = sel.x0; x <= sel.x1; x++) {
				if (!sel.weight(x + 0.5, y + 0.5)) continue;
				const i = y * gat.width + x;
				if (a.unlock) doc.gatLocked[i] = 0;
				else { gat.types[i] = type; doc.gatLocked[i] = 1; }
				n++;
			}
			if (a.unlock) syncGat(doc, sel);
			return { result: { cells: n }, refresh: { gat: sel } };
		},
	},
	'gat.auto': {
		group: 'gat', describe: 'Work out walkability from the ground everywhere (or in a rectangle): steep or missing ground is blocked, ground under the water line is water. Hand-painted cells are kept unless force is true.',
		args: { slope: ['number', 'Steepest walkable height change across a cell, in cells (default 1.5)', true], force: ['boolean', 'Repaint hand-painted cells too', true], x0: ['number', 'west', true], y0: ['number', 'south', true], x1: ['number', 'east', true], y1: ['number', 'north', true] },
		parts: ['gat.types', 'gat.heights', 'gat.locked'],
		run(doc, a) {
			if (a.force) doc.gatLocked = null;
			const rect = a.x0 !== undefined ? cellsIn(doc, a) : null;
			syncGat(doc, rect, { slope: num(a.slope, 'slope', 1.5) });
			return { result: { ok: true }, refresh: { gat: rect || true } };
		},
	},

	// ---- Water
	'water.set': {
		group: 'water', describe: 'The water: its level (cells up; ground below it is under water), texture type (0..7: the client\'s water textures), wave height, wave speed, wave pitch and animation speed.',
		args: { level: ['number', 'Water surface, cells up', true], type: ['number', 'Water texture 0..7', true], waveHeight: ['number', 'Wave height, cells', true], waveSpeed: ['number', 'Wave speed', true], wavePitch: ['number', 'Wave pitch', true], animSpeed: ['number', 'Frames per texture step', true], off: ['boolean', 'No water (level far below the ground)', true] },
		parts: ['gnd.water', 'rsw.water', 'gat.types'],
		run(doc, a) {
			const v = {};
			if (a.off) v.level = NO_WATER;
			if (a.level !== undefined) v.level = toFile(num(a.level, 'level'));
			if (a.type !== undefined) v.type = clamp(int(a.type, 'type'), 0, 7);
			if (a.waveHeight !== undefined) v.waveHeight = num(a.waveHeight, 'waveHeight') * 5;
			if (a.waveSpeed !== undefined) v.waveSpeed = num(a.waveSpeed, 'waveSpeed');
			if (a.wavePitch !== undefined) v.wavePitch = num(a.wavePitch, 'wavePitch');
			if (a.animSpeed !== undefined) v.animSpeed = Math.max(1, int(a.animSpeed, 'animSpeed'));
			setWater(doc, v);
			syncWater(doc);
			return { result: getWater(doc), refresh: { water: true, gat: true } };
		},
	},

	// ---- Light
	'light.global': {
		group: 'light', describe: 'The map\'s sun: longitude and latitude (degrees) of its direction, diffuse and ambient colours (0..1 each, or #rrggbb), and shadow opacity (0..1).',
		args: { longitude: ['number', 'Degrees', true], latitude: ['number', 'Degrees', true], diffuse: ['string', 'Colour', true], ambient: ['string', 'Colour', true], opacity: ['number', 'Shadow opacity 0..1', true] },
		parts: ['rsw.light'],
		run(doc, a) {
			const l = doc.rsw.light;
			if (a.longitude !== undefined) l.longitude = int(a.longitude, 'longitude');
			if (a.latitude !== undefined) l.latitude = int(a.latitude, 'latitude');
			if (a.diffuse !== undefined) l.diffuse = color3(a.diffuse, 'diffuse');
			if (a.ambient !== undefined) l.ambient = color3(a.ambient, 'ambient');
			if (a.opacity !== undefined) l.opacity = clamp(num(a.opacity, 'opacity'), 0, 1);
			return { result: l, refresh: { light: true } };
		},
	},
	'lightmap.reset': {
		group: 'light', describe: 'Make every lightmap plain: no baked shadows, no coloured light. The map is then lit by the sun alone.',
		args: {}, parts: ['gnd.lightmap', 'gnd.tiles'],
		run(doc) {
			const g = doc.gnd;
			g.lightmap = { ...g.lightmap, count: 1, data: plainLightmap() };
			for (const t of g.tiles) t.light = 0;
			doc._plainLight = 0;
			return { result: { ok: true }, refresh: { lightmaps: true } };
		},
	},

	// ---- Objects (.rsw)
	'objects.list': {
		group: 'objects', describe: 'The objects on the map: models, point lights, sounds and effects, with their index (what the other object commands take), place and settings. Filter by type, by distance from x,y, or by file name.',
		args: { type: ['string', 'model | light | sound | effect', true], x: ['number', 'Near x', true], y: ['number', 'Near y', true], radius: ['number', 'Within this many cells (default 10)', true], match: ['string', 'File or name contains', true], limit: ['number', 'At most (default 200)', true] },
		parts: [],
		run(doc, a) {
			const type = a.type ? { model: 1, light: 2, sound: 3, effect: 4 }[a.type] : 0;
			const r = num(a.radius, 'radius', 10), limit = int(a.limit, 'limit', 200);
			const out = [];
			doc.rsw.objects.forEach((o, i) => {
				if (type && o.type !== type) return;
				const d = describeObject(doc, o, i);
				if (a.x !== undefined && Math.hypot(d.x - num(a.x, 'x'), d.y - num(a.y, 'y')) > r) return;
				if (a.match && !`${d.file || ''} ${d.name}`.toLowerCase().includes(String(a.match).toLowerCase())) return;
				out.push(d);
			});
			return { result: { total: out.length, objects: out.slice(0, limit) } };
		},
	},
	'model.add': {
		group: 'objects', describe: 'Place a model from the client (a path under data/model/, as the model browser shows it) standing on the ground at x,y. Returns its index.',
		args: { file: ['string', 'e.g. 프론테라/분수대.rsm'], x: ['number', 'x'], y: ['number', 'y'], height: ['number', 'Height, cells up (default: on the ground)', true], rotation: ['number', 'Turn about the vertical, degrees', true], rotate: ['string', 'Full rotation x,y,z in degrees', true], scale: ['number', 'Uniform scale (default 1)', true], name: ['string', 'A name for it', true] },
		parts: ['rsw.objects'],
		run(doc, a) {
			const x = num(a.x, 'x'), y = num(a.y, 'y');
			checkCell(doc, Math.floor(x), Math.floor(y));
			const file = encodeName(String(a.file).replace(/^data[\\/]model[\\/]/i, '').replace(/\//g, '\\'));
			if (file.length >= 80) throw new Error('model path is longer than 79 bytes');
			const rot = a.rotate !== undefined ? String(a.rotate).split(',').map(Number) : [0, num(a.rotation, 'rotation', 0), 0];
			const s = num(a.scale, 'scale', 1);
			const o = {
				type: OBJECT.MODEL, name: encodeName(String(a.name || decodeName(file).split('\\').pop().replace(/\.rsm2?$/i, '')).slice(0, 39)), animType: 0, animSpeed: 1, blockType: 0,
				file, node: '', position: [(x + 0.5 - doc.gnd.width) * 5, a.height !== undefined ? toFile(num(a.height, 'height')) : groundHeight(doc, x + 0.5, y + 0.5) * 5, (y + 0.5 - doc.gnd.height) * 5],
				rotation: [rot[0] || 0, rot[1] || 0, rot[2] || 0], scale: [s, s, s],
			};
			if (doc.rsw.version[0] === 2 && doc.rsw.version[1] >= 6) o.unknownByte = 0;
			doc.rsw.objects.push(o);
			return { result: { index: doc.rsw.objects.length - 1 }, refresh: { objects: true } };
		},
	},
	'light.add': {
		group: 'objects', describe: 'Place a point light: its colour (0..1 or #rrggbb) and range (cells) colour the lightmaps when they are baked.',
		args: { x: ['number', 'x'], y: ['number', 'y'], height: ['number', 'Cells above the ground (default 3)', true], color: ['string', 'Colour (default #ffcc88)', true], range: ['number', 'Range in cells (default 8)', true], name: ['string', 'Name', true] },
		parts: ['rsw.objects'],
		run(doc, a) {
			const x = num(a.x, 'x'), y = num(a.y, 'y');
			const ground = groundHeight(doc, x + 0.5, y + 0.5) * 5;
			const o = { type: OBJECT.LIGHT, name: encodeName(String(a.name || `light${doc.rsw.objects.length}`).slice(0, 79)), position: [(x + 0.5 - doc.gnd.width) * 5, ground + toFile(num(a.height, 'height', 3)), (y + 0.5 - doc.gnd.height) * 5], range: num(a.range, 'range', 8) * 5 };
			setLightColor(o, color3(a.color ?? '#ffcc88', 'color'));
			doc.rsw.objects.push(o);
			return { result: { index: doc.rsw.objects.length - 1 }, refresh: { objects: true } };
		},
	},
	'sound.add': {
		group: 'objects', describe: 'Place an ambient sound: a .wav under data/wav/, its volume (0..1), the range it is heard in (cells) and how often it repeats (seconds).',
		args: { file: ['string', 'e.g. _water.wav'], x: ['number', 'x'], y: ['number', 'y'], volume: ['number', '0..1 (default 0.8)', true], range: ['number', 'Cells (default 20)', true], cycle: ['number', 'Seconds between plays (default 4)', true], name: ['string', 'Name', true] },
		parts: ['rsw.objects'],
		run(doc, a) {
			const x = num(a.x, 'x'), y = num(a.y, 'y');
			const file = encodeName(String(a.file).replace(/^data[\\/]wav[\\/]/i, '').replace(/\//g, '\\'));
			const o = { type: OBJECT.SOUND, name: encodeName(String(a.name || `sound${doc.rsw.objects.length}`).slice(0, 79)), file, position: [(x + 0.5 - doc.gnd.width) * 5, groundHeight(doc, x + 0.5, y + 0.5) * 5 - 10, (y + 0.5 - doc.gnd.height) * 5], volume: num(a.volume, 'volume', 0.8), width: 10, height: 10, range: num(a.range, 'range', 20) * 5, cycle: num(a.cycle, 'cycle', 4) };
			doc.rsw.objects.push(o);
			return { result: { index: doc.rsw.objects.length - 1 }, refresh: { objects: true } };
		},
	},
	'effect.add': {
		group: 'objects', describe: 'Place an effect emitter from the client\'s map effect list (e.g. 47 torch, 51 smoke): id, and the delay between emissions.',
		args: { id: ['number', 'Effect id'], x: ['number', 'x'], y: ['number', 'y'], height: ['number', 'Cells above the ground (default 0)', true], delay: ['number', 'Delay (default 1)', true], param: ['string', 'Four parameters, comma separated', true], name: ['string', 'Name', true] },
		parts: ['rsw.objects'],
		run(doc, a) {
			const x = num(a.x, 'x'), y = num(a.y, 'y');
			const o = { type: OBJECT.EFFECT, name: encodeName(String(a.name || `effect${doc.rsw.objects.length}`).slice(0, 79)), position: [(x + 0.5 - doc.gnd.width) * 5, groundHeight(doc, x + 0.5, y + 0.5) * 5 + toFile(num(a.height, 'height', 0)), (y + 0.5 - doc.gnd.height) * 5], id: int(a.id, 'id'), delay: num(a.delay, 'delay', 1) / 10, param: a.param ? String(a.param).split(',').map(Number).concat([0, 0, 0, 0]).slice(0, 4) : [1, 0, 0, 0] };
			doc.rsw.objects.push(o);
			return { result: { index: doc.rsw.objects.length - 1 }, refresh: { objects: true } };
		},
	},
	'object.update': {
		group: 'objects', describe: 'Change objects: x, y, height (cells up), rotation (degrees about the vertical) or rotate (x,y,z), scale (uniform, or x,y,z), name; for a light colour and range; for a sound volume, range and cycle.',
		args: { indexes: ['string', 'Object index, or several separated by commas'], x: ['number', 'x', true], y: ['number', 'y', true], height: ['number', 'Height, cells up', true], ground: ['boolean', 'Put it back on the ground', true], rotation: ['number', 'Degrees about the vertical', true], rotate: ['string', 'x,y,z degrees', true], scale: ['string', 'Uniform or x,y,z', true], name: ['string', 'Name', true], color: ['string', 'Light colour', true], range: ['number', 'Light/sound range, cells', true], volume: ['number', 'Sound volume', true], cycle: ['number', 'Sound cycle', true], file: ['string', 'Model or sound file', true] },
		parts: ['rsw.objects'],
		run(doc, a) {
			const idx = objIndexes(doc, a);
			for (const i of idx) {
				const o = doc.rsw.objects[i];
				if (a.x !== undefined) o.position[0] = (num(a.x, 'x') + 0.5 - doc.gnd.width) * 5;
				if (a.y !== undefined) o.position[2] = (num(a.y, 'y') + 0.5 - doc.gnd.height) * 5;
				if (a.height !== undefined) o.position[1] = toFile(num(a.height, 'height'));
				if (a.ground) { const c = rswToCell(doc, o.position); o.position[1] = groundHeight(doc, c.x + 0.5, c.y + 0.5) * 5; }
				if (o.type === OBJECT.MODEL) {
					if (a.rotation !== undefined) o.rotation[1] = num(a.rotation, 'rotation');
					if (a.rotate !== undefined) o.rotation = String(a.rotate).split(',').map(Number).concat([0, 0, 0]).slice(0, 3);
					if (a.scale !== undefined) { const s = String(a.scale).split(',').map(Number); o.scale = s.length >= 3 ? s.slice(0, 3) : [s[0], s[0], s[0]]; }
					if (a.file !== undefined) { o.file = encodeName(String(a.file).replace(/\//g, '\\')); delete o.fileField; }
				}
				if (a.name !== undefined) { o.name = encodeName(String(a.name)); delete o.nameField; }
				if (o.type === OBJECT.LIGHT) { if (a.color !== undefined) setLightColor(o, color3(a.color, 'color')); if (a.range !== undefined) o.range = num(a.range, 'range') * 5; }
				if (o.type === OBJECT.SOUND) { if (a.volume !== undefined) o.volume = num(a.volume, 'volume'); if (a.range !== undefined) o.range = num(a.range, 'range') * 5; if (a.cycle !== undefined) o.cycle = num(a.cycle, 'cycle'); if (a.file !== undefined) { o.file = encodeName(String(a.file)); delete o.fileField; } }
			}
			return { result: idx.map(i => describeObject(doc, doc.rsw.objects[i], i)), refresh: { objects: idx } };
		},
	},
	'object.move': {
		group: 'objects', describe: 'Move objects by dx, dy cells (and dheight), keeping them on the ground unless keepHeight.',
		args: { indexes: ['string', 'Indexes'], dx: ['number', 'East', true], dy: ['number', 'North', true], dheight: ['number', 'Up', true], keepHeight: ['boolean', 'Do not follow the ground', true], rotate: ['number', 'Also turn each by this many degrees', true] },
		parts: ['rsw.objects'],
		run(doc, a) {
			const idx = objIndexes(doc, a);
			const dx = num(a.dx, 'dx', 0), dy = num(a.dy, 'dy', 0), dh = num(a.dheight, 'dheight', 0);
			for (const i of idx) {
				const o = doc.rsw.objects[i];
				const before = rswToCell(doc, o.position);
				const offGround = o.position[1] - groundHeight(doc, before.x + 0.5, before.y + 0.5) * 5;
				o.position[0] += dx * 5; o.position[2] += dy * 5;
				if (!a.keepHeight && o.type === OBJECT.MODEL) { const c = rswToCell(doc, o.position); o.position[1] = groundHeight(doc, c.x + 0.5, c.y + 0.5) * 5 + offGround; }
				o.position[1] += toFile(dh);
				if (a.rotate && o.type === OBJECT.MODEL) o.rotation[1] += num(a.rotate, 'rotate');
			}
			return { result: { moved: idx.length }, refresh: { objects: idx } };
		},
	},
	'object.remove': {
		group: 'objects', describe: 'Delete objects. The indexes of later objects shift down.',
		args: { indexes: ['string', 'Indexes'] }, parts: ['rsw.objects'],
		run(doc, a) {
			const idx = objIndexes(doc, a).sort((p, q) => q - p);
			for (const i of idx) doc.rsw.objects.splice(i, 1);
			return { result: { removed: idx.length, remaining: doc.rsw.objects.length }, refresh: { objects: true } };
		},
	},
	'object.duplicate': {
		group: 'objects', describe: 'Copy objects, offset by dx, dy cells. Returns the new indexes.',
		args: { indexes: ['string', 'Indexes'], dx: ['number', 'East (default 2)', true], dy: ['number', 'North (default 0)', true] },
		parts: ['rsw.objects'],
		run(doc, a) {
			const idx = objIndexes(doc, a);
			const dx = num(a.dx, 'dx', 2), dy = num(a.dy, 'dy', 0);
			const out = [];
			for (const i of idx) {
				const o = structuredClone(doc.rsw.objects[i]);
				o.position[0] += dx * 5; o.position[2] += dy * 5;
				doc.rsw.objects.push(o);
				out.push(doc.rsw.objects.length - 1);
			}
			return { result: { indexes: out }, refresh: { objects: true } };
		},
	},
	'object.align': {
		group: 'objects', describe: 'Line objects up: on x (same east-west place), y, or height; to the first, the minimum, the maximum or the average. Or spread them evenly between the outermost two.',
		args: { indexes: ['string', 'Indexes'], axis: ['string', 'x | y | height'], to: ['string', 'first | min | max | average | spread'] },
		parts: ['rsw.objects'],
		run(doc, a) {
			const idx = objIndexes(doc, a);
			const k = { x: 0, height: 1, y: 2 }[a.axis];
			if (k === undefined) throw new Error('axis must be x, y or height');
			const vals = idx.map(i => doc.rsw.objects[i].position[k]);
			if (a.to === 'spread') {
				const order = idx.slice().sort((p, q) => doc.rsw.objects[p].position[k] - doc.rsw.objects[q].position[k]);
				const lo = Math.min(...vals), hi = Math.max(...vals);
				order.forEach((i, n) => { doc.rsw.objects[i].position[k] = lo + ((hi - lo) * n) / Math.max(1, order.length - 1); });
			} else {
				const v = a.to === 'min' ? Math.min(...vals) : a.to === 'max' ? Math.max(...vals) : a.to === 'average' ? vals.reduce((s, x) => s + x, 0) / vals.length : vals[0];
				for (const i of idx) doc.rsw.objects[i].position[k] = v;
			}
			return { result: { aligned: idx.length }, refresh: { objects: idx } };
		},
	},
	'object.copy': {
		group: 'objects', describe: 'Copy objects to a clipboard (returned as JSON, relative to their centre) for object.paste on this map or another one.',
		args: { indexes: ['string', 'Indexes'] }, parts: [],
		run(doc, a) { return { result: copyObjects(doc, objIndexes(doc, a)) }; },
	},
	'object.paste': {
		group: 'objects', describe: 'Paste a clipboard (from object.copy, from any map) centred on x,y, standing on the ground. Returns the new indexes.',
		args: { clip: ['object', 'What object.copy returned'], x: ['number', 'x'], y: ['number', 'y'], rotation: ['number', 'Turn the group by degrees', true], keepHeight: ['boolean', 'Keep the copied heights rather than following the ground', true] },
		parts: ['rsw.objects'],
		run(doc, a) { const out = pasteObjects(doc, typeof a.clip === 'string' ? JSON.parse(a.clip) : a.clip, num(a.x, 'x'), num(a.y, 'y'), num(a.rotation, 'rotation', 0), !!a.keepHeight); return { result: { indexes: out }, refresh: { objects: true } }; },
	},
	'object.copy_area': {
		group: 'objects', describe: 'Copy every object inside a rectangle of cells (models, lights, sounds, effects), for pasting somewhere else -- the way to take a building and its surroundings from an official map.',
		args: { x0: ['number', 'west'], y0: ['number', 'south'], x1: ['number', 'east'], y1: ['number', 'north'], type: ['string', 'Only models, lights, sounds or effects', true] },
		parts: [],
		run(doc, a) {
			const want = a.type ? { model: 1, models: 1, light: 2, lights: 2, sound: 3, sounds: 3, effect: 4, effects: 4 }[a.type] : 0;
			const x0 = Math.min(a.x0, a.x1), x1 = Math.max(a.x0, a.x1), y0 = Math.min(a.y0, a.y1), y1 = Math.max(a.y0, a.y1);
			const idx = [];
			doc.rsw.objects.forEach((o, i) => { const c = rswToCell(doc, o.position); if ((!want || o.type === want) && c.x >= x0 && c.x <= x1 && c.y >= y0 && c.y <= y1) idx.push(i); });
			return { result: copyObjects(doc, idx) };
		},
	},

	// ---- Gameplay
	'gameplay.list': {
		group: 'gameplay', describe: 'The NPCs, warps and monster spawns on the map, with their ids (what npc.update and the like take).',
		args: { kind: ['string', 'npc | warp | spawn', true] }, parts: [],
		run(doc, a) {
			const strip = o => { const { body, span, ...rest } = o; void body; void span; return rest; };
			const out = {};
			if (!a.kind || a.kind === 'npc') out.npcs = doc.gameplay.npcs.map(strip);
			if (!a.kind || a.kind === 'warp') out.warps = doc.gameplay.warps.map(strip);
			if (!a.kind || a.kind === 'spawn') out.spawns = doc.gameplay.spawns.map(strip);
			if (!a.kind) { out.signboards = doc.gameplay.signboards; out.population = doc.gameplay.population; }
			return { result: out };
		},
	},
	'npc.add': {
		group: 'gameplay', describe: 'Place an NPC. kind: script (calls a dialogue function you write in npc/<map>_dialogue.txt), sign (says `text`), healer, warper (destinations), shop (items). sprite is a client NPC sprite name like 4_F_KAFRA1 or a view id. dir 0 north .. 4 south .. 6 east (counter-clockwise).',
		args: {
			kind: ['string', 'script | sign | healer | warper | shop'], x: ['number', 'x'], y: ['number', 'y'], name: ['string', 'Name shown over it (a #suffix is added to keep it unique)'],
			sprite: ['string', 'Sprite name or id (default 4_M_MANAGER)', true], dir: ['number', 'Facing 0..7 (default 4, south)', true], text: ['string', 'What a sign or healer says (lines separated by \\n)', true],
			items: ['string', 'Shop items: id[:price] separated by commas (price -1 or none: the item\'s own price)', true], destinations: ['string', 'Warper: map:x:y[:label] separated by commas', true],
			touch: ['string', 'An OnTouch area "xs,ys" (cells each side)', true],
		},
		parts: ['gameplay'],
		run(doc, a) {
			const kind = a.kind || 'script';
			if (!['script', 'sign', 'healer', 'warper', 'shop'].includes(kind)) throw new Error('kind must be script, sign, healer, warper or shop');
			const x = int(a.x, 'x'), y = int(a.y, 'y');
			checkCell(doc, x, y);
			const obj = { id: nextId(doc, 'npc'), kind, map: doc.name, x, y, dir: int(a.dir, 'dir', 4) & 7, name: npcName(doc, a.name), sprite: String(a.sprite || '4_M_MANAGER') };
			applyNpcArgs(doc, obj, a);
			if (kind === 'script') obj.fn = functionName(doc.name, obj.name);
			doc.gameplay.npcs.push(obj);
			return { result: obj, refresh: { gameplay: true } };
		},
	},
	'warp.add': {
		group: 'gameplay', describe: 'Place a warp portal at x,y covering xs,ys cells each side, to dest map at dx,dy. twoWay also places the warp back on the destination (when it is this map) -- for another map it is written into its own script.',
		args: { x: ['number', 'x'], y: ['number', 'y'], map: ['string', 'Destination map'], dx: ['number', 'Destination x'], dy: ['number', 'Destination y'], xs: ['number', 'Cells each side east-west (default 1)', true], ys: ['number', 'Cells each side north-south (default 1)', true], name: ['string', 'Name', true], twoWay: ['boolean', 'Also a warp back', true] },
		parts: ['gameplay'],
		run(doc, a) {
			const x = int(a.x, 'x'), y = int(a.y, 'y');
			checkCell(doc, x, y);
			const dest = { map: String(a.map || doc.name).trim().toLowerCase(), x: int(a.dx, 'dx'), y: int(a.dy, 'dy') };
			const w = { id: nextId(doc, 'warp'), kind: 'warp', map: doc.name, x, y, xs: int(a.xs, 'xs', 1), ys: int(a.ys, 'ys', 1), name: npcName(doc, a.name || `${doc.name}_${dest.map}`), dest };
			doc.gameplay.warps.push(w);
			const out = [w];
			if (a.twoWay) {
				// The way back stands beside where this one lands, and lands beside
				// this portal: on either, the player would go straight back through.
				// Toward the middle of this map, along whichever way is further from its edge.
				const towardX = Math.abs(x - doc.gat.width / 2) > Math.abs(y - doc.gat.height / 2);
				const sx = towardX ? Math.sign(doc.gat.width / 2 - x) || 1 : 0, sy = towardX ? 0 : Math.sign(doc.gat.height / 2 - y) || 1;
				const land = { map: doc.name, x: x + sx * (w.xs + 2), y: y + sy * (w.ys + 2) };
				const back = { id: nextId(doc, 'warp'), kind: 'warp', map: dest.map, x: dest.x, y: dest.y + w.ys + 2, xs: w.xs, ys: w.ys, name: npcName(doc, `${dest.map}_${doc.name}`), dest: land };
				if (dest.map === doc.name) doc.gameplay.warps.push(back); else (doc.gameplay.external ||= []).push(back);
				out.push(back);
			}
			return { result: out, refresh: { gameplay: true } };
		},
	},
	'spawn.add': {
		group: 'gameplay', describe: 'Spawn monsters: mob (id or AegisName), amount, in an area of xs,ys cells each side of x,y (0,0,0,0 for anywhere on the map), respawning after delay milliseconds.',
		args: { mob: ['string', 'Monster id or AegisName (PORING)'], amount: ['number', 'How many (default 5)', true], x: ['number', 'Centre x (0 with xs 0: anywhere)', true], y: ['number', 'Centre y', true], xs: ['number', 'Cells each side (default 5)', true], ys: ['number', 'Cells each side (default 5)', true], delay: ['number', 'Respawn after, ms (default 5000)', true], variance: ['number', 'Plus up to this many ms', true], kind: ['string', 'monster | boss_monster | miniboss_monster', true], name: ['string', 'Name (default: the monster\'s)', true] },
		parts: ['gameplay'],
		run(doc, a) {
			const kind = a.kind || 'monster';
			if (!SPAWN_KINDS.includes(kind)) throw new Error(`kind must be ${SPAWN_KINDS.join(', ')}`);
			const mob = /^\d+$/.test(String(a.mob)) ? Number(a.mob) : String(a.mob).toUpperCase();
			const s = { id: nextId(doc, 'spawn'), kind, map: doc.name, x: int(a.x, 'x', 0), y: int(a.y, 'y', 0), xs: int(a.xs, 'xs', a.x === undefined ? 0 : 5), ys: int(a.ys, 'ys', a.x === undefined ? 0 : 5), name: String(a.name || '--en--'), mob, amount: Math.max(1, int(a.amount, 'amount', 5)), delay1: int(a.delay, 'delay', 5000), delay2: int(a.variance, 'variance', 0) };
			doc.gameplay.spawns.push(s);
			return { result: s, refresh: { gameplay: true } };
		},
	},
	'marker.update': {
		group: 'gameplay', describe: 'Change an NPC, warp or spawn by id: any of the fields npc.add, warp.add or spawn.add take (x, y, dir, name, sprite, text, items, destinations, xs, ys, map/dx/dy, mob, amount, delay).',
		args: { id: ['string', 'Marker id'], x: ['number', 'x', true], y: ['number', 'y', true], dir: ['number', 'Facing', true], name: ['string', 'Name', true], sprite: ['string', 'Sprite', true], text: ['string', 'Text', true], items: ['string', 'Shop items', true], destinations: ['string', 'Warper destinations', true], xs: ['number', 'xs', true], ys: ['number', 'ys', true], map: ['string', 'Warp destination map', true], dx: ['number', 'Destination x', true], dy: ['number', 'Destination y', true], mob: ['string', 'Monster', true], amount: ['number', 'Amount', true], delay: ['number', 'Respawn ms', true], kind: ['string', 'Kind (NPC kind or spawn kind)', true], touch: ['string', 'OnTouch area xs,ys or "none"', true] },
		parts: ['gameplay'],
		run(doc, a) {
			const { kind, obj } = findGameplay(doc, String(a.id));
			if (a.x !== undefined) obj.x = int(a.x, 'x');
			if (a.y !== undefined) obj.y = int(a.y, 'y');
			if (obj.kind !== 'warp' && !SPAWN_KINDS.includes(obj.kind)) checkCell(doc, obj.x, obj.y);
			if (a.name !== undefined) obj.name = obj.name === String(a.name) ? obj.name : (kind === 'spawn' ? String(a.name) : npcName(doc, a.name));
			if (kind === 'npc') {
				if (a.dir !== undefined) obj.dir = int(a.dir, 'dir') & 7;
				if (a.sprite !== undefined) obj.sprite = String(a.sprite);
				if (a.kind !== undefined && !obj.handwritten) obj.kind = a.kind;
				applyNpcArgs(doc, obj, a);
				if (obj.kind === 'script' && !obj.fn) obj.fn = functionName(doc.name, obj.name);
			}
			if (kind === 'warp') {
				if (a.xs !== undefined) obj.xs = int(a.xs, 'xs');
				if (a.ys !== undefined) obj.ys = int(a.ys, 'ys');
				if (a.map !== undefined) obj.dest.map = String(a.map).toLowerCase();
				if (a.dx !== undefined) obj.dest.x = int(a.dx, 'dx');
				if (a.dy !== undefined) obj.dest.y = int(a.dy, 'dy');
			}
			if (kind === 'spawn') {
				if (a.xs !== undefined) obj.xs = int(a.xs, 'xs');
				if (a.ys !== undefined) obj.ys = int(a.ys, 'ys');
				if (a.mob !== undefined) obj.mob = /^\d+$/.test(String(a.mob)) ? Number(a.mob) : String(a.mob).toUpperCase();
				if (a.amount !== undefined) obj.amount = Math.max(1, int(a.amount, 'amount'));
				if (a.delay !== undefined) obj.delay1 = int(a.delay, 'delay');
				if (a.kind !== undefined && SPAWN_KINDS.includes(a.kind)) obj.kind = a.kind;
			}
			obj.dirty = true;
			return { result: obj, refresh: { gameplay: true } };
		},
	},
	'marker.remove': {
		group: 'gameplay', describe: 'Delete an NPC, warp or spawn by id (several separated by commas).',
		args: { id: ['string', 'Marker id(s)'] }, parts: ['gameplay'],
		run(doc, a) {
			const ids = String(a.id).split(',').map(s => s.trim()).filter(Boolean);
			for (const id of ids) {
				const { list, i, obj } = findGameplay(doc, id);
				list.splice(i, 1);
				if (obj.handwritten) (doc.gameplay.removed ||= []).push(obj);
			}
			return { result: { removed: ids.length }, refresh: { gameplay: true } };
		},
	},
	'signboard.set': {
		group: 'gameplay', describe: 'An icon or a sign over a cell (usually an NPC\'s): icon is a path under data/texture/유저인터페이스/ like information\\over_kafra.bmp; type 1 is an icon alone, 3 a board with a caption.',
		args: { x: ['number', 'x'], y: ['number', 'y'], icon: ['string', 'Icon path (default information\\over_store.bmp)', true], type: ['number', '1 icon, 3 board (default 1)', true], caption: ['string', 'Board caption (ASCII)', true], height: ['number', 'Height (ignored by the client)', true], remove: ['boolean', 'Remove the sign on this cell', true] },
		parts: ['gameplay'],
		run(doc, a) {
			const x = int(a.x, 'x'), y = int(a.y, 'y');
			const list = doc.gameplay.signboards;
			const i = list.findIndex(s => s.x === x && s.y === y);
			if (a.remove) { if (i >= 0) list.splice(i, 1); return { result: { removed: i >= 0 }, refresh: { gameplay: true } }; }
			const row = { map: doc.name, x, y, height: int(a.height, 'height', 0), type: int(a.type, 'type', 1), icon: String(a.icon || 'information\\over_store.bmp').replace(/\//g, '\\'), caption: String(a.caption || ''), color: '#0x00FFFFFF' };
			if (i >= 0) list[i] = row; else list.push(row);
			return { result: row, refresh: { gameplay: true } };
		},
	},
	'population.set': {
		group: 'gameplay', describe: 'Let the AI characters (Settings → Fake players) live on this map: which population profile, as a town, field or dungeon, and how many more characters to add for it. count 0 removes it.',
		args: { profile: ['string', 'e.g. combat_pve_low, novice_default'], category: ['string', 'Towns | Fields | Dungeons'], count: ['number', 'Characters to add (0 removes)'], maxPerMap: ['number', 'Per-map cap', true] },
		parts: ['gameplay'],
		run(doc, a) {
			const count = int(a.count, 'count');
			if (!count) { doc.gameplay.population = null; return { result: null, refresh: { gameplay: true } }; }
			const category = String(a.category || 'Fields');
			if (!['Towns', 'Fields', 'Dungeons'].includes(category)) throw new Error('category must be Towns, Fields or Dungeons');
			doc.gameplay.population = { profile: String(a.profile || 'combat_pve_low'), category, count, maxPerMap: a.maxPerMap !== undefined ? int(a.maxPerMap, 'maxPerMap') : count };
			return { result: doc.gameplay.population, refresh: { gameplay: true } };
		},
	},

	// ---- Map properties (mod.json "maps")
	'props.set': {
		group: 'props', describe: 'The map\'s sky colour (r,g,b 0..1; none for black), clouds colour, weather (snow, rain, sakura, leaves, fireworks, cloud..cloud8, or none), music (a file in BGM/, like 08.mp3), and display name.',
		args: { sky: ['string', 'r,g,b or #rrggbb, or none', true], clouds: ['string', 'r,g,b or #rrggbb, or none', true], weather: ['string', 'Weather or none', true], bgm: ['string', 'Track file or none', true], displayName: ['string', 'Name shown on the minimap', true] },
		parts: ['props'],
		run(doc, a) {
			const p = doc.props;
			const off = v => v === null || v === 'none' || v === '';
			if (a.sky !== undefined) p.sky = off(a.sky) ? null : color3(a.sky, 'sky');
			if (a.clouds !== undefined) p.clouds = off(a.clouds) ? null : color3(a.clouds, 'clouds');
			if (a.weather !== undefined) {
				if (!off(a.weather) && !WEATHERS.includes(a.weather)) throw new Error(`weather must be one of ${WEATHERS.join(', ')}`);
				p.weather = off(a.weather) ? null : a.weather;
			}
			if (a.bgm !== undefined) {
				if (!off(a.bgm) && !/^[A-Za-z0-9_-]+\.mp3$/.test(a.bgm)) throw new Error('bgm must be a file name in BGM/, letters, digits, _ and -, ending .mp3');
				p.bgm = off(a.bgm) ? null : a.bgm;
			}
			if (a.displayName !== undefined) p.displayName = String(a.displayName);
			if (p.clouds && !p.sky) throw new Error('clouds need a sky colour too');
			return { result: p, refresh: { props: true } };
		},
	},
};

export const SKY_PRESETS = {
	'Blue sky (Juno, Valkyrie, airships)': { sky: [0.4, 0.6, 0.8], clouds: [1, 1, 1] },
	'Dusk over Thanatos': { sky: [0.88, 0.83, 0.76], clouds: [0.37, 0, 0] },
	'Endless Tower purple': { sky: [0.2, 0, 0.2], clouds: [1, 0.7, 0.7] },
	'Dark void': { sky: [0.02, 0.02, 0.06], clouds: null },
};

function applyNpcArgs(doc, obj, a) {
	if (a.text !== undefined) obj.text = String(a.text).replace(/\\n/g, '\n');
	if (a.items !== undefined) {
		const items = Array.isArray(a.items) ? a.items : String(a.items).split(',').map(s => s.trim()).filter(Boolean).map(s => { const [id, price] = s.split(':'); return { id: /^\d+$/.test(id) ? Number(id) : id, price: price === undefined ? -1 : Number(price) }; });
		obj.items = items;
	}
	if (a.destinations !== undefined) {
		obj.destinations = Array.isArray(a.destinations) ? a.destinations : String(a.destinations).split(',').map(s => s.trim()).filter(Boolean).map(s => { const [map, x, y, label] = s.split(':'); return { map: map.toLowerCase(), x: Number(x) || 0, y: Number(y) || 0, label: label || map }; });
	}
	if (a.touch !== undefined) {
		if (a.touch === 'none' || a.touch === '' || a.touch === null) obj.touch = null;
		else { const [xs, ys] = String(a.touch).split(',').map(Number); obj.touch = { xs: xs | 0, ys: (ys ?? xs) | 0 }; }
	}
}

// ---- Terrain implementation

function brush(doc, a) {
	const g = doc.gnd;
	const tool = a.tool || 'raise';
	const x = num(a.x, 'x'), y = num(a.y, 'y'), r = Math.max(0.5, num(a.radius, 'radius', 3));
	const hard = a.falloff === 'hard';
	const strengthDefault = tool === 'smooth' || tool === 'flatten' ? 0.5 : 1;
	const strength = num(a.strength, 'strength', strengthDefault);
	// The corner grid is in cubes: a vertex (vx, vy) is at cells (vx*2, vy*2).
	const vx0 = Math.max(0, Math.floor((x - r) / 2)), vx1 = Math.min(g.width, Math.ceil((x + r) / 2));
	const vy0 = Math.max(0, Math.floor((y - r) / 2)), vy1 = Math.min(g.height, Math.ceil((y + r) / 2));
	const avg = (vx, vy) => { const c = vertexCorners(g, vx, vy); return c.length ? c.reduce((s, k) => s + g.heights[k], 0) / c.length : 0; };
	const target = tool === 'set' ? toFile(num(a.height, 'height')) : tool === 'flatten' ? (a.height !== undefined ? toFile(num(a.height, 'height')) : avg(Math.round(x / 2), Math.round(y / 2))) : 0;
	const updates = [];
	for (let vy = vy0; vy <= vy1; vy++) {
		for (let vx = vx0; vx <= vx1; vx++) {
			const d = Math.hypot(vx * 2 - x, vy * 2 - y);
			if (d > r) continue;
			const w = hard ? 1 : 0.5 + 0.5 * Math.cos((Math.PI * d) / r);
			const corners = vertexCorners(g, vx, vy);
			if (!corners.length) continue;
			if (tool === 'raise' || tool === 'lower') {
				const delta = toFile(strength * w * (tool === 'lower' ? -1 : 1));
				for (const k of corners) updates.push([k, g.heights[k] + delta]);
			} else if (tool === 'noise') {
				// Deterministic per vertex, so a stroke over the same place is stable.
				const n = Math.sin(vx * 12.9898 + vy * 78.233) * 43758.5453;
				const delta = toFile((n - Math.floor(n) - 0.5) * strength * w);
				for (const k of corners) updates.push([k, g.heights[k] + delta]);
			} else if (tool === 'smooth') {
				let sum = 0, cnt = 0;
				for (let oy = -1; oy <= 1; oy++) for (let ox = -1; ox <= 1; ox++) {
					const nx = vx + ox, ny = vy + oy;
					if (nx < 0 || ny < 0 || nx > g.width || ny > g.height) continue;
					sum += avg(nx, ny); cnt++;
				}
				const mean = sum / cnt, t = clamp(strength * w, 0, 1);
				for (const k of corners) updates.push([k, g.heights[k] + (mean - g.heights[k]) * t]);
			} else if (tool === 'set' || tool === 'flatten') {
				const t = tool === 'set' ? (hard ? 1 : clamp(w * 1.5, 0, 1)) : clamp(strength * w, 0, 1);
				for (const k of corners) updates.push([k, g.heights[k] + (target - g.heights[k]) * t]);
			} else throw new Error('tool must be raise, lower, smooth, flatten, set or noise');
		}
	}
	for (const [k, v] of updates) g.heights[k] = v;
	const rect = { x0: Math.max(0, vx0 - 1), y0: Math.max(0, vy0 - 1), x1: Math.min(g.width - 1, vx1), y1: Math.min(g.height - 1, vy1) };
	if (a.sync !== false) syncGat(doc, { x0: rect.x0 * 2, y0: rect.y0 * 2, x1: rect.x1 * 2 + 1, y1: rect.y1 * 2 + 1 });
	return rect;
}

function terrainRect(doc, a) {
	const g = doc.gnd;
	const sel = cellsIn(doc, a);
	const r = cubeRect(doc, sel);
	const op = a.op || 'set';
	if (op === 'smooth') {
		for (let i = 0; i < 2; i++) brush(doc, { tool: 'smooth', x: (sel.x0 + sel.x1) / 2, y: (sel.y0 + sel.y1) / 2, radius: Math.max(sel.x1 - sel.x0, sel.y1 - sel.y0) / 2 + 1, strength: 0.8, sync: false });
	} else {
		for (let cy = r.y0; cy <= r.y1; cy++) for (let cx = r.x0; cx <= r.x1; cx++) {
			const k = (cy * g.width + cx) * 4;
			for (let c = 0; c < 4; c++) {
				if (op === 'set') g.heights[k + c] = toFile(num(a.height, 'height'));
				else if (op === 'raise') g.heights[k + c] += toFile(num(a.height, 'height', 1));
				else if (op === 'lower') g.heights[k + c] -= toFile(num(a.height, 'height', 1));
				else if (op === 'ramp') {
					const from = num(a.height, 'height'), to = num(a.to, 'to');
					const dir = a.direction || 'north';
					const px = cx + (c & 1), py = cy + (c >> 1);
					const t = dir === 'north' ? (py - r.y0) / (r.y1 + 1 - r.y0) : dir === 'south' ? 1 - (py - r.y0) / (r.y1 + 1 - r.y0) : dir === 'east' ? (px - r.x0) / (r.x1 + 1 - r.x0) : 1 - (px - r.x0) / (r.x1 + 1 - r.x0);
					g.heights[k + c] = toFile(from + (to - from) * t);
				} else throw new Error('op must be set, raise, lower, smooth or ramp');
			}
		}
		// Hard edges make cliffs (a ramp's sides too): give them faces.
		autoWalls(doc, { x0: Math.max(0, r.x0 - 1), y0: Math.max(0, r.y0 - 1), x1: Math.min(g.width - 1, r.x1 + 1), y1: Math.min(g.height - 1, r.y1 + 1) }, a.walls);
	}
	if (a.sync !== false) syncGat(doc, { x0: r.x0 * 2 - 2, y0: r.y0 * 2 - 2, x1: r.x1 * 2 + 3, y1: r.y1 * 2 + 3 });
	return { x0: Math.max(0, r.x0 - 1), y0: Math.max(0, r.y0 - 1), x1: Math.min(g.width - 1, r.x1 + 1), y1: Math.min(g.height - 1, r.y1 + 1) };
}

function textureArg(doc, t) {
	if (t === undefined || t === null || t === '') return 0;
	if (/^\d+$/.test(String(t))) {
		const i = Number(t);
		if (i >= doc.gnd.textures.length) throw new Error(`there is no texture ${i}; the map has ${doc.gnd.textures.length}`);
		return i;
	}
	return textureIndex(doc, encodeName(String(t).replace(/^data[\\/]texture[\\/]/i, '').replace(/\//g, '\\')));
}

function paintTexture(doc, a) {
	const g = doc.gnd;
	const sel = cellsIn(doc, a);
	const r = cubeRect(doc, sel);
	const texture = textureArg(doc, a.texture);
	const surface = a.surface || 'top';
	const span = int(a.span, 'span', 4);
	if (!doc._tileUse) doc._tileUse = countTileUse(g);
	for (let cy = r.y0; cy <= r.y1; cy++) {
		for (let cx = r.x0; cx <= r.x1; cx++) {
			if (!sel.weight(cx * 2 + 1, cy * 2 + 1)) continue;
			const i = cy * g.width + cx;
			if (surface === 'top' || surface === 'both') {
				const uv = tileUV(int(a.rotate, 'rotate', 0), !!a.flipX, !!a.flipY, span, cx, cy);
				let t = ownTile(doc, 'up', i);
				if (t < 0) { t = newTile(doc, texture, uv); g.up[i] = t; doc._tileUse[t] = 1; }
				Object.assign(g.tiles[t], { texture, u: uv.u, v: uv.v });
			}
			if (surface === 'walls' || surface === 'both') {
				for (const side of ['front', 'right']) {
					const t = ownTile(doc, side, i);
					if (t >= 0) g.tiles[t].texture = texture;
				}
			}
		}
	}
	return r;
}

function autoWalls(doc, r, textureName) {
	const g = doc.gnd;
	const fixed = textureName !== undefined && textureName !== null && textureName !== '' ? textureArg(doc, textureName) : null;
	if (!doc._tileUse) doc._tileUse = countTileUse(g);
	let made = 0;
	const h = g.heights;
	const topTex = i => (g.up[i] >= 0 && g.tiles[g.up[i]] ? g.tiles[g.up[i]].texture : 0);
	for (let cy = r.y0; cy <= r.y1; cy++) {
		for (let cx = r.x0; cx <= r.x1; cx++) {
			const i = cy * g.width + cx, k = i * 4;
			// East face: this cube's corners 1,3 against the east neighbour's 0,2.
			if (cx + 1 < g.width) {
				const n = (i + 1) * 4;
				const differs = Math.abs(h[k + 1] - h[n]) > 0.01 || Math.abs(h[k + 3] - h[n + 2]) > 0.01;
				if (differs && g.right[i] < 0) {
					const higher = (h[k + 1] + h[k + 3]) < (h[n] + h[n + 2]) ? i : i + 1;
					g.right[i] = newTile(doc, fixed ?? topTex(higher), { u: [0, 1, 0, 1], v: [0, 0, 1, 1] });
					doc._tileUse[g.right[i]] = 1;
					made++;
				} else if (!differs && g.right[i] >= 0) g.right[i] = -1;
			}
			// North face: corners 2,3 against the north neighbour's 0,1.
			if (cy + 1 < g.height) {
				const n = (i + g.width) * 4;
				const differs = Math.abs(h[k + 2] - h[n]) > 0.01 || Math.abs(h[k + 3] - h[n + 1]) > 0.01;
				if (differs && g.front[i] < 0) {
					const higher = (h[k + 2] + h[k + 3]) < (h[n] + h[n + 1]) ? i : i + g.width;
					g.front[i] = newTile(doc, fixed ?? topTex(higher), { u: [0, 1, 0, 1], v: [0, 0, 1, 1] });
					doc._tileUse[g.front[i]] = 1;
					made++;
				} else if (!differs && g.front[i] >= 0) g.front[i] = -1;
			}
		}
	}
	return made;
}

// ---- Resize and crop

/** Copy the map onto a new grid, the old cell (x, y) landing at (x + ox, y + oy). */
function regrid(doc, width, height, ox, oy) {
	const og = doc.gnd, ogat = doc.gat;
	if (width < 2 || height < 2 || width > 1024 || height > 1024) throw new Error('a map is from 2x2 to 1024x1024 cells');
	if (ox % 2 || oy % 2) throw new Error('moves must be by whole cubes (even numbers of cells)');
	const cw = width / 2, ch = height / 2, cox = ox / 2, coy = oy / 2;
	const g = { ...og, width: cw, height: ch, heights: new Float32Array(cw * ch * 4), up: new Int32Array(cw * ch).fill(-1), front: new Int32Array(cw * ch).fill(-1), right: new Int32Array(cw * ch).fill(-1), tiles: og.tiles.slice() };
	const fillTile = og.tiles.length ? { ...og.tiles[og.up.find(t => t >= 0) ?? 0] } : null;
	for (let y = 0; y < ch; y++) for (let x = 0; x < cw; x++) {
		const sx = x - cox, sy = y - coy, i = y * cw + x;
		if (sx >= 0 && sy >= 0 && sx < og.width && sy < og.height) {
			const s = sy * og.width + sx;
			g.heights.set(og.heights.subarray(s * 4, s * 4 + 4), i * 4);
			g.up[i] = og.up[s]; g.front[i] = og.front[s]; g.right[i] = og.right[s];
		} else if (fillTile) {
			g.tiles.push({ u: [0, 1, 0, 1], v: [1, 1, 0, 0], texture: fillTile.texture, light: fillTile.light, color: [255, 255, 255, 255] });
			g.up[i] = g.tiles.length - 1;
		}
	}
	const gat = { ...ogat, width, height, heights: new Float32Array(width * height * 4), types: new Uint32Array(width * height).fill(1) };
	for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
		const sx = x - ox, sy = y - oy;
		if (sx >= 0 && sy >= 0 && sx < ogat.width && sy < ogat.height) {
			const s = sy * ogat.width + sx, i = y * width + x;
			gat.heights.set(ogat.heights.subarray(s * 4, s * 4 + 4), i * 4);
			gat.types[i] = ogat.types[s];
		}
	}
	// Objects keep their place on the ground: their positions are relative to
	// the centre, which moves.
	const dx = (ox - (width - ogat.width) / 2) * 5, dz = (oy - (height - ogat.height) / 2) * 5;
	for (const o of doc.rsw.objects) { o.position[0] += dx; o.position[2] += dz; }
	for (const list of [doc.gameplay.npcs, doc.gameplay.warps, doc.gameplay.spawns, doc.gameplay.signboards]) {
		for (const m of list) if (!(m.x === 0 && m.y === 0 && m.xs === 0)) { m.x += ox; m.y += oy; }
	}
	doc.gnd = g;
	doc.gat = gat;
	if (doc.gatLocked) doc.gatLocked = null;
	// Fill in heights for new ground from the nearest edge, and walkability.
	syncGat(doc, null, { types: false });
	for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
		const sx = x - ox, sy = y - oy;
		if (!(sx >= 0 && sy >= 0 && sx < ogat.width && sy < ogat.height)) {
			const edge = x === 0 || y === 0 || x === width - 1 || y === height - 1;
			gat.types[y * width + x] = edge ? 1 : 0;
		}
	}
	refreshQuadtree(doc);
}

function resize(doc, width, height, anchor) {
	width = Math.ceil(width / 2) * 2; height = Math.ceil(height / 2) * 2;
	const dw = width - doc.gat.width, dh = height - doc.gat.height;
	const ox = anchor.includes('w') ? 0 : anchor.includes('e') ? dw : Math.floor(dw / 4) * 2;
	const oy = anchor.startsWith('s') ? 0 : anchor.startsWith('n') ? dh : Math.floor(dh / 4) * 2;
	regrid(doc, width, height, ox, oy);
}

function crop(doc, x0, y0, w, h) {
	if (w < 2 || h < 2) throw new Error('the crop is empty');
	regrid(doc, w, h, -x0, -y0);
}

// ---- Copy and paste

function copyObjects(doc, idx) {
	if (!idx.length) return { objects: [], center: [0, 0] };
	const cells = idx.map(i => rswToCell(doc, doc.rsw.objects[i].position));
	const cx = cells.reduce((s, c) => s + c.x, 0) / cells.length, cy = cells.reduce((s, c) => s + c.y, 0) / cells.length;
	return {
		kind: 'ragnarok-map-objects', from: doc.name, center: [cx, cy],
		objects: idx.map((i, k) => {
			const o = doc.rsw.objects[i];
			const ground = groundHeight(doc, cells[k].x + 0.5, cells[k].y + 0.5) * 5;
			const clean = { ...structuredClone(o), dx: cells[k].x - cx, dy: cells[k].y - cy, above: o.position[1] - ground };
			delete clean.nameField; delete clean.fileField; delete clean.nodeField;
			// Binary strings survive JSON, but say so for anything reading it.
			return clean;
		}),
	};
}

function pasteObjects(doc, clip, x, y, rotation, keepHeight) {
	if (!clip || !Array.isArray(clip.objects)) throw new Error('that is not a clipboard from object.copy');
	const out = [];
	const rad = (rotation * Math.PI) / 180;
	for (const src of clip.objects) {
		const o = structuredClone(src);
		const dx = src.dx * Math.cos(rad) + src.dy * Math.sin(rad), dy = -src.dx * Math.sin(rad) + src.dy * Math.cos(rad);
		const px = x + dx, py = y + dy;
		o.position = [(px + 0.5 - doc.gnd.width) * 5, keepHeight ? src.position[1] : groundHeight(doc, px + 0.5, py + 0.5) * 5 + (src.above || 0), (py + 0.5 - doc.gnd.height) * 5];
		if (o.type === OBJECT.MODEL && rotation) o.rotation[1] += rotation;
		delete o.dx; delete o.dy; delete o.above;
		if (o.type === OBJECT.MODEL && doc.rsw.version[0] === 2 && doc.rsw.version[1] >= 6 && o.unknownByte === undefined) o.unknownByte = 0;
		doc.rsw.objects.push(o);
		out.push(doc.rsw.objects.length - 1);
	}
	return out;
}

/** The parts a command touches, for undo. */
export function commandParts(name, args) {
	const c = COMMANDS[name];
	if (!c) throw new Error(`no command ${name}`);
	return typeof c.parts === 'function' ? c.parts(args) : c.parts;
}

/**
 * Run a command on a map, as one undo step when a history is given.
 * Unknown argument names are refused, so a typo is not silently ignored.
 */
export function runCommand(doc, name, args = {}, history = null, env = {}) {
	const c = COMMANDS[name];
	if (!c) throw new Error(`no command "${name}". Commands: ${Object.keys(COMMANDS).join(', ')}`);
	for (const k of Object.keys(args)) if (!(k in c.args)) throw new Error(`${name} has no argument "${k}" (it takes ${Object.keys(c.args).join(', ') || 'none'})`);
	for (const [k, spec] of Object.entries(c.args)) if (!spec[2] && (args[k] === undefined || args[k] === null || args[k] === '') && !(name === 'texture.paint')) {
		throw new Error(`${name} needs ${k}: ${spec[1]}`);
	}
	const parts = commandParts(name, args);
	const exec = () => c.run(doc, args, env) || {};
	const out = history && parts.length ? history.run(name, parts, exec) : exec();
	return { result: out.result, refresh: out.refresh || {} };
}

export { plainLightmapIndex, LIGHTMAP_SIZE, cellsIn };
