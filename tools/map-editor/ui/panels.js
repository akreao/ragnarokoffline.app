// The inspector on the right: each tool's options, and the selection.

import { h, field, seg, slider, rgbToHex, hexToRgb, debounce } from './dom.js';
import { decodeName } from '../lib/cp949.js';
import { rswToCell, SKY_PRESETS } from '../lib/commands.js';
import { lightColor } from '../lib/rsw.js';
import { getWater } from '../lib/map.js';
import { DIRECTIONS, displayName } from '../lib/script.js';
import { GAT_COLORS } from '../render/renderer.js';
import { modelBrowser, textureBrowser, spriteGrid, mobPicker, bgmBrowser, soundBrowser, textureThumb } from './browsers.js';

export const PANEL_TOOLS = ['select', 'sculpt', 'paint', 'walk', 'objects', 'gameplay', 'map', 'check'];

export const MAP_EFFECTS = [
	[47, 'Torch'], [690, 'Torch, red'], [691, 'Torch, green'], [45, 'Fireflies'], [946, 'Yellow flies'], [109, 'Bubbles'], [44, 'Smoke'],
	[693, 'Glow'], [701, 'Glow (cave)'], [324, 'Forest light'], [710, 'Green light'], [703, 'Circle of light'], [165, 'Sparkles'],
	[358, 'Ghost'], [110, 'Gas'], [689, 'Dust'], [821, 'Waterfall'], [838, 'Water below'], [231, 'Light pillar'], [199, 'Pong'],
];

let app = null;
const lazy = () => import('./app.js').then(m => { app = m; return m; });

function run(cmd, args) { return app.run(cmd, args); }

export function renderPanel(E) {
	if (!app) { lazy().then(() => renderPanel(E)); return; }
	const panel = document.getElementById('panel');
	const scroll = panel.scrollTop;
	panel.replaceChildren();
	if (!E.doc) {
		panel.append(h('h3', 'Map editor'), h('div.sec', h('p.muted', 'Open a map or make a new one to start.'), helpSection()));
		return;
	}
	const sel = [...E.sel];
	// A selection always shows its inspector first, whatever the tool.
	if (sel.length && ['select', 'objects', 'gameplay'].includes(E.tool)) panel.append(...selectionPanel(E, sel));
	const make = { select: selectPanel, sculpt: sculptPanel, paint: paintPanel, walk: walkPanel, objects: objectsPanel, gameplay: gameplayPanel, map: mapPanel, check: checkPanel }[E.tool];
	if (make) panel.append(...[].concat(make(E)));
	panel.scrollTop = scroll;
}

function rerender(E) { renderPanel(E); }

function helpSection() {
	const k = (key, what) => h('div', h('span.kbd', key), ' ', what);
	return h('div', h('h4', 'Moving around'), k('Right drag', 'turn the camera'), k('Shift + right drag / middle drag', 'pan'), k('Wheel', 'zoom'), k('W A S D, arrows', 'pan'), k('Q / E', 'turn'), k('T', 'top view'), k('Home', 'whole map'), k('F', 'frame the selection'),
		h('h4', 'Editing'), k('1 … 8', 'tools'), k('Ctrl+Z / Ctrl+Shift+Z', 'undo / redo'), k('Ctrl+S', 'save'), k('Ctrl+C / Ctrl+V', 'copy and paste objects, between maps too'), k('Ctrl+D', 'duplicate'), k('Delete', 'remove'), k('[ ]', 'turn the selection'), k('Alt + wheel', 'brush size'));
}

// ---- Select

function selectPanel(E) {
	if (E.sel.size) return [];
	const counts = { models: 0, lights: 0, sounds: 0, effects: 0 };
	for (const o of E.doc.rsw.objects) counts[['', 'models', 'lights', 'sounds', 'effects'][o.type]]++;
	const g = E.doc.gameplay;
	return [
		h('h3', 'Select'),
		h('div.sec',
			h('p.muted', 'Click a model, an NPC, a warp or a monster spawn to edit it. Drag on empty ground to select everything in a box.'),
			h('p', `${counts.models} models · ${counts.lights} lights · ${counts.sounds} sounds · ${counts.effects} effects`),
			h('p', `${g.npcs.length} NPCs · ${g.warps.length} warps · ${g.spawns.length} spawns`),
			field('Snap to cells', h('input', { type: 'checkbox', checked: E.opts.objects.snap, onchange: e => { E.opts.objects.snap = e.target.checked; } }))),
		h('div.sec', helpSection()),
	];
}

