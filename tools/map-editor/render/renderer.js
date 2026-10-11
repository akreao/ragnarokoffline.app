// The editor's view of a map, in WebGL2.
//
// It draws what roBrowser draws -- ground with its lightmaps and tile
// colours, walls, models, water -- with roBrowser's lighting, and on top of
// that what only an editor needs: the walkability overlay, a cell grid, the
// gameplay markers, selection boxes and the brush.
//
// Built for editing rather than for playing: the ground is in 16x16-cube
// chunks so a brush stroke rebuilds a few, each model file is compiled once
// in its own space and every placement is a matrix, so moving a model costs
// nothing to rebuild.

import { GROUND_VS, GROUND_FS, MODEL_VS, MODEL_FS, WATER_VS, WATER_FS, COLOR_VS, COLOR_FS, SPRITE_VS, SPRITE_FS } from './shaders.js';
import { mat4, vec3 } from '../lib/mat.js';
import { readRsm, compileModel, instanceMatrix } from '../lib/rsm.js';
import { decodeName } from '../lib/cp949.js';
import { getWater } from '../lib/map.js';
import { lightColor } from '../lib/rsw.js';
import { lightUniforms } from '../lib/light.js';

export { lightUniforms };

const CHUNK = 16;
const GROUND_STRIDE = 13;
const LAYER_SIZE = 256;

export const GAT_COLORS = {
	0: [0.2, 0.9, 0.3, 0.28],
	1: [0.95, 0.15, 0.15, 0.45],
	2: [0.2, 0.9, 0.3, 0.28],
	3: [0.15, 0.5, 1.0, 0.45],
	4: [0.2, 0.9, 0.3, 0.28],
	5: [1.0, 0.85, 0.1, 0.45],
	6: [0.2, 0.9, 0.3, 0.28],
};

function compile(gl, vs, fs) {
	const program = gl.createProgram();
	for (const [type, src] of [[gl.VERTEX_SHADER, vs], [gl.FRAGMENT_SHADER, fs]]) {
		const s = gl.createShader(type);
		gl.shaderSource(s, src);
		gl.compileShader(s);
		if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
		gl.attachShader(program, s);
	}
	gl.linkProgram(program);
	if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program));
	const u = {}, a = {};
	for (let i = 0, n = gl.getProgramParameter(program, gl.ACTIVE_UNIFORMS); i < n; i++) {
		const info = gl.getActiveUniform(program, i);
		u[info.name.replace(/\[0\]$/, '')] = gl.getUniformLocation(program, info.name);
	}
	for (let i = 0, n = gl.getProgramParameter(program, gl.ACTIVE_ATTRIBUTES); i < n; i++) {
		const info = gl.getActiveAttrib(program, i);
		a[info.name] = gl.getAttribLocation(program, info.name);
	}
	return { program, u, a };
}

export class Camera {
	constructor() {
		this.target = [0, 0, 0];
		this.yaw = 0;      // degrees; 0 looks north
		this.pitch = 55;   // degrees above the horizon; 90 is straight down
		this.distance = 120;
		this.fov = 40;
		this.ortho = false;
		this.view = mat4.create();
		this.proj = mat4.create();
	}
	eye() {
		const p = (this.pitch * Math.PI) / 180, y = (this.yaw * Math.PI) / 180;
		const d = this.distance;
		return [this.target[0] - Math.sin(y) * Math.cos(p) * d, this.target[1] - Math.sin(p) * d, this.target[2] - Math.cos(y) * Math.cos(p) * d];
	}
	update(width, height) {
		const eye = this.eye();
		// Straight down, "up" on screen is north turned by the yaw.
		const up = this.pitch > 89.5 ? [Math.sin((this.yaw * Math.PI) / 180), 0, Math.cos((this.yaw * Math.PI) / 180)] : [0, -1, 0];
		mat4.lookAt(this.view, eye, this.target, up);
		const aspect = width / Math.max(1, height);
		if (this.ortho) {
			const h = this.distance * Math.tan((this.fov * Math.PI) / 360);
			mat4.ortho(this.proj, -h * aspect, h * aspect, -h, h, 0.1, 5000);
		} else {
			mat4.perspective(this.proj, (this.fov * Math.PI) / 180, aspect, Math.max(0.5, this.distance / 200), 5000);
		}
	}
	/** A ray through a canvas pixel: { origin, dir } in world units. */
	ray(px, py, width, height) {
		const nx = (px / width) * 2 - 1, ny = 1 - (py / height) * 2;
		const inv = mat4.invert(mat4.create(), mat4.multiply(mat4.create(), this.proj, this.view));
		const a = mat4.transformPoint(inv, [nx, ny, -1]), b = mat4.transformPoint(inv, [nx, ny, 1]);
		return { origin: a, dir: vec3.normalize(vec3.sub(b, a)) };
	}
}

export class MapRenderer {
	/**
	 * @param {HTMLCanvasElement} canvas
	 * @param {object} assets  file(path) -> Promise<Uint8Array|null>,
	 *                         image(path) -> Promise<ImageData-like|ImageBitmap|null>
	 */
	constructor(canvas, assets) {
		this.canvas = canvas;
		this.assets = assets;
		const gl = canvas.getContext('webgl2', { antialias: true, preserveDrawingBuffer: true, alpha: false });
		if (!gl) throw new Error('This window has no WebGL2.');
		this.gl = gl;
		this.camera = new Camera();
		this.programs = {
			ground: compile(gl, GROUND_VS, GROUND_FS),
			model: compile(gl, MODEL_VS, MODEL_FS),
			water: compile(gl, WATER_VS, WATER_FS),
			color: compile(gl, COLOR_VS, COLOR_FS),
			sprite: compile(gl, SPRITE_VS, SPRITE_FS),
		};
		this.chunks = new Map();
		this.gatChunks = new Map();
		this.models = new Map();      // file (text, lowercase) -> { model, meshes, box, state }
		this.textures = new Map();    // model texture path -> WebGLTexture
		this.instances = [];          // { object, index, file, matrix, normal }
		this.sprites = new Map();     // key -> { texture, width, height, originX, originY }
		this.markers = [];            // { kind, id, x, y, z, sprite, size, label, color, area }
		this.selection = new Set();   // .rsw object indexes and 'npc:<id>' style keys
		this.hover = null;
		this.brush = null;            // { x, z, radius, color }
		this.show = { models: true, water: true, gat: false, grid: false, markers: true, lightmap: true, objects: true, areas: true };
		this.sky = [0.08, 0.08, 0.1];
		this.layerCapacity = 0;
		this.missing = new Set();
		this.onchange = null;         // called when something finished loading
		this.start = performance.now();
		this.quad = this.makeQuad();
		this.white = this.solidTexture([255, 255, 255, 255]);
		this.checker = this.checkerTexture();
		gl.enable(gl.DEPTH_TEST);
	}

