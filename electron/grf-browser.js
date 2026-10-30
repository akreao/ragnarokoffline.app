'use strict';
// The GRF browser's host side (Settings -> Tools -> GRF browser): what its
// page, tools/grf-browser/, asks of the app under ro-tool://grf-browser/.
//
//   files.json                  every file in the GRFs, by name (the asset
//                               server's /list-files)
//   asset/data/...              one file, as the game would get it: a mod's
//                               copy over the GRFs'
//   GET  api/mods               installed mods, to copy a file into
//   POST api/save {mod, path, data, description}
//                               write one file (base64) into
//                               state/mods/<mod>/data/..., making the mod
//                               (a mod.json) when it is new
//   POST api/export {name, files}  PNGs to edit, into state/grf-browser/<name>/,
//                               and that folder opened
//   GET  api/edited?name=       the PNGs in that folder now, to bring back
//   POST api/open {name}        open that folder again
//
// The page does the converting; this only reads and writes files, and only
// below those two folders.

const fs = require('node:fs');
const path = require('node:path');

const MOD_NAME = /^[A-Za-z0-9_-]{1,64}$/;
const WORK_NAME = /^[^/\\:*?"<>|\0]{1,120}$/;
const MAX_FILE = 64 * 1024 * 1024;

/** A relative path inside a folder, refusing anything that climbs out. */
function safeJoin(root, rel) {
	const parts = String(rel).replace(/\\/g, '/').split('/').filter(Boolean);
	if (!parts.length || parts.some(p => p === '.' || p === '..' || p.includes('\0'))) return null;
	const out = path.join(root, ...parts);
	return out.startsWith(root + path.sep) ? out : null;
}

function writeAtomic(file, bytes) {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	const tmp = `${file}.tmp-${process.pid}`;
	fs.writeFileSync(tmp, bytes);
	fs.renameSync(tmp, file);
}

/**
 * @param {object} deps
 *   stateDir(), assetBase() 'http://127.0.0.1:3338', fetch(url) (bypassing
 *   the tools' protocol handlers), openPath(dir) -> Promise<string error>
 *   (absent in a headless app), log(text)
 */
function createGrfBrowser(deps) {
	const modsDir = () => path.join(deps.stateDir(), 'mods');
	const workDir = () => path.join(deps.stateDir(), 'grf-browser');
	const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } });
	const fail = (message, status = 400) => json({ error: message }, status);

	function work(name) {
		if (!WORK_NAME.test(name || '') || /^\.+$/.test(name)) throw new Error('bad folder name');
		return path.join(workDir(), name);
	}

	async function open(dir) {
		if (!deps.openPath) return false;
		const error = await deps.openPath(dir);
		if (error) deps.log(`grf browser: could not open ${dir}: ${error}`);
		return !error;
	}

	function listMods() {
		let dirs = [];
		try { dirs = fs.readdirSync(modsDir(), { withFileTypes: true }).filter(d => d.isDirectory() && MOD_NAME.test(d.name)); } catch { /* none yet */ }
		return dirs.map(d => {
			let manifest = {};
			try { manifest = JSON.parse(fs.readFileSync(path.join(modsDir(), d.name, 'mod.json'), 'utf8')); } catch { /* none, or not ours to judge */ }
			return { name: d.name, description: manifest.description || '', version: manifest.version || '' };
		}).sort((a, b) => a.name.localeCompare(b.name));
	}

	function save({ mod, path: rel, data, description }) {
		if (!MOD_NAME.test(mod || '')) throw new Error(`"${mod}" is not a mod name: letters, digits, - and _`);
		if (!/^data\//i.test(String(rel || '').replace(/\\/g, '/'))) throw new Error('only files under data/ go into a mod from here');
		const bytes = Buffer.from(String(data || ''), 'base64');
		if (bytes.length > MAX_FILE) throw new Error('that file is too large');
		const root = path.join(modsDir(), mod);
		const file = safeJoin(root, rel);
		if (!file) throw new Error(`bad path ${rel}`);
		const created = !fs.existsSync(path.join(root, 'mod.json'));
		if (created) {
			const manifest = { name: mod, version: '1.0.0', description: String(description || 'Files changed with the GRF browser.'), requires: { era: 'any' } };
			writeAtomic(path.join(root, 'mod.json'), `${JSON.stringify(manifest, null, 2)}\n`);
		}
		writeAtomic(file, bytes);
		deps.log(`grf browser: wrote ${rel} to mods/${mod}${created ? ' (new mod)' : ''}`);
		return { mod, file, created };
	}

	async function exportFiles({ name, files }) {
		const dir = work(name);
		// A fresh folder each time: frames left from an earlier export would be read back in.
		fs.rmSync(dir, { recursive: true, force: true });
		for (const [rel, data] of Object.entries(files || {})) {
			const file = safeJoin(dir, rel);
			if (!file || !/\.(png|txt)$/i.test(rel)) throw new Error(`bad file name ${rel}`);
			writeAtomic(file, Buffer.from(String(data), 'base64'));
		}
		return { dir, opened: await open(dir) };
	}

	function edited(name) {
		const dir = work(name);
		const files = {};
		let list = [];
		try { list = fs.readdirSync(dir, { withFileTypes: true }); } catch { throw new Error('that folder is gone: export the file again'); }
		for (const d of list) if (d.isFile() && /\.png$/i.test(d.name)) files[d.name] = fs.readFileSync(path.join(dir, d.name)).toString('base64');
		return { dir, files };
	}

	async function fromAssets(rel) {
		const url = `${deps.assetBase()}/${rel.split('/').filter(Boolean).map(encodeURIComponent).join('/')}`;
		const res = await deps.fetch(url).catch(() => null);
		return res;
	}

	return async function route(name, url, request) {
		try {
			if (name === 'files.json') {
				const res = await deps.fetch(`${deps.assetBase()}/list-files`).catch(() => null);
				if (!res || !res.ok) return fail('The game\'s asset server is not running. Press Play once, then try again.', 503);
				return new Response(Buffer.from(await res.arrayBuffer()), { headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } });
			}
			const asset = /^asset\/(data\/.+)$/i.exec(name);
			if (asset) {
				const parts = asset[1].replace(/\\/g, '/').split('/');
				if (parts.some(p => !p || p === '.' || p === '..')) return fail('bad path', 404);
				const res = await fromAssets(parts.join('/'));
				if (!res || !res.ok) return fail(`no ${asset[1]}`, 404);
				return new Response(Buffer.from(await res.arrayBuffer()), { headers: { 'content-type': 'application/octet-stream', 'cache-control': 'no-store' } });
			}
			if (!name.startsWith('api/')) return null;
			const call = name.slice(4);
			const body = request.method === 'POST' ? JSON.parse((await request.text()) || '{}') : {};
			if (call === 'mods') return json({ mods: listMods(), modsDir: modsDir() });
			if (call === 'save' && request.method === 'POST') return json(save(body));
			if (call === 'export' && request.method === 'POST') return json(await exportFiles(body));
			if (call === 'edited') return json(edited(url.searchParams.get('name')));
			if (call === 'open' && request.method === 'POST') {
				const dir = work(body.name);
				if (!fs.existsSync(dir)) throw new Error('that folder is gone: export the file again');
				return json({ dir, opened: await open(dir) });
			}
			return fail('no such call', 404);
		} catch (e) {
			deps.log(`grf browser: ${name}: ${e.message}`);
			return fail(e.message);
		}
	};
}

module.exports = { createGrfBrowser, safeJoin };