function selectionPanel(E, sel) {
	const objects = sel.filter(k => typeof k === 'number' && E.doc.rsw.objects[k]);
	const markers = sel.filter(k => typeof k === 'string');
	const out = [];
	if (objects.length === 1 && !markers.length) out.push(...objectInspector(E, objects[0]));
	else if (objects.length > 1) out.push(...multiInspector(E, objects));
	if (markers.length === 1 && !objects.length) out.push(...markerInspector(E, markers[0]));
	else if (markers.length > 1) out.push(h('h3', `${markers.length} markers selected`), h('div.sec', h('p.muted', 'Arrow keys move them a cell at a time; Delete removes them.'), h('button.btn.danger', { onclick: () => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete' })); } }, 'Delete')));
	return out;
}

const fmt = (v, d = 2) => (Math.round(v * 10 ** d) / 10 ** d).toString();

function numInput(value, onchange, step = 0.5, width) {
	return h('input', { type: 'number', step, value: fmt(value), style: width ? { width } : null, onchange: e => onchange(Number(e.target.value)) });
}

function objectInspector(E, index) {
	const o = E.doc.rsw.objects[index];
	const c = rswToCell(E.doc, o.position);
	const upd = args => run('object.update', { indexes: [index], ...args });
	const kind = ['', 'Model', 'Light', 'Sound', 'Effect'][o.type];
	const sec = h('div.sec',
		field('Position', numInput(c.x, v => upd({ x: v })), numInput(c.y, v => upd({ y: v }))),
		field('Height', numInput(c.height, v => upd({ height: v }), 0.25), h('button.btn.small', { onclick: () => upd({ ground: true }) }, 'On ground')),
		field('Name', h('input', { value: decodeName(o.name || ''), onchange: e => upd({ name: e.target.value }) })));
	if (o.type === 1) {
		sec.prepend(h('p', h('b', decodeName(o.file).split('\\').pop()), h('br'), h('span.muted', decodeName(o.file))));
		sec.append(
			field('Turn', ...slider(((o.rotation[1] % 360) + 360) % 360, 0, 359, 1, v => upd({ rotation: v }), v => `${Math.round(v)}°`)),
			field('Rotate x,y,z', h('input', { value: o.rotation.map(v => fmt(v, 1)).join(','), onchange: e => upd({ rotate: e.target.value }) })),
			field('Scale', h('input', { value: o.scale[0] === o.scale[1] && o.scale[1] === o.scale[2] ? fmt(o.scale[0], 3) : o.scale.map(v => fmt(v, 3)).join(','), onchange: e => upd({ scale: e.target.value }) })),
		);
	} else if (o.type === 2) {
		sec.append(
			field('Colour', h('input', { type: 'color', value: rgbToHex(lightColor(o)), onchange: e => upd({ color: e.target.value }) })),
			field('Range', numInput(o.range / 5, v => upd({ range: v }), 1)),
			h('p.hint', 'Point lights colour the ground when the lightmaps are baked (Map → Bake lightmaps).'));
	} else if (o.type === 3) {
		sec.append(field('Sound', h('input', { value: decodeName(o.file), onchange: e => upd({ file: e.target.value }) })), field('Volume', numInput(o.volume, v => upd({ volume: v }), 0.05)), field('Range', numInput(o.range / 5, v => upd({ range: v }), 1)), field('Every', numInput(o.cycle, v => upd({ cycle: v }), 0.5), h('span.muted', 's')));
	} else if (o.type === 4) {
		sec.append(field('Effect', h('select', { onchange: e => { o.id = Number(e.target.value); app.setDirty(); app.rebuildMarkers(); } }, MAP_EFFECTS.map(([id, label]) => h('option', { value: id, selected: id === o.id ? true : null }, `${label} (${id})`)), MAP_EFFECTS.some(x => x[0] === o.id) ? null : h('option', { value: o.id, selected: true }, `effect ${o.id}`))));
	}
	return [
		h('h3', `${kind} #${index}`), sec,
		h('div.sec.row',
			h('button.btn', { onclick: () => { const r = run('object.duplicate', { indexes: [index] }); E.sel = new Set(r.indexes); E.renderer.selection = E.sel; rerender(E); } }, 'Duplicate'),
			h('button.btn', { onclick: () => { E.clipboard = run('object.copy', { indexes: [index] }); try { localStorage.setItem('map-editor:clipboard', JSON.stringify(E.clipboard)); } catch { /* */ } app.toast('Copied. Ctrl+V pastes it under the cursor, on this map or another.'); } }, 'Copy'),
			o.type === 1 ? h('button.btn', { onclick: () => { E.opts.objects.model = decodeName(o.file); E.opts.objects.mode = 'model'; app.setTool('objects'); } }, 'Place more') : null,
			h('button.btn.danger', { onclick: () => { run('object.remove', { indexes: [index] }); E.sel.clear(); rerender(E); } }, 'Delete')),
	];
}

function multiInspector(E, idx) {
	const align = (axis, to) => run('object.align', { indexes: idx, axis, to });
	return [
		h('h3', `${idx.length} objects selected`),
		h('div.sec',
			field('Line up x', h('div.row', ['min', 'average', 'max', 'spread'].map(t => h('button.btn.small', { onclick: () => align('x', t) }, t)))),
			field('Line up y', h('div.row', ['min', 'average', 'max', 'spread'].map(t => h('button.btn.small', { onclick: () => align('y', t) }, t)))),
			field('Same height', h('div.row', ['min', 'average', 'max'].map(t => h('button.btn.small', { onclick: () => align('height', t) }, t)))),
			field('Turn all', h('button.btn.small', { onclick: () => run('object.move', { indexes: idx, rotate: -15 }) }, '−15°'), h('button.btn.small', { onclick: () => run('object.move', { indexes: idx, rotate: 15 }) }, '+15°'))),
		h('div.sec.row',
			h('button.btn', { onclick: () => { const r = run('object.duplicate', { indexes: idx }); E.sel = new Set(r.indexes); E.renderer.selection = E.sel; rerender(E); } }, 'Duplicate'),
			h('button.btn', { onclick: () => { E.clipboard = run('object.copy', { indexes: idx }); try { localStorage.setItem('map-editor:clipboard', JSON.stringify(E.clipboard)); } catch { /* */ } app.toast(`Copied ${idx.length} objects.`); } }, 'Copy'),
			h('button.btn', { onclick: () => savePrefab(E, idx) }, 'Save as prefab'),
			h('button.btn.danger', { onclick: () => { run('object.remove', { indexes: idx }); E.sel.clear(); rerender(E); } }, 'Delete')),
	];
}

async function savePrefab(E, idx) {
	const name = await app.ask({ title: 'Save as a prefab', text: 'A prefab is a group of objects you can stamp on any map. Name it:', input: 'house', ok: 'Save' });
	if (!name) return;
	const clip = app.run('object.copy', { indexes: idx });
	const { get, post } = await import('./host.js');
	const prefabs = await get('api/prefabs').catch(() => []);
	const list = prefabs.filter(p => p.name !== name).concat({ name, clip, at: Date.now() });
	await post('api/prefabs', { prefabs: list });
	E.prefabs = list;
	app.toast(`Saved the prefab "${name}". Objects → Prefabs places it.`);
}

// ---- Markers (NPCs, warps, spawns, signs)

function findMarker(E, key) {
	const [kind, id] = key.split(/:(.*)/);
	if (kind === 'sign') return { kind, obj: E.doc.gameplay.signboards[Number(id)] };
	if (kind === 'start') return { kind, obj: E.doc.testPoint };
	const list = kind === 'npc' ? E.doc.gameplay.npcs : kind === 'warp' ? E.doc.gameplay.warps : E.doc.gameplay.spawns;
	return { kind, obj: list.find(o => o.id === id) };
}

function markerInspector(E, key) {
	const { kind, obj } = findMarker(E, key);
	if (!obj) return [];
	const upd = args => run('marker.update', { id: obj.id, ...args });
	const pos = field('Position', numInput(obj.x, v => upd({ x: v }), 1), numInput(obj.y, v => upd({ y: v }), 1));
	const remove = h('button.btn.danger', { onclick: () => { run('marker.remove', { id: obj.id }); E.sel.clear(); rerender(E); } }, 'Delete');
	const hand = obj.handwritten ? h('p.warnbox', `Written by hand in ${obj.file}. Moving it or changing its look rewrites only its first line there; its script is left as it is.`) : null;
	if (kind === 'npc') {
		const sec = h('div.sec', hand, pos,
			field('Name', h('input', { value: obj.name, onchange: e => upd({ name: e.target.value }) })),
			field('Facing', h('select', { onchange: e => upd({ dir: Number(e.target.value) }) }, DIRECTIONS.map((d, i) => h('option', { value: i, selected: (obj.dir | 0) === i ? true : null }, `${i} ${d}`)))),
			field('Sprite', h('input', { value: obj.sprite, onchange: e => upd({ sprite: e.target.value }) })));
		if (!obj.handwritten) sec.append(field('Kind', seg([['script', 'Script'], ['sign', 'Sign'], ['healer', 'Healer'], ['warper', 'Warper'], ['shop', 'Shop']], obj.kind, k => upd({ kind: k, ...(k === 'shop' && !obj.items ? { items: '501,502,503' } : {}), ...(k === 'warper' && !obj.destinations ? { destinations: 'prontera:156:191:Prontera' } : {}) }))));
		if (obj.kind === 'sign' || obj.kind === 'healer' || obj.kind === 'warper') sec.append(h('div', h('label.muted', obj.kind === 'sign' ? 'What it says (one line each)' : 'What it says first'), h('textarea', { rows: 3, value: obj.text || '', onchange: e => upd({ text: e.target.value }) })));
		if (obj.kind === 'shop') sec.append(shopEditor(E, obj, upd));
		if (obj.kind === 'warper') sec.append(h('div', h('label.muted', 'Destinations: map:x:y:Label, one per line'), h('textarea', { rows: 4, value: (obj.destinations || []).map(d => `${d.map}:${d.x}:${d.y}:${d.label || d.map}`).join('\n'), onchange: e => upd({ destinations: e.target.value.split('\n').map(s => s.trim()).filter(Boolean).join(',') }) })));
		if (obj.kind === 'script') {
			sec.append(h('p.hint', obj.handwritten ? 'Its script is in the file above.' : `Talking to it runs ${obj.fn || 'its function'}() in npc/${E.doc.name}_dialogue.txt — yours to write in any text editor. Save once to create it from a template.`));
			if (!obj.handwritten) sec.append(h('button.btn', { onclick: () => openDialogue(E, obj) }, 'Edit dialogue…'));
		}
		sec.append(field('Touch area', h('input', { placeholder: 'none, or xs,ys', value: obj.touch ? `${obj.touch.xs},${obj.touch.ys}` : '', onchange: e => upd({ touch: e.target.value || 'none' }) })));
		const sb = E.doc.gameplay.signboards.find(s => s.x === obj.x && s.y === obj.y);
		sec.append(field('Icon over it', h('select', { onchange: e => run('signboard.set', e.target.value ? { x: obj.x, y: obj.y, icon: e.target.value, type: 1 } : { x: obj.x, y: obj.y, remove: true }) }, [['', 'none'], ['information\\over_kafra.bmp', 'Kafra'], ['information\\over_store.bmp', 'Tool shop'], ['information\\over_weaponshop.bmp', 'Weapons'], ['information\\over_armorshops.bmp', 'Armour'], ['information\\over_inn.bmp', 'Inn'], ['information\\over_guide.bmp', 'Guide'], ['information\\over_nmtrade.bmp', 'Trader']].map(([v, l]) => h('option', { value: v, selected: (sb ? sb.icon : '') === v ? true : null }, l)))));
		return [h('h3', `NPC: ${displayName(obj.name)}`), sec, h('div.sec.row', h('button.btn', { onclick: () => app.focusSelection() }, 'Frame'), remove)];
	}
	if (kind === 'warp') {
		return [h('h3', 'Warp'), h('div.sec', hand, pos,
			field('Size', numInput(obj.xs, v => upd({ xs: v }), 1, '56px'), numInput(obj.ys, v => upd({ ys: v }), 1, '56px'), h('span.muted', 'cells each side')),
			field('Name', h('input', { value: obj.name, onchange: e => upd({ name: e.target.value }) })),
			field('To map', mapSelect(E, obj.dest.map, v => upd({ map: v }))),
			field('At', numInput(obj.dest.x, v => upd({ dx: v }), 1), numInput(obj.dest.y, v => upd({ dy: v }), 1), h('button.btn.small', { onclick: () => pickDestination(E, obj.dest.map, (map, x, y) => upd({ map, dx: x, dy: y })) }, 'Pick…'))),
		h('div.sec.row', h('button.btn', { onclick: () => app.focusSelection() }, 'Frame'), remove)];
	}
	if (kind === 'spawn') {
		const anywhere = obj.x === 0 && obj.y === 0 && obj.xs === 0 && obj.ys === 0;
		return [h('h3', 'Monsters'), h('div.sec', hand,
			mobPicker(E, obj.mob, id => upd({ mob: id })),
			field('How many', numInput(obj.amount, v => upd({ amount: v }), 1)),
			field('Respawn', numInput(obj.delay1, v => upd({ delay: v }), 1000), h('span.muted', 'ms')),
			field('Kind', seg([['monster', 'Normal'], ['miniboss_monster', 'Mini-boss'], ['boss_monster', 'Boss']], obj.kind, k => upd({ kind: k }))),
			field('Where', h('label', h('input', { type: 'checkbox', checked: anywhere, onchange: e => upd(e.target.checked ? { x: 0, y: 0, xs: 0, ys: 0 } : { x: Math.floor(E.doc.gat.width / 2), y: Math.floor(E.doc.gat.height / 2), xs: 5, ys: 5 }) }), ' anywhere on the map')),
			anywhere ? null : pos,
			anywhere ? null : field('Area', numInput(obj.xs, v => upd({ xs: v }), 1, '56px'), numInput(obj.ys, v => upd({ ys: v }), 1, '56px'), h('span.muted', 'cells each side')),
			density(E, obj)),
		h('div.sec.row', h('button.btn', { onclick: () => app.focusSelection() }, 'Frame'), remove)];
	}
	if (kind === 'sign') {
		const s = obj;
		return [h('h3', 'Sign over a cell'), h('div.sec', field('Cell', `${s.x}, ${s.y}`), field('Icon', h('input', { value: s.icon, onchange: e => run('signboard.set', { x: s.x, y: s.y, icon: e.target.value, type: s.type, caption: s.caption }) })), field('Caption', h('input', { value: s.caption, onchange: e => run('signboard.set', { x: s.x, y: s.y, icon: s.icon, type: e.target.value ? 3 : 1, caption: e.target.value }) }))), h('div.sec', h('button.btn.danger', { onclick: () => { run('signboard.set', { x: s.x, y: s.y, remove: true }); E.sel.clear(); rerender(E); } }, 'Delete'))];
	}
	if (kind === 'start') return [h('h3', 'Test start point'), h('div.sec', h('p', `Test in game puts your character at ${obj.x}, ${obj.y}.`))];
	return [];
}

function density(E, s) {
	if (s.xs === 0 && s.ys === 0) return h('p.hint', `${s.amount} over the whole map.`);
	const area = (s.xs * 2 + 1) * (s.ys * 2 + 1);
	return h('p.hint', `${s.amount} in ${area} cells: one per ${(area / s.amount).toFixed(1)} cells.`);
}

function shopEditor(E, obj, upd) {
	const items = obj.items || [];
	// Names come from the server's item table, read the first time a shop is shown.
	if (!E.tables.items && !E._itemsLoading) {
		E._itemsLoading = import('./host.js').then(({ get }) => get('api/tables/items')).then(list => { E.tables.items = list; rerender(E); }).catch(() => { E.tables.items = []; });
	}
	const byId = new Map((E.tables.items || []).map(i => [i.id, i]));
	const box = h('div');
	const line = (it, i) => {
		const info = byId.get(Number(it.id));
		return h('div.row', { style: { margin: '2px 0' } },
			h('input', { value: it.id, style: { width: '70px' }, onchange: e => { items[i] = { ...it, id: Number(e.target.value) || e.target.value }; upd({ items: items.slice() }); } }),
			h('span', { style: { flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, info ? info.name : ''),
			h('input', { type: 'number', value: it.price ?? -1, style: { width: '74px' }, title: 'Price; -1 is the item\'s own', onchange: e => { items[i] = { ...it, price: Number(e.target.value) }; upd({ items: items.slice() }); } }),
			h('button.btn.small', { onclick: () => { items.splice(i, 1); upd({ items: items.slice() }); } }, '×'));
	};
	box.append(h('label.muted', 'Sells (item id, price; -1 is its own price)'), ...items.map(line));
	const search = h('input', { placeholder: 'Add: search items by name or id', style: { width: '100%', marginTop: '4px' } });
	const results = h('div.list');
	const find = debounce(async () => {
		if (!E.tables.items) { const { get } = await import('./host.js'); E.tables.items = await get('api/tables/items').catch(() => []); }
		const q = search.value.trim().toLowerCase();
		results.replaceChildren(...(q ? E.tables.items.filter(i => String(i.id) === q || i.name.toLowerCase().includes(q) || i.aegis.toLowerCase().includes(q)).slice(0, 40) : []).map(i => h('div.li', { onclick: () => { items.push({ id: i.id, price: -1 }); upd({ items: items.slice() }); } }, `${i.name}`, h('small', `${i.id} · ${i.buy}z`))));
	});
	search.oninput = find;
	box.append(search, results);
	return box;
}

function mapSelect(E, current, onpick) {
	const list = E.tables.maps || [];
	const input = h('input', { value: current, list: 'map-names', onchange: e => onpick(e.target.value.trim().toLowerCase()) });
	if (!document.getElementById('map-names')) document.body.append(h('datalist#map-names', list.map(m => h('option', { value: m.map }, m.name ? `${m.map} — ${m.name}` : m.map))));
	return input;
}

async function pickDestination(E, map, done) {
	const { destinationPicker } = await import('./dialogs.js');
	destinationPicker(E, map, done);
}

async function openDialogue(E, npc) {
	if (E.dirty || !E.project || !E.project.scripts[`npc/${E.doc.name}_dialogue.txt`] || !(E.project.scripts[`npc/${E.doc.name}_dialogue.txt`] || '').includes(npc.fn)) await app.save({ silent: true });
	const { post } = await import('./host.js');
	try {
		const r = await post('api/host/open-file', { mod: E.mod, path: `npc/${E.doc.name}_dialogue.txt` });
		app.toast(r.message || `Opened npc/${E.doc.name}_dialogue.txt. Edit ${npc.fn}, save the file, then Test in game.`);
	} catch (e) {
		app.toast(`The dialogue is in mods/${E.mod}/npc/${E.doc.name}_dialogue.txt (function ${npc.fn}). ${e.message}`, false, 8000);
	}
}

// ---- Sculpt

function sculptPanel(E) {
	const o = E.opts.sculpt;
	const mode = o.mode || 'brush';
	const secs = [h('h3', 'Sculpt the ground'), h('div.sec', field('Mode', seg([['brush', 'Brush'], ['area', 'Area'], ['walls', 'Walls']], mode, m => { o.mode = m; rerender(E); })))];
	if (mode === 'brush') {
		secs.push(h('div.sec',
			seg([['raise', 'Raise'], ['lower', 'Lower'], ['smooth', 'Smooth'], ['flatten', 'Flatten'], ['set', 'Set'], ['noise', 'Rough']], o.tool, t => { o.tool = t; rerender(E); }),
			field('Size', ...slider(o.radius, 0.5, 30, 0.5, v => { o.radius = v; }, v => `${v}`)),
			field('Strength', ...slider(o.strength, 0.2, 12, 0.2, v => { o.strength = v; }, v => `${v.toFixed(1)}/s`)),
			['set', 'flatten'].includes(o.tool) ? field('Height', numInput(o.height, v => { o.height = v; }, 0.5), h('span.muted', 'cells up · Alt+click picks')) : null,
			field('Edge', seg([['smooth', 'Soft'], ['hard', 'Hard']], o.falloff, f => { o.falloff = f; rerender(E); })),
			h('p.hint', 'Hold Shift to do the opposite, Ctrl to smooth. Walkability follows the ground: steep slopes become blocked, unless you painted those cells by hand.')));
	} else if (mode === 'area') {
		o.area = o.area || { op: 'set', height: 2, to: 0, direction: 'north' };
		const a = o.area;
		secs.push(h('div.sec',
			h('p.muted', 'Drag a rectangle on the map, then:'),
			seg([['set', 'Plateau'], ['raise', 'Raise'], ['lower', 'Lower'], ['ramp', 'Ramp'], ['smooth', 'Smooth']], a.op, v => { a.op = v; rerender(E); }),
			field(a.op === 'ramp' ? 'From' : a.op === 'set' ? 'Height' : 'By', numInput(a.height, v => { a.height = v; }, 0.5), h('span.muted', 'cells')),
			a.op === 'ramp' ? field('To', numInput(a.to, v => { a.to = v; }, 0.5)) : null,
			a.op === 'ramp' ? field('Reaching it to the', seg([['north', 'N'], ['south', 'S'], ['east', 'E'], ['west', 'W']], a.direction, v => { a.direction = v; rerender(E); })) : null,
			h('p.hint', 'A plateau has hard edges: a cliff, with wall faces made for you. Ramps and smoothing keep it walkable.')));
	} else {
		secs.push(h('div.sec',
			h('p.muted', 'Where two cubes meet at different heights the ground needs a face, or there is a gap. These are made for you by Area and can be redone here.'),
			field('Texture', textureSelect(E, o.wallTexture, v => { o.wallTexture = v; })),
			h('div.row', h('button.btn', { onclick: () => run('walls.auto', o.wallTexture !== undefined && o.wallTexture !== '' ? { texture: o.wallTexture } : {}) }, 'Make walls everywhere')),
			h('p.hint', 'Paint → Surface: walls changes an existing wall\'s texture.')));
	}
	secs.push(h('div.sec', h('h4', 'One corner'), h('p.hint', 'For sharp edges: set one corner of one cube. Cube = half the cell numbers.'), cornerForm(E)));
	return secs;
}

function cornerForm(E) {
	const f = { cx: 0, cy: 0, corner: 0, height: 0 };
	return h('div',
		field('Cube', numInput(0, v => { f.cx = v; }, 1, '60px'), numInput(0, v => { f.cy = v; }, 1, '60px')),
		field('Corner', h('select', { onchange: e => { f.corner = Number(e.target.value); } }, ['south-west', 'south-east', 'north-west', 'north-east'].map((n, i) => h('option', { value: i }, n)))),
		field('Height', numInput(0, v => { f.height = v; }, 0.5), h('button.btn.small', { onclick: () => run('terrain.corner', f) }, 'Set')));
}

function textureSelect(E, current, onpick) {
	return h('select', { onchange: e => onpick(e.target.value) }, h('option', { value: '' }, 'the ground\'s own'), E.doc.gnd.textures.map((t, i) => h('option', { value: i, selected: String(current) === String(i) ? true : null }, `${i}: ${decodeName(t)}`)));
}

// ---- Paint

function paintPanel(E) {
	const o = E.opts.paint;
	const textures = E.doc.gnd.textures;
	if (o.texture >= textures.length) o.texture = 0;
	const palette = h('div.grid-list', textures.map((t, i) => {
		const item = h('div.item', { class: `item${i === o.texture ? ' on' : ''}`, title: decodeName(t), onclick: () => { o.texture = i; rerender(E); } }, textureThumb(E, decodeName(t)), h('div', `${i} ${decodeName(t).split('\\').pop()}`));
		return item;
	}));
	return [
		h('h3', 'Paint the ground'),
		h('div.sec', h('h4', 'This map\'s textures'), palette, h('div.row', { style: { marginTop: '6px' } }, h('button.btn', { onclick: () => { o.browse = !o.browse; rerender(E); } }, o.browse ? 'Close the browser' : 'Add a texture from your client…'))),
		o.browse ? h('div.sec', textureBrowser(E, path => { const r = run('texture.add', { path }); o.texture = r.index; o.browse = false; rerender(E); })) : null,
		h('div.sec',
			field('Mode', seg([['brush', 'Brush'], ['rect', 'Rectangle']], o.mode, m => { o.mode = m; rerender(E); })),
			o.mode === 'brush' ? field('Size', ...slider(o.radius, 0.5, 30, 0.5, v => { o.radius = v; })) : null,
			field('Surface', seg([['top', 'Ground'], ['walls', 'Walls'], ['both', 'Both']], o.surface, s => { o.surface = s; rerender(E); })),
			field('Repeat every', seg([[1, '1'], [2, '2'], [4, '4'], [8, '8']], o.span, s => { o.span = s; rerender(E); }), h('span.muted', 'cubes')),
			field('Turn', seg([[0, '0°'], [1, '90°'], [2, '180°'], [3, '270°']], o.rotate, r => { o.rotate = r; rerender(E); })),
			field('Mirror', h('label', h('input', { type: 'checkbox', checked: o.flipX, onchange: e => { o.flipX = e.target.checked; } }), ' east-west'), h('label', h('input', { type: 'checkbox', checked: o.flipY, onchange: e => { o.flipY = e.target.checked; } }), ' north-south')),
			h('p.hint', 'Alt+click picks the texture under the cursor; R turns it.')),
		h('div.sec', h('h4', 'Tint'), field('Colour', h('input', { type: 'color', value: o.tint || '#ffffff', onchange: e => { o.tint = e.target.value; } }), h('button.btn.small', { onclick: () => { const c = E.lastCell; if (!c) return; run('texture.color', { color: o.tint || '#ffffff', x: c.x, y: c.y, radius: o.radius }); } }, 'Tint under cursor')), h('p.hint', 'The client multiplies the ground by this colour: darker paths, warmer sand.')),
	];
}

// ---- Walkability

function walkPanel(E) {
	const o = E.opts.walk;
	const types = [[0, 'Walkable'], [1, 'Blocked'], [3, 'Water'], [5, 'Cliff']];
	const sw = t => h('span.swatch', { style: { background: rgbToHex(GAT_COLORS[t]) } });
	return [
		h('h3', 'Walkability'),
		h('div.sec',
			h('p.muted', 'What the server lets players walk on (.gat). It follows the ground by itself; paint here to fix it by hand. Painted cells stay as painted.'),
			h('div.seg', types.map(([t, label]) => h('button', { type: 'button', class: o.type === t ? 'on' : '', onclick: () => { o.type = t; rerender(E); } }, sw(t), ' ', label))),
			field('Mode', seg([['brush', 'Brush'], ['rect', 'Rectangle']], o.mode, m => { o.mode = m; rerender(E); })),
			o.mode === 'brush' ? field('Size', ...slider(o.radius, 0.5, 20, 0.5, v => { o.radius = v; })) : null,
			h('p.hint', 'Cliff: you can shoot or cast over it but not walk on it. Water: walkable, and rAthena treats it as water.')),
		h('div.sec', h('h4', 'From the ground'),
			field('Steepest', ...slider(o.slope ?? 1.5, 0.25, 5, 0.25, v => { o.slope = v; }, v => v.toFixed(2))),
			h('div.row', h('button.btn', { onclick: () => run('gat.auto', { slope: o.slope ?? 1.5 }) }, 'Work it out again'), h('button.btn', { onclick: () => { if (confirm('Forget every hand-painted cell and work all of it out from the ground?')) run('gat.auto', { slope: o.slope ?? 1.5, force: true }); } }, 'Including painted cells'))),
	];
}

// ---- Objects

function objectsPanel(E) {
	const o = E.opts.objects;
	const out = [h('h3', 'Objects'), h('div.sec', seg([['model', 'Models'], ['light', 'Lights'], ['sound', 'Sounds'], ['effect', 'Effects'], ['prefab', 'Prefabs'], ['paste', 'Paste']], o.mode, m => { o.mode = m; rerender(E); }))];
	if (o.mode === 'model') {
		out.push(h('div.sec',
			o.model ? h('p', 'Placing ', h('b', o.model.split('\\').pop()), h('span.muted', ' — click the map.')) : h('p.muted', 'Pick a model, then click on the map to place it.'),
			field('Turn', ...slider(o.rotation, 0, 359, 15, v => { o.rotation = v; }, v => `${v}°`)),
			field('Scale', numInput(o.scale, v => { o.scale = v; }, 0.1))),
		h('div.sec', modelBrowser(E, path => { o.model = path; rerender(E); })));
	} else if (o.mode === 'light') {
		out.push(h('div.sec', h('p.muted', 'Click to place a point light. Its colour reaches the ground when the lightmaps are baked (Map → Bake).'),
			field('Colour', h('input', { type: 'color', value: o.lightColor || '#ffcc88', onchange: e => { o.lightColor = e.target.value; } })),
			field('Range', numInput(o.lightRange || 8, v => { o.lightRange = v; }, 1), h('span.muted', 'cells')),
			field('Height', numInput(o.lightHeight || 3, v => { o.lightHeight = v; }, 0.5), h('span.muted', 'cells above the ground'))));
	} else if (o.mode === 'sound') {
		out.push(h('div.sec', h('p.muted', 'An ambient sound: water, wind, birds. Pick one, then click the map.'),
			field('Volume', numInput(o.volume ?? 0.8, v => { o.volume = v; }, 0.05)), field('Range', numInput(o.soundRange || 20, v => { o.soundRange = v; }, 1)), field('Every', numInput(o.cycle || 4, v => { o.cycle = v; }, 0.5), h('span.muted', 'seconds'))),
		h('div.sec', soundBrowser(E, file => { o.sound = file; rerender(E); })));
	} else if (o.mode === 'effect') {
		out.push(h('div.sec', h('p.muted', 'Effects from the client\'s list, as official maps use them. Pick one, then click.'),
			h('div.list', MAP_EFFECTS.map(([id, label]) => h('div.li', { class: `li${o.effect === id ? ' on' : ''}`, onclick: () => { o.effect = id; rerender(E); } }, label, h('small', `#${id}`)))),
			field('Other id', numInput(o.effect, v => { o.effect = v; }, 1)),
			field('Height', numInput(o.effectHeight || 0, v => { o.effectHeight = v; }, 0.5))));
	} else if (o.mode === 'prefab') {
		const list = h('div.list', h('div.li.muted', 'Loading…'));
		import('./host.js').then(({ get }) => get('api/prefabs')).then(prefabs => {
			E.prefabs = prefabs;
			list.replaceChildren(...(prefabs.length ? prefabs.map(p => h('div.li', { onclick: () => { E.clipboard = p.clip; o.mode = 'paste'; rerender(E); app.toast(`Click the map to place "${p.name}".`); } }, p.name, h('small', `${p.clip.objects.length} objects · from ${p.clip.from}`))) : [h('div.li.muted', 'No prefabs yet. Select several objects and press "Save as prefab".')]));
		}).catch(() => {});
		out.push(h('div.sec', h('p.muted', 'Groups of objects saved from any map — a house with its fence and lamps.'), list));
	} else if (o.mode === 'paste') {
		out.push(h('div.sec', E.clipboard ? h('p', `Click to paste ${E.clipboard.objects.length} objects from ${E.clipboard.from}.`) : h('p.muted', 'Nothing copied yet. Select objects on any map and press Ctrl+C, or use "Copy an area" below.'),
			h('h4', 'Copy an area from another map'),
			h('p.hint', 'Open the other map (an official one too), drag a box around what you want in Select, Ctrl+C, then come back here and Ctrl+V. The clipboard survives switching maps.')));
	}
	return out;
}

// ---- Gameplay

function gameplayPanel(E) {
	const o = E.opts.gameplay;
	const out = [h('h3', 'Gameplay'), h('div.sec', seg([['npc', 'NPC'], ['warp', 'Warp'], ['spawn', 'Monsters'], ['sign', 'Sign'], ['start', 'Start'], ['population', 'AI']], o.mode, m => { o.mode = m; rerender(E); }))];
	if (o.mode === 'npc') {
		out.push(h('div.sec',
			field('Kind', seg([['script', 'Script'], ['sign', 'Sign'], ['healer', 'Healer'], ['warper', 'Warper'], ['shop', 'Shop']], o.kind, k => { o.kind = k; rerender(E); })),
			field('Name', h('input', { value: o.name || '', placeholder: 'shown over its head', onchange: e => { o.name = e.target.value; } })),
			field('Facing', h('select', { onchange: e => { o.dir = Number(e.target.value); } }, DIRECTIONS.map((d, i) => h('option', { value: i, selected: (o.dir ?? 4) === i ? true : null }, d)))),
			h('p.hint', { script: 'Calls a function in npc/<map>_dialogue.txt, made from a template the first time: write its dialogue in any text editor.', sign: 'Says a few lines and closes.', healer: 'Heals fully when talked to.', warper: 'Offers a list of places and warps there.', shop: 'Sells items at their own price, or yours.' }[o.kind]),
			h('p.muted', 'Click the map to place it.')),
		h('div.sec', h('h4', 'Sprite'), spriteGrid(E, o.sprite, s => { o.sprite = s; rerender(E); })));
	} else if (o.mode === 'warp') {
		out.push(h('div.sec', h('p.muted', 'Drag the portal\'s area on the map. It sends players to:'),
			field('Map', mapSelect(E, o.destMap || 'prontera', v => { o.destMap = v; })),
			field('Cell', numInput(o.destX ?? 156, v => { o.destX = v; }, 1), numInput(o.destY ?? 191, v => { o.destY = v; }, 1), h('button.btn.small', { onclick: () => pickDestination(E, o.destMap || 'prontera', (map, x, y) => { o.destMap = map; o.destX = x; o.destY = y; rerender(E); }) }, 'Pick…')),
			h('p.hint', 'Two-way: select the warp after placing it and use "Way back" — or place a second warp on this map.'),
			h('button.btn', { onclick: () => {
				const last = E.doc.gameplay.warps.at(-1);
				if (!last) return app.toast('Place a warp first.', true);
				run('marker.remove', { id: last.id });
				run('warp.add', { x: last.x, y: last.y, xs: last.xs, ys: last.ys, map: last.dest.map, dx: last.dest.x, dy: last.dest.y, twoWay: true });
			} }, 'Make the last warp two-way')));
	} else if (o.mode === 'spawn') {
		out.push(h('div.sec', h('p.muted', 'Drag the area they wander in.'),
			mobPicker(E, o.mob, id => { o.mob = id; rerender(E); }),
			field('How many', numInput(o.amount, v => { o.amount = v; }, 1)),
			field('Respawn', numInput(o.delay, v => { o.delay = v; }, 1000), h('span.muted', 'ms')),
			h('button.btn', { onclick: () => run('spawn.add', { mob: o.mob, amount: o.amount, delay: o.delay }) }, 'Anywhere on the map instead')));
	} else if (o.mode === 'sign') {
		out.push(h('div.sec', h('p.muted', 'An icon or a board over a cell — usually an NPC\'s. Click the cell.'),
			field('Icon', h('input', { value: o.icon || 'information\\over_store.bmp', onchange: e => { o.icon = e.target.value; } })),
			field('Caption', h('input', { value: o.caption || '', placeholder: 'empty: icon only', onchange: e => { o.caption = e.target.value; o.signType = e.target.value ? 3 : 1; } }))));
	} else if (o.mode === 'start') {
		out.push(h('div.sec', h('p.muted', 'Click where Test in game should put your character.'), E.doc.testPoint ? h('p', `Now: ${E.doc.testPoint.x}, ${E.doc.testPoint.y}`) : null));
	} else if (o.mode === 'population') {
		const p = E.doc.gameplay.population || { profile: 'combat_pve_low', category: 'Fields', count: 0, maxPerMap: 0 };
		const f = { ...p };
		out.push(h('div.sec', h('p.muted', 'Let the AI characters (Settings → Fake players) live here too.'),
			field('As a', seg([['Towns', 'Town'], ['Fields', 'Field'], ['Dungeons', 'Dungeon']], f.category, c => { f.category = c; run('population.set', { ...f, count: f.count || 8 }); })),
			field('Profile', h('select', { onchange: e => { f.profile = e.target.value; } }, ['combat_pve_low', 'combat_pve_mid', 'combat_pve_high', 'novice_default', 'merchant_town', 'social_town'].map(n => h('option', { value: n, selected: n === f.profile ? true : null }, n)))),
			field('Characters', numInput(f.count, v => { f.count = v; }, 1)),
			h('div.row', h('button.btn', { onclick: () => run('population.set', { ...f, maxPerMap: f.count }) }, 'Set'), p.count ? h('button.btn', { onclick: () => run('population.set', { ...f, count: 0 }) }, 'None') : null),
			h('p.hint', 'Written to the mod\'s db/population_spawn.yml with the …Add forms, so the stock table is kept.')));
	}
	out.push(h('div.sec', h('h4', 'On this map'), gameplayList(E)));
	return out;
}

function gameplayList(E) {
	const rows = [];
	const g = E.doc.gameplay;
	const row = (key, label, sub, m) => h('div.li', { class: `li${E.sel.has(key) ? ' on' : ''}`, onclick: () => { E.sel = new Set([key]); E.renderer.selection = E.sel; app.focusOn(m.x, m.y, Math.max(30, E.renderer.camera.distance * 0.6)); rerender(E); } }, label, h('small', sub));
	for (const n of g.npcs) rows.push(row(`npc:${n.id}`, `☺ ${displayName(n.name)}`, `${n.kind}${n.handwritten ? ' ✎' : ''} · ${n.x},${n.y}`, n));
	for (const w of g.warps) rows.push(row(`warp:${w.id}`, `⟳ ${w.dest.map}`, `${w.x},${w.y} → ${w.dest.x},${w.dest.y}`, w));
	for (const s of g.spawns) rows.push(row(`spawn:${s.id}`, `✕ ${s.mob} ×${s.amount}`, s.xs || s.ys ? `${s.x},${s.y} ±${s.xs},${s.ys}` : 'anywhere', s));
	return rows.length ? h('div.list', rows) : h('p.muted', 'Nothing yet.');
}

// ---- Map

function mapPanel(E) {
	if (!E.doc) return [h('h3', 'Map')];
	const doc = E.doc, p = doc.props, l = doc.rsw.light;
	const water = getWater(doc) || { level: 1000, type: 0, waveHeight: 1, waveSpeed: 2, wavePitch: 50, animSpeed: 3 };
	const liveLight = (key, value, commit) => {
		if (!commit) { doc.rsw.light[key] = value; E.redraw = true; return; }
		const was = E.history.undoStack.length;
		void was;
		run('light.global', { [key]: Array.isArray(value) ? rgbToHex(value) : value });
	};
	const sky = p.sky ? rgbToHex(p.sky) : '#000000';
	return [
		h('h3', 'Map'),
		h('div.sec', h('h4', 'Name and size'),
			field('Name', h('input', { value: doc.name, maxlength: 11, onchange: e => { try { run('map.rename', { name: e.target.value.trim() }); } catch { e.target.value = doc.name; } } })),
			field('Display name', h('input', { value: p.displayName || '', placeholder: 'shown in the game', onchange: e => run('props.set', { displayName: e.target.value }) })),
			field('Size', h('span', `${doc.gat.width} × ${doc.gat.height} cells`)),
			field('Resize to', numInput(doc.gat.width, v => { E._rw = v; }, 2, '64px'), numInput(doc.gat.height, v => { E._rh = v; }, 2, '64px'), h('button.btn.small', { onclick: () => run('map.resize', { width: E._rw || doc.gat.width, height: E._rh || doc.gat.height }) }, 'Resize')),
			doc.source && doc.source.kind === 'client' && doc.source.map === doc.name ? h('p.warnbox', `This is the official ${doc.name}. Saving it into a mod overrides it for everyone with the mod on; give it a new name to make your own map instead.`) : null),
		h('div.sec', h('h4', 'Sky and weather'),
			field('Sky', h('input', { type: 'checkbox', checked: !!p.sky, onchange: e => run('props.set', e.target.checked ? { sky: '0.4,0.6,0.8' } : { sky: 'none', clouds: 'none' }) }), p.sky ? h('input', { type: 'color', value: sky, onchange: e => run('props.set', { sky: e.target.value }) }) : h('span.muted', 'black behind the map')),
			p.sky ? field('Clouds', h('input', { type: 'checkbox', checked: !!p.clouds, onchange: e => run('props.set', { clouds: e.target.checked ? '#ffffff' : 'none' }) }), p.clouds ? h('input', { type: 'color', value: rgbToHex(p.clouds), onchange: e => run('props.set', { clouds: e.target.value }) }) : null) : null,
			field('Presets', h('select', { onchange: e => { const s = SKY_PRESETS[e.target.value]; if (s) run('props.set', { sky: s.sky.join(','), clouds: s.clouds ? s.clouds.join(',') : 'none' }); } }, h('option', { value: '' }, 'from official maps…'), Object.keys(SKY_PRESETS).map(k => h('option', { value: k }, k)))),
			field('Weather', h('select', { onchange: e => run('props.set', { weather: e.target.value || 'none' }) }, [['', 'none'], ['snow', 'snow'], ['rain', 'rain'], ['sakura', 'sakura'], ['leaves', 'leaves'], ['fireworks', 'fireworks'], ['cloud', 'low clouds'], ['cloud2', 'clouds 2'], ['cloud3', 'clouds 3'], ['cloud4', 'clouds 4'], ['cloud5', 'clouds 5'], ['cloud6', 'clouds 6'], ['cloud7', 'clouds 7'], ['cloud8', 'clouds 8']].map(([v, n]) => h('option', { value: v, selected: (p.weather || '') === v ? true : null }, n)))),
			h('p.hint', 'Clouds drift in the game, not here. Weather is drawn only in the game.')),
		h('div.sec', h('h4', 'Music'), bgmBrowser(E, p.bgm, file => run('props.set', { bgm: file || 'none' }))),
		h('div.sec', h('h4', 'Water'),
			field('Water', h('input', { type: 'checkbox', checked: water.level < 500, onchange: e => run('water.set', e.target.checked ? { level: 0 } : { off: true }) })),
			water.level < 500 ? [
				field('Level', numInput(-water.level / 5, v => run('water.set', { level: v }), 0.25), h('span.muted', 'cells up')),
				field('Look', h('select', { onchange: e => run('water.set', { type: Number(e.target.value) }) }, [0, 1, 2, 3, 4, 5, 6, 7].map(t => h('option', { value: t, selected: water.type === t ? true : null }, `water ${t}`)))),
				field('Waves', numInput(water.waveHeight / 5, v => run('water.set', { waveHeight: v }), 0.05), numInput(water.waveSpeed, v => run('water.set', { waveSpeed: v }), 0.5), numInput(water.wavePitch, v => run('water.set', { wavePitch: v }), 5)),
				h('p.hint', 'Waves: height, speed, pitch. Walkable ground under the water line becomes walkable water.'),
			] : null),
		h('div.sec', h('h4', 'Sunlight'),
			field('Direction', ...slider(l.longitude, 0, 360, 1, (v, c) => liveLight('longitude', v, c), v => `${v}°`)),
			field('Height', ...slider(l.latitude, 0, 90, 1, (v, c) => liveLight('latitude', v, c), v => `${v}°`)),
			field('Sun colour', h('input', { type: 'color', value: rgbToHex(l.diffuse), oninput: e => liveLight('diffuse', hexToRgb(e.target.value), false), onchange: e => liveLight('diffuse', hexToRgb(e.target.value), true) })),
			field('Ambient', h('input', { type: 'color', value: rgbToHex(l.ambient), oninput: e => liveLight('ambient', hexToRgb(e.target.value), false), onchange: e => liveLight('ambient', hexToRgb(e.target.value), true) })),
			field('Shadows', ...slider(l.opacity, 0, 1, 0.05, (v, c) => liveLight('opacity', v, c), v => v.toFixed(2)))),
		h('div.sec', h('h4', 'Lightmaps'),
			h('p.muted', `${doc.gnd.lightmap.count} lightmaps. Baking works out the shadows the models and hills cast, and the colour of the point lights, and writes them into the ground.`),
			h('div.row',
				h('button.btn.primary', { onclick: async e => { e.target.disabled = true; e.target.textContent = 'Baking…'; await new Promise(r => setTimeout(r, 30)); try { const r = await app.bake({ samples: E._bakeQuality || 1 }); app.toast(`Baked ${r.surfaces} surfaces in ${(r.ms / 1000).toFixed(1)} s (${r.occluders} model triangles).`); } catch (err) { app.toast(err.message, true); } rerender(E); } }, 'Bake'),
				h('select', { onchange: e => { E._bakeQuality = Number(e.target.value); } }, h('option', { value: 1 }, 'quick'), h('option', { value: 4 }, 'soft shadows')),
				h('button.btn', { onclick: () => run('lightmap.reset', {}) }, 'Reset to plain'))),
		h('div.sec', h('h4', 'Minimap'), minimapPreview(E)),
		h('div.sec', h('h4', 'Files'), h('p.hint', `.gat ${doc.gat.version.join('.')} · .gnd ${doc.gnd.version.join('.')} · .rsw ${doc.rsw.version.join('.')} · ${doc.gnd.textures.length} textures · ${doc.gnd.tiles.length} tiles · ${doc.rsw.objects.length} objects`)),
	];
}

function minimapPreview(E) {
	const c = h('canvas', { width: 160, height: 160, style: { width: '160px', height: '160px', borderRadius: '6px', background: 'var(--code)' } });
	const draw = () => {
		const { image } = app.renderMinimap(256);
		const tmp = new OffscreenCanvas(image.width, image.height);
		tmp.getContext('2d').putImageData(new ImageData(image.data, image.width, image.height), 0, 0);
		c.getContext('2d').drawImage(tmp, 0, 0, 160, 160);
	};
	setTimeout(draw, 50);
	return h('div', c, h('p.hint', 'Made from the map seen from above every time you save, and written where the client looks for it.'), h('button.btn.small', { onclick: draw }, 'Refresh'));
}

// ---- Check

function checkPanel(E) {
	const list = h('div');
	const paint = () => {
		const issues = E.issues || [];
		const counts = { error: 0, warning: 0, note: 0 };
		for (const i of issues) counts[i.level]++;
		list.replaceChildren(
			h('p', issues.length ? `${counts.error} problems, ${counts.warning} warnings, ${counts.note} notes.` : 'Nothing found. Press Check to look again.'),
			...issues.map(i => h('div', { class: `issue ${i.level}`, onclick: () => { if (i.at && i.at.x !== undefined) app.focusOn(i.at.x, i.at.y, 35); if (i.at && i.at.id) { const k = ['npc', 'warp', 'spawn'].map(p => `${p}:${i.at.id}`).find(key => E.renderer.markers.some(m => m.key === key)); if (k) { E.sel = new Set([k]); E.renderer.selection = E.sel; } } } }, h('b', i.level === 'error' ? 'Problem: ' : i.level === 'warning' ? 'Warning: ' : 'Note: '), i.message)));
	};
	paint();
	return [h('h3', 'Check'), h('div.sec', h('p.muted', 'What would stop the map loading, or make it play badly: names, missing files, warps into walls, places nobody can reach.'), h('button.btn.primary', { onclick: async e => { e.target.disabled = true; await app.check(); e.target.disabled = false; paint(); } }, 'Check now'), list)];
}
