// The commands only the open page can run -- opening and saving, the camera,
// screenshots, searching the client, baking -- next to the editing commands
// in lib/commands.js. Together they are what `ragnarok-map` and the MCP
// tools offer (cli.js lists them from here and from lib/commands.js).

import { get, post } from './host.js';
import { COMMANDS } from '../lib/commands.js';
import { decodeName } from '../lib/cp949.js';
import { PAGE_COMMANDS } from '../lib/page-commands.js';

let app = null;
import('./app.js').then(m => { app = m; });

const need = () => { if (!app || !app.E.doc) throw new Error('No map is open: map.open or map.new first.'); return app.E; };

function search(list, q, fields, limit = 50) {
	const s = String(q || '').toLowerCase();
	return list.filter(x => !s || fields.some(f => String(x[f] ?? '').toLowerCase().includes(s))).slice(0, limit);
}

export function pageCommands() {
	const run = {
		help: () => ({
			about: 'Ragnarok Offline map editor. Coordinates are server cells (x east, y north); heights are cells up. Every editing command is one undo step.',
			commands: { ...Object.fromEntries(Object.entries(COMMANDS).map(([k, v]) => [k, { describe: v.describe, args: Object.fromEntries(Object.entries(v.args).map(([a, s]) => [a, `${s[0]}${s[2] ? '?' : ''}: ${s[1]}`])) }])), ...PAGE_COMMANDS },
		}),
		status: () => {
			const E = app.E;
			return E.doc ? { map: E.doc.name, mod: E.mod, cells: [E.doc.gat.width, E.doc.gat.height], dirty: E.dirty, tool: E.tool, selection: [...E.sel], camera: camera(E), undo: E.history.undoStack.map(s => s.label).slice(-10) } : { map: null };
		},
		'map.open': async a => { await app.openMap({ mod: a.mod, map: a.map, as: a.as, discard: !!a.discard, remote: true }); return run.status(); },
		'map.new': async a => {
			await app.newMap({ mod: a.mod, name: a.name, width: Number(a.width || 80), height: Number(a.height || 80), discard: !!a.discard, remote: true });
			if (a.texture) app.run('texture.paint', { texture: a.texture, x0: 0, y0: 0, x1: app.E.doc.gat.width - 1, y1: app.E.doc.gat.height - 1 });
			return run.status();
		},
		'map.save': async a => { need(); return app.save({ mod: a.mod || null, override: !!a.override, remote: true }); },
		'map.check': async a => { need(); const issues = await app.check({ quick: !!a.quick }); return { errors: issues.filter(i => i.level === 'error').length, issues }; },
		'map.test': async a => { need(); return app.testInGame({ x: a.x, y: a.y, char: a.char }); },
		'map.set_start': a => { const E = need(); E.doc.testPoint = { x: Number(a.x), y: Number(a.y) }; app.setDirty(); app.rebuildMarkers(); return E.doc.testPoint; },
		undo: () => { need(); app.undo(); return run.status(); },
		redo: () => { need(); app.redo(); return run.status(); },
		'view.camera': a => {
			const E = need(), c = E.renderer.camera;
			if (a.x !== undefined || a.y !== undefined) { const x = Number(a.x ?? c.target[0] - 0.5), y = Number(a.y ?? c.target[2] - 0.5); app.focusOn(x, y, a.distance !== undefined ? Number(a.distance) : c.distance); }
			if (a.distance !== undefined) c.distance = Math.max(4, Number(a.distance));
			if (a.yaw !== undefined) c.yaw = Number(a.yaw);
			if (a.pitch !== undefined) c.pitch = Math.max(10, Math.min(90, Number(a.pitch)));
			if (a.fit) app.fitView();
			if (a.top) c.pitch = 90;
			E.redraw = true;
			return camera(E);
		},
		'view.show': a => {
			const E = need();
			for (const k of ['models', 'water', 'gat', 'grid', 'markers', 'lightmap']) if (a[k] !== undefined) E.renderer.show[k] = a[k] === true || a[k] === 'true' || a[k] === 1;
			for (const box of document.querySelectorAll('#layers input[data-layer]')) box.checked = !!E.renderer.show[box.dataset.layer];
			E.redraw = true;
			return E.renderer.show;
		},
		'view.tool': a => { need(); app.setTool(String(a.tool)); return { tool: app.E.tool }; },
		'view.select': a => {
			const E = need();
			const keys = String(a.keys ?? '').split(',').map(s => s.trim()).filter(Boolean).map(k => (/^\d+$/.test(k) ? Number(k) : k));
			E.sel = new Set(keys); E.renderer.selection = E.sel;
			if (a.focus) app.focusSelection();
			app.renderPanel(E);
			E.redraw = true;
			return [...E.sel];
		},
		'view.screenshot': async a => {
			const E = need();
			// Let textures and models that are still on their way arrive.
			for (let i = 0; i < 50 && [...E.renderer.models.values()].some(m => m.state === 'loading'); i++) await new Promise(r => setTimeout(r, 100));
			await new Promise(r => setTimeout(r, Number(a.wait ?? 150)));
			const url = app.screenshot({ width: a.width ? Number(a.width) : undefined, height: a.height ? Number(a.height) : undefined, labels: a.labels !== false && a.labels !== 'false' });
			E.redraw = true;
			return { png: url.replace(/^data:image\/png;base64,/, ''), camera: camera(E) };
		},
		'view.minimap': () => { need(); const { bmp, image } = app.renderMinimap(512); void bmp; const c = document.createElement('canvas'); c.width = image.width; c.height = image.height; c.getContext('2d').putImageData(new ImageData(image.data, image.width, image.height), 0, 0); return { png: c.toDataURL('image/png').split(',')[1] }; },
		'lightmap.bake': async a => { need(); return app.bake({ shadows: a.shadows !== false, lights: a.lights !== false, samples: Number(a.samples || 1) }); },
		'projects.list': () => get('api/projects'),
		'maps.search': async a => search((app.E.tables.maps || []).some(m => !m.mod) ? app.E.tables.maps : (app.E.tables.maps = await get('api/maps')), a.query, ['map', 'name', 'mod'], Number(a.limit || 50)),
		'models.search': async a => {
			const all = app.E._models || (app.E._models = (await post('api/search', { filter: '^data\\\\model\\\\.*\\.rsm2?$' })).map(n => n.replace(/^data\\model\\/i, '')));
			const q = String(a.query || '').toLowerCase();
			return all.filter(p => !q || p.toLowerCase().includes(q)).slice(0, Number(a.limit || 50));
		},
		'textures.search': async a => {
			const all = app.E._textures || (app.E._textures = (await post('api/search', { filter: '^data\\\\texture\\\\.*\\.(bmp|tga|jpg)$' })).map(n => n.replace(/^data\\texture\\/i, '')));
			const q = String(a.query || '').toLowerCase();
			return all.filter(p => !q || p.toLowerCase().includes(q)).slice(0, Number(a.limit || 50));
		},
		'sounds.search': async a => {
			const all = app.E._wav || (app.E._wav = (await post('api/search', { filter: '^data\\\\wav\\\\.*\\.wav$' })).map(n => n.replace(/^data\\wav\\/i, '')));
			const q = String(a.query || '').toLowerCase();
			return all.filter(p => !q || p.toLowerCase().includes(q)).slice(0, Number(a.limit || 50));
		},
		'mobs.search': async a => search(app.E.tables.mobs || (app.E.tables.mobs = await get('api/tables/mobs')), a.query, ['name', 'aegis', 'id'], Number(a.limit || 30)),
		'items.search': async a => search(app.E.tables.items || (app.E.tables.items = await get('api/tables/items')), a.query, ['name', 'aegis', 'id'], Number(a.limit || 30)),
		'npcs.search': async a => search(app.E.tables.npcs || (app.E.tables.npcs = await get('api/tables/npcs')), a.query, ['name', 'id'], Number(a.limit || 50)),
		'bgm.list': async a => search(await get('api/bgm'), a.query, ['file', 'maps'], Number(a.limit || 100)),
		'prefab.list': () => get('api/prefabs'),
		'prefab.save': async a => {
			const E = need();
			const clip = app.run('object.copy', { indexes: a.indexes });
			const list = (await get('api/prefabs')).filter(p => p.name !== a.name).concat({ name: String(a.name), clip, at: Date.now() });
			await post('api/prefabs', { prefabs: list });
			void E;
			return { saved: a.name, objects: clip.objects.length };
		},
		'prefab.place': async a => {
			need();
			const p = (await get('api/prefabs')).find(x => x.name === a.name);
			if (!p) throw new Error(`no prefab called ${a.name}`);
			return app.run('object.paste', { clip: p.clip, x: Number(a.x), y: Number(a.y), rotation: Number(a.rotation || 0) });
		},
		'dialogue.open': async a => {
			const E = need();
			if (E.dirty) await app.save({ silent: true });
			return post('api/host/open-file', { mod: E.mod, path: `npc/${E.doc.name}_dialogue.txt`, function: a.fn });
		},
		'textures.used': () => { const E = need(); return E.doc.gnd.textures.map((t, i) => ({ index: i, path: decodeName(t) })); },
	};
	const out = {};
	for (const [k, fn] of Object.entries(run)) out[k] = { describe: (PAGE_COMMANDS[k] || {}).describe || '', run: fn };
	return out;
}

function camera(E) {
	const c = E.renderer.camera;
	return { x: +(c.target[0] - 0.5).toFixed(1), y: +(c.target[2] - 0.5).toFixed(1), distance: +c.distance.toFixed(1), yaw: +c.yaw.toFixed(1), pitch: +c.pitch.toFixed(1) };
}
