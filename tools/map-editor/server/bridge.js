// Everything the map editor page asks of its host, in one place, so the same
// answers come from the app (electron/tools.js, under ro-tool://map-editor/)
// and from the command line's own server (cli.js serve, for agents, tests and
// Playwright). A request is { method, path, query, body (Uint8Array) } and the
// answer { status, type, body }.
//
//   GET  asset/<client path>        a file: the open mod's own first, then the
//                                   asset server (the player's GRFs, mods)
//   POST api/search  {filter}       file names matching a regex: the asset
//                                   server's index plus the open mod's files
//   GET  api/projects               installed mods, and the maps in each
//   GET  api/project?mod=           one mod: mod.json, its npc/ scripts, its
//                                   signboards, and the editor's notes on it
//   POST api/save    {mod, files, remove, notes}
//                                   write files into state/mods/<mod>/
//   GET  api/maps                   every map the client has, with names
//   GET  api/bgm                    every track, and the maps that play it
//   GET  api/tables/mobs|items|npcs the server's monsters and items, the
//                                   client's NPC sprites
//   GET  api/prefabs, POST api/prefabs  saved groups of objects
//   POST api/remote/*               the live channel the CLI drives the open
//                                   page through (see remote.js)
//   POST api/host/<action>          what only the app can do (apply, open a
//                                   file, list characters): host.action()

import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { createRemote } from './remote.js';

const MOD_NAME = /^[A-Za-z0-9_-]{1,64}$/;
const MAX_BODY = 256 * 1024 * 1024;

/** The data folder name the client uses for UI textures, in Korean and as the mods often spell it. */
const UI_DIR = '유저인터페이스';
const UI_DIR_MOJIBAKE = 'À¯ÀúÀÎÅÍÆäÀÌ½º';

export function json(value, status = 200) {
	return { status, type: 'application/json; charset=utf-8', body: Buffer.from(JSON.stringify(value)) };
}
function text(value, status = 200, type = 'text/plain; charset=utf-8') {
	return { status, type, body: Buffer.from(String(value)) };
}

function decode(buf) {
	try { return new TextDecoder('utf-8', { fatal: true }).decode(buf); } catch { return new TextDecoder('euc-kr').decode(buf); }
}

/** A relative path inside a folder, refusing anything that climbs out. */
export function safeJoin(root, rel) {
	const parts = String(rel).replace(/\\/g, '/').split('/').filter(Boolean);
	if (!parts.length || parts.some(p => p === '.' || p === '..' || p.includes('\0'))) return null;
	const out = path.join(root, ...parts);
	return out.startsWith(root + path.sep) ? out : null;
}

/** Case-insensitive lookup of a path under a folder (mods are written on case-sensitive disks too). */
function findCaseless(root, rel) {
	const parts = String(rel).replace(/\\/g, '/').split('/').filter(Boolean);
	if (parts.some(p => p === '.' || p === '..')) return null;
	let dir = root;
	for (let i = 0; i < parts.length; i++) {
		let names;
		try { names = fs.readdirSync(dir); } catch { return null; }
		let want = parts[i].toLowerCase();
		let hit = names.find(n => n.toLowerCase() === want);
		// data/texture/유저인터페이스 is often written in its mojibake spelling.
		if (!hit && parts[i] === UI_DIR) hit = names.find(n => n === UI_DIR_MOJIBAKE);
		if (!hit) return null;
		dir = path.join(dir, hit);
	}
	return dir;
}

/**
 * @param {object} host
 *   stateDir()                 the app's state folder
 *   runtimeDir()               where client-tables/ and bin/ are (may be null)
 *   repoDir()                  the source checkout, for vendor/ fallbacks (may be null)
 *   assetBase()                'http://127.0.0.1:3338'
 *   fetch(url, init)           fetch, bypassing any protocol handler
 *   stack(args, input)         -> Promise<string>, `ragnarok-stack` (may throw)
 *   action(name, body)         -> Promise<any>, the app-only actions (may be null)
 *   log(text)
 */
