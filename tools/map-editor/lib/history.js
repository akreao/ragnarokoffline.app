// Undo and redo.
//
// Every change names the parts of the map it touches ('gnd.heights',
// 'rsw.objects', 'gameplay', ...). Before it runs, those parts are copied;
// after, the copy is reduced to what actually changed (a sparse diff for the
// big typed arrays), and undo swaps it back. One brush stroke, one command
// from an agent, one drag: one step.

export const PARTS = {
	'gnd.heights': { get: d => d.gnd.heights, set: (d, v) => { d.gnd.heights = v; } },
	'gnd.surfaces': { get: d => ({ up: d.gnd.up, front: d.gnd.front, right: d.gnd.right }), set: (d, v) => { d.gnd.up = v.up; d.gnd.front = v.front; d.gnd.right = v.right; } },
	'gnd.tiles': { get: d => d.gnd.tiles, set: (d, v) => { d.gnd.tiles = v; } },
	'gnd.textures': { get: d => ({ textures: d.gnd.textures, fields: d.gnd.textureFields }), set: (d, v) => { d.gnd.textures = v.textures; d.gnd.textureFields = v.fields; } },
	'gnd.lightmap': { get: d => d.gnd.lightmap, set: (d, v) => { d.gnd.lightmap = v; } },
	'gnd.water': { get: d => ({ water: d.gnd.water, version: d.gnd.version }), set: (d, v) => { d.gnd.water = v.water; d.gnd.version = v.version; } },
	'gat.heights': { get: d => d.gat.heights, set: (d, v) => { d.gat.heights = v; } },
	'gat.types': { get: d => d.gat.types, set: (d, v) => { d.gat.types = v; } },
	'gat.locked': { get: d => d.gatLocked || null, set: (d, v) => { d.gatLocked = v; } },
	'rsw.objects': { get: d => d.rsw.objects, set: (d, v) => { d.rsw.objects = v; } },
	'rsw.light': { get: d => d.rsw.light, set: (d, v) => { d.rsw.light = v; } },
	'rsw.water': { get: d => d.rsw.water, set: (d, v) => { d.rsw.water = v; } },
	gameplay: { get: d => d.gameplay, set: (d, v) => { d.gameplay = v; } },
	props: { get: d => d.props, set: (d, v) => { d.props = v; } },
	// Resizing replaces everything.
	whole: { get: d => ({ gat: d.gat, gnd: d.gnd, rsw: d.rsw, gameplay: d.gameplay, props: d.props, name: d.name, gatLocked: d.gatLocked }), set: (d, v) => Object.assign(d, v) },
};

function clone(v) {
	if (v === null || v === undefined) return v;
	if (ArrayBuffer.isView(v)) return v.slice();
	return structuredClone(v);
}

/** What changed in a typed array: the indexes and their old values, or the whole thing when most did. */
function diffTyped(before, after) {
	if (before.length !== after.length || before.constructor !== after.constructor) return { full: before };
	const idx = [];
	for (let i = 0; i < before.length; i++) if (before[i] !== after[i] && !(before[i] !== before[i] && after[i] !== after[i])) idx.push(i);
	if (idx.length > before.length / 3) return { full: before };
	const values = new before.constructor(idx.length);
	idx.forEach((i, k) => { values[k] = before[i]; });
	return { idx: Uint32Array.from(idx), values };
}

function applyTyped(current, diff) {
	if (diff.full) { const now = current; return { value: diff.full, inverse: { full: now } }; }
	const out = current.slice();
	const back = new current.constructor(diff.idx.length);
	diff.idx.forEach((i, k) => { back[k] = out[i]; out[i] = diff.values[k]; });
	return { value: out, inverse: { idx: diff.idx, values: back } };
}

export class History {
	constructor(doc, { limit = 80 } = {}) {
		this.doc = doc;
		this.limit = limit;
		this.undoStack = [];
		this.redoStack = [];
		this.open = null;
		this.onchange = null;
	}

	setDoc(doc) { this.doc = doc; this.undoStack = []; this.redoStack = []; this.open = null; this.changed(); }

	/** Start a step that will touch `parts`. Nested begins join the open step. */
	begin(label, parts) {
		if (this.open) {
			for (const p of parts) if (!(p in this.open.before)) this.open.before[p] = clone(PARTS[p].get(this.doc));
			this.open.depth++;
			return;
		}
		const before = {};
		for (const p of parts) before[p] = clone(PARTS[p].get(this.doc));
		this.open = { label, before, depth: 1, at: Date.now() };
	}

	commit() {
		if (!this.open) return null;
		if (--this.open.depth > 0) return null;
		const step = { label: this.open.label, parts: {}, at: this.open.at };
		let changed = false;
		for (const [p, before] of Object.entries(this.open.before)) {
			const now = PARTS[p].get(this.doc);
			if (ArrayBuffer.isView(before) && ArrayBuffer.isView(now)) {
				const d = diffTyped(before, now);
				if (d.full || d.idx.length) { step.parts[p] = { typed: d }; changed = true; }
			} else if (JSON.stringify(summarize(before)) !== JSON.stringify(summarize(now))) {
				step.parts[p] = { value: before };
				changed = true;
			}
		}
		this.open = null;
		if (!changed) return null;
		this.undoStack.push(step);
		if (this.undoStack.length > this.limit) this.undoStack.shift();
		this.redoStack = [];
		this.changed();
		return step;
	}

	cancel() {
		if (!this.open) return;
		for (const [p, before] of Object.entries(this.open.before)) PARTS[p].set(this.doc, before);
		this.open = null;
	}

	/** Run fn as one step. */
	run(label, parts, fn) {
		this.begin(label, parts);
		try {
			const result = fn();
			this.commit();
			return result;
		} catch (e) {
			this.cancel();
			throw e;
		}
	}

	swap(step) {
		const inverse = { label: step.label, parts: {}, at: step.at };
		for (const [p, change] of Object.entries(step.parts)) {
			const now = PARTS[p].get(this.doc);
			if (change.typed) {
				const { value, inverse: inv } = applyTyped(now, change.typed);
				PARTS[p].set(this.doc, value);
				inverse.parts[p] = { typed: inv };
			} else {
				PARTS[p].set(this.doc, change.value);
				inverse.parts[p] = { value: now };
			}
		}
		return inverse;
	}

	undo() {
		const step = this.undoStack.pop();
		if (!step) return null;
		this.redoStack.push(this.swap(step));
		this.changed();
		return step;
	}

	redo() {
		const step = this.redoStack.pop();
		if (!step) return null;
		this.undoStack.push(this.swap(step));
		this.changed();
		return step;
	}

	changed() { if (this.onchange) this.onchange(); }
}

// Big object arrays compare cheaply enough as JSON; typed arrays inside them
// (a lightmap's data) by length and a sample.
function summarize(v) {
	if (v === null || v === undefined) return v;
	if (ArrayBuffer.isView(v)) {
		let h = 0;
		for (let i = 0; i < v.length; i += Math.max(1, Math.floor(v.length / 4096))) h = (h * 31 + v[i]) | 0;
		let full = 0;
		for (let i = 0; i < v.length; i++) full = (full * 33 + v[i]) | 0;
		return [v.length, h, full];
	}
	if (Array.isArray(v)) return v.map(summarize);
	if (typeof v === 'object') { const o = {}; for (const k of Object.keys(v)) o[k] = summarize(v[k]); return o; }
	return v;
}
