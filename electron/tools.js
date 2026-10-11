'use strict';
// Settings -> Tools (#195): small pages that help while making mods, opened
// in their own windows and fed from the running server.
//
// The pages are self-contained HTML (tools/<id>/), written to work from a
// folder with files dropped on them. Here they are served from the app under
// ro-tool://<id>/, and the files they would look for next to themselves are
// answered from the server instead, so nothing needs extracting by hand and
// nothing needs Python:
//
//   ro-tool://mob-browser/mob_db.yml        ragnarok-stack export-table mob_db
//   ro-tool://mob-browser/item_db_*.yml     ... item_db_equip / _etc / _usable
//   ro-tool://item-browser/itemInfo.lua     the client's item table, as served
//   http://127.0.0.1:3338/item-icons.js     AegisName -> icon, built here
//   ro-tool://mob-browser/monster-sprites.json  monster id -> sprite name
//   ro-tool://mob-browser/sprite/<name>.spr|act the monster's sprite, from the
//                                            asset server (so it is same-origin)
//   ro-tool://db-browser/api/<call>          the database browser's bridge,
//                                            see db-bridge.js
//   ro-tool://control-panel/api/<call>       the control panel's, see
//                                            cp-bridge.js
//   ro-tool://control-panel/look-tables.json job, hair, headgear and garment
//                                            sprite names, from the client
//   ro-tool://control-panel/item-names.json?ids=..  names and icons of items
//   ro-tool://control-panel/asset/data/sprite/...   a player sprite or
//                                            palette, from the asset server
//   ro-tool://map-editor/asset/..., api/...  the map editor's bridge, see
//                                            map-editor.js
//
// The tables come with the mods' db/import laid over them, so a mod's
// monsters and items show up too. Each window has its own session and no
// preload: a tool page cannot reach the app.

const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');
const vm = require('node:vm');

// A client table, as text: the translation's are UTF-8, older ones and many
// a mod's are CP949 (EUC-KR). Decoded one file at a time, since the item
// tables below mix the two.
function decode(buf) {
	try { return new TextDecoder('utf-8', { fatal: true }).decode(buf); } catch { return new TextDecoder('euc-kr').decode(buf); }
}

const quoted = text => [...text.matchAll(/'([^']+)'/g)].map(m => m[1]);

// What the generated client config says -- the same lists the game reads.
function clientConfig(web) {
	try { return fs.readFileSync(path.join(web, 'Config.local.js'), 'utf8'); } catch { return ''; }
}

/**
 * The client's item tables, mods' included, as one text. The client lists
 * them newest mod first and base last, and keeps the *first* definition of an
 * item; the Tools pages keep the *last* one they parse. So they are joined in
 * the reverse order, and a mod's item -- new or renamed -- shows as it does in
 * game. `web` is the served asset root (state/assets).
 */
function clientItemInfo(web) {
	const listed = /customItemInfo:\s*\[([^\]]*)\]/.exec(clientConfig(web));
	// With no mod item tables the config names none, and the client reads the
	// first base table it finds.
	const base = ['System/itemInfo.lua', 'System/itemInfo.lub', 'System/itemInfo_true.lua', 'System/itemInfo_true.lub'];
	const exists = rel => fs.existsSync(path.join(web, rel));
	const tables = listed ? quoted(listed[1]).filter(exists) : base.filter(exists).slice(0, 1);
	if (tables.length === 0) throw new Error('The client\'s item table is not there yet. Start the game once, then try again.');
	return Buffer.from(tables.reverse().map(rel => decode(fs.readFileSync(path.join(web, rel)))).join('\n'), 'utf8');
}

/**
 * Mods' sprite tables (customLuaTables in the generated config: an id file and
 * a name file each, in the official format), as id -> sprite name, later mods
 * over earlier ones as the client merges them. `kind` is monster
 * (npcidentity / jobname), accessory (accessoryid / accname: headgear) or
 * robe (spriterobeid / spriterobename: garments).
 */
