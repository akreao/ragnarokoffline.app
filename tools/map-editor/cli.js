#!/usr/bin/env node
// ragnarok-map: the map editor from a terminal, a script or an AI agent.
//
//   ragnarok-map serve [--port N]          the editor in your browser, on 127.0.0.1
//   ragnarok-map open --mod M --map X      open a map in the editor (the app's
//                                          window, or a headless one)
//   ragnarok-map <command> [--arg v ...]   run a command in the open editor;
//                                          `ragnarok-map help` lists them
//   ragnarok-map shot [--out f.png] [...]  a screenshot of the editor's view
//   ragnarok-map offline --mod M --map X <command> [--arg v ...]
//                                          edit a mod's files with no editor
//                                          open (geometry, gameplay, properties)
//   ragnarok-map mcp                       an MCP server on stdin/stdout
//
// Arguments are --name value pairs (a value is read as JSON when it parses,
// so numbers and true/false come through as such), or one JSON object.
// Every answer is one line of JSON on stdout.
//
// Live commands reach the editor through the control server the app (or
// `serve`) writes to <state>/map-editor/connection.json. With no editor open,
// `open`, `shot` and the MCP server start a headless one: the app's own
// window when the app is running, otherwise Chromium through Playwright or
// Electron when this runs from a source checkout.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

// ---- Where things are

function dataRoot() {
	if (process.env.RAGNAROK_OFFLINE_HOME) return process.env.RAGNAROK_OFFLINE_HOME;
	if (process.platform === 'darwin') return path.join(os.homedir(), 'Library/Application Support/Ragnarok Offline');
	if (process.platform === 'win32') return path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData/Roaming'), 'Ragnarok Offline');
	return path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local/share'), 'Ragnarok Offline');
}
const stateDir = opts => opts.state || process.env.RAGNAROKMAC_STATE || path.join(dataRoot(), 'state');
const connectionFile = opts => path.join(stateDir(opts), 'map-editor', 'connection.json');
const repoDir = () => { const r = path.resolve(HERE, '..', '..'); return fs.existsSync(path.join(r, 'stack')) ? r : null; };
const stackBin = () => {
	const exe = process.platform === 'win32' ? 'ragnarok-stack.exe' : 'ragnarok-stack';
	for (const p of [process.env.RAGNAROKMAC_ROOT && path.join(process.env.RAGNAROKMAC_ROOT, 'bin', exe), path.join(dataRoot(), 'runtime', 'bin', exe)]) if (p && fs.existsSync(p)) return p;
	return null;
};
function assetBase(opts) {
	if (opts.assets) return String(opts.assets).replace(/\/$/, '');
	const port = process.env.RAGNAROK_OFFLINE_ASSET_PORT || 3338;
	return `http://127.0.0.1:${port}`;
}

// ---- Arguments

