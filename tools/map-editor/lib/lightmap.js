// Lightmap baking: the shadows models and hills cast on the ground, and the
// coloured light from the map's point lights, written into the .gnd's
// lightmaps the way the official tools bake them.
//
// A lightmap is 8x8 texels: 64 bytes of shadow (255 = lit; the client
// multiplies the ground by it) then 64 RGB triples the client *adds*. Each
// surface gets its own. The outer ring of texels is a border the client
// filters into: the surface spans texels 1..7 (roBrowser's lightmap atlas
// reads 0.125..0.875 of each 8x8 cell).
//
// Shadows are rays from each texel toward the sun, against the ground and
// every model's triangles (in a grid over the map, so each ray only meets the
// triangles near it).

import { lightUniforms } from './light.js';
import { lightColor } from './rsw.js';
import { ownTile, countTileUse } from './map.js';
import { LIGHTMAP_SIZE } from './gnd.js';

const CELL = 4; // grid cell for occluders, world units

class Occluders {
	constructor(tris, width, height) {
		this.tris = tris;
		this.gw = Math.ceil(width / CELL) + 1;
		this.gh = Math.ceil(height / CELL) + 1;
		this.cells = new Array(this.gw * this.gh);
		this.top = Infinity;
		this.stamp = new Uint32Array(tris.length / 9);
		this.mark = 0;
		for (let t = 0; t < tris.length / 9; t++) {
			const o = t * 9;
			let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
			for (let k = 0; k < 3; k++) {
				x0 = Math.min(x0, tris[o + k * 3]); x1 = Math.max(x1, tris[o + k * 3]);
				z0 = Math.min(z0, tris[o + k * 3 + 2]); z1 = Math.max(z1, tris[o + k * 3 + 2]);
				this.top = Math.min(this.top, tris[o + k * 3 + 1]);
			}
			const cx0 = Math.max(0, Math.floor(x0 / CELL)), cx1 = Math.min(this.gw - 1, Math.floor(x1 / CELL));
			const cz0 = Math.max(0, Math.floor(z0 / CELL)), cz1 = Math.min(this.gh - 1, Math.floor(z1 / CELL));
			for (let z = cz0; z <= cz1; z++) for (let x = cx0; x <= cx1; x++) (this.cells[z * this.gw + x] ||= []).push(t);
		}
	}

	/** Whether a ray from p along d hits a triangle before rising above `top`. */
	hit(p, d, top) {
		const tris = this.tris;
		this.mark++;
		if (this.mark === 0xffffffff) { this.stamp.fill(0); this.mark = 1; }
		// Walk the grid cells under the ray's path, in steps of half a cell.
		const horiz = Math.hypot(d[0], d[2]);
		const maxT = d[1] < -1e-6 ? (p[1] - top) / -d[1] : 400;
		const step = horiz > 1e-6 ? (CELL * 0.5) / horiz : maxT + 1;
		let lastCell = -1;
		for (let t = 0; t <= maxT + step; t += step) {
			const x = p[0] + d[0] * t, z = p[2] + d[2] * t;
			for (let ox = -1; ox <= 1; ox++) for (let oz = -1; oz <= 1; oz++) {
				const cx = Math.floor(x / CELL) + ox, cz = Math.floor(z / CELL) + oz;
				if (cx < 0 || cz < 0 || cx >= this.gw || cz >= this.gh) continue;
				const ci = cz * this.gw + cx;
				if (ci === lastCell) continue;
				const list = this.cells[ci];
				if (!list) continue;
				for (const tri of list) {
					if (this.stamp[tri] === this.mark) continue;
					this.stamp[tri] = this.mark;
					if (rayTri(p, d, tris, tri * 9)) return true;
				}
			}
			if (horiz <= 1e-6) break;
		}
		return false;
	}
}