const VIEW_ID_PREFIX = { monster: 'JT_', accessory: 'ACCESSORY_', robe: 'ROBE_' };
function clientViewTable(web, kind) {
	const tables = /customLuaTables:\s*\{([^\n]*)\}/.exec(clientConfig(web));
	const listed = tables && new RegExp(`${kind}:\\s*\\[((?:\\s*\\[[^\\]]*\\]\\s*,?)*)\\]`).exec(tables[1]);
	const out = {};
	if (!listed) return out;
	const read = f => { try { return decode(fs.readFileSync(f)); } catch { return ''; } };
	const idPattern = new RegExp(`\\b(${VIEW_ID_PREFIX[kind]}[A-Za-z0-9_]+)\\s*=\\s*(\\d+)`, 'g');
	for (const pair of listed[1].matchAll(/\[([^\]]*)\]/g)) {
		const [idFile, nameFile] = quoted(pair[1]).map(rel => path.join(web, rel));
		const ids = {};
		for (const m of read(idFile).matchAll(idPattern)) ids[m[1]] = m[2];
		for (const m of read(nameFile).matchAll(/\[\s*(?:[A-Za-z_][A-Za-z0-9_]*\.)?([A-Za-z0-9_]+)\s*\]\s*=\s*"([^"]+)"/g)) {
			const id = /^\d+$/.test(m[1]) ? m[1] : ids[m[1]];
			if (id) out[id] = m[2];
		}
	}
	return out;
}

function clientMonsterSprites(web) {
	return clientViewTable(web, 'monster');
}

/**
 * Item names and icons from the client's item tables (clientItemInfo), as
 * id -> { name, resource, slots }. The last definition of an id wins, as the
 * joined tables are ordered for.
 */
function clientItemNames(web) {
	const raw = clientItemInfo(web).toString('utf8');
	const starts = [...raw.matchAll(/\[\s*(\d+)\s*\]\s*=\s*\{/g)];
	const out = {};
	starts.forEach((m, i) => {
		const chunk = raw.slice(m.index, i + 1 < starts.length ? starts[i + 1].index : raw.length);
		const name = /\bidentifiedDisplayName\s*=\s*"([^"]*)"/.exec(chunk);
		if (!name) return;
		const res = /\bidentifiedResourceName\s*=\s*"([^"]*)"/.exec(chunk);
		const slots = /\bslotCount\s*=\s*(\d+)/.exec(chunk);
		out[m[1]] = { name: name[1], resource: res ? res[1] : '', slots: slots ? Number(slots[1]) : 0 };
	});
	return out;
}

/**
 * roBrowser's own sprite-name tables (src/DB), which it bundles rather than
 * serving: job -> body sprite and palette names, hair style order, headgear
 * and garment view ids -> sprite names. package.sh copies them beside the
 * client as client-tables/, the way it copies MonsterTable.js.
 *
 * They are ES modules that build their tables in code (JobNameTable copies
 * entries between jobs), so they are run, in a context of their own, rather
 * than read with a pattern. Their strings are CP949 bytes written as \x
 * escapes; they come out here as the Korean they spell, which is how the
 * asset server is asked for files.
 */
const CLIENT_TABLES = {
	jobs: 'Jobs/JobConst.js', classes: 'Jobs/JobNameTable.js', palettes: 'Jobs/PalNameTable.js',
	hair: 'Jobs/HairIndexTable.js', hats: 'Items/HatTable.js', robes: 'Items/RobeTable.js',
};
function clientTableModule(runtimeDir, rel, scope) {
	const candidates = [
		path.join(runtimeDir, 'client-tables', path.basename(rel)),
		// Running from source before package.sh has been run.
		path.join(__dirname, '..', 'vendor', 'roBrowserLegacy', 'src', 'DB', rel),
	];
	const file = candidates.find(f => fs.existsSync(f));
	if (!file) throw new Error(`The client's ${path.basename(rel)} is missing from this build.`);
	const source = fs.readFileSync(file, 'utf8')
		.replace(/^\s*import\s+\w+\s+from\s+['"][^'"]+['"];?[ \t\r]*$/gm, '')
		.replace(/\bexport\s+default\s+/, '__module.result = ');
	const context = { __module: {}, ...scope };
	vm.runInNewContext(source, context, { filename: file, timeout: 2000 });
	return context.__module.result;
}

