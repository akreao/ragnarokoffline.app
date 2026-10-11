// .spr/.act: NPC and monster sprites, for markers and pickers.
//
// The reading is the control panel's (tools/control-panel/sprite.js), which
// is the monster browser's; this copy draws one action in one direction of
// a single sprite, which is all a marker needs, and returns pixels rather
// than drawing on a canvas so it also works in a worker or in Node.

function reader(buf) {
	const u8 = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
	const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
	let p = 0;
	return {
		u8, get pos() { return p; }, set pos(v) { p = v; },
		u8v: () => dv.getUint8(p++),
		u16: () => { const v = dv.getUint16(p, true); p += 2; return v; },
		i16: () => { const v = dv.getInt16(p, true); p += 2; return v; },
		i32: () => { const v = dv.getInt32(p, true); p += 4; return v; },
		u32: () => { const v = dv.getUint32(p, true); p += 4; return v; },
		f32: () => { const v = dv.getFloat32(p, true); p += 4; return v; },
		str: n => { let s = ''; for (let i = 0; i < n; i++) s += String.fromCharCode(dv.getUint8(p + i)); p += n; return s; },
	};
}

export function readSpr(buf) {
	const r = reader(buf);
	if (r.str(2) !== 'SP') throw new Error('not a sprite');
	const version = r.u8v() / 10 + r.u8v();
	const indexed = r.u16();
	const rgba = version > 1.1 ? r.u16() : 0;
	const frames = [];
	for (let i = 0; i < indexed; i++) {
		const w = r.u16(), h = r.u16();
		const data = new Uint8Array(w * h);
		if (version < 2.1) {
			for (let j = 0; j < w * h; j++) data[j] = r.u8v();
		} else {
			const end = r.u16() + r.pos;
			let k = 0;
			while (r.pos < end) {
				const c = r.u8v();
				data[k++] = c;
				if (!c) {
					const n = r.u8v();
					if (!n) data[k++] = 0; else for (let j = 1; j < n; j++) data[k++] = 0;
				}
			}
		}
		frames.push({ rgba: false, w, h, data });
	}
	for (let i = 0; i < rgba; i++) {
		const w = r.i16(), h = r.i16();
		const data = r.u8.slice(r.pos, r.pos + w * h * 4);
		r.pos += w * h * 4;
		frames.push({ rgba: true, w, h, data });
	}
	const palette = version > 1.0 ? r.u8.slice(r.u8.length - 1024) : null;
	return { indexed, frames, palette };
}

export function readAct(buf) {
	const r = reader(buf);
	if (r.str(2) !== 'AC') throw new Error('not an action file');
	const version = r.u8v() / 10 + r.u8v();
	const count = r.u16();
	r.pos += 10;
	const actions = [];
	for (let a = 0; a < count; a++) {
		const frames = [];
		const nf = r.u32();
		for (let f = 0; f < nf; f++) {
			r.pos += 32;
			const nl = r.u32();
			const layers = [];
			for (let l = 0; l < nl; l++) {
				const layer = { x: r.i32(), y: r.i32(), index: r.i32(), mirror: r.i32(), alpha: 1, sx: 1, sy: 1, angle: 0, type: 0 };
				if (version >= 2.0) {
					r.u8v(); r.u8v(); r.u8v(); layer.alpha = r.u8v() / 255;
					layer.sx = r.f32();
					layer.sy = version <= 2.3 ? layer.sx : r.f32();
					layer.angle = r.i32();
					layer.type = r.i32();
					if (version >= 2.5) { r.i32(); r.i32(); }
				}
				layers.push(layer);
			}
			if (version >= 2.0) r.i32();
			if (version >= 2.3) {
				const np = r.i32();
				r.pos += np * 16;
			}
			frames.push({ layers });
		}
		actions.push(frames);
	}
	return { actions };
}

