// Dialogs: open a map (yours, or any in the client), make a new one, test in
// game, and pick a warp's destination by clicking on the other map.

import { h, debounce } from './dom.js';
import { get, post } from './host.js';
import { MapRenderer } from '../render/renderer.js';
import { openMap as openDoc } from '../lib/map.js';
import { cellKind } from '../lib/gat.js';

let app = null;
const appReady = () => (app ? Promise.resolve(app) : import('./app.js').then(m => (app = m)));

function show(title, body, buttons = [], { wide = false } = {}) {
	const dlg = document.getElementById('dialog');
	const form = document.getElementById('dialog-form');
	form.replaceChildren(
		h('div.dh', h('h2', title), h('button.btn.small', { type: 'button', onclick: () => dlg.close() }, '✕')),
		h('div.db', body),
		buttons.length ? h('div.df', buttons) : null);
	dlg.style.width = wide ? 'min(980px, 94vw)' : '';
	if (!dlg.open) dlg.showModal();
	return dlg;
}
const close = () => document.getElementById('dialog').close();

const MOD_NAME = /^[A-Za-z0-9_-]{1,64}$/;
const MAP_NAME = /^[a-z0-9_@-]{1,11}$/;

export async function openDialog(E, tab = 'mine') {
	await appReady();
	const body = h('div');
	const tabs = h('div.tabs', [['mine', 'My mods'], ['client', 'Maps in my client'], ['new', 'New map']].map(([id, label]) => h('button', { type: 'button', class: id === tab ? 'on' : '', onclick: () => openDialog(E, id) }, label)));
	body.append(tabs);
	if (tab === 'new') return newMapDialog(E, body);
	if (tab === 'mine') {
		const list = h('div.list', { style: { maxHeight: '420px' } }, h('div.li.muted', 'Reading your mods…'));
		body.append(h('p.muted', 'Mods in your mods folder, and the maps in each. A mod with no map yet can take a new one.'), list);
		show('Open a map', body);
		try {
			const projects = await get('api/projects');
			const rows = [];
			for (const p of projects) {
				for (const map of p.maps) rows.push(h('div.li', { onclick: async () => { close(); try { await app.openMap({ mod: p.mod, map }); } catch (e) { app.toast(e.message, true); } } }, h('b', map), h('small', `mod ${p.mod}`)));
			}
			const empty = projects.filter(p => !p.maps.length);
			list.replaceChildren(...(rows.length ? rows : [h('div.li.muted', 'None of your mods has a map yet. Make one in "New map", or open one of the client\'s and save it into a mod.')]),
				...(empty.length ? [h('div.li.muted', `Mods without maps: ${empty.map(p => p.mod).join(', ')}`)] : []));
		} catch (e) { list.replaceChildren(h('div.li', e.message)); }
		return;
	}
	// Maps in the client.
	const input = h('input', { placeholder: 'Search by file name or by name (prontera, Payon, izlude…)', style: { width: '100%' } });
	const list = h('div.list', { style: { maxHeight: '360px', marginTop: '8px' } }, h('div.li.muted', 'Reading the client\'s maps…'));
	const asName = h('input', { placeholder: 'new name (keeps the original untouched)', maxlength: 11 });
	const intoMod = h('input', { placeholder: 'mod to save it into' });
	let picked = null;
	const choice = h('div', { style: { marginTop: '10px' } });
	const paintChoice = () => {
		choice.replaceChildren(!picked ? h('p.muted', 'Pick a map.') : h('div',
			h('p', 'Open ', h('b', picked.map), picked.name ? ` (${picked.name})` : '', ' and save it as:'),
			h('div.field', h('label', 'New map name'), asName),
			h('div.field', h('label', 'Into the mod'), intoMod),
			h('p.hint', 'Saved under a new name, it is a new map: the original is left alone. Leave the name empty to edit the original itself — an override, which changes it for everyone with the mod on.')));
	};
	body.append(input, list, choice);
	paintChoice();
	const go = h('button.btn.primary', { type: 'button', onclick: async () => {
		if (!picked) return;
		const as = asName.value.trim().toLowerCase();
		const mod = intoMod.value.trim() || `${(as || picked.map).replace(/[^a-z0-9-]/g, '-')}-map`;
		if (as && !MAP_NAME.test(as)) return app.toast('A map name is at most 11 characters: lowercase letters, digits, _ and -.', true);
		if (!MOD_NAME.test(mod)) return app.toast('A mod name is letters, digits, - and _.', true);
		close();
		try { await app.openMap({ mod, map: picked.map, as: as || undefined }); } catch (e) { app.toast(e.message, true); }
	} }, 'Open');
	const view = h('button.btn', { type: 'button', onclick: async () => { if (!picked) return; close(); try { await app.openMap({ map: picked.map }); app.toast('Opened to look at. Save puts it in a mod.'); } catch (e) { app.toast(e.message, true); } } }, 'Just look');
	show('Open a map', body, [view, go]);
	let maps = E.tables.maps;
	// A list with no client maps in it was read while the asset server was down: read it again.
	if (!maps || !maps.some(m => !m.mod)) { try { maps = E.tables.maps = await get('api/maps'); } catch (e) { list.replaceChildren(h('div.li', e.message)); return; } }
	const paint = () => {
		const q = input.value.trim().toLowerCase();
		const rows = maps.filter(m => !q || m.map.includes(q) || (m.name || '').toLowerCase().includes(q)).slice(0, 300);
		list.replaceChildren(...rows.map(m => h('div.li', { class: `li${picked && picked.map === m.map ? ' on' : ''}`, onclick: () => { picked = m; asName.value = asName.value || ''; paint(); paintChoice(); } }, h('b', m.map), h('small', m.mod ? `mod ${m.mod}` : m.name || ''))));
	};
	input.oninput = debounce(paint, 100);
	paint();
	input.focus();
}

