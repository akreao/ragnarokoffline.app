// .rsm / .rsm2: the 3D models a map places. Read-only.
//
// Adapted from roBrowserLegacy's src/Loaders/Model.js (GPL-3.0, Vincent
// Thibault and contributors) so a model is built exactly as the game builds
// it: the same node matrices, the same bounding box, the same shading. The
// difference is where the placement goes. roBrowser bakes every placement
// into one big vertex buffer once per map; an editor moves models, so here a
// model is compiled once in its own space (compileModel) and each placement
// is a matrix (instanceMatrix) applied when drawing.

import { Reader } from './binary.js';
import { mat4, vec3 } from './mat.js';

export const SHADING = { NONE: 0, FLAT: 1, SMOOTH: 2 };

function newBox() {
	return { max: [-Infinity, -Infinity, -Infinity], min: [Infinity, Infinity, Infinity], offset: [0, 0, 0], range: [0, 0, 0], center: [0, 0, 0] };
}
function finishBox(box) {
	for (let i = 0; i < 3; i++) {
		box.offset[i] = (box.max[i] + box.min[i]) / 2;
		box.range[i] = (box.max[i] - box.min[i]) / 2;
		box.center[i] = box.min[i] + box.range[i];
	}
}

function readNode(model, r, only) {
	const version = model.version;
	const node = { only };
	if (version >= 2.2) { node.name = r.str(r.i32()); node.parent = r.str(r.i32()); } else { node.name = r.str(40); node.parent = r.str(40); }
	let count = r.i32();
	node.textures = new Array(count);
	for (let i = 0; i < count; i++) node.textures[i] = version >= 2.3 ? r.str(r.i32()) : r.i32();
	node.mat3 = [r.f32(), r.f32(), r.f32(), r.f32(), r.f32(), r.f32(), r.f32(), r.f32(), r.f32()];
	node.offset = [r.f32(), r.f32(), r.f32()];
	if (version >= 2.2) {
		node.pos = [0, 0, 0]; node.rotangle = 0; node.rotaxis = [0, 0, 0]; node.scale = [1, 1, 1]; node.flip = [1, -1, 1];
	} else {
		node.pos = [r.f32(), r.f32(), r.f32()];
		node.rotangle = r.f32();
		node.rotaxis = [r.f32(), r.f32(), r.f32()];
		node.scale = [r.f32(), r.f32(), r.f32()];
		node.flip = [1, 1, 1];
	}
	count = r.i32();
	node.vertices = new Array(count);
	for (let i = 0; i < count; i++) node.vertices[i] = [r.f32(), r.f32(), r.f32()];
	count = r.i32();
	node.tvertices = new Float32Array(count * 2);
	for (let i = 0; i < count; i++) {
		if (version >= 1.2) r.offset += 4; // a colour per texture vertex, unused
		node.tvertices[i * 2] = r.f32() * 0.98 + 0.01;
		node.tvertices[i * 2 + 1] = r.f32() * 0.98 + 0.01;
	}
	count = r.i32();
	node.faces = new Array(count);
	for (let i = 0; i < count; i++) {
		const len = version >= 2.2 ? r.i32() : -1;
		const face = { vertidx: [r.u16(), r.u16(), r.u16()], tvertidx: [r.u16(), r.u16(), r.u16()], texid: r.u16(), padding: r.u16(), twoSide: r.i32(), smoothGroup: 0 };
		if (version >= 1.2) {
			face.smoothGroup = r.i32();
			if (len > 24) r.i32();
			if (len > 28) r.i32();
			if (len > 32) r.offset += len - 32;
		}
		node.faces[i] = face;
	}
	if (version >= 1.6) {
		count = r.i32();
		node.scaleKeyFrames = [];
		for (let i = 0; i < count; i++) node.scaleKeyFrames.push({ frame: r.i32(), scale: [r.f32(), r.f32(), r.f32()], data: r.f32() });
	} else node.scaleKeyFrames = [];
	count = r.i32();
	node.rotKeyframes = [];
	for (let i = 0; i < count; i++) node.rotKeyframes.push({ frame: r.i32(), q: [r.f32(), r.f32(), r.f32(), r.f32()] });
	node.posKeyframes = [];
	if (version >= 2.2) {
		count = r.i32();
		for (let i = 0; i < count; i++) node.posKeyframes.push({ frame: r.i32(), px: r.f32(), py: r.f32(), pz: r.f32(), data: r.i32() });
	}
	if (version >= 2.3) {
		count = r.i32();
		for (let i = 0; i < count; i++) {
			r.i32(); // texture id
			const anims = r.i32();
			for (let j = 0; j < anims; j++) {
				r.i32(); // type
				const frames = r.i32();
				r.offset += frames * 8;
			}
		}
	}
	node.box = newBox();
	node.matrix = mat4.create();
	return node;
}

