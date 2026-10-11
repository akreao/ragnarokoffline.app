'use strict';
// Settings -> Tools -> Map editor (#414): the app's half of it.
//
// The page is tools/map-editor/, served under ro-tool://map-editor/ like the
// other Tools. What it asks of its host -- the client's files, the mods, the
// server's tables, saving -- is answered by the same bridge the command line
// uses (tools/map-editor/server/bridge.js); this file adapts it to Electron's
// protocol handler and adds what only the app can do:
//
//   test          switch the mod on, restart the server, put a character on
//                 the map, reopen the game (Test in game)
//   characters    the player's characters, for Test in game
//   open-file     open a mod's dialogue file in the player's text editor
//
// It also runs the control server agents use: `ragnarok-map` and its MCP
// server read <state>/map-editor/connection.json (port and token, readable
// only by the user) and send commands to the open editor page. The first time
// the editor is opened in a session, that folder gets the launcher and the
// agent guide.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { pathToFileURL } = require('node:url');

const ROOT = path.join(__dirname, '..', 'tools', 'map-editor');
const importEsm = rel => import(pathToFileURL(path.join(ROOT, rel)).href);

function shellQuote(s) { return `'${String(s).replace(/'/g, `'\\''`)}'`; }

/**
 * @param {object} deps
 *   stateDir(), runtimeDir(), assetPort(), net, shell, log(text),
 *   stackBin(), stackEnv(),
 *   test({ mod, map, x, y, char }) -> Promise<{ message }>  the app's Test in game
 *   openWindow(query, { show })   open (or focus) the editor window
 *   windowOpen() -> bool
 *   execPath                       the app binary, for the CLI launcher
 *   addRoute(route, { preferredPort }) -> Promise<{ port, remove }>
 *                                  a route on the app's local API for agents
 */
/**
 * Copy a folder out of the app. fs.cpSync cannot: it opens the folder with
 * opendir, which Electron's asar support does not cover (ENOTDIR), while
 * readdir and readFile work inside the archive.
 */
function copyOut(from, to) {
	fs.mkdirSync(to, { recursive: true });
	for (const d of fs.readdirSync(from, { withFileTypes: true })) {
		const src = path.join(from, d.name), dst = path.join(to, d.name);
		if (d.isDirectory()) copyOut(src, dst);
		else if (d.isFile()) fs.writeFileSync(dst, fs.readFileSync(src));
	}
}

function createMapEditor(deps) {
	let bridge = null;
	let control = null;
	const dir = () => path.join(deps.stateDir(), 'map-editor');

	async function getBridge() {
		if (bridge) return bridge;
		const { createBridge, runStack } = await importEsm('server/bridge.js');
		const { env } = deps.stackEnv();
		bridge = createBridge({
			name: 'app',
			actions: ['test', 'characters', 'open-file'],
			stateDir: deps.stateDir,
			runtimeDir: deps.runtimeDir,
			repoDir: () => { const r = path.join(__dirname, '..'); return fs.existsSync(path.join(r, 'vendor')) ? r : null; },
			assetBase: () => `http://127.0.0.1:${deps.assetPort()}`,
			fetch: (url, init) => deps.net.fetch(url, { ...init, bypassCustomProtocolHandlers: true }),
			stack: (args, input) => runStack(deps.stackBin(), env, args, input),
			action,
			log: deps.log,
		});
		return bridge;
	}

	async function characters() {
		const { runCp } = require('./cp-bridge');
		const answer = await runCp(deps, { action: 'characters' }, 60000);
		const out = [];
		for (const a of answer.accounts || []) for (const c of a.characters || []) out.push({ char_id: c.char_id, name: c.name, base_level: c.base_level, last_map: c.last_map, account: a.username });
		return { characters: out };
	}

	async function action(name, body) {
		if (name === 'characters') return characters();
		if (name === 'test') {
			const { mod, map, x, y, char } = body || {};
			if (!/^[A-Za-z0-9_-]{1,64}$/.test(mod || '')) throw new Error('Save the map into a mod first.');
			if (!/^[a-z0-9_@-]{1,11}$/.test(map || '')) throw new Error('That is not a map name rAthena keeps.');
			return deps.test({ mod, map, x: Math.max(0, Math.round(Number(x) || 0)), y: Math.max(0, Math.round(Number(y) || 0)), char: char ? String(char) : null });
		}
		if (name === 'open-file') {
			const mod = String(body.mod || ''), rel = String(body.path || '');
			if (!/^[A-Za-z0-9_-]{1,64}$/.test(mod) || !/^npc\/[A-Za-z0-9_@.-]+\.txt$/.test(rel)) throw new Error('The map editor only opens a mod\'s npc/ scripts.');
			const file = path.join(deps.stateDir(), 'mods', mod, ...rel.split('/'));
			if (!fs.existsSync(file)) throw new Error(`${rel} is not there yet: save the map first.`);
			const err = await deps.shell.openPath(file);
			if (err) throw new Error(err);
			return { message: `Opened ${rel}. Save it, then Test in game to try the dialogue.`, file };
		}
		throw new Error(`no action ${name}`);
	}

	/** ro-tool://map-editor/<name>: the bridge's routes, or null for the page's own files. */
	async function route(name, url, request) {
		if (!name.startsWith('asset/') && !name.startsWith('api/')) return null;
		// Only the editor's own page, as the other Tools' bridges check.
		const origin = request.headers.get('origin');
		if (origin && origin !== 'ro-tool://map-editor' && origin !== 'ro-tool://music-browser') return new Response('not allowed', { status: 403 });
		const b = await getBridge();
		const body = request.method === 'POST' ? new Uint8Array(await request.arrayBuffer()) : null;
		const answer = await b.handle({ method: request.method, path: name, query: url.searchParams, body });
		if (!answer) return new Response('not found', { status: 404 });
		return new Response(answer.body, { status: answer.status, headers: { 'content-type': answer.type, 'cache-control': answer.cache || 'no-store' } });
	}

	/** The launcher a terminal or an MCP client runs: the app's own binary, as Node, on a copy of the CLI. */
	function writeLauncher() {
		const cliDir = path.join(dir(), 'cli');
		// The editor's folder, copied out of the app (asar) so plain Node can read it.
		fs.rmSync(cliDir, { recursive: true, force: true });
		copyOut(ROOT, cliDir);
		const cli = path.join(cliDir, 'cli.js');
		const bin = deps.execPath;
		if (process.platform === 'win32') {
			const file = path.join(dir(), 'ragnarok-map.cmd');
			fs.writeFileSync(file, `@echo off\r\nset "ELECTRON_RUN_AS_NODE=1"\r\nset "RAGNAROKMAC_STATE=${deps.stateDir()}"\r\n"${bin}" "${cli}" %*\r\n`);
			return file;
		}
		const file = path.join(dir(), 'ragnarok-map');
		fs.writeFileSync(file, `#!/bin/sh\n# Ragnarok Offline's map editor from the command line. See AGENTS.md beside this file.\nELECTRON_RUN_AS_NODE=1 RAGNAROKMAC_STATE=${shellQuote(deps.stateDir())} exec ${shellQuote(bin)} ${shellQuote(cli)} "$@"\n`, { mode: 0o755 });
		try { fs.chmodSync(file, 0o755); } catch { /* ignore */ }
		return file;
	}

	const connectionFile = () => path.join(dir(), 'connection.json');
	const readConnection = () => { try { return JSON.parse(fs.readFileSync(connectionFile(), 'utf8')); } catch { return null; } };

	/**
	 * The map editor's routes on the app's local API for agents (the listener
	 * the game agent's /mcp is on, agent-play.js): MCP at /mcp/map, and the
	 * command line's control calls at /map/control/. Their token is the map
	 * editor's own, in connection.json. Opening the editor opens them unless
	 * the player turned them off (Settings, setAgentAccess).
	 */
	async function ensureControl() {
		if (control) return control;
		control = (async () => {
			const b = await getBridge();
			const { controlCalls } = await importEsm('server/http.js');
			const { createMcp } = await importEsm('server/mcp.js');
			const { mcpBody } = require('./agent-api');
			fs.mkdirSync(dir(), { recursive: true });
			const previous = readConnection();
			const token = previous && previous.app && /^[0-9a-f]{64}$/.test(previous.token || '') ? previous.token : crypto.randomBytes(32).toString('hex');
			const commands = {
				// Open the editor window for an agent, shown or not.
				'editor.open': async ({ mod, map, show } = {}) => {
					const query = new URLSearchParams();
					if (mod) query.set('mod', String(mod));
					if (map) query.set('map', String(map));
					await deps.openWindow(query.toString(), { show: show !== false });
					return { opened: true };
				},
			};
			let registered = null;
			const calls = controlCalls({ remote: b.remote, log: deps.log, commands, port: () => (registered ? registered.port : null) });
			// An MCP tool with no editor open opens one first, as the command line does.
			const mcp = createMcp({
				run: async (cmd, args) => {
					if (!b.remote.connected()) {
						await commands['editor.open']({ mod: args.mod, map: args.map });
						const until = Date.now() + 60000;
						while (!b.remote.connected()) {
							if (Date.now() > until) throw new Error('the map editor window did not come up');
							await new Promise(r => setTimeout(r, 300));
						}
					}
					return b.remote.run(cmd, args);
				},
			});
			registered = await deps.addRoute({
				match: p => p === '/mcp/map' || p.startsWith('/map/control/'),
				token: () => token,
				// A batch of edits is bigger than a game command.
				limit: 8 * 1024 * 1024,
				handle: async ({ method, path: p, body }) => {
					if (p === '/mcp/map') {
						if (method !== 'POST') return { status: 405, body: { error: 'POST /mcp/map' } };
						let message;
						try { message = JSON.parse(body.toString('utf8') || '{}'); } catch { return { status: 400, body: { error: 'not JSON' } }; }
						return mcpBody(message, mcp);
					}
					return calls({ method, what: p.slice('/map/control/'.length), body });
				},
			}, { preferredPort: previous && previous.base === '/map' ? previous.port : null });
			let command = null;
			try { command = writeLauncher(); } catch (e) { deps.log(`map editor: could not write the launcher: ${e.message}`); }
			try { fs.copyFileSync(path.join(ROOT, 'AGENTS.md'), path.join(dir(), 'AGENTS.md')); } catch (e) { deps.log(`map editor: could not write AGENTS.md: ${e.message}`); }
			const mcpUrl = `http://127.0.0.1:${registered.port}/mcp/map`;
			const { writePrivate } = await importEsm('server/http.js');
			writePrivate(connectionFile(), JSON.stringify({ app: true, port: registered.port, base: '/map', token, mcp: mcpUrl, command, guide: path.join(dir(), 'AGENTS.md') }, null, 2) + '\n');
			deps.log(`map editor: agents can connect at ${mcpUrl} (${connectionFile()})`);
			return registered;
		})();
		try { return await control; } catch (e) { control = null; throw e; }
	}

	/**
	 * Settings -> Play with an AI agent -> the map editor, and at every start.
	 * On: the routes, and connection.json for clients to find them. Off: no
	 * routes, and no file, so its token is gone with them (the next time it is
	 * turned on makes a new one).
	 */
	async function setAgentAccess(on) {
		if (on) { await ensureControl(); return; }
		await shutdown();
		const c = readConnection();
		if (c && c.app) fs.rmSync(connectionFile(), { force: true });
	}

	/** For Settings: how an agent connects to the map editor, once it is set up. */
	function agentInfo() {
		const c = readConnection();
		if (!c || !c.app || c.base !== '/map') return null;
		return {
			mcp: c.mcp, connection: connectionFile(), command: c.command, guide: c.guide,
			claudeCommand: `claude mcp add --transport http ragnarok-map ${c.mcp} --header "Authorization: Bearer ${c.token}"`,
		};
	}

	async function shutdown() {
		if (!control) return;
		try { const r = await control; await r.remove(); } catch { /* never started */ }
		control = null;
	}

	return { route, ensureControl, setAgentAccess, agentInfo, shutdown, getBridge };
}

module.exports = { createMapEditor, MAP_EDITOR_ROOT: ROOT };
