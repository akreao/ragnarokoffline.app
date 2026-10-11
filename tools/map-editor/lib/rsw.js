// .rsw: the world on the ground -- models, lights, sounds, effects, the
// global light and (before 2.6) the water.
//
// Read as roBrowser's Loaders/World.js reads it, keeping every field (and the
// padding of fixed-width names) so an unchanged map writes back byte for
// byte. Positions stay in file units: the renderer divides by 5 and moves the
// origin to the map's corner, as roBrowser's createInstance does.
//
// After the objects, 2.1+ files end in a quadtree of bounding boxes the
// official client culls with; roBrowser and rAthena ignore it. It is kept as
// read, and rebuilt (quadtree()) when the ground or the models change.

import { Reader, Writer } from './binary.js';

export const OBJECT = { MODEL: 1, LIGHT: 2, SOUND: 3, EFFECT: 4 };

/** A water level that means no water: far below any ground. */
export const NO_WATER = 1000;

const v3 = r => [r.f32(), r.f32(), r.f32()];

export function rswVersion(rsw) { return rsw.version[0] + rsw.version[1] / 10; }

export function readRsw(bytes) {
	const r = new Reader(bytes);
	const magic = r.str(4);
	if (magic !== 'GRSW') throw new Error(`not a .rsw file (starts "${magic}")`);
	const major = r.u8v(), minor = r.u8v();
	const version = major + minor / 10;
	const rsw = { version: [major, minor], buildNumber: 0, unknownByte: 0, files: {}, fileFields: {}, water: null, light: null, ground: null, objects: [], quadtree: null };
	if (version >= 2.5) rsw.buildNumber = r.i32();
	if (version >= 2.2) rsw.unknownByte = r.u8v();
	for (const key of ['ini', 'gnd', 'gat']) { rsw.fileFields[key] = r.field(40); rsw.files[key] = text(rsw.fileFields[key]); }
	if (version >= 1.4) { rsw.fileFields.src = r.field(40); rsw.files.src = text(rsw.fileFields.src); }

	if (version < 2.6) {
		const water = { level: 0, type: 0, waveHeight: 1, waveSpeed: 2, wavePitch: 50, animSpeed: 3 };
		if (version >= 1.3) water.level = r.f32();
		if (version >= 1.8) { water.type = r.i32(); water.waveHeight = r.f32(); water.waveSpeed = r.f32(); water.wavePitch = r.f32(); }
		if (version >= 1.9) water.animSpeed = r.i32();
		rsw.water = water;
	}
	const light = { longitude: 45, latitude: 45, diffuse: [1, 1, 1], ambient: [0.3, 0.3, 0.3], opacity: 1 };
	if (version >= 1.5) {
		light.longitude = r.i32(); light.latitude = r.i32();
		light.diffuse = v3(r); light.ambient = v3(r);
		if (version >= 1.7) light.opacity = r.f32();
	}
	rsw.light = light;
	if (version >= 1.6) rsw.ground = { top: r.i32(), bottom: r.i32(), left: r.i32(), right: r.i32() };
	if (version >= 2.7) {
		const n = r.i32();
		rsw.extra27 = r.bytes(4 * n);
	}

	const count = r.i32();
	for (let i = 0; i < count; i++) {
		const type = r.i32();
		if (type === OBJECT.MODEL) {
			const o = { type };
			if (version >= 1.3) {
				o.nameField = r.field(40); o.name = text(o.nameField);
				o.animType = r.i32(); o.animSpeed = r.f32(); o.blockType = r.i32();
			} else { o.name = ''; o.animType = 0; o.animSpeed = 1; o.blockType = 0; }
			if (version >= 2.6 && rsw.buildNumber >= 186) o.unknownByte = r.u8v();
			if (version >= 2.7) o.unknown27 = r.i32();
			o.fileField = r.field(80); o.file = text(o.fileField);
			o.nodeField = r.field(80); o.node = text(o.nodeField);
			o.position = v3(r); o.rotation = v3(r); o.scale = v3(r);
			rsw.objects.push(o);
		} else if (type === OBJECT.LIGHT) {
			const o = { type };
			o.nameField = r.field(80); o.name = text(o.nameField);
			o.position = v3(r);
			// Three colour channels. roBrowser reads them as integers; the
			// official tools write floats from 0 to 1. Kept as raw bits so
			// either survives, and read as floats when they look like floats.
			o.colorBits = [r.u32(), r.u32(), r.u32()];
			o.range = r.f32();
			rsw.objects.push(o);
		} else if (type === OBJECT.SOUND) {
			const o = { type };
			o.nameField = r.field(80); o.name = text(o.nameField);
			o.fileField = r.field(80); o.file = text(o.fileField);
			o.position = v3(r);
			o.volume = r.f32(); o.width = r.i32(); o.height = r.i32(); o.range = r.f32();
			o.cycle = version >= 2.0 ? r.f32() : 0;
			rsw.objects.push(o);
		} else if (type === OBJECT.EFFECT) {
			const o = { type };
			o.nameField = r.field(80); o.name = text(o.nameField);
			o.position = v3(r);
			o.id = r.i32(); o.delay = r.f32();
			o.param = [r.f32(), r.f32(), r.f32(), r.f32()];
			rsw.objects.push(o);
		} else {
			throw new Error(`unknown .rsw object type ${type} at object ${i}`);
		}
	}
	if (r.remaining) rsw.quadtree = r.bytes(r.remaining);
	return rsw;
}