function framePixels(spr, index, palette) {
	const f = spr.frames[index];
	if (!f) return null;
	const out = new Uint8ClampedArray(Math.max(1, f.w) * Math.max(1, f.h) * 4);
	for (let y = 0; y < f.h; y++) {
		for (let x = 0; x < f.w; x++) {
			const o = (y * f.w + x) * 4;
			if (f.rgba) {
				const s = ((f.h - y - 1) * f.w + x) * 4;
				out[o] = f.data[s + 3]; out[o + 1] = f.data[s + 2]; out[o + 2] = f.data[s + 1]; out[o + 3] = f.data[s];
			} else {
				const i = f.data[y * f.w + x];
				if (!i || !palette) continue;
				out[o] = palette[i * 4]; out[o + 1] = palette[i * 4 + 1]; out[o + 2] = palette[i * 4 + 2]; out[o + 3] = 255;
			}
		}
	}
	return { width: Math.max(1, f.w), height: Math.max(1, f.h), data: out };
}

/**
 * rAthena's facing (0 north, counter-clockwise: 1 north-west ... 6 east,
 * 7 north-east) as the act file's direction (0 south, clockwise: 1
 * south-west, 2 west ... 7 south-east), seen from a camera facing north.
 */
export function actDirection(dir) { return (12 - (dir & 7)) % 8; }

/**
 * One frame of a sprite as pixels: action `action` (0 standing), facing
 * `dir` (rAthena's). Mirroring and scaling are applied; rotation is not
 * (markers do not need it). Returns { width, height, data, originX, originY }
 * where the origin is the sprite's feet.
 */
export function renderSprite(spr, act, action = 0, dir = 4, frame = 0) {
	const index = action * 8 + actDirection(dir);
	const frames = act.actions[index] || act.actions[0] || [];
	const f = frames[frame] || frames[0];
	if (!f) return null;
	const placed = [];
	for (const layer of f.layers) {
		if (layer.index < 0) continue;
		const px = framePixels(spr, layer.index + (layer.type === 1 ? spr.indexed : 0), spr.palette);
		if (px) placed.push({ px, layer });
	}
	if (!placed.length) return null;
	let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
	for (const p of placed) {
		const w = p.px.width * Math.abs(p.layer.sx), h = p.px.height * Math.abs(p.layer.sy);
		x0 = Math.min(x0, p.layer.x - w / 2); x1 = Math.max(x1, p.layer.x + w / 2);
		y0 = Math.min(y0, p.layer.y - h / 2); y1 = Math.max(y1, p.layer.y + h / 2);
	}
	x0 = Math.floor(x0); y0 = Math.floor(y0); x1 = Math.ceil(x1); y1 = Math.ceil(y1);
	const width = Math.max(1, x1 - x0), height = Math.max(1, y1 - y0);
	const data = new Uint8ClampedArray(width * height * 4);
	for (const { px, layer } of placed) {
		const sx = layer.sx * (layer.mirror ? -1 : 1), sy = layer.sy;
		const w = px.width * Math.abs(layer.sx), h = px.height * Math.abs(layer.sy);
		const left = layer.x - w / 2 - x0, top = layer.y - h / 2 - y0;
		for (let y = 0; y < Math.round(h); y++) {
			for (let x = 0; x < Math.round(w); x++) {
				let u = Math.floor(x / Math.abs(sx)), v = Math.floor(y / Math.abs(sy));
				if (sx < 0) u = px.width - 1 - u;
				if (u < 0 || v < 0 || u >= px.width || v >= px.height) continue;
				const s = (v * px.width + u) * 4;
				const a = (px.data[s + 3] / 255) * layer.alpha;
				if (a <= 0) continue;
				const dx = Math.round(left + x), dy = Math.round(top + y);
				if (dx < 0 || dy < 0 || dx >= width || dy >= height) continue;
				const o = (dy * width + dx) * 4;
				const ia = 1 - a;
				data[o] = px.data[s] * a + data[o] * ia;
				data[o + 1] = px.data[s + 1] * a + data[o + 1] * ia;
				data[o + 2] = px.data[s + 2] * a + data[o + 2] * ia;
				data[o + 3] = Math.min(255, a * 255 + data[o + 3] * ia);
			}
		}
	}
	return { width, height, data, originX: -x0, originY: -y0 };
}