export async function newMapDialog(E, body = null) {
	await appReady();
	const own = !body;
	body = body || h('div');
	const name = h('input', { placeholder: 'my_isle', maxlength: 11 });
	const mod = h('input', { placeholder: 'my-isle (a folder in your mods)' });
	const w = h('input', { type: 'number', value: 80, step: 2, min: 10, max: 600 });
	const ht = h('input', { type: 'number', value: 80, step: 2, min: 10, max: 600 });
	const textures = [['필드바닥\\prt_초원01.bmp', 'Grass (Prontera fields)'], ['필드바닥\\prt_도시01.bmp', 'Paving (Prontera)'], ['필드바닥\\숲속바닥-06.bmp', 'Forest floor (Payon)'], ['필드바닥\\유노추가01.bmp', 'Stone (Juno)'], ['필드바닥\\mo-피라미드1-바닥.bmp', 'Sandstone (Morocc)'], ['BACKSIDE.BMP', 'Plain']];
	const tex = h('select', textures.map(([v, l]) => h('option', { value: v }, l)));
	name.oninput = () => { if (!mod.dataset.touched) mod.value = name.value ? `${name.value.replace(/_/g, '-')}` : ''; };
	mod.oninput = () => { mod.dataset.touched = '1'; };
	body.append(
		h('div.field', h('label', 'Map name'), name), h('p.hint', 'What @warp and scripts call it: at most 11 characters, lowercase letters, digits, _ and -.'),
		h('div.field', h('label', 'Mod'), mod), h('p.hint', 'The mod it is saved into; a new one is made. Several maps can share a mod.'),
		h('div.field', h('label', 'Size'), w, h('span', '×'), ht, h('span.muted', 'cells')),
		h('div.field', h('label', 'Ground'), tex));
	const create = h('button.btn.primary', { type: 'button', onclick: async () => {
		const n = name.value.trim().toLowerCase(), m = (mod.value.trim() || n.replace(/_/g, '-'));
		if (!MAP_NAME.test(n)) return app.toast('A map name is at most 11 characters: lowercase letters, digits, _ and -.', true);
		if (!MOD_NAME.test(m)) return app.toast('A mod name is letters, digits, - and _.', true);
		const taken = (E.tables.maps || []).find(x => x.map === n);
		if (taken && !confirm(`There is already a map called ${n}${taken.mod ? ` in the mod ${taken.mod}` : ' in your client'}. A new one with the same name would replace it. Go on?`)) return;
		close();
		try {
			await app.newMap({ mod: m, name: n, width: Number(w.value), height: Number(ht.value) });
			// The ground texture: picked here, painted everywhere.
			app.run('texture.paint', { texture: tex.value, x0: 0, y0: 0, x1: Number(w.value) - 1, y1: Number(ht.value) - 1 });
			app.E.history.undoStack.length = 0;
			app.toast(`${n} is ready. Save puts it in mods/${m}; Test in game takes you there.`);
		} catch (e) { app.toast(e.message, true); }
	} }, 'Create');
	if (own) show('New map', body, [create]);
	else { show('Open a map', body, [create]); }
	name.focus();
}