function text(raw) {
	let s = '';
	for (const c of raw) { if (c === 0) break; s += String.fromCharCode(c); }
	return s;
}

export function writeRsw(rsw) {
	const version = rswVersion(rsw);
	const w = new Writer(1024 + rsw.objects.length * 260 + (rsw.quadtree ? rsw.quadtree.length : 0));
	w.str('GRSW', 4);
	w.u8v(rsw.version[0]).u8v(rsw.version[1]);
	if (version >= 2.5) w.i32(rsw.buildNumber);
	if (version >= 2.2) w.u8v(rsw.unknownByte);
	const ff = rsw.fileFields || {};
	for (const key of ['ini', 'gnd', 'gat']) w.str(rsw.files[key] || '', 40, ff[key]);
	if (version >= 1.4) w.str(rsw.files.src || '', 40, ff.src);
	if (version < 2.6) {
		const wt = rsw.water || { level: 0, type: 0, waveHeight: 1, waveSpeed: 2, wavePitch: 50, animSpeed: 3 };
		if (version >= 1.3) w.f32(wt.level);
		if (version >= 1.8) w.i32(wt.type).f32(wt.waveHeight).f32(wt.waveSpeed).f32(wt.wavePitch);
		if (version >= 1.9) w.i32(wt.animSpeed);
	}
	if (version >= 1.5) {
		const l = rsw.light;
		w.i32(l.longitude).i32(l.latitude).f32s(l.diffuse).f32s(l.ambient);
		if (version >= 1.7) w.f32(l.opacity);
	}
	if (version >= 1.6) {
		const g = rsw.ground || { top: -500, bottom: 500, left: -500, right: 500 };
		w.i32(g.top).i32(g.bottom).i32(g.left).i32(g.right);
	}
	if (version >= 2.7) { const extra = rsw.extra27 || new Uint8Array(0); w.i32(extra.length / 4).bytes(extra); }
	w.i32(rsw.objects.length);
	for (const o of rsw.objects) {
		w.i32(o.type);
		if (o.type === OBJECT.MODEL) {
			if (version >= 1.3) { w.str(o.name || '', 40, o.nameField); w.i32(o.animType | 0).f32(o.animSpeed ?? 1).i32(o.blockType | 0); }
			if (version >= 2.6 && rsw.buildNumber >= 186) w.u8v(o.unknownByte | 0);
			if (version >= 2.7) w.i32(o.unknown27 | 0);
			w.str(o.file, 80, o.fileField);
			w.str(o.node || '', 80, o.nodeField);
			w.f32s(o.position).f32s(o.rotation).f32s(o.scale);
		} else if (o.type === OBJECT.LIGHT) {
			w.str(o.name || '', 80, o.nameField);
			w.f32s(o.position);
			const bits = o.colorBits || floatBits(o.color || [1, 1, 1]);
			w.u32(bits[0]).u32(bits[1]).u32(bits[2]);
			w.f32(o.range);
		} else if (o.type === OBJECT.SOUND) {
			w.str(o.name || '', 80, o.nameField);
			w.str(o.file, 80, o.fileField);
			w.f32s(o.position);
			w.f32(o.volume).i32(o.width).i32(o.height).f32(o.range);
			if (version >= 2.0) w.f32(o.cycle);
		} else if (o.type === OBJECT.EFFECT) {
			w.str(o.name || '', 80, o.nameField);
			w.f32s(o.position);
			w.i32(o.id).f32(o.delay).f32s(o.param);
		}
	}
	if (rsw.quadtree) w.bytes(rsw.quadtree);
	return w.result();
}

