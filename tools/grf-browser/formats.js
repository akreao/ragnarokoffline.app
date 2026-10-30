// The GRF browser's conversions: the client's files out to PNG pictures for
// an ordinary image editor, and edited pictures back into the file the client
// reads. Pure, so the same code runs in the page and in the tests; the page
// does the PNG encoding and decoding itself (the browser's canvas), and hands
// these functions plain RGBA images: { width, height, data } with data a
// Uint8ClampedArray, top row first.
//
// Reading .spr/.act and BMP/TGA is the map editor's (tools/map-editor/lib),
// served to this page under shared/.

/** What the browser can do with a file, by its extension. */
export function fileKind(name) {
	const ext = (/\.([^.\\/]+)$/.exec(name) || [])[1]?.toLowerCase() || '';
	if (ext === 'spr') return 'sprite';
	if (ext === 'act') return 'action';
	if (ext === 'pal') return 'palette';
	if (['bmp', 'tga', 'jpg', 'jpeg', 'png'].includes(ext)) return 'image';
	if (['txt', 'xml', 'ini', 'lua', 'csv', 'json', 'yml', 'yaml'].includes(ext)) return 'text';
	if (['wav', 'mp3', 'ogg'].includes(ext)) return 'sound';
	if (['rsw', 'gnd', 'gat'].includes(ext)) return 'map';
	if (ext === 'rsm' || ext === 'rsm2') return 'model';
	return 'other';
}

/** Kinds that go out as PNG and come back in: pictures, sprites' frames, palettes. */
export const EDITABLE = new Set(['sprite', 'image', 'palette']);

// ---- Sprites

/**
 * One frame of a sprite (read by the map editor's readSpr) as an RGBA image.
 * Palette index 0 is the background and comes out transparent; RGBA frames
 * are stored bottom row first, as A, B, G, R.
 */
export function frameToImage(spr, index) {
	const f = spr.frames[index];
	const width = Math.max(1, f.w), height = Math.max(1, f.h);
	const data = new Uint8ClampedArray(width * height * 4);
	for (let y = 0; y < f.h; y++) {
		for (let x = 0; x < f.w; x++) {
			const o = (y * f.w + x) * 4;
			if (f.rgba) {
				const s = ((f.h - y - 1) * f.w + x) * 4;
				data[o] = f.data[s + 3]; data[o + 1] = f.data[s + 2]; data[o + 2] = f.data[s + 1]; data[o + 3] = f.data[s];
			} else {
				const i = f.data[y * f.w + x];
				if (!i || !spr.palette) continue;
				data[o] = spr.palette[i * 4]; data[o + 1] = spr.palette[i * 4 + 1]; data[o + 2] = spr.palette[i * 4 + 2]; data[o + 3] = 255;
			}
		}
	}
	return { width, height, data };
}

/** The file name each frame goes out as: frame-000.png, frame-001.png ... */
export const frameFile = index => `frame-${String(index).padStart(3, '0')}.png`;

/**
 * The colour of each palette index nearest to an RGB, ignoring index 0 (the
 * background). Remembered per colour, since a frame repeats a few dozen.
 */
function nearestIndex(palette, cache, r, g, b) {
	const key = (r << 16) | (g << 8) | b;
	let hit = cache.get(key);
	if (hit !== undefined) return hit;
	let best = 1, bestDistance = Infinity;
	for (let i = 1; i < 256; i++) {
		const dr = palette[i * 4] - r, dg = palette[i * 4 + 1] - g, db = palette[i * 4 + 2] - b;
		const distance = dr * dr + dg * dg + db * db;
		if (distance < bestDistance) { bestDistance = distance; best = i; if (!distance) break; }
	}
	cache.set(key, best);
	return best;
}

/**
 * Up to 255 colours for a new palette, the most used first, from the opaque
 * pixels of `images` (scripts/mksprite.py's rule). Index 0 stays the
 * background, magenta as the stock files have it.
 */
