// The map editor page: one map open at a time, the tools on the left, the
// view in the middle, the inspector on the right.
//
// Every change goes through run(command, args) -- the same commands the CLI
// and MCP tools send (lib/commands.js) -- so a person and an agent edit the
// same way and share one undo history.

import { MapRenderer } from '../render/renderer.js';
import { createMap, openMap as openDoc, renameMap, groundHeight, forgetDerived } from '../lib/map.js';
import { runCommand, COMMANDS, cellToRsw, rswToCell } from '../lib/commands.js';
import { History } from '../lib/history.js';
import { attachProject, buildModFiles, savePayload, incomingWarps, minimapPath } from '../lib/project.js';
import { validate } from '../lib/validate.js';
import { bakeLightmaps, modelTriangles } from '../lib/lightmap.js';
import { encodeBmp, resizeImage } from '../lib/image.js';
import { decodeName } from '../lib/cp949.js';
import { get, post, createAssets, hostName } from './host.js';
import { Markers, drawLabels } from './markers.js';
import { renderPanel, PANEL_TOOLS } from './panels.js';
import { openDialog, newMapDialog, testDialog } from './dialogs.js';
import { pageCommands } from './remote.js';

const $ = id => document.getElementById(id);

export const E = {
	doc: null, project: null, mod: null, history: null, renderer: null, markers: null, assets: createAssets(),
	tool: 'select', opts: {
		sculpt: { tool: 'raise', radius: 4, strength: 3, height: 0, falloff: 'smooth' },
		paint: { texture: 0, radius: 2, rotate: 0, flipX: false, flipY: false, span: 4, surface: 'top', mode: 'brush' },
		walk: { type: 1, radius: 1, mode: 'brush' },
		objects: { mode: 'model', model: null, effect: 47, sound: '', rotation: 0, scale: 1, snap: true },
		gameplay: { mode: 'npc', kind: 'script', sprite: '4_M_MANAGER', mob: 1002, amount: 5, delay: 5000 },
	},
	sel: new Set(), hover: null, dirty: false, tables: {}, clipboard: null, issues: [], context: {}, redraw: true, savedJson: null,
};

// ---- Feedback

let toastTimer = 0;
export function toast(text, bad = false, ms = 3500) {
	const t = $('toast');
	t.textContent = text;
	t.className = bad ? 'bad' : '';
	t.hidden = false;
	clearTimeout(toastTimer);
	toastTimer = setTimeout(() => { t.hidden = true; }, ms);
}

export function setDirty(on = true) {
	E.dirty = on;
	const s = $('save-state');
	s.hidden = !E.doc;
	s.textContent = on ? 'Unsaved' : E.savedAt ? `Saved ${E.savedAt.toLocaleTimeString()}` : 'Saved';
	s.className = on ? 'pill warn' : 'pill ok';
	document.title = `${on ? '• ' : ''}${E.doc ? E.doc.name + ' — ' : ''}Map editor`;
}

function syncButtons() {
	const open = !!E.doc;
	for (const id of ['btn-save', 'btn-check', 'btn-test']) $(id).disabled = !open;
	$('btn-undo').disabled = !E.history || !E.history.undoStack.length;
	$('btn-redo').disabled = !E.history || !E.history.redoStack.length;
	$('btn-undo').title = E.history && E.history.undoStack.length ? `Undo ${E.history.undoStack.at(-1).label} (Ctrl+Z)` : 'Undo (Ctrl+Z)';
	$('btn-redo').title = E.history && E.history.redoStack.length ? `Redo ${E.history.redoStack.at(-1).label} (Ctrl+Shift+Z)` : 'Redo';
	$('empty').hidden = open;
	$('map-title').textContent = open ? E.doc.name : 'No map open';
	$('map-sub').textContent = open ? `${E.doc.gat.width}×${E.doc.gat.height} · mod ${E.mod || '(not saved yet)'}${E.doc.source && E.doc.source.kind === 'client' ? ` · from ${E.doc.source.map}` : ''}` : '';
	for (const b of document.querySelectorAll('#tools button')) { b.classList.toggle('on', b.dataset.tool === E.tool); b.disabled = !open && b.dataset.tool !== 'map'; }
}

// ---- Running commands

/** Apply what a change says needs rebuilding. */
export function refresh(r = {}) {
	const R = E.renderer, doc = E.doc;
	if (!doc) return;
	if (r.whole) { const cam = { ...R.camera, target: R.camera.target.slice() }; R.setDoc(doc); if (!r.recenter) Object.assign(R.camera, cam); }
	else {
		if (r.textures) R.texturesChanged();
		if (r.lightmaps) R.lightmapsChanged();
		if (r.ground) R.groundChanged(r.ground === true ? null : r.ground);
		else if (r.gat) R.gatChanged(r.gat === true ? null : r.gat);
		if (r.water) R.buildWater();
		if (r.objects) { if (Array.isArray(r.objects)) r.objects.forEach(i => R.objectMoved(i)); else R.objectsChanged(); }
	}
	if (r.props || r.whole) applySky();
	if (r.gameplay || r.objects || r.ground || r.whole) rebuildMarkers();
	E.redraw = true;
}

function applySky() {
	const p = E.doc.props;
	E.renderer.sky = p.sky ? p.sky.slice(0, 3) : [0.04, 0.04, 0.05];
}

export function rebuildMarkers() {
	if (!E.doc) return;
	E.markers.build(E.doc, { objects: true });
	E.markers.whenLoaded(() => { E.markers.build(E.doc, { objects: true }); E.redraw = true; });
	E.redraw = true;
}

/**
 * Run a command on the open map, as one undo step. Errors are thrown for the
 * caller (the remote channel reports them) and shown unless quiet.
 */
export function run(cmd, args = {}, { quiet = false, panel = true } = {}) {
	if (!E.doc) throw new Error('No map is open. Open or make one first (map.open / map.new).');
	try {
		const out = runCommand(E.doc, cmd, args, E.history);
		refresh(out.refresh);
		if (COMMANDS[cmd].parts.length) setDirty(true);
		if (panel) renderPanel(E);
		syncButtons();
		return out.result;
	} catch (e) {
		if (!quiet) toast(e.message, true);
		throw e;
	}
}

/** Refresh everything an undo or redo could have changed. */
function afterSwap(step) {
	if (!step) return;
	forgetDerived(E.doc);
	const parts = Object.keys(step.parts);
	const r = {};
	if (parts.includes('whole')) r.whole = true;
	if (parts.some(p => p.startsWith('gnd'))) { r.textures = true; r.lightmaps = true; r.ground = true; r.water = true; }
	if (parts.some(p => p.startsWith('gat'))) r.gat = true;
	if (parts.includes('rsw.water')) r.water = true;
	if (parts.includes('rsw.objects')) r.objects = true;
	if (parts.includes('gameplay')) r.gameplay = true;
	if (parts.includes('props')) r.props = true;
	refresh(r);
	E.sel.clear();
	setDirty(true);
	renderPanel(E);
	syncButtons();
	toast(`${step.label}`, false, 1200);
}
export function undo() { if (E.history) afterSwap(E.history.undo()); }
export function redo() { if (E.history) afterSwap(E.history.redo()); }