function rayTri(p, d, v, o) {
	const e1x = v[o + 3] - v[o], e1y = v[o + 4] - v[o + 1], e1z = v[o + 5] - v[o + 2];
	const e2x = v[o + 6] - v[o], e2y = v[o + 7] - v[o + 1], e2z = v[o + 8] - v[o + 2];
	const px = d[1] * e2z - d[2] * e2y, py = d[2] * e2x - d[0] * e2z, pz = d[0] * e2y - d[1] * e2x;
	const det = e1x * px + e1y * py + e1z * pz;
	if (Math.abs(det) < 1e-9) return false;
	const inv = 1 / det;
	const tx = p[0] - v[o], ty = p[1] - v[o + 1], tz = p[2] - v[o + 2];
	const u = (tx * px + ty * py + tz * pz) * inv;
	if (u < 0 || u > 1) return false;
	const qx = ty * e1z - tz * e1y, qy = tz * e1x - tx * e1z, qz = tx * e1y - ty * e1x;
	const w = (d[0] * qx + d[1] * qy + d[2] * qz) * inv;
	if (w < 0 || u + w > 1) return false;
	const t = (e2x * qx + e2y * qy + e2z * qz) * inv;
	return t > 0.02;
}

/** Ground height (world, down) at world x,z, bilinear on the cube. */
function groundY(g, x, z) {
	const cx = Math.min(g.width - 1, Math.max(0, Math.floor(x / 2))), cz = Math.min(g.height - 1, Math.max(0, Math.floor(z / 2)));
	const u = Math.min(1, Math.max(0, x / 2 - cx)), v = Math.min(1, Math.max(0, z / 2 - cz));
	const i = (cz * g.width + cx) * 4, h = g.heights;
	return ((h[i] * (1 - u) + h[i + 1] * u) * (1 - v) + (h[i + 2] * (1 - u) + h[i + 3] * u) * v) / 5;
}

function groundBlocks(g, p, d, top) {
	const maxT = d[1] < -1e-6 ? (p[1] - top) / -d[1] : 200;
	for (let t = 0.6; t < maxT; t += 0.5) {
		const x = p[0] + d[0] * t, y = p[1] + d[1] * t, z = p[2] + d[2] * t;
		if (x < 0 || z < 0 || x >= g.width * 2 || z >= g.height * 2) return false;
		if (y > groundY(g, x, z) + 0.05) return true;
	}
	return false;
}

/**
 * The surfaces of the ground with their four lightmap corners, as world
 * positions in the order the renderer gives them lightmap coordinates:
 * (u1,v1), (u2,v1), (u1,v2), (u2,v2).
 */
function surfaces(g, rect) {
	const out = [];
	const h = g.heights;
	for (let y = rect.y0; y <= rect.y1; y++) {
		for (let x = rect.x0; x <= rect.x1; x++) {
			const i = y * g.width + x, k = i * 4;
			if (g.up[i] >= 0) out.push({ side: 'up', i, c: [[x * 2, h[k] / 5, y * 2], [(x + 1) * 2, h[k + 1] / 5, y * 2], [x * 2, h[k + 2] / 5, (y + 1) * 2], [(x + 1) * 2, h[k + 3] / 5, (y + 1) * 2]] });
			if (g.front[i] >= 0 && y + 1 < g.height) {
				const b = (i + g.width) * 4;
				out.push({ side: 'front', i, c: [[x * 2, h[k + 2] / 5, (y + 1) * 2], [(x + 1) * 2, h[k + 3] / 5, (y + 1) * 2], [x * 2, h[b] / 5, (y + 1) * 2], [(x + 1) * 2, h[b + 1] / 5, (y + 1) * 2]] });
			}
			if (g.right[i] >= 0 && x + 1 < g.width) {
				const b = (i + 1) * 4;
				out.push({ side: 'right', i, c: [[(x + 1) * 2, h[k + 3] / 5, (y + 1) * 2], [(x + 1) * 2, h[k + 1] / 5, y * 2], [(x + 1) * 2, h[b + 2] / 5, (y + 1) * 2], [(x + 1) * 2, h[b] / 5, y * 2]] });
			}
		}
	}
	return out;
}