export function buildPalette(images) {
	const counts = new Map();
	for (const img of images) {
		for (let o = 0; o < img.data.length; o += 4) {
			if (img.data[o + 3] < 128) continue;
			const key = (img.data[o] << 16) | (img.data[o + 1] << 8) | img.data[o + 2];
			counts.set(key, (counts.get(key) || 0) + 1);
		}
	}
	const colours = [...counts].sort((a, b) => b[1] - a[1]).slice(0, 255).map(([key]) => key);
	const palette = new Uint8Array(1024);
	palette.set([255, 0, 255, 0], 0);
	colours.forEach((key, i) => palette.set([(key >> 16) & 255, (key >> 8) & 255, key & 255, 0], (i + 1) * 4));
	// Unused entries repeat the last colour rather than black, so nothing maps to a colour nobody drew.
	const last = colours.length * 4;
	for (let i = colours.length + 1; i < 256; i++) palette.set(palette.subarray(last, last + 4), i * 4);
	return { palette, colours: counts.size };
}

/**
 * Edited pictures back into a sprite. `images` maps a frame index to its new
 * RGBA image; frames without one keep what they had. Palette frames take the
 * nearest colour of the sprite's own palette -- so recolours (job and hair
 * palettes) keep working -- unless `newPalette` is set, which builds one from
 * every frame. Transparent pixels (alpha under 128) become the background.
 * Returns { spr, changed, inexact }: inexact counts pixels whose colour was not
 * in the palette and so moved to the nearest one.
 */
export function rebuildSprite(spr, images, { newPalette = false } = {}) {
	const frames = spr.frames.map(f => ({ ...f }));
	let palette = spr.palette ? new Uint8Array(spr.palette) : null;
	const replaced = [...images.keys()].filter(i => i >= 0 && i < frames.length);
	const paletteFrames = replaced.filter(i => !frames[i].rgba);
	if (newPalette || (!palette && paletteFrames.length)) {
		// Every palette frame shares the palette, so it is built from all of them: edited ones as edited.
		const all = frames.map((f, i) => (f.rgba ? null : images.get(i) || frameToImage({ ...spr, palette: palette || new Uint8Array(1024) }, i))).filter(Boolean);
		palette = buildPalette(all).palette;
	}
	const cache = new Map();
	let inexact = 0;
	const exact = new Set();
	for (let i = 1; i < 256 && palette; i++) exact.add((palette[i * 4] << 16) | (palette[i * 4 + 1] << 8) | palette[i * 4 + 2]);
	// With a new palette, the frames nobody edited are mapped again too.
	const indices = newPalette ? frames.map((f, i) => i).filter(i => !frames[i].rgba) : [];
	for (const i of new Set([...replaced, ...indices])) {
		const img = images.get(i) || frameToImage(spr, i);
		const f = frames[i];
		const w = img.width, h = img.height;
		if (f.rgba) {
			const data = new Uint8Array(w * h * 4);
			for (let y = 0; y < h; y++) {
				for (let x = 0; x < w; x++) {
					const s = (y * w + x) * 4, o = ((h - y - 1) * w + x) * 4;
					data[o] = img.data[s + 3]; data[o + 1] = img.data[s + 2]; data[o + 2] = img.data[s + 1]; data[o + 3] = img.data[s];
				}
			}
			frames[i] = { rgba: true, w, h, data };
			continue;
		}
		const data = new Uint8Array(w * h);
		for (let p = 0; p < w * h; p++) {
			const o = p * 4;
			if (img.data[o + 3] < 128) continue;
			const r = img.data[o], g = img.data[o + 1], b = img.data[o + 2];
			if (!exact.has((r << 16) | (g << 8) | b)) inexact++;
			data[p] = nearestIndex(palette, cache, r, g, b);
		}
		frames[i] = { rgba: false, w, h, data };
	}
	return { spr: { indexed: spr.indexed, frames, palette }, changed: replaced.length, inexact };
}

/**
 * A .spr, version 2.0: palette frames uncompressed, then RGBA frames, then
 * the palette. Every client and sprite tool reads it.
 */