// ---- Opening and saving

export async function loadTables() {
	const want = { sprites: 'api/tables/sprites', mobs: 'api/tables/mobs', npcs: 'api/tables/npcs', maps: 'api/maps' };
	await Promise.all(Object.entries(want).map(async ([k, route]) => {
		if (E.tables[k]) return;
		try { E.tables[k] = await get(route); } catch (e) { E.tables[k] = k === 'sprites' ? {} : []; E.tables[`${k}Error`] = e.message; }
	}));
	E.markers.tables = E.tables;
}

function setDoc(doc, project) {
	E.doc = doc;
	E.project = project;
	E.mod = project ? project.mod : null;
	E.history = new History(doc);
	E.history.onchange = syncButtons;
	E.sel.clear();
	E.issues = [];
	E.renderer.setDoc(doc);
	applySky();
	rebuildMarkers();
	setDirty(false);
	syncButtons();
	renderPanel(E);
	E.redraw = true;
	try { localStorage.setItem('map-editor:last', JSON.stringify({ mod: E.mod, map: doc.name })); } catch { /* private window */ }
}

async function fetchMapFile(map, ext) {
	return E.assets.file(`data/${map}.${ext}`);
}

/**
 * Open a map. `mod`: the mod it lives in (or will be saved to). `map`: its
 * name, in the mod or in the client's GRFs. `as`: save it as a new map under
 * this name (an official map made into your own) -- without it, an official
 * map saved into a mod overrides the original for everyone with the mod on.
 */
export async function openMap({ mod, map, as, discard = false, remote = false } = {}) {
	if (E.dirty && !discard) {
		if (remote) throw new Error(`${E.doc.name} has unsaved changes: map.save first, or pass discard: true.`);
		if (!(await ask({ title: 'Unsaved changes', text: `Discard the unsaved changes to ${E.doc.name}?`, ok: 'Discard' }))) return null;
	}
	map = String(map || '').toLowerCase().replace(/\.(rsw|gnd|gat)$/, '');
	if (!map) throw new Error('which map?');
	const project = mod ? await get(`api/project?mod=${encodeURIComponent(mod)}`) : null;
	if (!mod) await post('api/open-mod', { mod: null });
	E.assets.forget();
	const [gnd, rsw, gat] = await Promise.all([fetchMapFile(map, 'gnd'), fetchMapFile(map, 'rsw'), fetchMapFile(map, 'gat')]);
	if (!gnd) throw new Error(`There is no map called ${map} in ${mod ? `the mod ${mod} or ` : ''}your client.`);
	const inMod = project && project.exists && (await get(`api/search?filter=x`).catch(() => null), true);
	void inMod;
	const doc = openDoc({ name: map, gnd, rsw, gat, source: { kind: project && (project.manifest || project.exists) ? 'mod' : 'client', map } });
	if (as && as !== map) renameMap(doc, as);
	attachProject(doc, project || { mod, scripts: {} });
	if (project && !project.exists) doc.source = { kind: 'client', map };
	await loadTables();
	setDoc(doc, project || (mod ? { mod, scripts: {}, exists: false } : null));
	toast(`Opened ${map}${as && as !== map ? ` as ${as}` : ''}${doc.warnings ? ' — ' + doc.warnings.join('; ') : ''}`);
	return E.doc;
}

export async function newMap({ mod, name, width = 80, height = 80, texture, discard = false, remote = false } = {}) {
	void texture;
	if (E.dirty && !discard) {
		if (remote) throw new Error(`${E.doc.name} has unsaved changes: map.save first, or pass discard: true.`);
		if (!(await ask({ title: 'Unsaved changes', text: `Discard the unsaved changes to ${E.doc.name}?`, ok: 'Discard' }))) return null;
	}
	if (!mod) throw new Error('A new map needs a mod to live in: give it a name (letters, digits, - and _).');
	const project = await get(`api/project?mod=${encodeURIComponent(mod)}`);
	E.assets.forget();
	const doc = createMap({ name, width, height });
	attachProject(doc, project);
	doc.source = { kind: 'new' };
	doc.testPoint = { x: Math.floor(doc.gat.width / 2), y: Math.floor(doc.gat.height / 2) };
	await loadTables();
	setDoc(doc, project);
	setDirty(true);
	return E.doc;
}

/** The minimap as the game would draw it from above, as BMP bytes. */
export function renderMinimap(size = 512) {
	const R = E.renderer;
	const img = R.renderTopDown(size, size);
	return { bmp: encodeBmp(img), image: img };
}

async function exists(path) { return E.assets.exists(path); }

export async function check({ quick = false } = {}) {
	if (!E.doc) return [];
	const maps = new Set((E.tables.maps || []).map(m => m.map));
	maps.add(E.doc.name);
	const mobs = new Set();
	for (const m of E.tables.mobs || []) { mobs.add(String(m.id)); mobs.add(m.aegis.toUpperCase()); }
	E.issues = await validate(E.doc, {
		exists: quick ? null : exists,
		incoming: incomingWarps(E.doc.name, E.project ? E.project.scripts : {}),
		maps: maps.size > 1 ? maps : null,
		mobs: mobs.size ? mobs : null,
		testPoint: E.doc.testPoint,
	});
	if (!quick) E.issues.push(...await checkOtherMaps());
	return E.issues;
}

/** Warps that land on other maps, and the ways back that stand on them: is that cell walkable there? */
async function checkOtherMaps() {
	const out = [];
	const { readGat, cellKind } = await import('../lib/gat.js');
	const spots = [];
	for (const w of E.doc.gameplay.warps) if (w.dest && w.dest.map !== E.doc.name) spots.push({ map: w.dest.map, x: w.dest.x, y: w.dest.y, what: `the warp ${w.name} lands on`, id: w.id });
	for (const w of E.doc.gameplay.external || []) spots.push({ map: w.map, x: w.x, y: w.y, what: `the way back stands on`, id: w.id });
	for (const n of E.doc.gameplay.npcs) for (const d of n.destinations || []) if (d.map !== E.doc.name) spots.push({ map: d.map, x: d.x, y: d.y, what: `${n.name} sends players to`, id: n.id });
	const gats = new Map();
	for (const s of spots) {
		if (!gats.has(s.map)) gats.set(s.map, E.assets.file(`data/${s.map}.gat`).then(b => (b ? readGat(b) : null)).catch(() => null));
		const gat = await gats.get(s.map);
		if (!gat) { out.push({ level: 'warning', code: 'other-map', message: `${s.what} ${s.map}, which is not in your client or your mods.`, at: { id: s.id } }); continue; }
		if (s.x < 0 || s.y < 0 || s.x >= gat.width || s.y >= gat.height) { out.push({ level: 'error', code: 'other-map-off', message: `${s.what} ${s.map} ${s.x},${s.y}, off that map (it is ${gat.width}x${gat.height}).`, at: { id: s.id } }); continue; }
		if (!cellKind(gat.types[s.y * gat.width + s.x]).walk) out.push({ level: 'error', code: 'other-map-blocked', message: `${s.what} ${s.map} ${s.x},${s.y}, which you cannot walk on there.`, at: { id: s.id } });
	}
	return out;
}

