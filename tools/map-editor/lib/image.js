// The client's pictures: BMP and TGA in, BMP out. Pure, so the same code
// decodes a ground texture in the page and paints a minimap in the CLI.
//
// Decoded images are { width, height, data: Uint8ClampedArray RGBA, top row
// first }. Magenta (255,0,255) is the client's transparent colour, and is
// made transparent here as roBrowser does (Utils/Texture.js).

export function decodeImage(bytes, name = '') {
	const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
	if (u8[0] === 0x42 && u8[1] === 0x4d) return bleed(decodeBmp(u8));
	if (/\.tga$/i.test(name) || looksLikeTga(u8)) return bleed(decodeTga(u8));
	return null; // JPEG/PNG: the browser decodes those
}

/**
 * Give transparent pixels the colour of their opaque neighbours. Filtering
 * and mipmaps blend a texel with the ones beside it, transparent or not, so a
 * transparent pixel that is still magenta underneath draws a pink fringe
 * round every leaf and banner.
 */
export function bleed(img) {
	const { width: w, height: h, data } = img;
	const known = new Uint8Array(w * h);
	let pending = [];
	for (let i = 0; i < w * h; i++) { if (data[i * 4 + 3] > 0) known[i] = 1; else pending.push(i); }
	if (!pending.length) return img;
	for (let pass = 0; pass < 4 && pending.length; pass++) {
		const filled = [], next = [];
		for (const i of pending) {
			const x = i % w, y = (i / w) | 0;
			let r = 0, g = 0, b = 0, n = 0;
			for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
				const nx = x + dx, ny = y + dy;
				if (nx < 0 || ny < 0 || nx >= w || ny >= h || !known[ny * w + nx]) continue;
				const o = (ny * w + nx) * 4;
				r += data[o]; g += data[o + 1]; b += data[o + 2]; n++;
			}
			if (n) filled.push(i, r / n, g / n, b / n); else next.push(i);
		}
		for (let k = 0; k < filled.length; k += 4) {
			const i = filled[k];
			data[i * 4] = filled[k + 1]; data[i * 4 + 1] = filled[k + 2]; data[i * 4 + 2] = filled[k + 3];
			known[i] = 1;
		}
		pending = next;
	}
	for (const i of pending) { data[i * 4] = 0; data[i * 4 + 1] = 0; data[i * 4 + 2] = 0; }
	return img;
}

function looksLikeTga(u8) {
	return u8.length > 18 && (u8[2] === 2 || u8[2] === 10) && (u8[16] === 24 || u8[16] === 32);
}

export function decodeBmp(u8) {
	const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
	const offset = dv.getUint32(10, true);
	const header = dv.getUint32(14, true);
	const width = dv.getInt32(18, true);
	let height = dv.getInt32(22, true);
	const bpp = dv.getUint16(28, true);
	const compression = header >= 40 ? dv.getUint32(30, true) : 0;
	const topDown = height < 0;
	height = Math.abs(height);
	if (width <= 0 || height <= 0 || width > 8192 || height > 8192) throw new Error(`bad BMP size ${width}x${height}`);
	if (compression !== 0 && compression !== 3) throw new Error(`compressed BMP (${compression}) is not supported`);
	let palette = null;
	if (bpp <= 8) {
		const colors = (header >= 40 && dv.getUint32(46, true)) || 1 << bpp;
		palette = u8.subarray(14 + header, 14 + header + colors * 4);
	}
	const stride = Math.ceil((width * bpp) / 32) * 4;
	const data = new Uint8ClampedArray(width * height * 4);
	for (let y = 0; y < height; y++) {
		const row = offset + (topDown ? y : height - 1 - y) * stride;
		for (let x = 0; x < width; x++) {
			let r, g, b, a = 255;
			if (bpp === 24) { b = u8[row + x * 3]; g = u8[row + x * 3 + 1]; r = u8[row + x * 3 + 2]; }
			else if (bpp === 32) { b = u8[row + x * 4]; g = u8[row + x * 4 + 1]; r = u8[row + x * 4 + 2]; }
			else if (bpp === 8) { const i = u8[row + x] * 4; b = palette[i]; g = palette[i + 1]; r = palette[i + 2]; }
			else if (bpp === 4) { const v = u8[row + (x >> 1)]; const i = ((x & 1) ? v & 15 : v >> 4) * 4; b = palette[i]; g = palette[i + 1]; r = palette[i + 2]; }
			else if (bpp === 1) { const i = ((u8[row + (x >> 3)] >> (7 - (x & 7))) & 1) * 4; b = palette[i]; g = palette[i + 1]; r = palette[i + 2]; }
			else if (bpp === 16) { const v = u8[row + x * 2] | (u8[row + x * 2 + 1] << 8); r = ((v >> 10) & 31) << 3; g = ((v >> 5) & 31) << 3; b = (v & 31) << 3; }
			else throw new Error(`${bpp}-bit BMP is not supported`);
			if (r > 0xf0 && g < 0x10 && b > 0xf0) a = 0;
			const o = (y * width + x) * 4;
			data[o] = r; data[o + 1] = g; data[o + 2] = b; data[o + 3] = a;
		}
	}
	return { width, height, data };
}