export function writeSpr(spr) {
	const indexed = spr.frames.filter(f => !f.rgba);
	const rgba = spr.frames.filter(f => f.rgba);
	let size = 8;
	for (const f of indexed) size += 4 + f.w * f.h;
	for (const f of rgba) size += 4 + f.w * f.h * 4;
	size += 1024;
	const out = new Uint8Array(size);
	const dv = new DataView(out.buffer);
	// 'SP', the version as minor then major byte, then the two frame counts.
	out.set([0x53, 0x50, 0, 2]);
	dv.setUint16(4, indexed.length, true);
	dv.setUint16(6, rgba.length, true);
	let p = 8;
	for (const f of indexed) {
		dv.setUint16(p, f.w, true); dv.setUint16(p + 2, f.h, true); p += 4;
		out.set(f.data.subarray(0, f.w * f.h), p); p += f.w * f.h;
	}
	for (const f of rgba) {
		dv.setInt16(p, f.w, true); dv.setInt16(p + 2, f.h, true); p += 4;
		out.set(f.data.subarray(0, f.w * f.h * 4), p); p += f.w * f.h * 4;
	}
	const palette = spr.palette || new Uint8Array(1024);
	out.set(palette.subarray(0, 1024), p);
	return out;
}

// ---- Palettes

/** A .pal (256 colours, R G B and a reserved byte) as a 16x16 grid of `cell`-pixel squares. */
export function paletteToImage(pal, cell = 8) {
	const width = 16 * cell, height = 16 * cell;
	const data = new Uint8ClampedArray(width * height * 4);
	for (let y = 0; y < height; y++) {
		for (let x = 0; x < width; x++) {
			const i = ((y / cell) | 0) * 16 + ((x / cell) | 0);
			const o = (y * width + x) * 4;
			data[o] = pal[i * 4]; data[o + 1] = pal[i * 4 + 1]; data[o + 2] = pal[i * 4 + 2]; data[o + 3] = 255;
		}
	}
	return { width, height, data };
}

/** paletteToImage read back: each colour from the middle of its square, at any size. */
export function imageToPalette(img) {
	const pal = new Uint8Array(1024);
	for (let i = 0; i < 256; i++) {
		const x = Math.min(img.width - 1, Math.floor((((i % 16) + 0.5) * img.width) / 16));
		const y = Math.min(img.height - 1, Math.floor(((((i / 16) | 0) + 0.5) * img.height) / 16));
		const o = (y * img.width + x) * 4;
		pal.set([img.data[o], img.data[o + 1], img.data[o + 2], 0], i * 4);
	}
	return pal;
}

// ---- Pictures

/** A 32-bit uncompressed TGA, bottom row first, as the client's own are. */
export function encodeTga(img) {
	const { width, height, data } = img;
	const out = new Uint8Array(18 + width * height * 4);
	out[2] = 2;
	out[12] = width & 255; out[13] = width >> 8;
	out[14] = height & 255; out[15] = height >> 8;
	out[16] = 32; out[17] = 8;
	for (let y = 0; y < height; y++) {
		for (let x = 0; x < width; x++) {
			const s = (y * width + x) * 4, o = 18 + ((height - 1 - y) * width + x) * 4;
			out[o] = data[s + 2]; out[o + 1] = data[s + 1]; out[o + 2] = data[s]; out[o + 3] = data[s + 3];
		}
	}
	return out;
}

// ---- Names

/** A GRF name (backslashes, Korean) as the path it takes inside a mod: data/... with slashes. */
export function modPath(name) {
	return String(name).replace(/\\/g, '/').replace(/^\/+/, '');
}

/** A folder name for a file's PNGs: its path, flattened, and nothing a file system minds. */
export function workName(name) {
	return modPath(name).replace(/^data\//i, '').replace(/[/\\:*?"<>|]+/g, '_').replace(/^\.+/, '').slice(0, 120) || 'file';
}