export async function save({ silent = false, mod = null, override = false, remote = false } = {}) {
	if (!E.doc) throw new Error('No map is open.');
	if (mod && mod !== E.mod) {
		if (!/^[A-Za-z0-9_-]{1,64}$/.test(mod)) throw new Error('A mod name is letters, digits, - and _.');
		E.mod = mod;
		E.project = await get(`api/project?mod=${encodeURIComponent(mod)}`);
	}
	if (!E.mod) {
		if (remote) throw new Error('This map is in no mod yet: map.save with mod: "<folder name>".');
		const name = await ask({ title: 'Save into a mod', text: 'Which mod should this map go in? A new folder in your mods is made for it.', input: `${E.doc.name.replace(/_/g, '-')}-map`, ok: 'Save', pattern: /^[A-Za-z0-9_-]{1,64}$/, invalid: 'Letters, digits, - and _.' });
		if (!name) return null;
		E.mod = name;
		E.project = await get(`api/project?mod=${encodeURIComponent(name)}`);
	}
	if (E.doc.source && E.doc.source.kind === 'client' && E.doc.name === E.doc.source.map && !E.overrideOk && !override) {
		const why = `${E.doc.name} is an official map. Saving it into ${E.mod} replaces it for everyone with the mod switched on — its ground, and its map cache on the server. Rename it (Map → Name) to make a new map instead.`;
		if (remote) throw new Error(`${why} Pass override: true to save it as an override anyway, or map.rename first.`);
		if (!(await ask({ title: 'Override an official map?', text: why, ok: 'Save as an override' }))) return null;
	}
	if (override || E.doc.source?.kind === 'client') E.overrideOk = true;
	const { bmp } = renderMinimap(512);
	const built = buildModFiles(E.doc, E.project, { minimap: bmp });
	const answer = await post('api/save', savePayload(E.mod, built));
	// Read the mod back: hand-written lines have moved, and their places are what edits use.
	E.project = await get(`api/project?mod=${encodeURIComponent(E.mod)}`);
	const keepSel = [...E.sel];
	attachProject(E.doc, E.project);
	E.doc.gameplay.removed = [];
	E.assets.forget(`data/${E.doc.name}`);
	E.assets.forget(minimapPath(E.doc.name).toLowerCase());
	E.sel = new Set(keepSel.filter(k => typeof k === 'number'));
	E.savedAt = new Date();
	E.doc.source = { ...(E.doc.source || {}), kind: 'mod' };
	setDirty(false);
	rebuildMarkers();
	renderPanel(E);
	syncButtons();
	if (!silent) toast(`Saved ${E.doc.name} into mods/${E.mod}: ${answer.written.length} files${built.summary.length ? ' (' + built.summary.join('; ') + ')' : ''}.`);
	clearRecovery();
	return { mod: E.mod, dir: answer.dir, written: answer.written, summary: built.summary };
}

/** Save, switch the mod on, restart the server, put a character on the map. */
export async function testInGame({ x, y, char } = {}) {
	if (!E.doc) throw new Error('No map is open.');
	const issues = await check();
	const errors = issues.filter(i => i.level === 'error');
	if (errors.length) { renderPanelTool('check'); throw new Error(`Fix ${errors.length} problem(s) first: ${errors[0].message}`); }
	const saved = await save({ silent: true });
	if (!saved) return null;
	const point = { x: x ?? E.doc.testPoint?.x ?? Math.floor(E.doc.gat.width / 2), y: y ?? E.doc.testPoint?.y ?? Math.floor(E.doc.gat.height / 2) };
	toast('Applying: the server restarts, which takes a little while…', false, 60000);
	const result = await post('api/host/test', { mod: E.mod, map: E.doc.name, x: point.x, y: point.y, char });
	toast(result.message || 'The map is on. Log in and you will be there.', false, 8000);
	return result;
}

/**
 * A question in the page's own dialog (Electron has no window.prompt):
 * resolves with true/false, or with the text typed when `input` is given.
 */
export function ask({ title, text, input = null, ok = 'OK', pattern = null, invalid = '' }) {
	return new Promise(resolve => {
		const dlg = $('dialog'), form = $('dialog-form');
		const field = input !== null ? Object.assign(document.createElement('input'), { value: input, style: 'width:100%' }) : null;
		const note = document.createElement('p'); note.className = 'hint';
		const done = value => { dlg.close(); resolve(value); };
		const okBtn = Object.assign(document.createElement('button'), { type: 'button', className: 'btn primary', textContent: ok });
		okBtn.onclick = () => {
			if (!field) return done(true);
			const v = field.value.trim();
			if (!v || (pattern && !pattern.test(v))) { note.textContent = invalid || 'That will not do.'; return; }
			done(v);
		};
		const cancel = Object.assign(document.createElement('button'), { type: 'button', className: 'btn', textContent: 'Cancel', onclick: () => done(field ? null : false) });
		const head = document.createElement('div'); head.className = 'dh'; head.innerHTML = '<h2></h2>'; head.firstChild.textContent = title;
		const body = document.createElement('div'); body.className = 'db';
		const p = document.createElement('p'); p.textContent = text;
		body.append(p); if (field) body.append(field, note);
		const foot = document.createElement('div'); foot.className = 'df'; foot.append(cancel, okBtn);
		form.replaceChildren(head, body, foot);
		dlg.oncancel = () => resolve(field ? null : false);
		if (!dlg.open) dlg.showModal();
		(field || okBtn).focus();
		if (field) field.onkeydown = e => { if (e.key === 'Enter') { e.preventDefault(); okBtn.click(); } };
	});
}

// ---- Recovery: an unsaved map survives a crash or a closed window

const RECOVERY = 'map-editor:recovery';
function idb() {
	return new Promise((resolve, reject) => {
		const req = indexedDB.open('map-editor', 1);
		req.onupgradeneeded = () => req.result.createObjectStore('kv');
		req.onsuccess = () => resolve(req.result);
		req.onerror = () => reject(req.error);
	});
}
async function kv(op, key, value) {
	const db = await idb();
	return new Promise((resolve, reject) => {
		const tx = db.transaction('kv', op === 'get' ? 'readonly' : 'readwrite');
		const st = tx.objectStore('kv');
		const req = op === 'get' ? st.get(key) : op === 'put' ? st.put(value, key) : st.delete(key);
		req.onsuccess = () => resolve(req.result);
		req.onerror = () => reject(req.error);
	});
}
async function autosave() {
	if (!E.doc || !E.dirty) return;
	try {
		const { mapFiles } = await import('../lib/map.js');
		await kv('put', RECOVERY, { at: Date.now(), mod: E.mod, name: E.doc.name, files: mapFiles(E.doc), gameplay: E.doc.gameplay, props: E.doc.props, testPoint: E.doc.testPoint, source: E.doc.source });
	} catch { /* no IndexedDB here */ }
}
function clearRecovery() { kv('delete', RECOVERY).catch(() => {}); }
async function offerRecovery() {
	let r = null;
	try { r = await kv('get', RECOVERY); } catch { return; }
	if (!r || Date.now() - r.at > 14 * 864e5) return;
	if (!(await ask({ title: 'Restore unsaved work?', text: `There is an unsaved copy of ${r.name}${r.mod ? ` (mod ${r.mod})` : ''} from ${new Date(r.at).toLocaleString()}.`, ok: 'Restore' }))) { clearRecovery(); return; }
	const doc = openDoc({ name: r.name, gnd: r.files[`${r.name}.gnd`], rsw: r.files[`${r.name}.rsw`], gat: r.files[`${r.name}.gat`], source: r.source });
	doc.gameplay = r.gameplay; doc.props = r.props; doc.testPoint = r.testPoint;
	const project = r.mod ? await get(`api/project?mod=${encodeURIComponent(r.mod)}`).catch(() => null) : null;
	await loadTables();
	setDoc(doc, project);
	setDirty(true);
}