/**
 * Bake every surface's lightmap. `occluders` is a Float32Array of world-space
 * triangles (9 floats each) -- the models, from the renderer or rsm.js.
 * Options: shadows, lights (point lights), samples (rays per texel, 1..8),
 * rect (cubes) to bake only part. Calls progress(done, total) now and then.
 * Returns { surfaces, ms }.
 */
export function bakeLightmaps(doc, { occluders = new Float32Array(0), shadows = true, lights = true, samples = 1, rect = null, progress = null } = {}) {
	const started = Date.now();
	const g = doc.gnd;
	const r = rect || { x0: 0, y0: 0, x1: g.width - 1, y1: g.height - 1 };
	const light = lightUniforms(doc.rsw.light);
	const toward = light.direction; // points at the sun (y down, so negative y is up)
	const shadowAlpha = 1 - Math.min(1, Math.max(0, doc.rsw.light.opacity ?? 1));
	const occ = new Occluders(occluders, g.width * 2, g.height * 2);
	let top = occ.top;
	for (const v of g.heights) top = Math.min(top, v / 5);
	top -= 1;
	const points = lights ? doc.rsw.objects.filter(o => o.type === 2).map(o => ({ p: [o.position[0] / 5 + g.width, o.position[1] / 5, o.position[2] / 5 + g.height], color: lightColor(o), range: Math.max(0.1, o.range / 5) })) : [];
	const list = surfaces(g, r);
	if (!doc._tileUse) doc._tileUse = countTileUse(g);
	// Keep the lightmaps outside the baked rectangle; give each baked surface a new one.
	const keep = g.lightmap;
	const data = new Uint8Array(keep.data.length + list.length * LIGHTMAP_SIZE);
	data.set(keep.data);
	let next = keep.count;
	const jitter = samples > 1 ? Array.from({ length: samples }, (_, s) => [((s * 0.618) % 1 - 0.5) * 0.08, ((s * 0.382) % 1 - 0.5) * 0.08]) : [[0, 0]];
	list.forEach((s, n) => {
		const t = ownTile(doc, s.side, s.i);
		if (t < 0) return;
		const base = next * LIGHTMAP_SIZE;
		for (let ly = 0; ly < 8; ly++) {
			for (let lx = 0; lx < 8; lx++) {
				const su = Math.min(1, Math.max(0, (lx - 0.5) / 6)), sv = Math.min(1, Math.max(0, (ly - 0.5) / 6));
				const [c00, c10, c01, c11] = s.c;
				const p = [0, 1, 2].map(k => (c00[k] * (1 - su) + c10[k] * su) * (1 - sv) + (c01[k] * (1 - su) + c11[k] * su) * sv);
				// Lift off the surface, toward the light, so it does not shadow itself.
				const start = [p[0] + toward[0] * 0.05, p[1] + toward[1] * 0.05 - 0.02, p[2] + toward[2] * 0.05];
				let lit = 1;
				if (shadows && toward[1] < -0.01) {
					let blocked = 0;
					for (const [jx, jz] of jitter) {
						const d = [toward[0] + jx, toward[1], toward[2] + jz];
						const len = Math.hypot(d[0], d[1], d[2]);
						d[0] /= len; d[1] /= len; d[2] /= len;
						if (occ.hit(start, d, top) || groundBlocks(g, start, d, top)) blocked++;
					}
					lit = 1 - blocked / jitter.length;
				}
				data[base + ly * 8 + lx] = Math.round(255 * (lit + (1 - lit) * shadowAlpha));
				let cr = 0, cg = 0, cb = 0;
				for (const L of points) {
					const dist = Math.hypot(L.p[0] - p[0], L.p[1] - p[1], L.p[2] - p[2]);
					if (dist >= L.range) continue;
					const att = 1 - dist / L.range;
					cr += L.color[0] * att; cg += L.color[1] * att; cb += L.color[2] * att;
				}
				const o = base + 64 + (ly * 8 + lx) * 3;
				data[o] = Math.min(255, Math.round(cr * 255)); data[o + 1] = Math.min(255, Math.round(cg * 255)); data[o + 2] = Math.min(255, Math.round(cb * 255));
			}
		}
		g.tiles[t].light = next;
		next++;
		if (progress && n % 500 === 0) progress(n, list.length);
	});
	g.lightmap = { ...keep, count: next, data: data.subarray(0, next * LIGHTMAP_SIZE).slice() };
	compactLightmaps(doc);
	return { surfaces: list.length, lightmaps: g.lightmap.count, ms: Date.now() - started };
}