	// ---- Building

	setDoc(doc) {
		this.doc = doc;
		const gl = this.gl;
		for (const c of this.chunks.values()) gl.deleteBuffer(c.buffer);
		this.chunks.clear();
		for (const c of this.gatChunks.values()) gl.deleteBuffer(c.buffer);
		this.gatChunks.clear();
		this.buildTileColors();
		this.buildLightmap();
		this.loadGroundTextures();
		this.buildAllChunks();
		this.buildWater();
		this.buildGat();
		this.objectsChanged();
		const g = doc.gnd;
		this.camera.target = [g.width, 0, g.height];
		this.camera.distance = Math.max(40, Math.max(g.width, g.height) * 1.4);
	}

	buildAllChunks() {
		const g = this.doc.gnd;
		for (let cy = 0; cy < Math.ceil(g.height / CHUNK); cy++) for (let cx = 0; cx < Math.ceil(g.width / CHUNK); cx++) this.buildChunk(cx, cy);
	}

	/** Rebuild what a change to the cubes in this rectangle touched (cubes, inclusive). */
	groundChanged(rect) {
		if (!rect) { this.buildTileColors(); this.buildAllChunks(); this.buildWater(); this.buildGat(); return; }
		this.buildTileColors();
		// One cube of margin: a corner's smooth normal and the walls depend on neighbours.
		const c0x = Math.max(0, Math.floor((rect.x0 - 1) / CHUNK)), c1x = Math.floor((rect.x1 + 1) / CHUNK);
		const c0y = Math.max(0, Math.floor((rect.y0 - 1) / CHUNK)), c1y = Math.floor((rect.y1 + 1) / CHUNK);
		for (let cy = c0y; cy <= c1y; cy++) for (let cx = c0x; cx <= c1x; cx++) if (cx * CHUNK < this.doc.gnd.width && cy * CHUNK < this.doc.gnd.height) this.buildChunk(cx, cy);
		this.buildWater();
		this.buildGat({ x0: rect.x0 * 2 - 2, y0: rect.y0 * 2 - 2, x1: rect.x1 * 2 + 3, y1: rect.y1 * 2 + 3 });
	}

	gatChanged(rect) { this.buildGat(rect); }

	lightmapsChanged() { this.buildLightmap(); this.buildAllChunks(); }

	texturesChanged() { this.loadGroundTextures(); this.buildAllChunks(); }

	cubeNormal(x, y) {
		const g = this.doc.gnd;
		if (x < 0 || y < 0 || x >= g.width || y >= g.height) return null;
		const i = y * g.width + x;
		if (g.up[i] < 0) return [0, 0, 0];
		const h = g.heights, k = i * 4;
		const a = [x * 2, h[k] / 5, y * 2], b = [(x + 1) * 2, h[k + 1] / 5, y * 2], c = [(x + 1) * 2, h[k + 3] / 5, (y + 1) * 2], d = [x * 2, h[k + 2] / 5, (y + 1) * 2];
		const n1 = vec3.calcNormal(a, b, c), n2 = vec3.calcNormal(c, d, a);
		return vec3.normalize(vec3.add(n1, n2));
	}

	lightmapUV(i) {
		const w = this.lmCountW, h = this.lmCountH, W = this.lmWidth, H = this.lmHeight;
		return {
			u1: (((i % w) + 0.125) / w) * ((w * 8) / W), u2: (((i % w) + 0.875) / w) * ((w * 8) / W),
			v1: ((Math.floor(i / w) + 0.125) / h) * ((h * 8) / H), v2: ((Math.floor(i / w) + 0.875) / h) * ((h * 8) / H),
		};
	}