// ---- Tools and panels

export function setTool(tool) {
	E.tool = tool;
	if (tool === 'walk') { E.renderer.show.gat = true; syncLayers(); }
	E.renderer.brush = null;
	renderPanel(E);
	syncButtons();
	E.redraw = true;
}
function renderPanelTool(tool) { setTool(tool); }

function syncLayers() {
	for (const box of document.querySelectorAll('#layers input[data-layer]')) box.checked = !!E.renderer.show[box.dataset.layer];
}

// ---- Input

const view = () => $('view');
let drag = null;
let strokeTimer = 0;

function cellAt(ev) {
	const rect = view().getBoundingClientRect();
	const hit = E.renderer.pickGround(E.renderer.rayAt(ev.clientX - rect.left, ev.clientY - rect.top));
	return hit ? { x: hit[0], y: hit[2], world: hit } : null;
}

function pickAt(ev) {
	const rect = view().getBoundingClientRect();
	const px = ev.clientX - rect.left, py = ev.clientY - rect.top;
	const marker = E.renderer.show.markers ? E.renderer.pickMarker(px, py) : null;
	const model = E.renderer.show.models ? E.renderer.pickModel(E.renderer.rayAt(px, py)) : null;
	if (marker && (!model || typeof marker.key !== 'number' || true)) return { type: 'marker', key: marker.key, marker };
	if (model) return { type: 'model', index: model.index, key: model.index };
	return null;
}

function status(ev) {
	const c = ev ? cellAt(ev) : null;
	if (!c || !E.doc) { $('st-cell').textContent = '—'; $('st-height').textContent = ''; $('st-type').textContent = ''; return c; }
	const x = Math.floor(c.x), y = Math.floor(c.y);
	$('st-cell').textContent = `cell ${x}, ${y}`;
	$('st-height').textContent = `height ${(-groundHeight(E.doc, c.x, c.y)).toFixed(2)}`;
	const t = x >= 0 && y >= 0 && x < E.doc.gat.width && y < E.doc.gat.height ? E.doc.gat.types[y * E.doc.gat.width + x] : null;
	$('st-type').textContent = t === null ? '' : ['walkable', 'blocked', 'walkable', 'water', 'walkable', 'cliff', 'walkable'][t] || `type ${t}`;
	return c;
}

const HINTS = {
	select: 'Click to select · drag to move · Ctrl+drag raises · Shift adds · drag on empty ground to box-select · Delete removes · [ ] turn · Ctrl+D duplicate',
	sculpt: 'Drag to sculpt · Shift lowers · Ctrl smooths · Alt picks the height · +/- brush size',
	paint: 'Drag to paint · Alt picks the texture under the cursor · R rotates · +/- brush size',
	walk: 'Drag to paint walkability · Alt picks a type · +/- brush size',
	objects: 'Click to place · Alt+click picks the model under the cursor',
	gameplay: 'Click to place an NPC · drag an area for warps and monsters · select one to edit it',
	map: '', check: '',
};

function brushArgs(c) { return { x: c.x, y: c.y }; }

function startStroke(label, parts) { E.history.begin(label, parts); }
function endStroke() { const step = E.history.commit(); if (step) setDirty(true); syncButtons(); }

