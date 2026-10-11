// The minimap: the map seen from straight above, written where the client
// looks for it (data/texture/유저인터페이스/map/<name>.bmp). Without one the
// client asks, gets nothing and shows an empty frame.
//
// The page renders it with WebGL (what the game would draw, models and all).
// This is the software version for the command line, with no GPU: the ground
// textures, lit by the lightmaps and the sun, with water and the models'
// footprints laid over it.

import { decodeName } from './cp949.js';
import { lightUniforms } from './light.js';
import { getWater } from './map.js';
import { vec3 } from './mat.js';

/**
 * @param doc
 * @param textures  Map of texture name (as in the .gnd) -> decoded image, or missing
 * @param opts      { size (default 512), footprints: [{x0,y0,x1,y1}] in cells }
 * @returns { width, height, data }
 */
export function renderMinimap(doc, textures = new Map(), { size = 512, footprints = [] } = {}) {
	const g = doc.gnd;
	const W = size, H = size;
	const cellsW = g.width * 2, cellsH = g.height * 2;
	const scale = Math.max(cellsW, cellsH) / size; // cells per pixel
	const ox = (size - cellsW / scale) / 2, oy = (size - cellsH / scale) / 2;
	const data = new Uint8ClampedArray(W * H * 4);
	const light = lightUniforms(doc.rsw.light);
	const water = getWater(doc);
	const lm = g.lightmap;
	for (let py = 0; py < H; py++) {
		for (let px = 0; px < W; px++) {
			const o = (py * W + px) * 4;
			// North is up: the top row is the largest y.
			const x = (px - ox + 0.5) * scale, y = cellsH - (py - oy + 0.5) * scale;
			if (x < 0 || y < 0 || x >= cellsW || y >= cellsH) { data[o] = 255; data[o + 1] = 0; data[o + 2] = 255; data[o + 3] = 255; continue; }
			const cx = Math.floor(x / 2), cy = Math.floor(y / 2), i = cy * g.width + cx;
			const ti = g.up[i];
			if (ti < 0 || !g.tiles[ti]) { data[o] = 0; data[o + 1] = 0; data[o + 2] = 0; data[o + 3] = 255; continue; }
			const t = g.tiles[ti];
			const fu = x / 2 - cx, fv = y / 2 - cy;
			const u = (t.u[0] * (1 - fu) + t.u[1] * fu) * (1 - fv) + (t.u[2] * (1 - fu) + t.u[3] * fu) * fv;
			const v = (t.v[0] * (1 - fu) + t.v[1] * fu) * (1 - fv) + (t.v[2] * (1 - fu) + t.v[3] * fu) * fv;
			const img = textures.get(g.textures[t.texture]);
			let r = 120, gg = 140, b = 110;
			if (img) {
				const sx = Math.min(img.width - 1, Math.max(0, Math.floor(u * img.width))), sy = Math.min(img.height - 1, Math.max(0, Math.floor(v * img.height)));
				const s = (sy * img.width + sx) * 4;
				r = img.data[s]; gg = img.data[s + 1]; b = img.data[s + 2];
			}
			// Tile colour (BGRA).
			r *= t.color[2] / 255; gg *= t.color[1] / 255; b *= t.color[0] / 255;
			// Sun on the slope.
			const k = i * 4, h = g.heights;
			const n = vec3.calcNormal([0, h[k] / 5, 0], [2, h[k + 1] / 5, 0], [2, h[k + 3] / 5, 2]);
			const lw = Math.max(0, vec3.dot(n, light.direction));
			const shade = [0, 1, 2].map(c => Math.min(1, lw * light.diffuse[c] + light.ambient[c]) * Math.min(1, light.env[c]));
			r *= shade[0]; gg *= shade[1]; b *= shade[2];
			// Lightmap: shadow, then added colour.
			if (t.light < lm.count) {
				const lx = Math.min(7, Math.max(0, Math.floor(1 + fu * 6))), ly = Math.min(7, Math.max(0, Math.floor(1 + fv * 6)));
				const base = t.light * 256;
				const sh = lm.data[base + ly * 8 + lx] / 255;
				r = r * sh + lm.data[base + 64 + (ly * 8 + lx) * 3];
				gg = gg * sh + lm.data[base + 65 + (ly * 8 + lx) * 3];
				b = b * sh + lm.data[base + 66 + (ly * 8 + lx) * 3];
			}
			if (water && (h[k] + h[k + 1] + h[k + 2] + h[k + 3]) / 4 > water.level) { r = r * 0.45 + 40; gg = gg * 0.45 + 90; b = b * 0.45 + 150; }
			data[o] = r; data[o + 1] = gg; data[o + 2] = b; data[o + 3] = 255;
		}
	}
	// Models: their footprints, darkened.
	for (const f of footprints) {
		for (let py = Math.floor(oy + (cellsH - f.y1) / scale); py <= Math.ceil(oy + (cellsH - f.y0) / scale); py++) {
			for (let px = Math.floor(ox + f.x0 / scale); px <= Math.ceil(ox + f.x1 / scale); px++) {
				if (px < 0 || py < 0 || px >= W || py >= H) continue;
				const o = (py * W + px) * 4;
				data[o] *= 0.6; data[o + 1] *= 0.6; data[o + 2] *= 0.6;
			}
		}
	}
	return { width: W, height: H, data };
}

/** The ground textures a minimap needs, by .gnd name, with their client paths. */
export function minimapTextures(doc) {
	return doc.gnd.textures.map(name => ({ name, path: `data/texture/${decodeName(name).replace(/\\/g, '/')}` }));
}