export function decodeTga(u8) {
	const idLength = u8[0], type = u8[2];
	const width = u8[12] | (u8[13] << 8), height = u8[14] | (u8[15] << 8);
	const bpp = u8[16], descriptor = u8[17];
	if (type !== 2 && type !== 10) throw new Error(`TGA type ${type} is not supported`);
	if (bpp !== 24 && bpp !== 32) throw new Error(`${bpp}-bit TGA is not supported`);
	const px = bpp / 8;
	const raw = new Uint8Array(width * height * px);
	let p = 18 + idLength;
	if (type === 2) raw.set(u8.subarray(p, p + raw.length));
	else {
		let o = 0;
		while (o < raw.length) {
			const head = u8[p++];
			const n = (head & 127) + 1;
			if (head & 128) { for (let i = 0; i < n; i++) { raw.set(u8.subarray(p, p + px), o); o += px; } p += px; }
			else { raw.set(u8.subarray(p, p + n * px), o); o += n * px; p += n * px; }
		}
	}
	const topDown = (descriptor & 0x20) !== 0;
	const data = new Uint8ClampedArray(width * height * 4);
	for (let y = 0; y < height; y++) {
		const sy = topDown ? y : height - 1 - y;
		for (let x = 0; x < width; x++) {
			const s = (sy * width + x) * px, o = (y * width + x) * 4;
			data[o] = raw[s + 2]; data[o + 1] = raw[s + 1]; data[o + 2] = raw[s]; data[o + 3] = px === 4 ? raw[s + 3] : 255;
		}
	}
	return { width, height, data };
}

/** A 24-bit BMP of an RGBA image (alpha dropped, transparent drawn magenta). */
export function encodeBmp(img) {
	const { width, height, data } = img;
	const stride = Math.ceil((width * 3) / 4) * 4;
	const size = 54 + stride * height;
	const out = new Uint8Array(size);
	const dv = new DataView(out.buffer);
	out[0] = 0x42; out[1] = 0x4d;
	dv.setUint32(2, size, true);
	dv.setUint32(10, 54, true);
	dv.setUint32(14, 40, true);
	dv.setInt32(18, width, true);
	dv.setInt32(22, height, true);
	dv.setUint16(26, 1, true);
	dv.setUint16(28, 24, true);
	dv.setUint32(34, stride * height, true);
	dv.setInt32(38, 2835, true);
	dv.setInt32(42, 2835, true);
	for (let y = 0; y < height; y++) {
		const row = 54 + (height - 1 - y) * stride;
		for (let x = 0; x < width; x++) {
			const s = (y * width + x) * 4;
			const transparent = data[s + 3] < 128;
			out[row + x * 3] = transparent ? 255 : data[s + 2];
			out[row + x * 3 + 1] = transparent ? 0 : data[s + 1];
			out[row + x * 3 + 2] = transparent ? 255 : data[s];
		}
	}
	return out;
}