function onDown(ev) {
	if (!E.doc) return;
	view().focus();
	const R = E.renderer;
	if (ev.button === 2 || ev.button === 1 || (ev.button === 0 && E.spaceDown)) {
		drag = { kind: ev.button === 1 || ev.shiftKey || E.spaceDown ? 'pan' : 'orbit', x: ev.clientX, y: ev.clientY, cam: { yaw: R.camera.yaw, pitch: R.camera.pitch, target: R.camera.target.slice() } };
		view().setPointerCapture(ev.pointerId);
		return;
	}
	if (ev.button !== 0) return;
	const c = cellAt(ev);
	const tool = E.tool;
	if (tool === 'select' || (tool === 'gameplay' && !ev.altKey && pickAt(ev) && pickAt(ev).type === 'marker' && E.opts.gameplay.mode !== 'spawn-area')) {
		const hit = pickAt(ev);
		if (hit) {
			if (ev.shiftKey) { if (E.sel.has(hit.key)) E.sel.delete(hit.key); else E.sel.add(hit.key); }
			else if (!E.sel.has(hit.key)) { E.sel.clear(); E.sel.add(hit.key); }
			R.selection = E.sel;
			renderPanel(E);
			if (c && !ev.shiftKey) drag = { kind: 'move', start: c, last: c, began: false };
		} else {
			if (!ev.shiftKey) E.sel.clear();
			if (c) drag = { kind: 'box', start: c };
			renderPanel(E);
		}
		E.redraw = true;
		view().setPointerCapture(ev.pointerId);
		return;
	}
	if (!c) return;
	if (tool === 'sculpt') {
		const o = E.opts.sculpt;
		if (ev.altKey) { o.height = +(-groundHeight(E.doc, c.x, c.y)).toFixed(2); renderPanel(E); return; }
		if (o.mode === 'walls') return;
		if (o.mode === 'area') {
			const a = o.area || { op: 'set', height: 2 };
			drag = { kind: 'rect', start: c, then: rect => run('terrain.rect', { ...rect, op: a.op, height: a.height, ...(a.op === 'ramp' ? { to: a.to, direction: a.direction } : {}) }) };
			view().setPointerCapture(ev.pointerId);
			return;
		}
		startStroke('sculpt', ['gnd.heights', 'gat.heights', 'gat.types']);
		drag = { kind: 'stroke' };
		const apply = () => {
			if (!drag || drag.kind !== 'stroke' || !E.lastCell) return;
			const t = ev.ctrlKey || E.ctrlDown ? 'smooth' : (ev.shiftKey || E.shiftDown) && o.tool === 'raise' ? 'lower' : (ev.shiftKey || E.shiftDown) && o.tool === 'lower' ? 'raise' : o.tool;
			// Strength is cells a second while the button is held: 20 applications a second.
			const per = o.strength / 20;
			try { run('terrain.brush', { tool: t, ...brushArgs(E.lastCell), radius: o.radius, strength: t === 'smooth' || t === 'flatten' ? Math.min(1, o.strength / 12) : per, height: t === 'set' || t === 'flatten' ? o.height : undefined, falloff: o.falloff }, { panel: false }); } catch { /* shown */ }
		};
		E.lastCell = c;
		apply();
		strokeTimer = setInterval(apply, 50);
		view().setPointerCapture(ev.pointerId);
		return;
	}
	if (tool === 'paint') {
		const o = E.opts.paint;
		if (ev.altKey) {
			const g = E.doc.gnd, i = Math.floor(c.y / 2) * g.width + Math.floor(c.x / 2);
			if (g.up[i] >= 0) { o.texture = g.tiles[g.up[i]].texture; renderPanel(E); }
			return;
		}
		if (o.mode === 'rect') { drag = { kind: 'rect', start: c, then: rect => run('texture.paint', { texture: o.texture, ...rect, rotate: o.rotate, flipX: o.flipX, flipY: o.flipY, span: o.span, surface: o.surface }) }; view().setPointerCapture(ev.pointerId); return; }
		startStroke('paint', ['gnd.tiles', 'gnd.surfaces', 'gnd.textures', 'gnd.lightmap']);
		drag = { kind: 'stroke' };
		const paint = cc => { try { run('texture.paint', { texture: o.texture, ...brushArgs(cc), radius: o.radius, rotate: o.rotate, flipX: o.flipX, flipY: o.flipY, span: o.span, surface: o.surface }, { panel: false }); } catch { /* shown */ } };
		paint(c);
		drag.each = paint;
		view().setPointerCapture(ev.pointerId);
		return;
	}
	if (tool === 'walk') {
		const o = E.opts.walk;
		const x = Math.floor(c.x), y = Math.floor(c.y);
		if (ev.altKey) { o.type = E.doc.gat.types[y * E.doc.gat.width + x]; renderPanel(E); return; }
		if (o.mode === 'rect') { drag = { kind: 'rect', start: c, then: rect => run('gat.paint', { type: o.type, ...rect }) }; view().setPointerCapture(ev.pointerId); return; }
		startStroke('walkability', ['gat.types', 'gat.locked']);
		drag = { kind: 'stroke' };
		const paint = cc => { try { run('gat.paint', { type: o.type, x: Math.floor(cc.x) + 0.5, y: Math.floor(cc.y) + 0.5, radius: o.radius }, { panel: false }); } catch { /* shown */ } };
		paint(c);
		drag.each = paint;
		view().setPointerCapture(ev.pointerId);
		return;
	}
	if (tool === 'objects') {
		const o = E.opts.objects;
		if (ev.altKey) { const hit = pickAt(ev); if (hit && hit.type === 'model') { o.model = decodeName(E.doc.rsw.objects[hit.index].file); o.mode = 'model'; renderPanel(E); } return; }
		const x = +c.x.toFixed(2) - 0.5, y = +c.y.toFixed(2) - 0.5;
		let r;
		if (o.mode === 'model') { if (!o.model) { toast('Pick a model in the browser on the right first.', true); return; } r = run('model.add', { file: o.model, x, y, rotation: o.rotation, scale: o.scale }); }
		else if (o.mode === 'light') r = run('light.add', { x, y, color: o.lightColor || '#ffcc88', range: o.lightRange || 8, height: o.lightHeight || 3 });
		else if (o.mode === 'sound') { if (!o.sound) { toast('Pick a sound first.', true); return; } r = run('sound.add', { file: o.sound, x, y, volume: o.volume ?? 0.8, range: o.soundRange || 20, cycle: o.cycle || 4 }); }
		else if (o.mode === 'effect') r = run('effect.add', { id: o.effect, x, y, height: o.effectHeight || 0 });
		else if (o.mode === 'paste' && E.clipboard) { const out = run('object.paste', { clip: E.clipboard, x, y }); E.sel = new Set(out.indexes); E.renderer.selection = E.sel; renderPanel(E); return; }
		if (r && r.index !== undefined) { E.sel = new Set([r.index]); E.renderer.selection = E.sel; renderPanel(E); }
		return;
	}
	if (tool === 'gameplay') {
		const o = E.opts.gameplay;
		const x = Math.floor(c.x), y = Math.floor(c.y);
		if (o.mode === 'npc') {
			const r = run('npc.add', { kind: o.kind, x, y, name: o.name || defaultNpcName(o.kind), sprite: o.sprite, dir: o.dir ?? 4, ...(o.kind === 'sign' ? { text: 'Welcome!' } : {}), ...(o.kind === 'shop' ? { items: '501,502,503,506,601,602' } : {}), ...(o.kind === 'warper' ? { destinations: 'prontera:156:191:Prontera' } : {}) });
			E.sel = new Set([`npc:${r.id}`]); E.renderer.selection = E.sel; renderPanel(E);
			return;
		}
		if (o.mode === 'warp' || o.mode === 'spawn') { drag = { kind: 'rect', start: c, then: rect => placeArea(o.mode, rect) }; view().setPointerCapture(ev.pointerId); return; }
		if (o.mode === 'sign') { run('signboard.set', { x, y, icon: o.icon || 'information\\over_store.bmp', type: o.signType || 1, caption: o.caption || '' }); return; }
		if (o.mode === 'start') { E.doc.testPoint = { x, y }; setDirty(true); rebuildMarkers(); renderPanel(E); toast(`Test in game will put you at ${x}, ${y}.`); return; }
	}
}

function defaultNpcName(kind) { return { script: 'Villager', sign: 'Sign', healer: 'Healer', warper: 'Warper', shop: 'Merchant' }[kind] || 'NPC'; }

function placeArea(mode, rect) {
	const o = E.opts.gameplay;
	const x = Math.round((rect.x0 + rect.x1) / 2), y = Math.round((rect.y0 + rect.y1) / 2);
	const xs = Math.max(mode === 'warp' ? 0 : 1, Math.round((rect.x1 - rect.x0) / 2)), ys = Math.max(mode === 'warp' ? 0 : 1, Math.round((rect.y1 - rect.y0) / 2));
	let r;
	if (mode === 'warp') r = run('warp.add', { x, y, xs, ys, map: o.destMap || 'prontera', dx: o.destX ?? 156, dy: o.destY ?? 191 })[0];
	else r = run('spawn.add', { mob: o.mob, amount: o.amount, x, y, xs, ys, delay: o.delay });
	E.sel = new Set([`${mode}:${r.id}`]); E.renderer.selection = E.sel; renderPanel(E);
}

function rectOf(a, b) {
	return { x0: Math.floor(Math.min(a.x, b.x)), y0: Math.floor(Math.min(a.y, b.y)), x1: Math.floor(Math.max(a.x, b.x)), y1: Math.floor(Math.max(a.y, b.y)) };
}