export function readRsm(bytes) {
	const r = new Reader(bytes);
	const magic = r.str(4);
	if (magic !== 'GRSM' && magic !== 'GRSX') throw new Error(`not a .rsm file (starts "${magic}")`);
	const model = {};
	model.version = r.i8() + r.i8() / 10;
	model.animLen = r.i32();
	model.shadeType = r.i32();
	model.alpha = model.version >= 1.4 ? r.u8v() / 255 : 1;
	const textures = [];
	const extra = [];
	let mainName = null;
	if (model.version >= 2.3) {
		model.fps = r.f32();
		let count = r.i32();
		for (let i = 0; i < count; i++) textures.push(r.str(r.i32()));
	} else if (model.version >= 2.2) {
		model.fps = r.f32();
		let count = r.i32();
		for (let i = 0; i < count; i++) extra.push(r.str(r.i32()));
		count = r.i32();
		for (let i = 0; i < count; i++) textures.push(r.str(r.i32()));
	} else {
		r.offset += 16;
		const count = r.i32();
		for (let i = 0; i < count; i++) extra.push(r.str(40));
		mainName = r.str(40);
		textures.push(mainName);
	}
	const count = r.i32();
	model.nodes = [];
	model.main = null;
	for (let i = 0; i < count; i++) {
		const node = readNode(model, r, count === 1);
		model.nodes.push(node);
		if (mainName && node.name === mainName) model.main = node;
	}
	if (!model.main) model.main = model.nodes[0];
	if (!model.main) throw new Error('model has no nodes');
	// The rest (position keyframes before 1.6, volume boxes) changes nothing drawn.
	model.textures = extra;
	if (model.version >= 2.3) {
		for (const node of model.nodes) {
			node.textures = node.textures.map(t => {
				if (typeof t === 'number') return t;
				if (!model.textures.includes(t)) model.textures.push(t);
				return model.textures.indexOf(t);
			});
		}
	}
	model.box = newBox();
	calcModelBox(model);
	return model;
}

function nodeBox(model, node, parentMatrix) {
	mat4.copy(node.matrix, parentMatrix);
	mat4.translate(node.matrix, node.matrix, node.pos);
	if (!node.rotKeyframes.length) mat4.rotate(node.matrix, node.matrix, node.rotangle, node.rotaxis);
	else mat4.rotateQuat(node.matrix, node.matrix, node.rotKeyframes[0].q);
	mat4.scale(node.matrix, node.matrix, node.scale);
	const m = mat4.clone(node.matrix);
	if (!node.only) mat4.translate(m, m, node.offset);
	mat4.multiply(m, m, mat4.fromMat3(node.mat3));
	const box = node.box;
	for (const [x, y, z] of node.vertices) {
		const v = [m[0] * x + m[4] * y + m[8] * z + m[12], m[1] * x + m[5] * y + m[9] * z + m[13], m[2] * x + m[6] * y + m[10] * z + m[14]];
		for (let j = 0; j < 3; j++) { box.min[j] = Math.min(v[j], box.min[j]); box.max[j] = Math.max(v[j], box.max[j]); }
	}
	finishBox(box);
	for (const child of model.nodes) {
		if (child.parent === node.name && node.name !== node.parent && child !== node) nodeBox(model, child, node.matrix);
	}
}

function calcModelBox(model) {
	nodeBox(model, model.main, mat4.create());
	const box = model.box;
	for (let i = 0; i < 3; i++) {
		for (const n of model.nodes) {
			box.max[i] = Math.max(box.max[i], n.box.max[i]);
			box.min[i] = Math.min(box.min[i], n.box.min[i]);
		}
	}
	finishBox(box);
}

/**
 * The model's meshes in its own space: one Float32Array per texture, nine
 * floats a vertex (position, normal, uv, alpha), as roBrowser lays them out.
 * Also the bounding box of the result, for picking and the selection box.
 */