	buildChunk(chx, chy) {
		const gl = this.gl, doc = this.doc, g = doc.gnd;
		const x0 = chx * CHUNK, y0 = chy * CHUNK, x1 = Math.min(g.width, x0 + CHUNK), y1 = Math.min(g.height, y0 + CHUNK);
		// Smooth normals per corner, from the cube normals around it (roBrowser's getSmoothNormal).
		const nw = x1 - x0 + 2, nh = y1 - y0 + 2;
		const normals = new Array(nw * nh);
		for (let y = y0 - 1; y <= y1; y++) for (let x = x0 - 1; x <= x1; x++) normals[(y - y0 + 1) * nw + (x - x0 + 1)] = this.cubeNormal(x, y);
		const nAt = (x, y) => normals[(y - y0 + 1) * nw + (x - x0 + 1)] || [0, 0, 0];
		const corner = (x, y, dx, dy) => vec3.normalize(vec3.add(vec3.add(nAt(x, y), nAt(x + dx, y)), vec3.add(nAt(x + dx, y + dy), nAt(x, y + dy))));
		const out = [];
		const h = g.heights;
		const push = (px, py, pz, n, u, v, layer, lu, lv, tu, tv) => out.push(px, py, pz, n[0], n[1], n[2], u, v, layer, lu, lv, tu, tv);
		const layerOf = t => (t.texture < g.textures.length ? t.texture : 0);
		for (let y = y0; y < y1; y++) {
			for (let x = x0; x < x1; x++) {
				const i = y * g.width + x, k = i * 4;
				if (g.up[i] >= 0) {
					const t = g.tiles[g.up[i]];
					if (t) {
						const l = this.lightmapUV(t.light), L = layerOf(t);
						const n0 = corner(x, y, -1, -1), n1 = corner(x, y, 1, -1), n2 = corner(x, y, 1, 1), n3 = corner(x, y, -1, 1);
						const tu0 = (x + 0.5) / g.width, tu1 = (x + 1.5) / g.width, tv0 = (y + 0.5) / g.height, tv1 = (y + 1.5) / g.height;
						push(x * 2, h[k] / 5, y * 2, n0, t.u[0], t.v[0], L, l.u1, l.v1, tu0, tv0);
						push((x + 1) * 2, h[k + 1] / 5, y * 2, n1, t.u[1], t.v[1], L, l.u2, l.v1, tu1, tv0);
						push((x + 1) * 2, h[k + 3] / 5, (y + 1) * 2, n2, t.u[3], t.v[3], L, l.u2, l.v2, tu1, tv1);
						push((x + 1) * 2, h[k + 3] / 5, (y + 1) * 2, n2, t.u[3], t.v[3], L, l.u2, l.v2, tu1, tv1);
						push(x * 2, h[k + 2] / 5, (y + 1) * 2, n3, t.u[2], t.v[2], L, l.u1, l.v2, tu0, tv1);
						push(x * 2, h[k] / 5, y * 2, n0, t.u[0], t.v[0], L, l.u1, l.v1, tu0, tv0);
					}
				}
				if (g.front[i] >= 0 && y + 1 < g.height) {
					const t = g.tiles[g.front[i]];
					if (t) {
						const l = this.lightmapUV(t.light), L = layerOf(t), b = (i + g.width) * 4, n = [0, 0, 1];
						push(x * 2, h[b] / 5, (y + 1) * 2, n, t.u[2], t.v[2], L, l.u1, l.v2, 0, 0);
						push((x + 1) * 2, h[k + 3] / 5, (y + 1) * 2, n, t.u[1], t.v[1], L, l.u2, l.v1, 0, 0);
						push((x + 1) * 2, h[b + 1] / 5, (y + 1) * 2, n, t.u[3], t.v[3], L, l.u2, l.v2, 0, 0);
						push(x * 2, h[b] / 5, (y + 1) * 2, n, t.u[2], t.v[2], L, l.u1, l.v2, 0, 0);
						push((x + 1) * 2, h[k + 3] / 5, (y + 1) * 2, n, t.u[1], t.v[1], L, l.u2, l.v1, 0, 0);
						push(x * 2, h[k + 2] / 5, (y + 1) * 2, n, t.u[0], t.v[0], L, l.u1, l.v1, 0, 0);
					}
				}
				if (g.right[i] >= 0 && x + 1 < g.width) {
					const t = g.tiles[g.right[i]];
					if (t) {
						const l = this.lightmapUV(t.light), L = layerOf(t), b = (i + 1) * 4, n = [1, 0, 0];
						push((x + 1) * 2, h[k + 1] / 5, y * 2, n, t.u[1], t.v[1], L, l.u2, l.v1, 0, 0);
						push((x + 1) * 2, h[k + 3] / 5, (y + 1) * 2, n, t.u[0], t.v[0], L, l.u1, l.v1, 0, 0);
						push((x + 1) * 2, h[b] / 5, y * 2, n, t.u[3], t.v[3], L, l.u2, l.v2, 0, 0);
						push((x + 1) * 2, h[b] / 5, y * 2, n, t.u[3], t.v[3], L, l.u2, l.v2, 0, 0);
						push((x + 1) * 2, h[b + 2] / 5, (y + 1) * 2, n, t.u[2], t.v[2], L, l.u1, l.v2, 0, 0);
						push((x + 1) * 2, h[k + 3] / 5, (y + 1) * 2, n, t.u[0], t.v[0], L, l.u1, l.v1, 0, 0);
					}
				}
			}
		}
		const key = `${chx},${chy}`;
		let chunk = this.chunks.get(key);
		if (!chunk) { chunk = { buffer: gl.createBuffer(), count: 0 }; this.chunks.set(key, chunk); }
		gl.bindBuffer(gl.ARRAY_BUFFER, chunk.buffer);
		gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(out), gl.STATIC_DRAW);
		chunk.count = out.length / GROUND_STRIDE;
	}

	buildTileColors() {
		const gl = this.gl, g = this.doc.gnd;
		const data = new Uint8Array(g.width * g.height * 4);
		for (let i = 0; i < g.width * g.height; i++) {
			const t = g.up[i] >= 0 ? g.tiles[g.up[i]] : null;
			if (t) { data[i * 4] = t.color[2]; data[i * 4 + 1] = t.color[1]; data[i * 4 + 2] = t.color[0]; data[i * 4 + 3] = t.color[3]; }
		}
		if (!this.tileColor) this.tileColor = gl.createTexture();
		gl.bindTexture(gl.TEXTURE_2D, this.tileColor);
		gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
		gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, g.width, g.height, 0, gl.RGBA, gl.UNSIGNED_BYTE, data);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
	}

	buildLightmap() {
		const gl = this.gl, lm = this.doc.gnd.lightmap;
		const count = Math.max(1, lm.count);
		this.lmCountW = Math.round(Math.sqrt(count));
		this.lmCountH = Math.ceil(Math.sqrt(count));
		this.lmWidth = 2 ** Math.ceil(Math.log2(this.lmCountW * 8));
		this.lmHeight = 2 ** Math.ceil(Math.log2(this.lmCountH * 8));
		const out = new Uint8Array(this.lmWidth * this.lmHeight * 4);
		const per = 64;
		for (let i = 0; i < lm.count; i++) {
			const pos = i * 4 * per, x = (i % this.lmCountW) * 8, y = Math.floor(i / this.lmCountW) * 8;
			for (let px = 0; px < 8; px++) {
				for (let py = 0; py < 8; py++) {
					const o = (x + px + (y + py) * this.lmWidth) * 4, s = pos + per + (px + py * 8) * 3;
					out[o] = lm.data[s]; out[o + 1] = lm.data[s + 1]; out[o + 2] = lm.data[s + 2]; out[o + 3] = lm.data[pos + px + py * 8];
				}
			}
		}
		if (!this.lightmap) this.lightmap = gl.createTexture();
		gl.bindTexture(gl.TEXTURE_2D, this.lightmap);
		gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, this.lmWidth, this.lmHeight, 0, gl.RGBA, gl.UNSIGNED_BYTE, out);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
	}

	ensureLayers(n) {
		const gl = this.gl;
		if (this.groundTextures && n <= this.layerCapacity) return false;
		const capacity = Math.min(gl.getParameter(gl.MAX_ARRAY_TEXTURE_LAYERS), Math.max(8, 2 ** Math.ceil(Math.log2(n + 4))));
		if (this.groundTextures) gl.deleteTexture(this.groundTextures);
		this.groundTextures = gl.createTexture();
		gl.bindTexture(gl.TEXTURE_2D_ARRAY, this.groundTextures);
		gl.texStorage3D(gl.TEXTURE_2D_ARRAY, 1 + Math.log2(LAYER_SIZE), gl.RGBA8, LAYER_SIZE, LAYER_SIZE, capacity);
		gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
		gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
		gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
		gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
		this.layerCapacity = capacity;
		this.layerNames = [];
		return true;
	}

	loadGroundTextures() {
		const names = this.doc.gnd.textures;
		const fresh = this.ensureLayers(names.length);
		const scratch = this.scratchCanvas || (this.scratchCanvas = new OffscreenCanvas(LAYER_SIZE, LAYER_SIZE));
		const ctx = scratch.getContext('2d', { willReadFrequently: true });
		names.forEach((name, layer) => {
			if (!fresh && this.layerNames[layer] === name) return;
			this.layerNames[layer] = name;
			// Placeholder until it arrives.
			this.uploadLayer(layer, this.checkerPixels());
			const path = 'data/texture/' + decodeName(name);
			this.assets.image(path).then(img => {
				if (!img) { this.missing.add(path); return; }
				if (this.layerNames[layer] !== name) return;
				ctx.clearRect(0, 0, LAYER_SIZE, LAYER_SIZE);
				if (img.data) {
					const tmp = new OffscreenCanvas(img.width, img.height);
					tmp.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(img.data), img.width, img.height), 0, 0);
					ctx.drawImage(tmp, 0, 0, LAYER_SIZE, LAYER_SIZE);
				} else ctx.drawImage(img, 0, 0, LAYER_SIZE, LAYER_SIZE);
				this.uploadLayer(layer, ctx.getImageData(0, 0, LAYER_SIZE, LAYER_SIZE).data);
				this.changed();
			}).catch(() => this.missing.add(path));
		});
	}

	uploadLayer(layer, pixels) {
		const gl = this.gl;
		gl.bindTexture(gl.TEXTURE_2D_ARRAY, this.groundTextures);
		gl.texSubImage3D(gl.TEXTURE_2D_ARRAY, 0, 0, 0, layer, LAYER_SIZE, LAYER_SIZE, 1, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(pixels.buffer || pixels));
		gl.generateMipmap(gl.TEXTURE_2D_ARRAY);
	}

	checkerPixels() {
		if (this._checker) return this._checker;
		const p = new Uint8Array(LAYER_SIZE * LAYER_SIZE * 4);
		for (let y = 0; y < LAYER_SIZE; y++) for (let x = 0; x < LAYER_SIZE; x++) {
			const on = ((x >> 5) + (y >> 5)) & 1, o = (y * LAYER_SIZE + x) * 4;
			p[o] = on ? 200 : 120; p[o + 1] = on ? 120 : 200; p[o + 2] = on ? 200 : 120; p[o + 3] = 255;
		}
		return (this._checker = p);
	}

	buildWater() {
		const gl = this.gl, doc = this.doc, g = doc.gnd;
		const water = getWater(doc);
		this.water = water;
		const out = [];
		if (water) {
			const level = water.level / 5, wave = water.waveHeight / 5;
			for (let y = 0; y < g.height; y++) {
				for (let x = 0; x < g.width; x++) {
					const i = y * g.width + x;
					if (g.up[i] < 0) continue;
					const k = i * 4, h = g.heights;
					if (!(h[k] / 5 > level - wave || h[k + 1] / 5 > level - wave || h[k + 2] / 5 > level - wave || h[k + 3] / 5 > level - wave)) continue;
					const uv = (a, b) => [((a % 5) / 5) || (a ? 1 : 0), ((b % 5) / 5) || (b ? 1 : 0)];
					const q = [[x, y], [x + 1, y], [x + 1, y + 1], [x + 1, y + 1], [x, y + 1], [x, y]];
					for (const [qx, qy] of q) {
						const [u, v] = [((qx % 5) / 5) || (qx > x ? 1 : 0), ((qy % 5) / 5) || (qy > y ? 1 : 0)];
						out.push(qx * 2, level, qy * 2, u, v);
					}
					void uv;
				}
			}
		}
		if (!this.waterBuffer) this.waterBuffer = gl.createBuffer();
		gl.bindBuffer(gl.ARRAY_BUFFER, this.waterBuffer);
		gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(out), gl.STATIC_DRAW);
		this.waterCount = out.length / 5;
		if (water && this.waterType !== water.type) {
			this.waterType = water.type;
			this.waterFrames = [];
			for (let i = 0; i < 32; i++) {
				const path = `data/texture/워터/water${water.type}${String(i).padStart(2, '0')}.jpg`;
				this.loadTexture(path, true).then(t => { this.waterFrames[i] = t; if (i === 0) this.changed(); });
			}
		}
	}

	buildGat(rect) {
		const gl = this.gl, gat = this.doc.gat;
		const G = 32;
		const cx0 = rect ? Math.max(0, Math.floor(rect.x0 / G)) : 0, cy0 = rect ? Math.max(0, Math.floor(rect.y0 / G)) : 0;
		const cx1 = rect ? Math.min(Math.ceil(gat.width / G) - 1, Math.floor(rect.x1 / G)) : Math.ceil(gat.width / G) - 1;
		const cy1 = rect ? Math.min(Math.ceil(gat.height / G) - 1, Math.floor(rect.y1 / G)) : Math.ceil(gat.height / G) - 1;
		for (let cy = cy0; cy <= cy1; cy++) {
			for (let cx = cx0; cx <= cx1; cx++) {
				const out = [];
				for (let y = cy * G; y < Math.min(gat.height, (cy + 1) * G); y++) {
					for (let x = cx * G; x < Math.min(gat.width, (cx + 1) * G); x++) {
						const i = y * gat.width + x, k = i * 4, h = gat.heights;
						const c = GAT_COLORS[gat.types[i]] || [0.6, 0.2, 0.8, 0.5];
						const lift = -0.06, inset = 0.04;
						const p = [[x + inset, h[k] / 5, y + inset], [x + 1 - inset, h[k + 1] / 5, y + inset], [x + 1 - inset, h[k + 3] / 5, y + 1 - inset], [x + inset, h[k + 2] / 5, y + 1 - inset]];
						for (const j of [0, 1, 2, 2, 3, 0]) out.push(p[j][0], p[j][1] + lift, p[j][2], ...c);
					}
				}
				const key = `${cx},${cy}`;
				let chunk = this.gatChunks.get(key);
				if (!chunk) { chunk = { buffer: gl.createBuffer(), count: 0 }; this.gatChunks.set(key, chunk); }
				gl.bindBuffer(gl.ARRAY_BUFFER, chunk.buffer);
				gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(out), gl.STATIC_DRAW);
				chunk.count = out.length / 7;
			}
		}
	}

	// ---- Models

	/** Re-read the .rsw's objects: placements, lights, sounds, effects. */
	objectsChanged() {
		const doc = this.doc;
		this.instances = [];
		doc.rsw.objects.forEach((o, index) => {
			if (o.type !== 1) return;
			const file = decodeName(o.file).toLowerCase().replace(/\//g, '\\');
			const entry = this.modelEntry(file);
			const inst = { object: o, index, file, entry, matrix: null, normal: null };
			this.instances.push(inst);
			if (entry.state === 'ready') this.place(inst);
		});
	}

	/** Recompute one placement's matrix after its object moved. */
	objectMoved(index) {
		for (const inst of this.instances) if (inst.index === index && inst.entry.state === 'ready') this.place(inst);
	}

	place(inst) {
		const g = this.doc.gnd;
		inst.matrix = instanceMatrix(inst.entry.model, inst.object, g.width, g.height);
		const n = mat4.extractRotation(mat4.create(), inst.matrix);
		inst.normal = new Float32Array([n[0], n[1], n[2], n[4], n[5], n[6], n[8], n[9], n[10]]);
	}

	modelEntry(file) {
		let entry = this.models.get(file);
		if (entry) return entry;
		entry = { state: 'loading', file };
		this.models.set(file, entry);
		this.assets.file('data/model/' + file).then(bytes => {
			if (!bytes) { entry.state = 'missing'; this.missing.add('data/model/' + file); this.changed(); return; }
			try {
				entry.model = readRsm(bytes);
				const compiled = compileModel(entry.model);
				entry.box = compiled.box;
				entry.meshData = compiled.meshes;
				entry.meshes = compiled.meshes.map(m => this.uploadMesh(m, entry.model.textures[m.texture]));
				entry.state = 'ready';
				for (const inst of this.instances) if (inst.entry === entry) this.place(inst);
			} catch (e) {
				entry.state = 'broken';
				entry.error = e.message;
			}
			this.changed();
		});
		return entry;
	}

	uploadMesh(mesh, textureName) {
		const gl = this.gl;
		const buffer = gl.createBuffer();
		gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
		gl.bufferData(gl.ARRAY_BUFFER, mesh.data, gl.STATIC_DRAW);
		const out = { buffer, count: mesh.data.length / 9, texture: this.white };
		if (textureName) this.loadTexture('data/texture/' + decodeName(textureName)).then(t => { if (t) { out.texture = t; this.changed(); } });
		return out;
	}

	loadTexture(path, repeat = false) {
		if (this.textures.has(path)) return this.textures.get(path);
		const promise = this.assets.image(path).then(img => {
			if (!img) { this.missing.add(path); return null; }
			const gl = this.gl;
			const t = gl.createTexture();
			gl.bindTexture(gl.TEXTURE_2D, t);
			gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
			if (img.data) gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, img.width, img.height, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(img.data.buffer || img.data));
			else gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img);
			gl.generateMipmap(gl.TEXTURE_2D);
			gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
			gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
			const wrap = repeat ? gl.REPEAT : gl.CLAMP_TO_EDGE;
			gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, wrap);
			gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, wrap);
			return t;
		}).catch(() => null);
		this.textures.set(path, promise);
		return promise;
	}

	solidTexture(rgba) {
		const gl = this.gl, t = gl.createTexture();
		gl.bindTexture(gl.TEXTURE_2D, t);
		gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(rgba));
		return t;
	}

	checkerTexture() {
		const gl = this.gl, t = gl.createTexture();
		gl.bindTexture(gl.TEXTURE_2D, t);
		const p = new Uint8Array(8 * 8 * 4);
		for (let i = 0; i < 64; i++) { const on = ((i % 8 >> 2) + (i >> 5)) & 1; p.set(on ? [255, 0, 255, 255] : [40, 40, 40, 255], i * 4); }
		gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 8, 8, 0, gl.RGBA, gl.UNSIGNED_BYTE, p);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
		return t;
	}

	makeQuad() {
		const gl = this.gl, b = gl.createBuffer();
		gl.bindBuffer(gl.ARRAY_BUFFER, b);
		gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 1, 0, 1, 1, 1, 1, 0, 1, 0, 0]), gl.STATIC_DRAW);
		return b;
	}

	/** A sprite texture from RGBA pixels (lib/sprite.js renderSprite, or an icon). */
	setSprite(key, img) {
		const gl = this.gl;
		let s = this.sprites.get(key);
		if (!s) { s = { texture: gl.createTexture() }; this.sprites.set(key, s); }
		gl.bindTexture(gl.TEXTURE_2D, s.texture);
		gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
		if (img.data) gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, img.width, img.height, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(img.data.buffer || img.data));
		else gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
		s.width = img.width; s.height = img.height;
		s.originX = img.originX ?? img.width / 2; s.originY = img.originY ?? img.height;
		this.changed();
		return s;
	}

	changed() { if (this.onchange) this.onchange(); }

	// ---- Drawing

	resize() {
		const dpr = Math.min(2, (typeof devicePixelRatio === 'number' && devicePixelRatio) || 1);
		const w = Math.max(1, Math.round(this.canvas.clientWidth * dpr)), h = Math.max(1, Math.round(this.canvas.clientHeight * dpr));
		if (this.canvas.width !== w || this.canvas.height !== h) { this.canvas.width = w; this.canvas.height = h; }
	}

	render() {
		if (!this.doc) return;
		const gl = this.gl, cam = this.camera;
		if (!this.target) this.resize();
		const w = this.target ? this.target.width : this.canvas.width, h = this.target ? this.target.height : this.canvas.height;
		gl.viewport(0, 0, w, h);
		cam.update(w, h);
		gl.clearColor(this.sky[0], this.sky[1], this.sky[2], 1);
		gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
		const light = lightUniforms(this.doc.rsw.light);
		this.lightState = light;
		this.drawGround(light);
		if (this.show.models) this.drawModels(light);
		if (this.show.water && this.waterCount) this.drawWater();
		if (this.show.gat) this.drawGat();
		this.drawOverlays();
		if (this.show.markers) this.drawMarkers();
	}

	bindAttrib(p, name, size, stride, offset) {
		const gl = this.gl, loc = p.a[name];
		if (loc === undefined || loc < 0) return;
		gl.enableVertexAttribArray(loc);
		gl.vertexAttribPointer(loc, size, gl.FLOAT, false, stride * 4, offset * 4);
	}

	disableAttribs(p) { for (const loc of Object.values(p.a)) if (loc >= 0) this.gl.disableVertexAttribArray(loc); }

	drawGround(light) {
		const gl = this.gl, p = this.programs.ground, cam = this.camera;
		gl.useProgram(p.program);
		gl.uniformMatrix4fv(p.u.uView, false, cam.view);
		gl.uniformMatrix4fv(p.u.uProj, false, cam.proj);
		gl.uniform3fv(p.u.uLightDir, light.direction);
		gl.uniform3fv(p.u.uAmbient, light.ambient);
		gl.uniform3fv(p.u.uDiffuse, light.diffuse);
		gl.uniform3fv(p.u.uEnv, light.env);
		gl.uniform1i(p.u.uUseLightmap, this.show.lightmap ? 1 : 0);
		gl.uniform1i(p.u.uGrid, this.show.grid ? 1 : 0);
		const b = this.brush;
		gl.uniform4f(p.u.uBrush, b ? b.x : 0, b ? b.z : 0, b ? b.radius : 0, b ? 1 : 0);
		gl.uniform3fv(p.u.uBrushColor, (b && b.color) || [1, 0.9, 0.2]);
		gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D_ARRAY, this.groundTextures); gl.uniform1i(p.u.uTextures, 0);
		gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, this.lightmap); gl.uniform1i(p.u.uLightmap, 1);
		gl.activeTexture(gl.TEXTURE2); gl.bindTexture(gl.TEXTURE_2D, this.tileColor); gl.uniform1i(p.u.uTileColor, 2);
		for (const chunk of this.chunks.values()) {
			if (!chunk.count) continue;
			gl.bindBuffer(gl.ARRAY_BUFFER, chunk.buffer);
			this.bindAttrib(p, 'aPosition', 3, GROUND_STRIDE, 0);
			this.bindAttrib(p, 'aNormal', 3, GROUND_STRIDE, 3);
			this.bindAttrib(p, 'aUV', 2, GROUND_STRIDE, 6);
			this.bindAttrib(p, 'aLayer', 1, GROUND_STRIDE, 8);
			this.bindAttrib(p, 'aLightUV', 2, GROUND_STRIDE, 9);
			this.bindAttrib(p, 'aTileUV', 2, GROUND_STRIDE, 11);
			gl.drawArrays(gl.TRIANGLES, 0, chunk.count);
		}
		this.disableAttribs(p);
		gl.activeTexture(gl.TEXTURE0);
	}

	drawModels(light) {
		const gl = this.gl, p = this.programs.model, cam = this.camera;
		gl.useProgram(p.program);
		gl.uniformMatrix4fv(p.u.uView, false, cam.view);
		gl.uniformMatrix4fv(p.u.uProj, false, cam.proj);
		gl.uniform3fv(p.u.uLightDir, light.direction);
		gl.uniform3fv(p.u.uAmbient, light.ambient);
		gl.uniform3fv(p.u.uDiffuse, light.diffuse);
		gl.uniform3fv(p.u.uEnv, light.env);
		gl.uniform1i(p.u.uUseLightmap, this.show.lightmap ? 1 : 0);
		gl.uniform1i(p.u.uTexture, 0);
		gl.enable(gl.BLEND);
		gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
		for (const inst of this.instances) {
			if (!inst.matrix) continue;
			const selected = this.selection.has(inst.index), hovered = this.hover && this.hover.type === 'model' && this.hover.index === inst.index;
			gl.uniformMatrix4fv(p.u.uModel, false, inst.matrix);
			gl.uniformMatrix3fv(p.u.uNormalMat, false, inst.normal);
			gl.uniform4fv(p.u.uTint, selected ? [1, 0.75, 0.1, 0.35] : hovered ? [0.4, 0.8, 1, 0.2] : [0, 0, 0, 0]);
			for (const m of inst.entry.meshes) {
				gl.bindBuffer(gl.ARRAY_BUFFER, m.buffer);
				this.bindAttrib(p, 'aPosition', 3, 9, 0);
				this.bindAttrib(p, 'aNormal', 3, 9, 3);
				this.bindAttrib(p, 'aUV', 2, 9, 6);
				this.bindAttrib(p, 'aAlpha', 1, 9, 8);
				gl.bindTexture(gl.TEXTURE_2D, m.texture);
				gl.drawArrays(gl.TRIANGLES, 0, m.count);
			}
		}
		this.disableAttribs(p);
		gl.disable(gl.BLEND);
	}

	drawWater() {
		const gl = this.gl, p = this.programs.water, cam = this.camera, w = this.water;
		const frames = this.waterFrames || [];
		const tick = performance.now() - this.start, frame = tick / (1000 / 60);
		const tex = frames[Math.floor((frame / Math.max(1, w.animSpeed)) % 32)] || frames.find(Boolean) || this.white;
		gl.useProgram(p.program);
		gl.uniformMatrix4fv(p.u.uView, false, cam.view);
		gl.uniformMatrix4fv(p.u.uProj, false, cam.proj);
		gl.uniform1f(p.u.uWaveHeight, w.waveHeight / 5);
		gl.uniform1f(p.u.uWavePitch, w.wavePitch);
		gl.uniform1f(p.u.uOffset, ((frame * w.waveSpeed) % 360) - 180);
		gl.uniform1f(p.u.uOpacity, w.type !== 4 && w.type !== 6 ? 0.8 : 1.0);
		gl.bindTexture(gl.TEXTURE_2D, tex);
		gl.uniform1i(p.u.uTexture, 0);
		gl.enable(gl.BLEND);
		gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
		gl.depthMask(false);
		gl.bindBuffer(gl.ARRAY_BUFFER, this.waterBuffer);
		this.bindAttrib(p, 'aPosition', 3, 5, 0);
		this.bindAttrib(p, 'aUV', 2, 5, 3);
		gl.drawArrays(gl.TRIANGLES, 0, this.waterCount);
		this.disableAttribs(p);
		gl.depthMask(true);
		gl.disable(gl.BLEND);
	}

	colorProgram(model = null) {
		const gl = this.gl, p = this.programs.color, cam = this.camera;
		gl.useProgram(p.program);
		gl.uniformMatrix4fv(p.u.uView, false, cam.view);
		gl.uniformMatrix4fv(p.u.uProj, false, cam.proj);
		gl.uniformMatrix4fv(p.u.uModel, false, model || mat4.create());
		return p;
	}

	drawColored(data, mode, model = null) {
		if (!data.length) return;
		const gl = this.gl, p = this.colorProgram(model);
		if (!this.scratch) this.scratch = gl.createBuffer();
		gl.bindBuffer(gl.ARRAY_BUFFER, this.scratch);
		gl.bufferData(gl.ARRAY_BUFFER, data instanceof Float32Array ? data : new Float32Array(data), gl.STREAM_DRAW);
		this.bindAttrib(p, 'aPosition', 3, 7, 0);
		this.bindAttrib(p, 'aColor', 4, 7, 3);
		gl.drawArrays(mode, 0, data.length / 7);
		this.disableAttribs(p);
	}

	drawGat() {
		const gl = this.gl, p = this.colorProgram();
		gl.enable(gl.BLEND);
		gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
		gl.depthMask(false);
		gl.enable(gl.POLYGON_OFFSET_FILL);
		gl.polygonOffset(-1, -1);
		for (const chunk of this.gatChunks.values()) {
			if (!chunk.count) continue;
			gl.bindBuffer(gl.ARRAY_BUFFER, chunk.buffer);
			this.bindAttrib(p, 'aPosition', 3, 7, 0);
			this.bindAttrib(p, 'aColor', 4, 7, 3);
			gl.drawArrays(gl.TRIANGLES, 0, chunk.count);
		}
		this.disableAttribs(p);
		gl.disable(gl.POLYGON_OFFSET_FILL);
		gl.depthMask(true);
		gl.disable(gl.BLEND);
	}

	/** A rectangle of cells drawn on the ground: outline and a light fill. */
	areaGeometry(x0, y0, x1, y1, color, fill, out, outLines) {
		const gh = (x, y) => this.groundAt(x, y) - 0.08;
		const steps = [];
		const add = (x, y) => steps.push([x, gh(x, y), y]);
		for (let x = x0; x < x1; x += 0.5) add(x, y0);
		for (let y = y0; y < y1; y += 0.5) add(x1, y);
		for (let x = x1; x > x0; x -= 0.5) add(x, y1);
		for (let y = y1; y > y0; y -= 0.5) add(x0, y);
		for (let i = 0; i < steps.length; i++) {
			const a = steps[i], b = steps[(i + 1) % steps.length];
			outLines.push(...a, ...color, ...b, ...color);
		}
		if (fill) {
			for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
				const p = [[x, y], [x + 1, y], [x + 1, y + 1], [x, y + 1]].map(([px, py]) => [px, gh(px, py), py]);
				for (const j of [0, 1, 2, 2, 3, 0]) out.push(...p[j], ...fill);
			}
		}
	}

	groundAt(x, y) {
		const g = this.doc.gnd;
		const fx = x / 2, fy = y / 2;
		const cx = Math.min(g.width - 1, Math.max(0, Math.floor(fx))), cy = Math.min(g.height - 1, Math.max(0, Math.floor(fy)));
		const u = Math.min(1, Math.max(0, fx - cx)), v = Math.min(1, Math.max(0, fy - cy));
		const i = (cy * g.width + cx) * 4, h = g.heights;
		return ((h[i] * (1 - u) + h[i + 1] * u) * (1 - v) + (h[i + 2] * (1 - u) + h[i + 3] * u) * v) / 5;
	}

	boxLines(entry, matrix, color, out) {
		const b = entry.box;
		const c = [];
		for (const x of [b.min[0], b.max[0]]) for (const y of [b.min[1], b.max[1]]) for (const z of [b.min[2], b.max[2]]) c.push(mat4.transformPoint(matrix, [x, y, z]));
		for (const [i, j] of [[0, 1], [2, 3], [4, 5], [6, 7], [0, 2], [1, 3], [4, 6], [5, 7], [0, 4], [1, 5], [2, 6], [3, 7]]) out.push(...c[i], ...color, ...c[j], ...color);
	}

	drawOverlays() {
		const gl = this.gl;
		const fills = [], lines = [];
		for (const inst of this.instances) {
			if (!inst.matrix || !this.selection.has(inst.index)) continue;
			this.boxLines(inst.entry, inst.matrix, [1, 0.8, 0.1, 1], lines);
		}
		if (this.show.areas) {
			for (const m of this.markers) {
				if (!m.area) continue;
				const sel = this.selection.has(m.key);
				const col = sel ? [1, 0.85, 0.1, 1] : m.color;
				this.areaGeometry(m.area.x0, m.area.y0, m.area.x1, m.area.y1, col, [m.color[0], m.color[1], m.color[2], sel ? 0.3 : 0.16], fills, lines);
			}
		}
		if (this.selectionRect) {
			const r = this.selectionRect;
			this.areaGeometry(r.x0, r.y0, r.x1, r.y1, [1, 1, 1, 1], [1, 1, 1, 0.12], fills, lines);
		}
		if (this.extraLines) lines.push(...this.extraLines);
		gl.enable(gl.BLEND);
		gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
		gl.depthMask(false);
		gl.enable(gl.POLYGON_OFFSET_FILL);
		gl.polygonOffset(-2, -2);
		this.drawColored(fills, gl.TRIANGLES);
		gl.disable(gl.POLYGON_OFFSET_FILL);
		gl.disable(gl.DEPTH_TEST);
		this.drawColored(lines, gl.LINES);
		gl.enable(gl.DEPTH_TEST);
		gl.depthMask(true);
		gl.disable(gl.BLEND);
	}

	drawMarkers() {
		const gl = this.gl, p = this.programs.sprite, cam = this.camera;
		gl.useProgram(p.program);
		gl.uniformMatrix4fv(p.u.uView, false, cam.view);
		gl.uniformMatrix4fv(p.u.uProj, false, cam.proj);
		gl.uniform1i(p.u.uTexture, 0);
		gl.enable(gl.BLEND);
		gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
		gl.bindBuffer(gl.ARRAY_BUFFER, this.quad);
		this.bindAttrib(p, 'aCorner', 2, 2, 0);
		for (const m of this.markers) {
			const s = m.sprite && this.sprites.get(m.sprite);
			if (!s) continue;
			// Sprites are drawn at the game's scale: 35 pixels to a cell.
			const scale = (m.scale || 1) / 35;
			gl.uniform3f(p.u.uPos, m.x + 0.5, m.z, m.y + 0.5);
			gl.uniform2f(p.u.uSize, s.width * scale, s.height * scale);
			gl.uniform2f(p.u.uOrigin, s.originX / s.width, s.originY / s.height);
			const sel = this.selection.has(m.key), hov = this.hover && this.hover.key === m.key;
			gl.uniform4fv(p.u.uTint, sel ? [1, 0.8, 0.1, 0.35] : hov ? [0.4, 0.8, 1, 0.25] : [0, 0, 0, 0]);
			gl.bindTexture(gl.TEXTURE_2D, s.texture);
			gl.drawArrays(gl.TRIANGLES, 0, 6);
		}
		this.disableAttribs(p);
		gl.disable(gl.BLEND);
	}

	// ---- Picking

	/** Screen pixel (CSS px) -> canvas ray. */
	rayAt(cssX, cssY) {
		const sx = cssX * (this.canvas.width / this.canvas.clientWidth || 1), sy = cssY * (this.canvas.height / this.canvas.clientHeight || 1);
		return this.camera.ray(sx, sy, this.canvas.width, this.canvas.height);
	}

	/** Where a ray meets the ground, as world [x, y, z], or null. */
	pickGround(ray) {
		const g = this.doc.gnd;
		const maxT = this.camera.distance * 6 + 2000;
		// March in half-cell steps, then refine.
		let prev = null;
		for (let t = 0; t < maxT; t += 0.5) {
			const p = vec3.add(ray.origin, vec3.scale(ray.dir, t));
			if (p[0] < -2 || p[2] < -2 || p[0] > g.width * 2 + 2 || p[2] > g.height * 2 + 2) { prev = null; continue; }
			const ground = this.groundAt(Math.min(g.width * 2 - 0.001, Math.max(0, p[0])), Math.min(g.height * 2 - 0.001, Math.max(0, p[2])));
			const below = p[1] >= ground;
			if (below && prev !== null) {
				let lo = t - 0.5, hi = t;
				for (let k = 0; k < 20; k++) {
					const mid = (lo + hi) / 2, q = vec3.add(ray.origin, vec3.scale(ray.dir, mid));
					if (q[1] >= this.groundAt(Math.min(g.width * 2 - 0.001, Math.max(0, q[0])), Math.min(g.height * 2 - 0.001, Math.max(0, q[2])))) hi = mid; else lo = mid;
				}
				const hit = vec3.add(ray.origin, vec3.scale(ray.dir, hi));
				if (hit[0] < 0 || hit[2] < 0 || hit[0] >= g.width * 2 || hit[2] >= g.height * 2) return null;
				return hit;
			}
			prev = below;
		}
		// No ground under the ray (looking at the sky): the y=0 plane, for dragging.
		if (Math.abs(ray.dir[1]) > 1e-6) {
			const t = -ray.origin[1] / ray.dir[1];
			if (t > 0) { const p = vec3.add(ray.origin, vec3.scale(ray.dir, t)); return [p[0], 0, p[2]]; }
		}
		return null;
	}

	/** The model a ray hits first, as { index, t }. */
	pickModel(ray) {
		let best = null;
		for (const inst of this.instances) {
			if (!inst.matrix) continue;
			const inv = mat4.invert(mat4.create(), inst.matrix);
			if (!inv) continue;
			const o = mat4.transformPoint(inv, ray.origin), d = mat4.transformDir(inv, ray.dir);
			const b = inst.entry.box;
			let t0 = -Infinity, t1 = Infinity;
			for (let i = 0; i < 3; i++) {
				if (Math.abs(d[i]) < 1e-9) { if (o[i] < b.min[i] || o[i] > b.max[i]) { t0 = Infinity; break; } continue; }
				let a = (b.min[i] - o[i]) / d[i], c = (b.max[i] - o[i]) / d[i];
				if (a > c) [a, c] = [c, a];
				t0 = Math.max(t0, a); t1 = Math.min(t1, c);
			}
			if (t0 > t1 || t1 < 0) continue;
			// Distance along the world ray: scale back from model space.
			const hit = mat4.transformPoint(inst.matrix, vec3.add(o, vec3.scale(d, Math.max(0, t0))));
			const t = vec3.length(vec3.sub(hit, ray.origin));
			if (!best || t < best.t) best = { index: inst.index, t };
		}
		return best;
	}

	/** World point -> CSS pixel, or null when behind the camera. */
	project(world) {
		const m = mat4.multiply(mat4.create(), this.camera.proj, this.camera.view);
		const [x, y, z] = world;
		const cx = m[0] * x + m[4] * y + m[8] * z + m[12], cy = m[1] * x + m[5] * y + m[9] * z + m[13];
		const cw = m[3] * x + m[7] * y + m[11] * z + m[15];
		if (cw <= 0) return null;
		const size = this.projectSize || { width: this.canvas.clientWidth, height: this.canvas.clientHeight };
		return { x: ((cx / cw + 1) / 2) * size.width, y: ((1 - cy / cw) / 2) * size.height };
	}

	/** The marker nearest a CSS pixel, within `radius` pixels of its body. */
	pickMarker(cssX, cssY, radius = 18) {
		let best = null;
		for (const m of this.markers) {
			const s = m.sprite && this.sprites.get(m.sprite);
			const feet = this.project([m.x + 0.5, m.z, m.y + 0.5]);
			if (!feet) continue;
			const px = this.camera.distance ? (this.canvas.clientHeight / (2 * Math.tan((this.camera.fov * Math.PI) / 360) * this.camera.distance)) : 1;
			const h = s ? (s.height / 35) * px * (m.scale || 1) : 20;
			const center = { x: feet.x, y: feet.y - h / 2 };
			const d = Math.hypot(center.x - cssX, center.y - cssY) - Math.max(6, h / 3);
			if (d < radius && (!best || d < best.d)) best = { marker: m, d };
		}
		if (best) return best.marker;
		// Inside an area marker.
		const ground = this.pickGround(this.rayAt(cssX, cssY));
		if (ground) {
			for (const m of this.markers) if (m.area && ground[0] >= m.area.x0 && ground[0] <= m.area.x1 && ground[2] >= m.area.y0 && ground[2] <= m.area.y1) return m;
		}
		return null;
	}

	/** Point lights, sounds and effects, for the markers layer. */
	worldObjectMarkers() {
		const g = this.doc.gnd, out = [];
		this.doc.rsw.objects.forEach((o, index) => {
			if (o.type === 1) return;
			const x = o.position[0] / 5 + g.width - 0.5, y = o.position[2] / 5 + g.height - 0.5, z = o.position[1] / 5;
			const kind = o.type === 2 ? 'light' : o.type === 3 ? 'sound' : 'effect';
			out.push({ key: index, kind, index, x, y, z, sprite: `icon:${kind}`, scale: 1, label: decodeName(o.name || ''), color: o.type === 2 ? [...lightColor(o), 1] : [1, 1, 1, 1] });
		});
		return out;
	}

	/** The pixels of the current frame, as a PNG data URL. */
	screenshot() {
		this.render();
		return this.canvas.toDataURL('image/png');
	}

	/**
	 * Draw a frame into an offscreen buffer of any size and read it back:
	 * { width, height, data } RGBA, top row first. For screenshots and the
	 * minimap; the view on screen is untouched.
	 */
	renderOffscreen(width, height) {
		const gl = this.gl;
		const max = gl.getParameter(gl.MAX_RENDERBUFFER_SIZE);
		width = Math.max(1, Math.min(max, Math.round(width))); height = Math.max(1, Math.min(max, Math.round(height)));
		const fb = gl.createFramebuffer();
		const color = gl.createRenderbuffer(), depth = gl.createRenderbuffer();
		gl.bindRenderbuffer(gl.RENDERBUFFER, color);
		gl.renderbufferStorage(gl.RENDERBUFFER, gl.RGBA8, width, height);
		gl.bindRenderbuffer(gl.RENDERBUFFER, depth);
		gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT24, width, height);
		gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
		gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.RENDERBUFFER, color);
		gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, depth);
		this.target = { width, height };
		try { this.render(); } finally { this.target = null; }
		const px = new Uint8Array(width * height * 4);
		gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, px);
		gl.bindFramebuffer(gl.FRAMEBUFFER, null);
		gl.deleteFramebuffer(fb); gl.deleteRenderbuffer(color); gl.deleteRenderbuffer(depth);
		// GL's rows run bottom up.
		const out = new Uint8ClampedArray(width * height * 4);
		for (let y = 0; y < height; y++) out.set(px.subarray((height - 1 - y) * width * 4, (height - y) * width * 4), y * width * 4);
		return { width, height, data: out };
	}

	/**
	 * The map from straight above, edge to edge, with nothing but the map in
	 * it: what the client's minimap is.
	 */
	renderTopDown(width, height) {
		const cam = this.camera, saved = { target: cam.target.slice(), yaw: cam.yaw, pitch: cam.pitch, distance: cam.distance, ortho: cam.ortho, fov: cam.fov };
		const show = { ...this.show }, brush = this.brush, sel = this.selection, rect = this.selectionRect, sky = this.sky;
		const g = this.doc.gnd;
		const span = Math.max(g.width, g.height) * 2;
		cam.ortho = true; cam.pitch = 90; cam.yaw = 0; cam.fov = 40;
		cam.distance = span / 2 / Math.tan((cam.fov * Math.PI) / 360);
		cam.target = [g.width, 0, g.height];
		Object.assign(this.show, { markers: false, gat: false, grid: false, areas: false });
		this.brush = null; this.selection = new Set(); this.selectionRect = null; this.sky = [1, 0, 1];
		try { return this.renderOffscreen(width, height); } finally {
			Object.assign(cam, saved); cam.target = saved.target;
			this.show = show; this.brush = brush; this.selection = sel; this.selectionRect = rect; this.sky = sky;
		}
	}
}