function onMove(ev) {
	if (!E.doc) return;
	const R = E.renderer;
	if (drag && (drag.kind === 'orbit' || drag.kind === 'pan')) {
		const dx = ev.clientX - drag.x, dy = ev.clientY - drag.y;
		if (drag.kind === 'orbit') {
			R.camera.yaw = drag.cam.yaw - dx * 0.3;
			R.camera.pitch = Math.max(12, Math.min(90, drag.cam.pitch + dy * 0.3));
		} else {
			const s = R.camera.distance / 600, yaw = (R.camera.yaw * Math.PI) / 180;
			const rx = Math.cos(yaw), rz = -Math.sin(yaw), fx = Math.sin(yaw), fz = Math.cos(yaw);
			R.camera.target[0] = drag.cam.target[0] - (dx * rx - dy * fx) * s;
			R.camera.target[2] = drag.cam.target[2] - (dx * rz - dy * fz) * s;
		}
		E.redraw = true;
		return;
	}
	const c = status(ev);
	E.lastCell = c || E.lastCell;
	const tool = E.tool;
	if (c && ['sculpt', 'paint', 'walk'].includes(tool)) {
		const o = E.opts[tool];
		R.brush = (o.mode === 'rect' || o.mode === 'area' || o.mode === 'walls') ? null : { x: tool === 'walk' ? Math.floor(c.x) + 0.5 : c.x, z: tool === 'walk' ? Math.floor(c.y) + 0.5 : c.y, radius: o.radius, color: tool === 'sculpt' ? [1, 0.85, 0.2] : tool === 'paint' ? [0.3, 0.8, 1] : [1, 0.4, 0.4] };
		E.redraw = true;
	} else if (R.brush) { R.brush = null; E.redraw = true; }
	if (!drag) {
		const hit = ['select', 'gameplay', 'objects'].includes(tool) ? pickAt(ev) : null;
		const key = hit ? hit.key : null;
		if ((R.hover && R.hover.key) !== key) { R.hover = hit ? { type: hit.type, key, index: hit.index } : null; E.hover = R.hover; E.redraw = true; }
		return;
	}
	if (!c) return;
	if (drag.kind === 'stroke' && drag.each) drag.each(c);
	if (drag.kind === 'move' && (ev.ctrlKey || ev.metaKey)) {
		// Ctrl+drag: up and down, not across.
		const idx = [...E.sel].filter(k => typeof k === 'number');
		if (idx.length && ev.movementY) {
			if (!drag.began) { startStroke('move', ['rsw.objects', 'gameplay']); drag.began = true; }
			runCommand(E.doc, 'object.move', { indexes: idx, dheight: -ev.movementY * (E.renderer.camera.distance / 600), keepHeight: true });
			idx.forEach(i => E.renderer.objectMoved(i));
			setDirty(true);
			E.redraw = true;
		}
		return;
	}
	if (drag.kind === 'move') {
		const dx = c.x - drag.last.x, dy = c.y - drag.last.y;
		const snap = E.opts.objects.snap && !ev.altKey;
		const tx = snap ? Math.round(c.x - drag.start.x) : c.x - drag.start.x, ty = snap ? Math.round(c.y - drag.start.y) : c.y - drag.start.y;
		const px = snap ? Math.round(drag.last.x - drag.start.x) : drag.last.x - drag.start.x, py = snap ? Math.round(drag.last.y - drag.start.y) : drag.last.y - drag.start.y;
		const mx = tx - px, my = ty - py;
		void dx; void dy;
		if (mx || my) {
			if (!drag.began) { startStroke('move', ['rsw.objects', 'gameplay']); drag.began = true; }
			moveSelection(mx, my, true);
			drag.last = { x: snap ? drag.start.x + tx : c.x, y: snap ? drag.start.y + ty : c.y };
		}
	}
	if (drag.kind === 'box' || drag.kind === 'rect') { R.selectionRect = rectOf(drag.start, c); R.selectionRect.x1 += 1; R.selectionRect.y1 += 1; E.redraw = true; }
}

function onUp(ev) {
	const R = E.renderer;
	clearInterval(strokeTimer);
	if (!drag) return;
	const d = drag;
	drag = null;
	try { view().releasePointerCapture(ev.pointerId); } catch { /* not captured */ }
	if (d.kind === 'stroke') { endStroke(); renderPanel(E); return; }
	if (d.kind === 'move') { if (d.began) { endStroke(); refresh({ objects: true, gameplay: true }); renderPanel(E); } return; }
	const c = cellAt(ev) || d.start;
	if (d.kind === 'box') {
		R.selectionRect = null;
		const r = rectOf(d.start, c);
		if (r.x1 - r.x0 + r.y1 - r.y0 > 0) {
			E.doc.rsw.objects.forEach((o, i) => { const p = rswToCell(E.doc, o.position); if (p.x >= r.x0 && p.x <= r.x1 + 1 && p.y >= r.y0 && p.y <= r.y1 + 1) E.sel.add(i); });
			for (const m of R.markers) if (typeof m.key === 'string' && m.x >= r.x0 && m.x <= r.x1 && m.y >= r.y0 && m.y <= r.y1) E.sel.add(m.key);
		}
		R.selection = E.sel;
		renderPanel(E);
		E.redraw = true;
	}
	if (d.kind === 'rect') { R.selectionRect = null; const r = rectOf(d.start, c); try { d.then(r); } catch { /* shown */ } E.redraw = true; }
}

/** Move the selection by whole cells (objects and markers alike), live. */
export function moveSelection(dx, dy, live = false) {
	const doc = E.doc;
	const objects = [...E.sel].filter(k => typeof k === 'number');
	const markers = [...E.sel].filter(k => typeof k === 'string');
	if (!live) E.history.begin('move', ['rsw.objects', 'gameplay']);
	if (objects.length) runCommand(doc, 'object.move', { indexes: objects, dx, dy });
	for (const key of markers) {
		const [kind, id] = key.split(/:(.*)/);
		if (kind === 'sign') { const s = doc.gameplay.signboards[Number(id)]; if (s) { s.x += Math.round(dx); s.y += Math.round(dy); } continue; }
		if (kind === 'start') { doc.testPoint.x += Math.round(dx); doc.testPoint.y += Math.round(dy); continue; }
		const list = kind === 'npc' ? doc.gameplay.npcs : kind === 'warp' ? doc.gameplay.warps : doc.gameplay.spawns;
		const m = list.find(o => o.id === id);
		if (m) { m.x += Math.round(dx); m.y += Math.round(dy); m.dirty = true; }
	}
	if (!live) { E.history.commit(); setDirty(true); }
	else setDirty(true);
	if (objects.length) objects.forEach(i => E.renderer.objectMoved(i));
	rebuildMarkers();
	syncButtons();
}

function deleteSelection() {
	if (!E.sel.size) return;
	const objects = [...E.sel].filter(k => typeof k === 'number');
	const markers = [...E.sel].filter(k => typeof k === 'string');
	E.history.begin('delete', ['rsw.objects', 'gameplay']);
	try {
		if (objects.length) runCommand(E.doc, 'object.remove', { indexes: objects });
		const ids = markers.filter(k => /^(npc|warp|spawn):/.test(k)).map(k => k.split(/:(.*)/)[1]);
		if (ids.length) runCommand(E.doc, 'marker.remove', { id: ids.join(',') });
		for (const k of markers.filter(k => k.startsWith('sign:')).map(k => Number(k.slice(5))).sort((a, b) => b - a)) E.doc.gameplay.signboards.splice(k, 1);
		E.history.commit();
	} catch (e) { E.history.cancel(); toast(e.message, true); }
	E.sel.clear();
	refresh({ objects: true, gameplay: true });
	setDirty(true);
	renderPanel(E);
	syncButtons();
}