export function compileModel(model) {
	const byTexture = new Map();
	const bounds = newBox();
	for (const node of model.nodes) {
		const matrix = mat4.create();
		mat4.translate(matrix, matrix, [-model.box.center[0], -model.box.max[1], -model.box.center[2]]);
		mat4.multiply(matrix, matrix, node.matrix);
		if (!node.only) mat4.translate(matrix, matrix, node.offset);
		mat4.multiply(matrix, matrix, mat4.fromMat3(node.mat3));
		const normalMat = mat4.extractRotation(mat4.create(), matrix);

		const verts = new Float32Array(node.vertices.length * 3);
		node.vertices.forEach(([x, y, z], i) => {
			verts[i * 3] = matrix[0] * x + matrix[4] * y + matrix[8] * z + matrix[12];
			verts[i * 3 + 1] = matrix[1] * x + matrix[5] * y + matrix[9] * z + matrix[13];
			verts[i * 3 + 2] = matrix[2] * x + matrix[6] * y + matrix[10] * z + matrix[14];
			for (let j = 0; j < 3; j++) { bounds.min[j] = Math.min(bounds.min[j], verts[i * 3 + j]); bounds.max[j] = Math.max(bounds.max[j], verts[i * 3 + j]); }
		});

		const faceNormals = new Float32Array(node.faces.length * 3);
		if (model.shadeType === SHADING.NONE || (model.shadeType !== SHADING.FLAT && model.shadeType !== SHADING.SMOOTH)) {
			for (let i = 1; i < faceNormals.length; i += 3) faceNormals[i] = -1;
		} else {
			node.faces.forEach((f, i) => {
				const n = vec3.calcNormal(node.vertices[f.vertidx[0]], node.vertices[f.vertidx[1]], node.vertices[f.vertidx[2]]);
				faceNormals[i * 3] = normalMat[0] * n[0] + normalMat[4] * n[1] + normalMat[8] * n[2];
				faceNormals[i * 3 + 1] = normalMat[1] * n[0] + normalMat[5] * n[1] + normalMat[9] * n[2];
				faceNormals[i * 3 + 2] = normalMat[2] * n[0] + normalMat[6] * n[1] + normalMat[10] * n[2];
			});
		}
		// Smooth shading: each vertex's normal is the normalised sum of the
		// face normals around it, per smoothing group (roBrowser's
		// calcNormal_SMOOTH, done in one pass rather than per vertex).
		let smooth = null;
		if (model.shadeType === SHADING.SMOOTH) {
			smooth = new Map();
			node.faces.forEach((f, i) => {
				let g = smooth.get(f.smoothGroup);
				if (!g) { g = new Float32Array(node.vertices.length * 3); smooth.set(f.smoothGroup, g); }
				for (const v of f.vertidx) { g[v * 3] += faceNormals[i * 3]; g[v * 3 + 1] += faceNormals[i * 3 + 1]; g[v * 3 + 2] += faceNormals[i * 3 + 2]; }
			});
			for (const g of smooth.values()) {
				for (let v = 0; v < g.length; v += 3) {
					const l = Math.hypot(g[v], g[v + 1], g[v + 2]) || 1;
					g[v] /= l; g[v + 1] /= l; g[v + 2] /= l;
				}
			}
		}

		node.faces.forEach((f, i) => {
			const tex = node.textures[f.texid];
			if (tex === undefined) return;
			let list = byTexture.get(tex);
			if (!list) { list = []; byTexture.set(tex, list); }
			for (let j = 0; j < 3; j++) {
				const a = f.vertidx[j] * 3, b = f.tvertidx[j] * 2;
				let nx, ny, nz;
				if (smooth) { const g = smooth.get(f.smoothGroup); nx = g[a]; ny = g[a + 1]; nz = g[a + 2]; } else { nx = faceNormals[i * 3]; ny = faceNormals[i * 3 + 1]; nz = faceNormals[i * 3 + 2]; }
				list.push(verts[a], verts[a + 1], verts[a + 2], nx, ny, nz, node.tvertices[b], node.tvertices[b + 1], model.alpha);
			}
		});
	}
	finishBox(bounds);
	return {
		meshes: [...byTexture].map(([texture, list]) => ({ texture, data: new Float32Array(list) })),
		box: bounds,
	};
}

/**
 * A placement's matrix, as roBrowser's createInstance builds it: `object` is
 * an .rsw model (file units), `gndWidth`/`gndHeight` the ground's size in
 * cubes. World units are server cells; y is down.
 */
export function instanceMatrix(model, object, gndWidth, gndHeight) {
	const m = mat4.create();
	const p = object.position;
	mat4.translate(m, m, [p[0] / 5 + gndWidth, p[1] / 5, p[2] / 5 + gndHeight]);
	mat4.rotateZ(m, m, (object.rotation[2] / 180) * Math.PI);
	mat4.rotateX(m, m, (object.rotation[0] / 180) * Math.PI);
	mat4.rotateY(m, m, (object.rotation[1] / 180) * Math.PI);
	mat4.scale(m, m, [object.scale[0] / 5, object.scale[1] / 5, object.scale[2] / 5]);
	if (model && model.version >= 2.2) {
		mat4.scale(m, m, model.main.flip);
		mat4.translate(m, m, model.main.offset);
		mat4.translate(m, m, [0, model.box.range[1], 0]);
		mat4.translate(m, m, model.box.offset);
	}
	return m;
}