function clientLookTables(runtimeDir, web) {
	const load = (key, scope) => clientTableModule(runtimeDir, CLIENT_TABLES[key], scope);
	const korean = text => (typeof text === 'string' ? decode(Buffer.from(text, 'latin1')) : text);
	const names = table => Object.fromEntries(Object.entries(table).map(([id, name]) => [id, korean(name)]));
	const JobId = load('jobs', {});
	const JobNameTable = load('classes', { JobId });
	const jobs = {};
	for (const [key, id] of Object.entries(JobId)) if (!(id in jobs)) jobs[id] = key;
	return {
		jobs,
		classes: names(JobNameTable),
		palettes: names(load('palettes', { JobId, JobNameTable })),
		hair: load('hair', {}),
		// Mods' headgear and garments over the client's, as the game merges them.
		hats: { ...names(load('hats', {})), ...clientViewTable(web, 'accessory') },
		robes: { ...names(load('robes', {})), ...clientViewTable(web, 'robe') },
		costume: [JobId.COSTUME_SECOND_JOB_START, JobId.COSTUME_SECOND_JOB_END],
	};
}

const SCHEME = 'ro-tool';
const PARTITION = 'persist:ro-tools';
const ROOT = path.join(__dirname, '..', 'tools');

const TOOLS = [
	{
		id: 'item-browser',
		name: 'Item browser',
		description: 'Every item the game client knows: names, descriptions, icons and slots, grouped by type.',
		page: 'item-browser.html',
		author: 'BlaXun',
	},
	{
		id: 'mob-browser',
		name: 'Monster browser',
		description: 'Every monster on your server, mods included: stats, skills, drops with their icons, MVPs.',
		page: 'mob-browser.html',
		author: 'BlaXun',
		needsServer: true,
	},
	{
		id: 'log-viewer',
		name: 'Log viewer',
		description: 'The game client, the servers, the app and the engine, logging live as you play: for debugging a mod or an NPC script.',
		page: 'log-viewer.html',
		author: 'Ragnarok Offline',
	},
	{
		id: 'db-browser',
		name: 'Database',
		description: 'Browse the server\'s database table by table, and edit rows: characters, inventories, accounts. Saving stops the game for a few seconds and takes a backup first.',
		page: 'db-browser.html',
		needsServer: true,
	},
	{
		id: 'map-editor',
		name: 'Map editor',
		description: 'Make a map, or change one of the client\'s, and turn it into a mod: the ground, its textures, walkability, water and light, the models on it, its NPCs, warps and monsters, its sky, weather and music. Test in game in one click. AI agents can use it too (ragnarok-map, MCP).',
		page: 'map-editor.html',
		author: 'Ragnarok Offline',
		needsServer: true,
		width: 1440, height: 900,
	},
	{
		id: 'music-browser',
		name: 'Music browser',
		description: 'Every music track in your client and your mods, which maps play each one, and a play button: for picking a map\'s music.',
		page: 'music.html',
		// The map editor's page and bridge.
		dir: 'map-editor',
		author: 'Ragnarok Offline',
		needsServer: true,
	},
	{
		id: 'control-panel',
		name: 'Control panel',
		description: 'Every account and character on your server: how they look, their level, zeny, equipment and where they are. Move a stuck character to its save point, delete a character the way the game does, or make an account.',
		page: 'control-panel.html',
		needsServer: true,
	},
];

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.yml': 'text/yaml; charset=utf-8', '.lua': 'application/octet-stream', '.png': 'image/png', '.json': 'application/json' };

// Registered before the app is ready: a standard, secure scheme, so relative
// URLs and fetch() work in the pages the way they would over HTTP.
const schemePrivileges = { scheme: SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } };

/**
 * @param {object} deps
 *   BrowserWindow, session, net, shell, dialog, stackBin(), stackEnv(), stateDir(), runtimeDir(), log(text), icon
 *   and, for the log viewer: nebulaLogsDir(), redact(text), openGameDevTools()
 */
// The asset origin the tool pages name (ASSET_ORIGIN in tools/*/*.html). A
// copy whose asset server was moved (electron/ports.js) answers somewhere
// else, so requests to this one are sent on to wherever that is.
const PAGE_ASSET_HOST = '127.0.0.1:3338';