function onWheel(ev) {
	if (!E.doc) return;
	ev.preventDefault();
	const R = E.renderer;
	if (['sculpt', 'paint', 'walk'].includes(E.tool) && (ev.altKey)) {
		const o = E.opts[E.tool];
		o.radius = Math.max(0.5, Math.min(40, o.radius * (ev.deltaY > 0 ? 0.9 : 1.1)));
		renderPanel(E);
		return;
	}
	const before = cellAt(ev);
	R.camera.distance = Math.max(6, Math.min(2000, R.camera.distance * (ev.deltaY > 0 ? 1.12 : 1 / 1.12)));
	// Zoom toward the cursor.
	if (before && ev.deltaY < 0) { R.camera.target[0] += (before.world[0] - R.camera.target[0]) * 0.1; R.camera.target[2] += (before.world[2] - R.camera.target[2]) * 0.1; }
	E.redraw = true;
}

function onKey(ev) {
	if (ev.target.closest && ev.target.closest('input, textarea, select, dialog')) return;
	const k = ev.key, mod = ev.ctrlKey || ev.metaKey;
	E.shiftDown = ev.shiftKey; E.ctrlDown = ev.ctrlKey;
	if (k === ' ') { E.spaceDown = ev.type === 'keydown'; ev.preventDefault(); return; }
	if (ev.type !== 'keydown') return;
	if (mod && k.toLowerCase() === 'z') { ev.preventDefault(); if (ev.shiftKey) redo(); else undo(); return; }
	if (mod && k.toLowerCase() === 'y') { ev.preventDefault(); redo(); return; }
	if (mod && k.toLowerCase() === 's') { ev.preventDefault(); save().catch(e => toast(e.message, true)); return; }
	if (mod && k.toLowerCase() === 'o') { ev.preventDefault(); openDialog(E); return; }
	if (!E.doc) return;
	const R = E.renderer;
	if (mod && k.toLowerCase() === 'c') { const idx = [...E.sel].filter(x => typeof x === 'number'); if (idx.length) { E.clipboard = run('object.copy', { indexes: idx }); try { localStorage.setItem('map-editor:clipboard', JSON.stringify(E.clipboard)); } catch { /* full */ } toast(`Copied ${idx.length} object(s). Objects → Paste, or Ctrl+V, on any map.`); } return; }
	if (mod && k.toLowerCase() === 'v') { if (!E.clipboard) { try { E.clipboard = JSON.parse(localStorage.getItem('map-editor:clipboard')); } catch { /* none */ } } if (E.clipboard && E.lastCell) { const out = run('object.paste', { clip: E.clipboard, x: E.lastCell.x - 0.5, y: E.lastCell.y - 0.5 }); E.sel = new Set(out.indexes); R.selection = E.sel; renderPanel(E); } return; }
	if (mod && k.toLowerCase() === 'd') { ev.preventDefault(); const idx = [...E.sel].filter(x => typeof x === 'number'); if (idx.length) { const out = run('object.duplicate', { indexes: idx, dx: 2, dy: 0 }); E.sel = new Set(out.indexes); R.selection = E.sel; renderPanel(E); } return; }
	if (k === 'Delete' || k === 'Backspace') { deleteSelection(); return; }
	if (k === 'Escape') { E.sel.clear(); R.selection = E.sel; renderPanel(E); E.redraw = true; return; }
	if (/^[1-8]$/.test(k)) { setTool(PANEL_TOOLS[Number(k) - 1]); return; }
	if (k === '[' || k === ']') { const idx = [...E.sel].filter(x => typeof x === 'number'); if (idx.length) run('object.move', { indexes: idx, rotate: (k === '[' ? -1 : 1) * (ev.shiftKey ? 90 : 15) }); return; }
	if (k === '+' || k === '=' || k === '-') { const o = E.opts[E.tool]; if (o && o.radius !== undefined) { o.radius = Math.max(0.5, Math.min(40, o.radius + (k === '-' ? -0.5 : 0.5))); renderPanel(E); } return; }
	if (k.toLowerCase() === 'r' && E.tool === 'paint') { E.opts.paint.rotate = (E.opts.paint.rotate + 1) & 3; renderPanel(E); return; }
	if (k.toLowerCase() === 't') { R.camera.pitch = R.camera.pitch > 85 ? 55 : 90; E.redraw = true; return; }
	if (k === 'Home') { fitView(); return; }
	if (k.toLowerCase() === 'f' && E.sel.size) { focusSelection(); return; }
	if (k.toLowerCase() === 'q' || k.toLowerCase() === 'e') { R.camera.yaw += k.toLowerCase() === 'q' ? -15 : 15; E.redraw = true; return; }
	const arrows = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, 1], ArrowDown: [0, -1] };
	if (arrows[k]) {
		ev.preventDefault();
		const [dx, dy] = arrows[k];
		if (E.sel.size) { moveSelection(dx, dy); renderPanel(E); }
		else { const yaw = (R.camera.yaw * Math.PI) / 180, s = R.camera.distance / 30; R.camera.target[0] += (dx * Math.cos(yaw) + dy * Math.sin(yaw)) * s; R.camera.target[2] += (-dx * Math.sin(yaw) + dy * Math.cos(yaw)) * s; E.redraw = true; }
		return;
	}
	const pan = { w: [0, 1], s: [0, -1], a: [-1, 0], d: [1, 0] }[k.toLowerCase()];
	if (pan && !mod) { const yaw = (R.camera.yaw * Math.PI) / 180, s = R.camera.distance / 25; R.camera.target[0] += (pan[0] * Math.cos(yaw) + pan[1] * Math.sin(yaw)) * s; R.camera.target[2] += (-pan[0] * Math.sin(yaw) + pan[1] * Math.cos(yaw)) * s; E.redraw = true; }
}

export function fitView() {
	const g = E.doc.gnd, R = E.renderer;
	R.camera.target = [g.width, -groundHeight(E.doc, g.width, g.height) * 0 + groundHeight(E.doc, g.width, g.height), g.height];
	R.camera.distance = Math.max(40, Math.max(g.width, g.height) * 2.6);
	R.camera.yaw = 0; R.camera.pitch = 55;
	E.redraw = true;
}

export function focusSelection() {
	const pts = [];
	for (const k of E.sel) {
		if (typeof k === 'number') { const c = rswToCell(E.doc, E.doc.rsw.objects[k].position); pts.push([c.x, c.y]); }
		else { const m = E.renderer.markers.find(mm => mm.key === k); if (m) pts.push([m.x, m.y]); }
	}
	if (!pts.length) return;
	const x = pts.reduce((s, p) => s + p[0], 0) / pts.length, y = pts.reduce((s, p) => s + p[1], 0) / pts.length;
	focusOn(x, y);
}

export function focusOn(x, y, distance = 45) {
	const R = E.renderer;
	R.camera.target = [x + 0.5, groundHeight(E.doc, x + 0.5, y + 0.5), y + 0.5];
	R.camera.distance = distance;
	E.redraw = true;
}

// ---- Lightmaps and screenshots (need the renderer's models)