export async function testDialog(E) {
	await appReady();
	const body = h('div');
	const sel = h('select', h('option', { value: '' }, 'Reading your characters…'));
	const x = h('input', { type: 'number', value: E.doc.testPoint ? E.doc.testPoint.x : Math.floor(E.doc.gat.width / 2) });
	const y = h('input', { type: 'number', value: E.doc.testPoint ? E.doc.testPoint.y : Math.floor(E.doc.gat.height / 2) });
	body.append(
		h('p', 'Saves the map into ', h('b', E.mod || '(a new mod)'), ', switches the mod on, restarts the server, and puts a character there — log in and you are on the map.'),
		h('div.field', h('label', 'Character'), sel),
		h('div.field', h('label', 'Arrive at'), x, y, h('span.muted', '(Gameplay → Start sets this by clicking)')),
		h('p.hint', 'The character must be logged out; the restart sees to that. Your own game window reopens when it is done.'));
	const go = h('button.btn.primary', { type: 'button', onclick: async () => {
		go.disabled = true;
		const point = { x: Number(x.value), y: Number(y.value) };
		E.doc.testPoint = point;
		try { close(); await app.testInGame({ ...point, char: sel.value || undefined }); } catch (e) { app.toast(e.message, true, 10000); }
	} }, 'Save and test');
	show('Test in game', body, [go]);
	if (app.hostName === 'cli') {
		sel.replaceChildren(h('option', { value: '' }, 'only in the app'));
		body.append(h('p.warnbox', 'Test in game needs the app: open the map editor from Settings → Tools. Here you can still Save.'));
		return;
	}
	try {
		const chars = await post('api/host/characters', {});
		const list = chars.characters || [];
		sel.replaceChildren(...(list.length ? list : [{ char_id: '', name: 'no characters yet: make one in the game first' }]).map(c => h('option', { value: c.char_id }, c.name ? `${c.name}${c.class_name ? ` (${c.class_name}` : ''}${c.base_level ? `, ${c.base_level})` : c.class_name ? ')' : ''}${c.last_map ? ` · on ${c.last_map}` : ''}` : c.char_id)));
		const last = localStorage.getItem('map-editor:test-char');
		if (last && list.some(c => String(c.char_id) === last)) sel.value = last;
		sel.onchange = () => { try { localStorage.setItem('map-editor:test-char', sel.value); } catch { /* */ } };
	} catch (e) { sel.replaceChildren(h('option', { value: '' }, e.message)); }
}

/**
 * Click on another map to choose a warp's destination. Its ground is drawn
 * from above with the walkability on it, so a blocked cell is plain to see.
 */
export async function destinationPicker(E, map, done) {
	await appReady();
	const input = h('input', { value: map, list: 'map-names', placeholder: 'map name' });
	const canvas = h('canvas.picker-view');
	const info = h('p.hint', 'Loading…');
	const body = h('div', h('div.field', h('label', 'Map'), input, h('button.btn.small', { type: 'button', onclick: () => load(input.value.trim().toLowerCase()) }, 'Show')), canvas, info);
	show('Where the warp lands', body, [], { wide: true });
	const r = new MapRenderer(canvas, E.assets);
	r.show.gat = true; r.show.markers = false; r.show.water = true;
	let doc = null;
	const frame = () => { if (!document.getElementById('dialog').open) return; r.render(); requestAnimationFrame(frame); };
	async function load(name) {
		info.textContent = `Loading ${name}…`;
		if (name === E.doc.name) doc = E.doc;
		else {
			const [gnd, rsw, gat] = await Promise.all(['gnd', 'rsw', 'gat'].map(ext => E.assets.file(`data/${name}.${ext}`)));
			if (!gnd) { info.textContent = `There is no map called ${name}.`; return; }
			doc = openDoc({ name, gnd, rsw, gat });
		}
		r.setDoc(doc);
		r.camera.pitch = 90; r.camera.ortho = false;
		r.camera.distance = Math.max(doc.gnd.width, doc.gnd.height) * 2.3;
		info.textContent = 'Click a green (walkable) cell. Wheel zooms, right-drag turns, Shift+right-drag pans.';
		requestAnimationFrame(frame);
	}
	let drag = null;
	canvas.oncontextmenu = e => e.preventDefault();
	canvas.onwheel = e => { e.preventDefault(); r.camera.distance *= e.deltaY > 0 ? 1.12 : 0.89; };
	canvas.onpointerdown = e => {
		if (!doc) return;
		if (e.button !== 0) { drag = { x: e.clientX, y: e.clientY, yaw: r.camera.yaw, pitch: r.camera.pitch, t: r.camera.target.slice(), pan: e.shiftKey || e.button === 1 }; return; }
		const rect = canvas.getBoundingClientRect();
		const hit = r.pickGround(r.rayAt(e.clientX - rect.left, e.clientY - rect.top));
		if (!hit) return;
		const cx = Math.floor(hit[0]), cy = Math.floor(hit[2]);
		const t = doc.gat.types[cy * doc.gat.width + cx];
		if (!cellKind(t).walk && !confirm(`${cx},${cy} is not walkable: a player landing there is stuck. Use it anyway?`)) return;
		close();
		done(doc.name, cx, cy);
	};
	canvas.onpointermove = e => {
		if (drag) {
			const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
			if (drag.pan) { const s = r.camera.distance / 500; r.camera.target[0] = drag.t[0] - dx * s; r.camera.target[2] = drag.t[2] + dy * s; }
			else { r.camera.yaw = drag.yaw - dx * 0.3; r.camera.pitch = Math.max(12, Math.min(90, drag.pitch + dy * 0.3)); }
			return;
		}
		if (!doc) return;
		const rect = canvas.getBoundingClientRect();
		const hit = r.pickGround(r.rayAt(e.clientX - rect.left, e.clientY - rect.top));
		if (hit) { const cx = Math.floor(hit[0]), cy = Math.floor(hit[2]); info.textContent = `${doc.name} ${cx}, ${cy} — ${cellKind(doc.gat.types[cy * doc.gat.width + cx]).name}`; r.brush = { x: cx + 0.5, z: cy + 0.5, radius: 0.7, color: [1, 1, 0.2] }; }
	};
	canvas.onpointerup = () => { drag = null; };
	load(map);
}