function createTools(deps) {
	const assetHost = () => `127.0.0.1:${deps.assetPort ? deps.assetPort() : 3338}`;
	const isAsset = url => url.host === PAGE_ASSET_HOST || url.host === assetHost();
	const toAsset = href => { const url = new URL(href); url.host = assetHost(); return url.toString(); };
	const windows = new Map();
	// Converted icons, by path: the item list asks for hundreds at a time.
	const pngCache = new Map();
	let handlersReady = false;
	const dbBridge = require('./db-bridge').createDbBridge(deps);
	// The map editor (#414): its bridge, Test in game, and the agents' control server.
	const mapEditor = require('./map-editor').createMapEditor({
		stateDir: deps.stateDir, runtimeDir: deps.runtimeDir, assetPort: () => (deps.assetPort ? deps.assetPort() : 3338),
		net: deps.net, shell: deps.shell, log: deps.log, stackBin: deps.stackBin, stackEnv: deps.stackEnv,
		execPath: process.execPath,
		test: request => {
			if (!deps.mapEditorTest) throw new Error('Test in game is not available in this copy of the app.');
			return deps.mapEditorTest(request);
		},
		openWindow: (query, { show } = {}) => open('map-editor', { query, show }),
		addRoute: (route, options) => {
			if (!deps.addAgentRoute) throw new Error('This copy of the app has no local API for agents.');
			return deps.addAgentRoute(route, options);
		},
	});
	const cpBridge = require('./cp-bridge').createCpBridge(deps);
	// Parsed once per window: the item tables are megabytes.
	let itemNames = null;

	function exportTable(name) {
		const { cwd, env } = deps.stackEnv();
		return new Promise((resolve, reject) => {
			execFile(deps.stackBin(), ['export-table', name], { cwd, env, timeout: 60000, maxBuffer: 64 * 1024 * 1024 }, (error, stdout, stderr) => {
				if (error) reject(new Error((stderr || '').trim() || error.message));
				else resolve(stdout);
			});
		});
	}

	const itemInfo = () => clientItemInfo(path.join(deps.stateDir(), 'assets'));
	const modMonsterSprites = () => clientMonsterSprites(path.join(deps.stateDir(), 'assets'));

	// AegisName -> icon name, for the monster browser's drops: the server's
	// item tables give AegisName -> id, the client's gives id -> icon.
	async function itemIcons() {
		const ids = new Map();
		for (const table of ['item_db_equip', 'item_db_etc', 'item_db_usable']) {
			const text = await exportTable(table);
			for (const m of text.matchAll(/(?:^|\n) {2}- Id:\s*(\d+)([\s\S]*?)(?=\n {2}- Id:|\n\S|$)/g)) {
				const aegis = /\bAegisName:\s*(\S+)/.exec(m[2]);
				if (aegis) ids.set(aegis[1], Number(m[1]));
			}
		}
		const raw = itemInfo();
		let text;
		try { text = new TextDecoder('utf-8', { fatal: true }).decode(raw); } catch { text = new TextDecoder('euc-kr').decode(raw); }
		const icons = new Map();
		for (const m of text.matchAll(/\[\s*(\d+)\s*\]\s*=\s*\{/g)) {
			const chunk = text.slice(m.index, m.index + 4000);
			const res = /\bidentifiedResourceName\s*=\s*"([^"]*)"/.exec(chunk);
			if (res && res[1]) icons.set(Number(m[1]), res[1]);
		}
		const out = {};
		for (const [aegis, id] of ids) if (icons.has(id)) out[aegis] = icons.get(id);
		return 'window.__mobItemIcons=' + JSON.stringify(out) + ';if(window.__mobItemIconsReady)window.__mobItemIconsReady();\n';
	}

	// The client's monster id -> sprite name table (roBrowser's
	// DB/Monsters/MonsterTable.js, shipped beside the client by package.sh).
	let monsterSprites = null;
	function monsterTable() {
		if (monsterSprites) return { ...monsterSprites, ...modMonsterSprites() };
		const candidates = [
			path.join(deps.runtimeDir(), 'client-tables', 'MonsterTable.js'),
			// Running from source before package.sh has been run.
			path.join(__dirname, '..', 'vendor', 'roBrowserLegacy', 'src', 'DB', 'Monsters', 'MonsterTable.js'),
		];
		const file = candidates.find(f => fs.existsSync(f));
		if (!file) throw new Error('The client\'s monster table is missing from this build.');
		const out = {};
		for (const m of fs.readFileSync(file, 'utf8').matchAll(/^\s*(\d+)\s*:\s*'([^']+)'/gm)) out[m[1]] = m[2];
		// Mods' new monsters over the built-in table, as the client merges them.
		// Not cached with the built-ins: a mod can be switched on while the
		// window is open.
		monsterSprites = out;
		return { ...out, ...modMonsterSprites() };
	}

	// The log viewer (#202): its stream, and the two things it may ask of the
	// app. See log-stream.js.
	let logStreams = null;
	async function logViewerRoute(name, url, request) {
		if (name === 'stream') {
			if (!logStreams) {
				logStreams = require('./log-stream').createLogStreams({
					stateDir: deps.stateDir, nebulaLogsDir: deps.nebulaLogsDir,
					stackBin: deps.stackBin, stackEnv: deps.stackEnv, redact: deps.redact,
				});
			}
			return logStreams.response(url);
		}
		if (name === 'sources.json') return respond(JSON.stringify(require('./log-stream').SOURCES.map(({ id, name }) => ({ id, name }))), TYPES['.json']);
		if (name === 'mods.json') {
			// The enabled mods' names, for the badges on lines that name one.
			const { cwd, env } = deps.stackEnv();
			const rows = await new Promise(resolve => execFile(deps.stackBin(), ['mods'], { cwd, env, timeout: 30000 }, (error, stdout) => resolve(error ? '' : stdout)));
			const on = rows.split('\n').map(l => l.split('\t')).filter(r => r[0] === 'on' && r[1]).map(r => r[1]);
			return respond(JSON.stringify(on), TYPES['.json']);
		}
		if (name === 'api/devtools') {
			if (request.method !== 'POST') return respond('POST only', 'text/plain', 405);
			deps.openGameDevTools();
			return respond('{}', TYPES['.json']);
		}
		return null;
	}

	// The control panel (#230): its bridge, the client tables it draws a
	// character with, and the sprite files themselves.
	async function controlPanelRoute(name, url, request) {
		if (name.startsWith('api/')) return cpBridge(request, name.slice(4));
		if (name === 'look-tables.json') return respond(JSON.stringify(clientLookTables(deps.runtimeDir(), path.join(deps.stateDir(), 'assets'))), TYPES['.json']);
		if (name === 'item-names.json') {
			if (!itemNames) itemNames = clientItemNames(path.join(deps.stateDir(), 'assets'));
			const ids = (url.searchParams.get('ids') || '').split(',').filter(id => /^\d{1,10}$/.test(id)).slice(0, 500);
			return respond(JSON.stringify(Object.fromEntries(ids.filter(id => itemNames[id]).map(id => [id, itemNames[id]]))), TYPES['.json']);
		}
		// A player's sprite or palette, by the path the game asks for: only
		// sprites and palettes, nothing above data/.
		const asset = /^asset\/(data\/(?:sprite|palette)\/.+\.(?:spr|act|pal))$/i.exec(name);
		if (asset) {
			const parts = asset[1].split('/');
			if (parts.some(p => !p || p === '.' || p === '..' || p.includes('\\'))) return respond('not found', 'text/plain', 404);
			const res = await deps.net.fetch(`http://${assetHost()}/${parts.map(encodeURIComponent).join('/')}`, { bypassCustomProtocolHandlers: true });
			if (!res.ok) return respond(`no ${asset[1]}`, 'text/plain', 404);
			return respond(Buffer.from(await res.arrayBuffer()), 'application/octet-stream');
		}
		return null;
	}

	function respond(body, type, status = 200) {
		return new Response(body, { status, headers: { 'content-type': type, 'cache-control': 'no-store' } });
	}

	// One request to a tool: its page and files, and what they ask of the
	// server. The ro-tool:// scheme below and a headless app's admin page
	// (electron/headless/admin-server.js, /tools/<id>/...) both answer with this.
	async function route(id, name, url, request) {
		const tool = TOOLS.find(t => t.id === id);
		if (!tool) return respond('no such tool', 'text/plain', 404);
		try {
			if (tool.id === 'log-viewer') {
				const answer = await logViewerRoute(name, url, request);
				if (answer) return answer;
			}
			if (tool.id === 'db-browser' && name.startsWith('api/')) return await dbBridge(request, name.slice(4));
			if (tool.id === 'map-editor' || tool.dir === 'map-editor') {
				const answer = await mapEditor.route(name, url, request);
				if (answer) return answer;
			}
			if (tool.id === 'control-panel') {
				const answer = await controlPanelRoute(name, url, request);
				if (answer) return answer;
			}
			if (name === 'mob_db.yml' || /^item_db_(equip|etc|usable)\.yml$/.test(name)) {
				return respond(await exportTable(name.replace(/\.yml$/, '')), TYPES['.yml']);
			}
			if (name === 'itemInfo.lua') return respond(itemInfo(), TYPES['.lua']);
			if (name === 'monster-sprites.json') return respond(JSON.stringify(monsterTable()), TYPES['.json']);
			const sprite = /^sprite\/([^/]+)\.(spr|act)$/.exec(name);
			if (sprite) {
				// data/sprite/몬스터/ ("monster"): the asset server resolves the
				// Korean folder and the GRFs' lowercase names.
				const url = `http://${assetHost()}/data/sprite/${encodeURIComponent('몬스터')}/${encodeURIComponent(sprite[1].toLowerCase())}.${sprite[2]}`;
				const res = await deps.net.fetch(url, { bypassCustomProtocolHandlers: true });
				if (!res.ok) return respond(`no sprite ${sprite[1]}`, 'text/plain', 404);
				return respond(Buffer.from(await res.arrayBuffer()), 'application/octet-stream');
			}
			// The tool's own files, and nothing outside its folder.
			const dir = path.join(ROOT, tool.dir || tool.id);
			const file = path.resolve(dir, name || tool.page);
			if (!file.startsWith(dir + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) return respond('not found', 'text/plain', 404);
			return respond(fs.readFileSync(file), TYPES[path.extname(file)] || 'application/octet-stream');
		} catch (e) {
			deps.log(`tools: ${tool.id} ${name}: ${e.message}`);
			return respond(e.message, 'text/plain', 503);
		}
	}

	// What a tool page asks of the asset server, by path: the monster
	// browser's icon map (built here), the game's .bmp pictures with their
	// magenta made transparent, and anything else as it is.
	async function asset(pathAndQuery) {
		const url = new URL(pathAndQuery, `http://${assetHost()}`);
		if (url.pathname === '/item-icons.js') {
			try { return respond(await itemIcons(), TYPES['.js']); } catch (e) {
				deps.log(`tools: item icons: ${e.message}`);
				return respond('/* ' + e.message.replace(/\*\//g, '') + ' */', TYPES['.js'], 503);
			}
		}
		// The game's .bmp pictures, with their magenta turned transparent.
		if (/\.bmp$/i.test(url.pathname)) {
			const key = url.pathname;
			if (!pngCache.has(key)) {
				const res = await deps.net.fetch(url.toString(), { bypassCustomProtocolHandlers: true });
				if (!res.ok) return res;
				const original = Buffer.from(await res.arrayBuffer());
				const png = require('./bmp').bmpToPng(original);
				if (pngCache.size > 5000) pngCache.clear();
				pngCache.set(key, png ? { body: png, type: 'image/png' } : { body: original, type: 'image/bmp' });
			}
			const hit = pngCache.get(key);
			return new Response(hit.body, { headers: { 'content-type': hit.type, 'cache-control': 'max-age=3600' } });
		}
		return deps.net.fetch(url.toString(), { bypassCustomProtocolHandlers: true });
	}

	function setupSession() {
		if (handlersReady) return;
		const ses = deps.session.fromPartition(PARTITION);
		ses.protocol.handle(SCHEME, request => {
			const url = new URL(request.url);
			return route(url.hostname, decodeURIComponent(url.pathname.replace(/^\/+/, '')), url, request);
		});
		// The monster browser loads its icon map from the asset server, where
		// the old extraction script used to leave it. Answer that one URL here
		// and let everything else through.
		ses.protocol.handle('http', async request => {
			const url = new URL(request.url);
			if (isAsset(url) && (url.pathname === '/item-icons.js' || /\.bmp$/i.test(url.pathname))) return asset(url.pathname + url.search);
			// The pages only read from the asset server, so a moved one is a GET.
			if (isAsset(url) && url.host !== assetHost()) return deps.net.fetch(toAsset(request.url), { bypassCustomProtocolHandlers: true });
			return deps.net.fetch(request, { bypassCustomProtocolHandlers: true });
		});
		handlersReady = true;
	}

	// `query` and `show` are the map editor's: a map to open, and whether an
	// agent's editor window is shown.
	async function open(id, { query = '', show = true } = {}) {
		const tool = TOOLS.find(t => t.id === id);
		if (!tool) throw new Error(`No tool called ${id}`);
		const existing = windows.get(id);
		if (existing && !existing.isDestroyed()) {
			if (show) { existing.show(); existing.focus(); }
			if (id === 'map-editor' && query) {
				const q = new URLSearchParams(query);
				if (q.get('map')) await (await mapEditor.getBridge()).remote.run('map.open', { mod: q.get('mod') || undefined, map: q.get('map') }).catch(e => deps.log(`tools: map editor: ${e.message}`));
			}
			return;
		}
		setupSession();
		const ses = deps.session.fromPartition(PARTITION);
		// The pages cache what they parsed and restore it before looking for
		// anything newer. Start them clean, so a mod added since shows up. Not
		// the map editor's: its store is the unsaved map it can recover.
		if (id !== 'map-editor') await ses.clearStorageData({ storages: ['indexdb'] }).catch(() => {});
		if (id === 'control-panel') itemNames = null;
		// The map editor's routes for agents open with it, unless the player turned them off.
		if (id === 'map-editor' && (!deps.mapEditorAgentAllowed || deps.mapEditorAgentAllowed())) mapEditor.ensureControl().catch(e => deps.log(`tools: map editor: ${e.message}`));
		const win = new deps.BrowserWindow({
			width: tool.width || 1280, height: tool.height || 860, show,
			title: `${tool.name} — Ragnarok Offline`,
			icon: deps.icon,
			webPreferences: { partition: PARTITION, contextIsolation: true, nodeIntegration: false, sandbox: true },
		});
		windows.set(id, win);
		win.on('closed', () => {
			windows.delete(id);
			// Stop following logs with no viewer left to show them.
			if (id === 'log-viewer' && logStreams) logStreams.stopAll();
		});
		win.on('page-title-updated', e => e.preventDefault());
		// A page that asks before it is left (the map editor, with changes not
		// saved to a mod) gets no question from Electron: the close is just
		// cancelled, and the window's close button does nothing. Ask here. The
		// window stays until the answer; Close destroys it, which skips the
		// page's handler.
		win.webContents.on('will-prevent-unload', () => {
			if (!deps.dialog) return;
			deps.dialog.showMessageBox(win, {
				type: 'question',
				buttons: ['Close', 'Keep editing'],
				defaultId: 1,
				cancelId: 1,
				message: `Close ${tool.name}?`,
				detail: id === 'map-editor'
					? 'This map has changes that are not saved to a mod. The editor keeps a copy, and offers to restore it the next time you open it.'
					: 'This page has changes it has not saved.',
			}).then(({ response }) => { if (response === 0 && !win.isDestroyed()) win.destroy(); }, () => {});
		});
		win.webContents.setWindowOpenHandler(({ url }) => {
			// Links out (rAthena docs, GitHub) open in the browser, not here.
			if (/^https?:\/\//.test(url)) deps.shell.openExternal(url);
			return { action: 'deny' };
		});
		win.webContents.on('will-navigate', event => {
			if (!event.url.startsWith(`${SCHEME}://${id}/`)) event.preventDefault();
		});
		await win.loadURL(`${SCHEME}://${id}/${tool.page}${query ? `?${query}` : ''}`);
	}

	return {
		route,
		asset,
		list: () => TOOLS.map(({ id, name, description, author, needsServer }) => ({ id, name, description, author, needsServer: !!needsServer })),
		open,
		mapEditor,
	};
}

module.exports = { createTools, schemePrivileges, SCHEME, TOOLS, clientItemInfo, clientMonsterSprites, clientViewTable, clientItemNames, clientLookTables };