function parseArgs(argv) {
	const opts = {}, rest = [];
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a.startsWith('--')) {
			const eq = a.indexOf('=');
			const key = eq > 0 ? a.slice(2, eq) : a.slice(2);
			let value = eq > 0 ? a.slice(eq + 1) : (argv[i + 1] !== undefined && !argv[i + 1].startsWith('--') ? argv[++i] : true);
			opts[key] = coerce(value);
		} else rest.push(a);
	}
	return { opts, rest };
}
function coerce(v) {
	if (typeof v !== 'string') return v;
	if (/^-?\d+(\.\d+)?$/.test(v)) return Number(v);
	if (v === 'true' || v === 'false') return v === 'true';
	if (/^[[{]/.test(v)) { try { return JSON.parse(v); } catch { /* a string */ } }
	return v;
}
const GLOBAL = new Set(['state', 'assets', 'port', 'out', 'json', 'headless', 'browser', 'show', 'timeout']);
function commandArgs(opts, rest) {
	let args = {};
	if (rest[0] && rest[0].startsWith('{')) args = JSON.parse(rest[0]);
	for (const [k, v] of Object.entries(opts)) if (!GLOBAL.has(k)) args[k] = v;
	return args;
}

function print(value) { process.stdout.write(JSON.stringify(value) + '\n'); }
function fail(message, code = 1) { print({ error: message }); process.exit(code); }

// ---- The live control channel

function readConnection(opts) {
	try { return JSON.parse(fs.readFileSync(connectionFile(opts), 'utf8')); } catch { return null; }
}

async function control(conn, what, body) {
	const res = await fetch(`http://127.0.0.1:${conn.port}${conn.base || ''}/control/${what}`, {
		method: body === undefined ? 'GET' : 'POST',
		headers: { authorization: `Bearer ${conn.token}`, 'content-type': 'application/json' },
		body: body === undefined ? undefined : JSON.stringify(body),
	});
	return res.json();
}

async function liveStatus(opts) {
	const conn = readConnection(opts);
	if (!conn) return null;
	try { const s = await control(conn, 'status'); return s.error ? null : { conn, ...s }; } catch { return null; }
}

async function waitForPage(conn, ms = 60000) {
	const until = Date.now() + ms;
	while (Date.now() < until) {
		try { const s = await control(conn, 'status'); if (s.connected) return s; } catch { /* starting */ }
		await new Promise(r => setTimeout(r, 300));
	}
	throw new Error('the map editor page did not come up');
}

let headless = null;

/**
 * An editor to talk to: the open one, or one started for this run -- the
 * app's window (asked over its control server), or a browser on our own
 * server.
 */
async function ensureEditor(opts, { mod, map } = {}) {
	const live = await liveStatus(opts);
	if (live && live.connected) return live.conn;
	if (live && live.conn.app) {
		// The app is running but its editor window is not open: ask it to open one.
		const r = await control(live.conn, 'run', { cmd: 'editor.open', args: { mod, map, show: opts.show !== false && opts.headless !== true } });
		if (r.error) throw new Error(r.error);
		await waitForPage(live.conn);
		return live.conn;
	}
	if (!headless) headless = await startHeadless(opts, { mod, map });
	return headless.conn;
}

async function runLive(opts, cmd, args) {
	const conn = await ensureEditor(opts, { mod: args.mod, map: args.map });
	const r = await control(conn, 'run', { cmd, args });
	if (r.error) throw new Error(r.error);
	return r.result;
}

// ---- Serving the page

async function makeBridge(opts) {
	const { createBridge, runStack } = await import('./server/bridge.js');
	const bin = stackBin();
	return createBridge({
		name: 'cli',
		stateDir: () => stateDir(opts),
		runtimeDir: () => path.join(dataRoot(), 'runtime'),
		repoDir,
		assetBase: () => assetBase(opts),
		fetch: (url, init) => fetch(url, init),
		stack: (args, input) => { if (!bin) throw new Error('ragnarok-stack is not installed here'); return runStack(bin, { ...process.env, RAGNAROKMAC_STATE: stateDir(opts) }, args, input); },
		action: async (name, body) => {
			if (name === 'open-file') {
				const file = path.join(stateDir(opts), 'mods', body.mod, ...String(body.path).split('/'));
				if (!fs.existsSync(file)) throw new Error(`${body.path} does not exist yet: save first`);
				const opener = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'explorer' : 'xdg-open';
				spawn(opener, [file], { detached: true, stdio: 'ignore' }).unref();
				return { message: `Opened ${file}` };
			}
			throw new Error('Test in game needs the app: open the map editor from Settings → Tools.');
		},
		log: text => process.stderr.write(text + '\n'),
	});
}

async function serve(opts, { quiet = false, writeConnection = true } = {}) {
	const { startServer, writePrivate } = await import('./server/http.js');
	const bridge = await makeBridge(opts);
	const token = crypto.randomBytes(32).toString('hex');
	const server = await startServer({ bridge, remote: bridge.remote, root: HERE, token, port: opts.port || 0, log: t => process.stderr.write(t + '\n') });
	const conn = { port: server.port, token, url: `http://127.0.0.1:${server.port}/`, pid: process.pid, serve: true };
	const file = connectionFile(opts);
	let wrote = false;
	if (writeConnection) {
		const existing = await liveStatus(opts);
		if (!existing || !existing.connected) { writePrivate(file, JSON.stringify(conn, null, 2) + '\n'); wrote = true; }
	}
	const cleanup = () => { if (wrote) { try { const now = JSON.parse(fs.readFileSync(file, 'utf8')); if (now.pid === process.pid) fs.rmSync(file, { force: true }); } catch { /* gone */ } } };
	process.on('exit', cleanup);
	process.on('SIGINT', () => { cleanup(); process.exit(0); });
	process.on('SIGTERM', () => { cleanup(); process.exit(0); });
	if (!quiet) process.stderr.write(`Map editor: ${conn.url}  (Ctrl+C to stop)\n`);
	return { server, conn, bridge };
}

/** A browser for the page, with no window: Playwright's Chromium, or Electron from a checkout. */
async function startHeadless(opts, { mod, map } = {}) {
	const { server, conn } = await serve(opts, { quiet: true, writeConnection: false });
	const query = new URLSearchParams();
	if (mod) query.set('mod', mod);
	if (map) query.set('map', map);
	const url = `${conn.url}?${query}`;
	let browser = null, page = null, child = null;
	const tryPlaywright = async () => {
		const pw = await import(pathToFileURL(require.resolve('playwright')).href).catch(() => import(pathToFileURL(require.resolve('@playwright/test')).href));
		const chromium = pw.chromium || (pw.default && pw.default.chromium);
		browser = await chromium.launch({ headless: true, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
		page = await browser.newPage({ viewport: { width: Number(opts.width || 1280), height: Number(opts.height || 800) } });
		page.on('console', m => { if (m.type() === 'error' && process.env.MAP_EDITOR_DEBUG) process.stderr.write(`page: ${m.text()}\n`); });
		await page.goto(url);
	};
	const tryElectron = async () => {
		const electron = require('electron');
		child = spawn(electron, [path.join(HERE, 'server', 'headless-electron.cjs'), url, String(opts.width || 1280), String(opts.height || 800)], { stdio: 'ignore' });
	};
	try { await tryPlaywright(); } catch (e1) {
		try { await tryElectron(); } catch (e2) {
			await server.close();
			throw new Error(`No editor is open and none could be started here (${e1.message.split('\n')[0]}; ${e2.message.split('\n')[0]}). In the app, open the map editor from Settings → Tools (and check Settings → Play with an AI agent → Map editor is on); or run \`ragnarok-map serve\` and open its address in a browser.`);
		}
	}
	await waitForPage(conn, 90000);
	return { conn, close: async () => { if (browser) await browser.close().catch(() => {}); if (child) child.kill(); await server.close(); } };
}

// ---- Offline: commands on a mod's files, no page

async function offline(opts, cmd, args) {
	const { openMap, createMap } = await import('./lib/map.js');
	const { runCommand, COMMANDS } = await import('./lib/commands.js');
	const { attachProject, buildModFiles, savePayload, incomingWarps } = await import('./lib/project.js');
	const { renderMinimap, minimapTextures } = await import('./lib/minimap.js');
	const { encodeBmp, decodeImage } = await import('./lib/image.js');
	const { validate } = await import('./lib/validate.js');
	const { bakeLightmaps } = await import('./lib/lightmap.js');
	const mod = opts.mod || args.mod, map = opts.map || args.map;
	delete args.mod; delete args.map;
	if (!mod) throw new Error('offline needs --mod (and --map)');
	const bridge = await makeBridge(opts);
	const project = bridge.readProject(mod);
	bridge.setOpenMod(mod);
	let doc;
	if (cmd === 'map.new') {
		doc = createMap({ name: args.name || map, width: Number(args.width || 80), height: Number(args.height || 80) });
		attachProject(doc, project);
		doc.testPoint = { x: doc.gat.width >> 1, y: doc.gat.height >> 1 };
		if (args.texture) runCommand(doc, 'texture.paint', { texture: args.texture, x0: 0, y0: 0, x1: doc.gat.width - 1, y1: doc.gat.height - 1 });
	} else {
		if (!map) throw new Error('offline needs --map');
		const file = async ext => { const b = await bridge.asset(`data/${map}.${ext}`); return b ? new Uint8Array(b) : null; };
		const [gnd, rsw, gat] = await Promise.all([file('gnd'), file('rsw'), file('gat')]);
		if (!gnd) throw new Error(`no map ${map} in mods/${mod} or the client (is the app running, for the client's maps?)`);
		doc = openMap({ name: map, gnd, rsw, gat, source: { kind: project.exists ? 'mod' : 'client', map } });
		if (args.as) { const { renameMap } = await import('./lib/map.js'); renameMap(doc, args.as); delete args.as; }
		attachProject(doc, project);
	}
	let result;
	const save = async () => {
		const textures = new Map();
		for (const t of minimapTextures(doc)) { const b = await bridge.asset(t.path); if (b) { try { const img = decodeImage(new Uint8Array(b), t.path); if (img) textures.set(t.name, img); } catch { /* skip */ } } }
		const built = buildModFiles(doc, project, { minimap: encodeBmp(renderMinimap(doc, textures)) });
		const out = bridge.save(savePayload(mod, built));
		return { ...out, summary: built.summary };
	};
	if (cmd === 'map.new' || cmd === 'map.save' || cmd === 'map.open') result = await save();
	else if (cmd === 'map.check') {
		// Files can only be checked against the client through its asset server.
		const up = await fetch(`${assetBase(opts)}/api/health`).then(r => r.ok, () => false);
		result = await validate(doc, { incoming: incomingWarps(doc.name, project.scripts), exists: up ? async p => !!(await bridge.asset(p)) : null });
		if (!up) result.push({ level: 'note', code: 'files-unchecked', message: 'The game\'s asset server is not running, so the textures, models and sounds were not checked against your client. Start the game once and check again.' });
	}
	else if (cmd === 'lightmap.bake') { result = bakeLightmaps(doc, { shadows: true, samples: Number(args.samples || 1) }); result.saved = await save(); result.note = 'Offline baking casts shadows from the hills only; bake in the editor for the models\' shadows.'; }
	else if (cmd === 'batch') {
		const steps = Array.isArray(args.steps) ? args.steps : JSON.parse(fs.readFileSync(args.file, 'utf8'));
		result = [];
		for (const [c, a] of steps) result.push(runCommand(doc, c, a || {}).result);
		result = { results: result, saved: await save() };
	} else if (COMMANDS[cmd]) {
		result = runCommand(doc, cmd, args).result;
		if (COMMANDS[cmd].parts.length) result = { result, saved: await save() };
	} else throw new Error(`offline cannot run ${cmd}: it runs the editing commands, map.new, map.save, map.check, lightmap.bake and batch`);
	return result;
}

// ---- MCP, on stdio

async function mcp(opts) {
	const { createMcp } = await import('./server/mcp.js');
	const handle = createMcp({ run: (cmd, args) => runLive(opts, cmd, args) });
	const write = message => process.stdout.write(JSON.stringify(message) + '\n');
	let buffer = '';
	process.stdin.setEncoding('utf8');
	process.stdin.on('data', chunk => {
		buffer += chunk;
		let nl;
		while ((nl = buffer.indexOf('\n')) >= 0) {
			const line = buffer.slice(0, nl).trim();
			buffer = buffer.slice(nl + 1);
			if (!line) continue;
			let msg;
			try { msg = JSON.parse(line); } catch { write({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } }); continue; }
			handle(msg).then(r => { if (r) write(r); }, e => write({ jsonrpc: '2.0', id: msg.id, error: { code: -32603, message: e.message } }));
		}
	});
	process.stdin.on('end', async () => { if (headless) await headless.close(); process.exit(0); });
}

// ---- Main

const HELP = `ragnarok-map: the Ragnarok Offline map editor from the command line.

  ragnarok-map serve [--port N]                 the editor in a browser
  ragnarok-map open --map X [--mod M] [--as Y]  open a map in the editor
  ragnarok-map <command> [--arg value ...]      run a command in the open editor
  ragnarok-map shot [--out file.png] [--x --y --distance --yaw --pitch --top --width --height]
  ragnarok-map offline --mod M --map X <command> [--arg value ...]
  ragnarok-map mcp                              MCP server on stdio
  ragnarok-map help                             every command and its arguments

See AGENTS.md beside this file.`;

async function main() {
	const [verb, ...argv] = process.argv.slice(2);
	const { opts, rest } = parseArgs(argv);
	if (!verb || verb === '--help' || verb === '-h') { process.stdout.write(HELP + '\n'); return; }
	if (verb === 'serve') {
		const { conn } = await serve(opts);
		print({ url: conn.url, connection: connectionFile(opts) });
		if (opts.open) spawn(process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'explorer' : 'xdg-open', [conn.url], { detached: true, stdio: 'ignore' }).unref();
		return; // keeps running
	}
	if (verb === 'mcp') return mcp(opts);
	if (verb === 'help' && !(await liveStatus(opts))?.connected) {
		const { allCommands } = await import('./server/mcp.js');
		print({ commands: allCommands() });
		return;
	}
	if (verb === 'offline') {
		const cmd = rest.shift();
		print(await offline(opts, cmd, commandArgs(opts, rest)));
		return;
	}
	try {
		if (verb === 'open') {
			const conn = await ensureEditor(opts, { mod: opts.mod, map: opts.map });
			const r = await control(conn, 'run', { cmd: 'map.open', args: { map: opts.map, mod: opts.mod, as: opts.as } });
			if (r.error) throw new Error(r.error);
			print(r.result);
		} else if (verb === 'shot') {
			const args = commandArgs(opts, rest);
			const cam = {};
			for (const k of ['x', 'y', 'distance', 'yaw', 'pitch', 'top', 'fit']) if (args[k] !== undefined) cam[k] = args[k];
			if (args.mod || args.map) await runLive(opts, 'map.open', { mod: args.mod, map: args.map });
			if (Object.keys(cam).length) await runLive(opts, 'view.camera', cam);
			const shot = await runLive(opts, 'view.screenshot', { width: args.width, height: args.height, labels: args.labels });
			const out = opts.out || path.join(process.cwd(), `map-${Date.now()}.png`);
			fs.writeFileSync(out, Buffer.from(shot.png, 'base64'));
			print({ saved: out, camera: shot.camera });
		} else {
			const args = commandArgs(opts, rest);
			const result = await runLive(opts, verb, args);
			if (result && result.png && opts.out) { fs.writeFileSync(opts.out, Buffer.from(result.png, 'base64')); print({ saved: opts.out }); }
			else print(result ?? null);
		}
	} catch (e) {
		if (headless) await headless.close();
		fail(e.message);
	}
	if (headless) await headless.close();
}

main().catch(e => fail(e.message));