const f32 = new Float32Array(1), u32 = new Uint32Array(f32.buffer);
function floatBits(color) { return color.map(c => { f32[0] = c; return u32[0]; }); }

/**
 * A light's colour as 0..1 floats. The official tools store floats; a few
 * maps hold integers 0..255, which as floats are tiny denormals.
 */
export function lightColor(o) {
	if (o.color) return o.color;
	return o.colorBits.map(bits => {
		u32[0] = bits; const f = f32[0];
		if (Number.isFinite(f) && Math.abs(f) >= 1e-6 && Math.abs(f) <= 64) return f;
		return bits <= 255 ? bits / 255 : 1;
	});
}

export function setLightColor(o, color) {
	o.color = color.slice(0, 3);
	o.colorBits = floatBits(o.color);
}

/** A fresh world for a new map: version 2.1, water and light in the file. */
export function createRsw(name) {
	return {
		version: [2, 1], buildNumber: 0, unknownByte: 0,
		files: { ini: '', gnd: `${name}.gnd`, gat: `${name}.gat`, src: '' }, fileFields: {},
		// No water: the level far below the ground (heights are positive down).
		water: { level: NO_WATER, type: 0, waveHeight: 1, waveSpeed: 2, wavePitch: 50, animSpeed: 3 },
		light: { longitude: 45, latitude: 45, diffuse: [1, 1, 1], ambient: [0.3, 0.3, 0.3], opacity: 0.5 },
		ground: { top: -500, bottom: 500, left: -500, right: 500 },
		objects: [], quadtree: null,
	};
}

/**
 * The 2.1+ quadtree: 1365 nodes (five levels below the root), each a box as
 * max, min, half size and centre (12 floats), depth first. Built over the
 * ground's extent and its height range; the official client only culls
 * with it, so an approximate box is safe where an absent one is not.
 * `bounds` is { minX, maxX, minZ, maxZ, minY, maxY } in file units.
 */
export function buildQuadtree(bounds) {
	const out = new Float32Array(1365 * 12);
	let at = 0;
	function node(minX, maxX, minZ, maxZ, depth) {
		const max = [maxX, bounds.maxY, maxZ], min = [minX, bounds.minY, minZ];
		const half = [(maxX - minX) / 2, (bounds.maxY - bounds.minY) / 2, (maxZ - minZ) / 2];
		const center = [minX + half[0], bounds.minY + half[1], minZ + half[2]];
		out.set([...max, ...min, ...half, ...center], at * 12);
		at++;
		if (depth < 5) {
			const mx = (minX + maxX) / 2, mz = (minZ + maxZ) / 2;
			node(minX, mx, minZ, mz, depth + 1);
			node(mx, maxX, minZ, mz, depth + 1);
			node(minX, mx, mz, maxZ, depth + 1);
			node(mx, maxX, mz, maxZ, depth + 1);
		}
	}
	node(bounds.minX, bounds.maxX, bounds.minZ, bounds.maxZ, 0);
	return new Uint8Array(out.buffer);
}