/** Bake lightmaps with the models' real triangles as shadow casters. */
export async function bake({ shadows = true, lights = true, samples = 1 } = {}) {
	const R = E.renderer;
	// Wait for models still loading.
	for (let i = 0; i < 100 && [...R.models.values()].some(m => m.state === 'loading'); i++) await new Promise(r => setTimeout(r, 100));
	const placements = R.instances.filter(i => i.matrix && i.entry.meshData).map(i => ({ meshes: i.entry.meshData, matrix: i.matrix }));
	const occluders = shadows ? modelTriangles(placements) : new Float32Array(0);
	E.history.begin('bake lightmaps', ['gnd.lightmap', 'gnd.tiles', 'gnd.surfaces']);
	let out;
	try { out = bakeLightmaps(E.doc, { occluders, shadows, lights, samples }); E.history.commit(); } catch (e) { E.history.cancel(); throw e; }
	refresh({ lightmaps: true });
	setDirty(true);
	syncButtons();
	return { ...out, occluders: occluders.length / 9 };
}

/** A screenshot of the view, with the marker labels, as a PNG data URL. */
export function screenshot({ width, height, labels = true } = {}) {
	const R = E.renderer;
	const w = width || R.canvas.width, h = height || R.canvas.height;
	const pixels = R.renderOffscreen(w, h);
	const c = document.createElement('canvas');
	c.width = w; c.height = h;
	const g = c.getContext('2d');
	g.putImageData(new ImageData(pixels.data, w, h), 0, 0);
	if (labels && R.show.markers) {
		const lc = document.createElement('canvas');
		lc.style.width = `${w}px`; lc.style.height = `${h}px`;
		Object.defineProperty(lc, 'clientWidth', { value: w });
		Object.defineProperty(lc, 'clientHeight', { value: h });
		const saveW = R.canvas.clientWidth, saveH = R.canvas.clientHeight;
		R.projectSize = { width: w, height: h };
		drawLabels(lc, R, { selection: E.sel, hover: null });
		R.projectSize = null;
		void saveW; void saveH;
		g.drawImage(lc, 0, 0, w, h);
	}
	return c.toDataURL('image/png');
}

// ---- The live channel: commands from the CLI and MCP clients

let pollFailures = 0;
async function pollRemote() {
	for (;;) {
		try {
			const { commands } = await post('api/remote/poll', { info: E.doc ? { map: E.doc.name, mod: E.mod, dirty: E.dirty, cells: [E.doc.gat.width, E.doc.gat.height] } : { map: null } });
			pollFailures = 0;
			for (const c of commands || []) {
				$('st-remote').textContent = `agent: ${c.cmd}`;
				let reply;
				try { reply = { id: c.id, result: await execute(c.cmd, c.args || {}) }; } catch (e) { reply = { id: c.id, error: e.message }; }
				await post('api/remote/result', reply).catch(() => {});
				setTimeout(() => { $('st-remote').textContent = ''; }, 2500);
			}
		} catch {
			pollFailures++;
			await new Promise(r => setTimeout(r, Math.min(10000, 500 * pollFailures)));
		}
	}
}

/** One command from outside: an editing command, or one of the page's own. */
export async function execute(cmd, args) {
	const page = pageCommands();
	if (page[cmd]) return page[cmd].run(args);
	if (COMMANDS[cmd]) return run(cmd, args, { quiet: true });
	throw new Error(`no command "${cmd}" -- "help" lists them`);
}

// ---- Start

function frame() {
	const R = E.renderer;
	const waterOn = R.show.water && R.waterCount && E.doc;
	if (E.redraw || waterOn) {
		R.render();
		drawLabels($('labels'), R, { selection: E.sel, hover: E.hover });
		E.redraw = false;
	}
	requestAnimationFrame(frame);
}

async function boot() {
	const R = new MapRenderer($('view'), E.assets);
	E.renderer = R;
	R.selection = E.sel;
	R.onchange = () => { E.redraw = true; };
	E.markers = new Markers(R, E.assets, E.tables);
	window.mapEditor = { E, run, execute, undo, redo, openMap, newMap, save, check, screenshot, bake, testInGame, commands: () => ({ ...Object.fromEntries(Object.entries(COMMANDS).map(([k, v]) => [k, v.describe])), ...Object.fromEntries(Object.entries(pageCommands()).map(([k, v]) => [k, v.describe])) }) };
	try { E.context = await get('api/context'); } catch { E.context = {}; }
	const v = $('view');
	v.addEventListener('pointerdown', onDown);
	v.addEventListener('pointermove', onMove);
	v.addEventListener('pointerup', onUp);
	v.addEventListener('pointercancel', onUp);
	v.addEventListener('wheel', onWheel, { passive: false });
	v.addEventListener('contextmenu', e => e.preventDefault());
	v.addEventListener('pointerleave', () => { if (!drag) { R.brush = null; E.redraw = true; } });
	window.addEventListener('keydown', onKey);
	window.addEventListener('keyup', onKey);
	window.addEventListener('resize', () => { E.redraw = true; });
	window.addEventListener('beforeunload', e => { if (E.dirty) { autosave(); e.preventDefault(); e.returnValue = ''; } });
	for (const b of document.querySelectorAll('#tools button')) b.onclick = () => setTool(b.dataset.tool);
	for (const box of document.querySelectorAll('#layers input[data-layer]')) box.onchange = () => { R.show[box.dataset.layer] = box.checked; if (box.dataset.layer === 'markers') rebuildMarkers(); E.redraw = true; };
	$('btn-undo').onclick = undo;
	$('btn-redo').onclick = redo;
	$('btn-open').onclick = () => openDialog(E);
	$('empty-open').onclick = () => openDialog(E);
	$('empty-new').onclick = () => newMapDialog(E);
	$('btn-save').onclick = () => save().catch(e => toast(e.message, true));
	$('btn-check').onclick = async () => { await check(); setTool('check'); };
	$('btn-test').onclick = () => testDialog(E);
	$('btn-top').onclick = () => { R.camera.pitch = R.camera.pitch > 85 ? 55 : 90; E.redraw = true; };
	$('btn-reset-view').onclick = () => E.doc && fitView();
	$('btn-shot').onclick = () => { if (!E.doc) return; const a = document.createElement('a'); a.href = screenshot(); a.download = `${E.doc.name}-${Date.now()}.png`; a.click(); };
	setInterval(() => { $('st-hint').textContent = E.doc ? HINTS[E.tool] || '' : ''; }, 500);
	setInterval(autosave, 60000);
	syncButtons();
	renderPanel(E);
	requestAnimationFrame(frame);
	pollRemote();
	const params = new URLSearchParams(location.search);
	try {
		if (params.get('new')) await newMap({ mod: params.get('mod'), name: params.get('new'), width: Number(params.get('width') || 80), height: Number(params.get('height') || 80) });
		else if (params.get('map')) await openMap({ mod: params.get('mod'), map: params.get('map'), as: params.get('as') || undefined });
		else await offerRecovery();
	} catch (e) { toast(e.message, true, 8000); }
	loadTables().catch(() => {});
}

boot();

export { cellToRsw, hostName, renderPanel };