export function createBridge(host) {
	const modsDir = () => path.join(host.stateDir(), 'mods');
	const notesDir = () => path.join(host.stateDir(), 'map-editor');
	const remote = createRemote();
	// The mod whose files the page is editing: its own files win over the
	// asset server's, so a texture just added shows before anything is applied.
	let openMod = null;
	const cache = new Map();

	function modDir(name) {
		if (!MOD_NAME.test(name || '')) throw new Error(`"${name}" is not a mod name: letters, digits, - and _`);
		return path.join(modsDir(), name);
	}

	async function assetFromServer(rel) {
		const url = `${host.assetBase()}/${rel.split('/').filter(Boolean).map(encodeURIComponent).join('/')}`;
		// No asset server (the game not started yet) is the same as no such file.
		const res = await host.fetch(url).catch(() => null);
		if (!res || !res.ok) return null;
		return Buffer.from(await res.arrayBuffer());
	}

	async function asset(rel) {
		if (openMod) {
			const local = findCaseless(modDir(openMod), rel);
			if (local && fs.statSync(local).isFile()) return fs.readFileSync(local);
		}
		return assetFromServer(rel);
	}

	// The asset server's file names matching `filter`, or null when it did not
	// answer (not started yet, restarting): not the same as "no such files",
	// so a table built from it is not kept.
	async function serverSearch(filter) {
		try {
			const res = await host.fetch(`${host.assetBase()}/search`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ filter }) });
			if (res.ok) return (await res.text()).split('\n').filter(Boolean);
			host.log(`map editor: the asset server's search answered ${res.status}`);
		} catch (e) {
			host.log(`map editor: the asset server's search failed: ${e.message}`);
		}
		return null;
	}

	async function search(filter) {
		const names = (await serverSearch(filter)) || [];
		if (openMod) {
			const re = new RegExp(filter, 'i');
			const root = modDir(openMod);
			const walk = (dir, rel) => {
				let list;
				try { list = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
				for (const d of list) {
					const r = rel ? `${rel}\\${d.name}` : d.name;
					if (d.isDirectory()) walk(path.join(dir, d.name), r);
					else if (re.test(r.replace(UI_DIR_MOJIBAKE, UI_DIR)) && !names.includes(r)) names.push(r.replace(UI_DIR_MOJIBAKE, UI_DIR));
				}
			};
			walk(path.join(root, 'data'), 'data');
		}
		return names;
	}

	function listProjects() {
		const out = [];
		let dirs = [];
		try { dirs = fs.readdirSync(modsDir(), { withFileTypes: true }).filter(d => d.isDirectory() && MOD_NAME.test(d.name)); } catch { /* none yet */ }
		for (const d of dirs) {
			const data = path.join(modsDir(), d.name, 'data');
			let maps = [];
			try { maps = fs.readdirSync(data).filter(f => /\.gnd$/i.test(f)).map(f => f.replace(/\.gnd$/i, '').toLowerCase()); } catch { /* no data */ }
			let manifest = null;
			try { manifest = JSON.parse(fs.readFileSync(path.join(modsDir(), d.name, 'mod.json'), 'utf8')); } catch { /* none */ }
			out.push({ mod: d.name, maps, description: manifest?.description || '', version: manifest?.version || '' });
		}
		return out.sort((a, b) => b.maps.length - a.maps.length || a.mod.localeCompare(b.mod));
	}

	function readProject(mod) {
		const root = modDir(mod);
		const out = { mod, exists: fs.existsSync(root), manifest: null, scripts: {}, signboards: null, population: null, notes: {} };
		try { out.manifest = JSON.parse(fs.readFileSync(path.join(root, 'mod.json'), 'utf8')); } catch { /* new */ }
		const npc = path.join(root, 'npc');
		const walk = (dir, rel) => {
			let list;
			try { list = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
			for (const d of list) {
				const r = `${rel}/${d.name}`;
				if (d.isDirectory()) walk(path.join(dir, d.name), r);
				else if (/\.txt$/i.test(d.name)) out.scripts[r] = decode(fs.readFileSync(path.join(dir, d.name)));
			}
		};
		walk(npc, 'npc');
		const sign = findCaseless(root, 'data/luafiles514/lua files/SignBoardList.lub');
		if (sign) out.signboards = decode(fs.readFileSync(sign));
		const pop = findCaseless(root, 'db/population_spawn.yml');
		if (pop) out.population = fs.readFileSync(pop, 'utf8');
		try { out.notes = JSON.parse(fs.readFileSync(path.join(notesDir(), 'projects', `${mod}.json`), 'utf8')); } catch { /* none */ }
		return out;
	}

	/**
	 * Write files into a mod. `files` maps a path in the mod to base64 bytes
	 * or { text }; `remove` lists paths to delete. Only these folders, which
	 * are what a map mod is made of.
	 */
	function save({ mod, files = {}, remove = [], notes }) {
		const root = modDir(mod);
		const allowed = /^(mod\.json|README\.md|data\/.+|npc\/.+\.txt|db\/.+\.yml|BGM\/[A-Za-z0-9_-]+\.mp3)$/;
		const written = [];
		for (const [rel, value] of Object.entries(files)) {
			if (!allowed.test(rel)) throw new Error(`the map editor does not write ${rel}`);
			const file = safeJoin(root, rel);
			if (!file) throw new Error(`bad path ${rel}`);
			fs.mkdirSync(path.dirname(file), { recursive: true });
			const bytes = typeof value === 'string' ? Buffer.from(value, 'base64') : Buffer.from(value.text, 'utf8');
			const tmp = `${file}.tmp-${process.pid}`;
			fs.writeFileSync(tmp, bytes);
			fs.renameSync(tmp, file);
			written.push(rel);
		}
		for (const rel of remove) {
			if (!allowed.test(rel)) continue;
			const file = safeJoin(root, rel);
			if (file) fs.rmSync(file, { force: true });
		}
		if (notes) {
			fs.mkdirSync(path.join(notesDir(), 'projects'), { recursive: true });
			fs.writeFileSync(path.join(notesDir(), 'projects', `${mod}.json`), JSON.stringify(notes, null, 1));
		}
		openMod = mod;
		cache.delete('projects');
		host.log(`map editor: saved ${written.length} file(s) to mods/${mod}`);
		return { mod, dir: root, written };
	}

	// ---- Tables: maps, music, monsters, items, NPC sprites

	async function clientText(rel) {
		const buf = await asset(rel).catch(() => null);
		return buf ? decode(buf) : '';
	}

	async function maps() {
		if (cache.has('maps')) return cache.get('maps');
		const found = await serverSearch('^data\\\\[^\\\\]+\\.rsw$');
		const names = (found || []).map(n => n.replace(/^data\\/i, '').replace(/\.rsw$/i, '').toLowerCase());
		const table = await clientText('data/mapnametable.txt');
		const display = {};
		for (const m of table.matchAll(/^([^#\r\n]+?)\.rsw#([^#\r\n]*)#/gim)) display[m[1].toLowerCase()] = m[2];
		const mods = listProjects().flatMap(p => p.maps.map(map => ({ map, mod: p.mod })));
		const out = [...new Set([...names, ...mods.map(m => m.map)])].sort().map(map => ({ map, name: display[map] || '', mod: (mods.find(m => m.map === map) || {}).mod || null }));
		if (found && found.length) cache.set('maps', out);
		return out;
	}

	async function bgm() {
		const tracks = new Map();
		// The client's own BGM folder is not in the GRF index; ask for the usual numbers.
		const table = await clientText('data/mp3nametable.txt');
		const uses = {};
		for (const m of table.matchAll(/^([^#\r\n]+?)\.rsw#bgm\\+([^#\r\n]+)#/gim)) {
			const track = m[2].toLowerCase();
			(uses[track] ||= []).push(m[1].toLowerCase());
		}
		for (const t of Object.keys(uses)) tracks.set(t, { file: t, maps: uses[t], source: 'client' });
		// The mods' own music.
		for (const p of listProjects()) {
			let files = [];
			try { files = fs.readdirSync(path.join(modsDir(), p.mod, 'BGM')).filter(f => /\.mp3$/i.test(f)); } catch { continue; }
			for (const f of files) {
				const t = tracks.get(f.toLowerCase()) || { file: f, maps: [], source: 'mod' };
				t.mod = p.mod;
				tracks.set(f.toLowerCase(), t);
			}
		}
		// What the mods' "maps" entries already use.
		for (const p of listProjects()) {
			try {
				const m = JSON.parse(fs.readFileSync(path.join(modsDir(), p.mod, 'mod.json'), 'utf8')).maps || {};
				for (const [map, look] of Object.entries(m)) if (look.bgm) {
					const t = tracks.get(look.bgm.toLowerCase()) || { file: look.bgm, maps: [], source: 'client' };
					if (!t.maps.includes(map)) t.maps.push(map);
					tracks.set(look.bgm.toLowerCase(), t);
				}
			} catch { /* none */ }
		}
		return [...tracks.values()].sort((a, b) => a.file.localeCompare(b.file, undefined, { numeric: true }));
	}

	function clientTable(name) {
		const candidates = [];
		if (host.runtimeDir && host.runtimeDir()) candidates.push(path.join(host.runtimeDir(), 'client-tables', name));
		if (host.repoDir && host.repoDir()) candidates.push(path.join(host.repoDir(), 'vendor', 'roBrowserLegacy', 'src', 'DB', 'Monsters', name));
		const file = candidates.find(f => fs.existsSync(f));
		return file ? fs.readFileSync(file, 'utf8') : '';
	}

	/** The client's id -> sprite name table (MonsterTable.js): monsters and NPCs alike. */
	function spriteTable() {
		if (cache.has('sprites')) return cache.get('sprites');
		const out = {};
		for (const m of clientTable('MonsterTable.js').matchAll(/^\s*(\d+)\s*:\s*'([^']+)'/gm)) out[m[1]] = m[2];
		cache.set('sprites', out);
		return out;
	}

	async function serverTable(name) {
		try { return await host.stack(['export-table', name]); } catch (e) {
			// Running from a checkout with no server: the source tables.
			const repo = host.repoDir && host.repoDir();
			const file = repo && [path.join(repo, 'vendor', 'rathena', 'db', 're', `${name}.yml`)].find(f => fs.existsSync(f));
			if (file) return fs.readFileSync(file, 'utf8');
			throw e;
		}
	}

	async function mobs() {
		if (cache.has('mobs')) return cache.get('mobs');
		const yml = await serverTable('mob_db');
		const sprites = spriteTable();
		const out = [];
		for (const m of yml.matchAll(/(?:^|\n) {2}- Id:\s*(\d+)([\s\S]*?)(?=\n {2}- Id:|\n\S|$)/g)) {
			const body = m[2];
			const get = k => { const r = new RegExp(`\\n\\s{4}${k}:\\s*(.+)`).exec(body); return r ? r[1].trim().replace(/^"|"$/g, '') : ''; };
			out.push({ id: Number(m[1]), aegis: get('AegisName'), name: get('Name'), level: Number(get('Level')) || 1, mvp: /\n\s{4}MvpDrops:/.test(body), sprite: sprites[m[1]] || get('AegisName') });
		}
		cache.set('mobs', out);
		return out;
	}

	async function items() {
		if (cache.has('items')) return cache.get('items');
		const out = [];
		for (const table of ['item_db_usable', 'item_db_etc', 'item_db_equip']) {
			let yml = '';
			try { yml = await serverTable(table); } catch { continue; }
			for (const m of yml.matchAll(/(?:^|\n) {2}- Id:\s*(\d+)([\s\S]*?)(?=\n {2}- Id:|\n\S|$)/g)) {
				const name = /\n\s{4}Name:\s*(.+)/.exec(m[2]);
				const buy = /\n\s{4}Buy:\s*(\d+)/.exec(m[2]);
				const aegis = /\n\s{4}AegisName:\s*(.+)/.exec(m[2]);
				out.push({ id: Number(m[1]), name: name ? name[1].trim().replace(/^"|"$/g, '') : '', aegis: aegis ? aegis[1].trim() : '', buy: buy ? Number(buy[1]) : 0, table });
			}
		}
		cache.set('items', out);
		return out;
	}

	async function npcSprites() {
		if (cache.has('npcs')) return cache.get('npcs');
		const table = spriteTable();
		const byName = new Map();
		for (const [id, name] of Object.entries(table)) {
			const n = Number(id);
			// NPC sprite ids: below 1000 and the 10000+ range (rAthena's NPC view ids).
			if ((n > 44 && n < 1000) || n >= 10000) if (!byName.has(name)) byName.set(name, n);
		}
		// Sprites in data/sprite/npc the table does not name (mods', newer clients').
		const found = await search('^data\\\\sprite\\\\npc\\\\[^\\\\]+\\.spr$');
		for (const f of found) {
			const name = f.replace(/^.*\\/, '').replace(/\.spr$/i, '');
			if (![...byName.keys()].some(k => k.toLowerCase() === name.toLowerCase())) byName.set(name.toUpperCase(), null);
		}
		const out = [...byName].map(([name, id]) => ({ name, id })).sort((a, b) => a.name.localeCompare(b.name));
		if (found.length) cache.set('npcs', out);
		return out;
	}

	// ---- Prefabs: groups of objects, saved across maps and sessions

	function prefabsFile() { return path.join(notesDir(), 'prefabs.json'); }
	function readPrefabs() { try { return JSON.parse(fs.readFileSync(prefabsFile(), 'utf8')); } catch { return []; } }

	async function handle(req) {
		const route = req.path.replace(/^\/+/, '');
		try {
			if (route.startsWith('asset/')) {
				const rel = route.slice(6);
				const bytes = await asset(rel);
				if (!bytes) return text(`no ${rel}`, 404);
				return { status: 200, type: 'application/octet-stream', body: bytes, cache: 'max-age=600' };
			}
			const body = req.body && req.body.length ? JSON.parse(Buffer.from(req.body).toString('utf8')) : {};
			switch (route) {
				case 'api/search': return json(await search(String(body.filter || '')));
				case 'api/projects': return json(listProjects());
				case 'api/project': { const mod = req.query.get('mod'); openMod = mod; return json(readProject(mod)); }
				case 'api/open-mod': openMod = body.mod || null; return json({ ok: true });
				case 'api/save': return json(save(body));
				case 'api/maps': return json(await maps());
				case 'api/bgm': return json(await bgm());
				case 'api/tables/mobs': return json(await mobs());
				case 'api/tables/items': return json(await items());
				case 'api/tables/npcs': return json(await npcSprites());
				case 'api/tables/sprites': return json(spriteTable());
				case 'api/prefabs':
					if (req.method === 'POST') {
						fs.mkdirSync(notesDir(), { recursive: true });
						fs.writeFileSync(prefabsFile(), JSON.stringify(body.prefabs || [], null, 1));
						return json({ ok: true });
					}
					return json(readPrefabs());
				case 'api/missing': {
					const res = await host.fetch(`${host.assetBase()}/api/missing-files`).catch(() => null);
					return json(res && res.ok ? await res.json() : null);
				}
				case 'api/context': return json({ host: host.name || 'cli', actions: host.actions || [], assetBase: host.assetBase(), stateDir: host.stateDir() });
				case 'api/log': host.log(`map editor: ${String(body.text || '').slice(0, 500)}`); return json({ ok: true });
			}
			if (route.startsWith('api/remote/')) return json(await remote.page(route.slice(11), body));
			if (route.startsWith('api/host/')) {
				if (!host.action) return json({ error: 'Only the app can do that. Open the map editor from Settings → Tools.' }, 501);
				return json(await host.action(route.slice(9), body));
			}
			return null;
		} catch (e) {
			host.log(`map editor: ${route}: ${e.message}`);
			return json({ error: e.message }, 500);
		}
	}

	return { handle, remote, save, readProject, listProjects, asset, search, setOpenMod: m => { openMod = m; } };
}

/** `ragnarok-stack <args>` as a promise of its output. */
export function runStack(bin, env, args, input) {
	return new Promise((resolve, reject) => {
		const child = execFile(bin, args, { env, timeout: 120000, maxBuffer: 128 * 1024 * 1024 }, (error, stdout, stderr) => {
			if (error) reject(new Error((stderr || '').trim() || error.message));
			else resolve(stdout);
		});
		if (input !== undefined) { child.stdin.end(input); }
	});
}
