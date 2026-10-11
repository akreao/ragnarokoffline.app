// .gat: where you can walk. One cell per server coordinate.
//
//   "GRAT", major, minor, width u32, height u32,
//   then width*height cells: four corner heights (f32) and a type (u32).
//
// Heights are in file units, positive *down* (RO's y axis), and the corners
// are (x,y) (x+1,y) (x,y+1) (x+1,y+1). The type is what rAthena reads into
// its map cache (src/map/map.cpp, map_gat2cell): only the number matters to
// the server, and the client draws nothing from it.

import { Reader, Writer } from './binary.js';

/** The cell types an editor offers, as rAthena reads them. */
export const GAT_TYPES = {
	0: { name: 'walkable', walk: true, shoot: true, water: false },
	1: { name: 'blocked', walk: false, shoot: false, water: false },
	2: { name: 'walkable (2)', walk: true, shoot: true, water: false },
	3: { name: 'walkable water', walk: true, shoot: true, water: true },
	4: { name: 'walkable (4)', walk: true, shoot: true, water: false },
	5: { name: 'cliff (shoot over, not walk)', walk: false, shoot: true, water: false },
	6: { name: 'walkable (6)', walk: true, shoot: true, water: false },
};

/** What rAthena makes of a raw type (map_gat2cell): walkable, shootable, water. */
export function cellKind(type) {
	const t = type >>> 0;
	// Grf Editor's "weird" types carry a high bit; the server masks nothing,
	// so anything it does not know is treated as blocked.
	const known = GAT_TYPES[t];
	return known || { name: `unknown (${t})`, walk: false, shoot: false, water: false };
}

export function readGat(bytes) {
	const r = new Reader(bytes);
	const magic = r.str(4);
	if (magic !== 'GRAT') throw new Error(`not a .gat file (starts "${magic}")`);
	const major = r.u8v(), minor = r.u8v();
	const width = r.u32(), height = r.u32();
	if (!width || !height || width > 4096 || height > 4096) throw new Error(`impossible .gat size ${width}x${height}`);
	const n = width * height;
	const heights = new Float32Array(n * 4);
	const types = new Uint32Array(n);
	for (let i = 0; i < n; i++) {
		heights[i * 4] = r.f32();
		heights[i * 4 + 1] = r.f32();
		heights[i * 4 + 2] = r.f32();
		heights[i * 4 + 3] = r.f32();
		types[i] = r.u32();
	}
	return { version: [major, minor], width, height, heights, types, trailing: r.remaining ? r.bytes(r.remaining) : null };
}

export function writeGat(gat) {
	const n = gat.width * gat.height;
	const w = new Writer(14 + n * 20 + (gat.trailing ? gat.trailing.length : 0));
	w.str('GRAT', 4);
	w.u8v(gat.version[0]).u8v(gat.version[1]);
	w.u32(gat.width).u32(gat.height);
	for (let i = 0; i < n; i++) {
		w.f32(gat.heights[i * 4]).f32(gat.heights[i * 4 + 1]).f32(gat.heights[i * 4 + 2]).f32(gat.heights[i * 4 + 3]);
		w.u32(gat.types[i]);
	}
	if (gat.trailing) w.bytes(gat.trailing);
	return w.result();
}

export function createGat(width, height, type = 0) {
	return { version: [1, 2], width, height, heights: new Float32Array(width * height * 4), types: new Uint32Array(width * height).fill(type), trailing: null };
}