/** Merge identical lightmaps (most of a sunny map is plain) and drop unused ones. */
export function compactLightmaps(doc) {
	const g = doc.gnd, lm = g.lightmap;
	const seen = new Map(), remap = new Int32Array(lm.count).fill(-1);
	const used = new Uint8Array(lm.count);
	for (const t of g.tiles) if (t.light < lm.count) used[t.light] = 1;
	const out = [];
	for (let i = 0; i < lm.count; i++) {
		if (!used[i] && i !== 0) continue;
		const slice = lm.data.subarray(i * LIGHTMAP_SIZE, (i + 1) * LIGHTMAP_SIZE);
		let key = '';
		for (let j = 0; j < LIGHTMAP_SIZE; j += 1) key += String.fromCharCode(slice[j]);
		if (seen.has(key)) { remap[i] = seen.get(key); continue; }
		seen.set(key, out.length);
		remap[i] = out.length;
		out.push(slice);
	}
	const data = new Uint8Array(out.length * LIGHTMAP_SIZE);
	out.forEach((s, i) => data.set(s, i * LIGHTMAP_SIZE));
	for (const t of g.tiles) t.light = t.light < lm.count && remap[t.light] >= 0 ? remap[t.light] : 0;
	g.lightmap = { ...lm, count: out.length, data };
	delete doc._plainLight;
}

/**
 * What looks wrong about the lightmaps: a map rendered as a white sheet
 * (lightmaps adding near-full colour), or one that is all shadow.
 */
export function lightmapProblems(doc) {
	const lm = doc.gnd.lightmap;
	if (!lm.count) return ['the ground has no lightmaps'];
	let added = 0, shade = 0, n = 0;
	const used = new Set(doc.gnd.tiles.map(t => t.light));
	for (const i of used) {
		if (i >= lm.count) return [`a tile names lightmap ${i}, but there are only ${lm.count}`];
		const b = i * LIGHTMAP_SIZE;
		for (let j = 0; j < 64; j++) { shade += lm.data[b + j]; added += lm.data[b + 64 + j * 3] + lm.data[b + 65 + j * 3] + lm.data[b + 66 + j * 3]; n++; }
	}
	const out = [];
	if (added / (n * 3) > 160) out.push('the lightmaps add almost full white light: the ground will render as a white sheet (a lightmap is shadow then added colour, not brightness). Use Light → Reset lightmaps or Bake.');
	if (shade / n < 40) out.push('the lightmaps are almost all shadow: the ground will render nearly black.');
	return out;
}

/** World-space triangles of placed models, from compiled meshes and instance matrices. */
export function modelTriangles(placements) {
	let total = 0;
	for (const p of placements) for (const m of p.meshes) total += m.data.length / 9;
	const out = new Float32Array(total * 3);
	let o = 0;
	for (const { meshes, matrix: m } of placements) {
		for (const mesh of meshes) {
			const d = mesh.data;
			for (let i = 0; i < d.length; i += 9) {
				const x = d[i], y = d[i + 1], z = d[i + 2];
				out[o++] = m[0] * x + m[4] * y + m[8] * z + m[12];
				out[o++] = m[1] * x + m[5] * y + m[9] * z + m[13];
				out[o++] = m[2] * x + m[6] * y + m[10] * z + m[14];
			}
		}
	}
	return out;
}