/** The average colour of an image's opaque pixels, for minimaps. */
export function averageColor(img) {
	let r = 0, g = 0, b = 0, n = 0;
	const step = Math.max(1, Math.floor((img.width * img.height) / 4096));
	for (let i = 0; i < img.width * img.height; i += step) {
		const o = i * 4;
		if (img.data[o + 3] < 128) continue;
		r += img.data[o]; g += img.data[o + 1]; b += img.data[o + 2]; n++;
	}
	return n ? [r / n, g / n, b / n] : [128, 128, 128];
}

/** Nearest-neighbour resize, for texture layers and thumbnails. */
export function resizeImage(img, width, height) {
	if (img.width === width && img.height === height) return img;
	const data = new Uint8ClampedArray(width * height * 4);
	for (let y = 0; y < height; y++) {
		const sy = Math.min(img.height - 1, Math.floor((y * img.height) / height));
		for (let x = 0; x < width; x++) {
			const sx = Math.min(img.width - 1, Math.floor((x * img.width) / width));
			const s = (sy * img.width + sx) * 4, o = (y * width + x) * 4;
			data[o] = img.data[s]; data[o + 1] = img.data[s + 1]; data[o + 2] = img.data[s + 2]; data[o + 3] = img.data[s + 3];
		}
	}
	return { width, height, data };
}

/** A PNG of an RGBA image (stored, uncompressed zlib), for screenshots in Node. */
export function encodePng(img) {
	const { width, height, data } = img;
	const raw = new Uint8Array((width * 4 + 1) * height);
	for (let y = 0; y < height; y++) {
		raw[y * (width * 4 + 1)] = 0;
		raw.set(data.subarray(y * width * 4, (y + 1) * width * 4), y * (width * 4 + 1) + 1);
	}
	const chunks = [];
	const u32 = v => [(v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255];
	const chunk = (type, body) => {
		const t = [...type].map(c => c.charCodeAt(0));
		const all = new Uint8Array(4 + body.length);
		all.set(t); all.set(body, 4);
		chunks.push(new Uint8Array(u32(body.length)), all, new Uint8Array(u32(crc32(all))));
	};
	chunk('IHDR', new Uint8Array([...u32(width), ...u32(height), 8, 6, 0, 0, 0]));
	chunk('IDAT', zlibStored(raw));
	chunk('IEND', new Uint8Array(0));
	const sig = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
	const total = sig.length + chunks.reduce((a, c) => a + c.length, 0);
	const out = new Uint8Array(total);
	let o = 0;
	for (const c of [sig, ...chunks]) { out.set(c, o); o += c.length; }
	return out;
}

let crcTable = null;
function crc32(u8) {
	if (!crcTable) {
		crcTable = new Uint32Array(256);
		for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; crcTable[n] = c >>> 0; }
	}
	let c = 0xffffffff;
	for (const b of u8) c = crcTable[(c ^ b) & 255] ^ (c >>> 8);
	return (c ^ 0xffffffff) >>> 0;
}

function zlibStored(u8) {
	const blocks = Math.ceil(u8.length / 65535) || 1;
	const out = new Uint8Array(2 + u8.length + blocks * 5 + 4);
	out[0] = 0x78; out[1] = 0x01;
	let o = 2;
	for (let i = 0; i < blocks; i++) {
		const part = u8.subarray(i * 65535, Math.min(u8.length, (i + 1) * 65535));
		out[o++] = i === blocks - 1 ? 1 : 0;
		out[o++] = part.length & 255; out[o++] = part.length >> 8;
		out[o++] = ~part.length & 255; out[o++] = (~part.length >> 8) & 255;
		out.set(part, o); o += part.length;
	}
	let a = 1, b = 0;
	for (const v of u8) { a = (a + v) % 65521; b = (b + a) % 65521; }
	out[o++] = b >> 8; out[o++] = b & 255; out[o++] = a >> 8; out[o++] = a & 255;
	return out;
}
