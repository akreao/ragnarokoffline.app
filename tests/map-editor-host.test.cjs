'use strict';
// The map editor's host side (#414): the bridge that reads the client and
// writes mods, the local server agents and browsers use, the live channel to
// the open page, the command line, and its place in Settings -> Tools.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { execFile, spawn } = require('node:child_process');

const ROOT = path.join(__dirname, '..', 'tools', 'map-editor');
const { pathToFileURL } = require('node:url');
// A file URL: import() takes no bare Windows paths.
const mod = name => import(pathToFileURL(path.join(ROOT, name)).href);
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'map-editor-'));

/** A stand-in asset server: one file, and the search route. */
function fakeAssets() {
	return new Promise(resolve => {
		const server = http.createServer((req, res) => {
			if (req.method === 'POST' && req.url === '/search') { res.end('data\\model\\a\\tree.rsm\ndata\\texture\\b\\grass.bmp'); return; }
			if (decodeURIComponent(req.url) === '/data/texture/필드바닥/grass.bmp') { res.end('from-the-grf'); return; }
			res.statusCode = 404; res.end('no');
		});
		server.listen(0, '127.0.0.1', () => resolve({ server, base: `http://127.0.0.1:${server.address().port}` }));
	});
}

async function bridgeFor(state, assets) {
	const { createBridge } = await mod('server/bridge.js');
	return createBridge({
		stateDir: () => state, runtimeDir: () => null, repoDir: () => null,
		assetBase: () => assets.base, fetch: (u, i) => fetch(u, i),
		stack: async () => { throw new Error('no server here'); }, action: null, log: () => {},
	});
}

test('saving writes only a map mod\'s own files, and nothing outside the mod', async () => {
	const state = tmp();
	const assets = await fakeAssets();
	try {
		const b = await bridgeFor(state, assets);
		const ok = b.save({ mod: 'my-isle', files: { 'data/x.gat': Buffer.from('gat').toString('base64'), 'npc/x.txt': { text: 'hi' }, 'mod.json': { text: '{}' } } });
		assert.deepEqual(ok.written.sort(), ['data/x.gat', 'mod.json', 'npc/x.txt']);
		assert.equal(fs.readFileSync(path.join(state, 'mods', 'my-isle', 'npc', 'x.txt'), 'utf8'), 'hi');
		for (const bad of ['../escape.txt', 'data/../../escape', 'conf/battle/feature.conf', 'System/x.lua', 'npc/x.exe']) {
			assert.throws(() => b.save({ mod: 'my-isle', files: { [bad]: { text: 'x' } } }), /does not write|bad path/, bad);
		}
		assert.throws(() => b.save({ mod: '../mods', files: {} }), /not a mod name/);
		assert.ok(!fs.existsSync(path.join(state, 'escape.txt')));
	} finally { assets.server.close(); }
});

test('a mod\'s own files are served before the client\'s, by any spelling of the folder', async () => {
	const state = tmp();
	const assets = await fakeAssets();
	try {
		const b = await bridgeFor(state, assets);
		const dir = path.join(state, 'mods', 'm', 'data', 'texture', 'À¯ÀúÀÎÅÍÆäÀÌ½º', 'map');
		fs.mkdirSync(dir, { recursive: true });
		fs.writeFileSync(path.join(dir, 'x.bmp'), 'mine');
		b.setOpenMod('m');
		assert.equal(String(await b.asset('data/texture/유저인터페이스/map/X.BMP')), 'mine', 'the Korean name finds the mojibake folder, any case');
		assert.equal(String(await b.asset('data/texture/필드바닥/grass.bmp')), 'from-the-grf');
		assert.equal(await b.asset('data/../../etc/passwd'), null);
		const found = await b.search('grass');
		assert.ok(found.includes('data\\texture\\b\\grass.bmp'));
	} finally { assets.server.close(); }
});

test('the local server checks the host, the page token and the control token', async () => {
	const state = tmp();
	const assets = await fakeAssets();
	const { startServer } = await mod('server/http.js');
	const b = await bridgeFor(state, assets);
	const s = await startServer({ bridge: b, remote: b.remote, root: ROOT, token: 't'.repeat(64), port: 0 });
	const at = p => `http://127.0.0.1:${s.port}${p}`;
	try {
		const page = await (await fetch(at('/'))).text();
		assert.match(page, /MAP_EDITOR_HOST/, 'the page is handed its token');
		assert.equal((await fetch(at('/api/projects'))).status, 403, 'no page token, no API');
		assert.equal((await fetch(at('/api/projects'), { headers: { 'x-map-editor': s.pageToken } })).status, 200);
		assert.equal((await fetch(at('/asset/data/texture/필드바닥/grass.bmp'))).status, 200, 'plain file reads need no token');
		assert.equal((await fetch(at('/control/status'))).status, 401);
		const status = await fetch(at('/control/status'), { headers: { authorization: `Bearer ${'t'.repeat(64)}` } });
		assert.equal((await status.json()).connected, false);
		const fromPage = await fetch(at('/control/status'), { headers: { authorization: `Bearer ${'t'.repeat(64)}`, origin: 'https://evil.example' } });
		assert.equal(fromPage.status, 403, 'a web page cannot drive the editor');
		// DNS rebinding: any other Host is refused.
		const rebound = await new Promise(resolve => http.get({ host: '127.0.0.1', port: s.port, path: '/', headers: { host: 'evil.example' } }, r => resolve(r.statusCode)));
		assert.equal(rebound, 421);
		// Paths that try to climb out of the editor's folder find nothing.
		for (const p of ['/../../../electron/main.js', '/..%2f..%2fpackage.json', '/lib/%2e%2e/%2e%2e/%2e%2e/README.md']) {
			const code = await new Promise(resolve => http.get({ host: '127.0.0.1', port: s.port, path: p }, r => resolve(r.statusCode)));
			assert.equal(code, 404, p);
		}
	} finally { await s.close(); assets.server.close(); }
});

test('a command waits for the open page\'s answer, and says so when there is no page', async () => {
	const { createRemote } = await mod('server/remote.js');
	const r = createRemote();
	await assert.rejects(r.run('status'), /No map editor is open/);
	const poll = r.page('poll', { info: { map: 'x' } });
	const pending = r.run('map.info', { a: 1 });
	const { commands } = await poll;
	assert.equal(commands[0].cmd, 'map.info');
	await r.page('result', { id: commands[0].id, result: { ok: 1 } });
	assert.deepEqual(await pending, { ok: 1 });
	const failing = r.run('x');
	const next = await r.page('poll', {});
	await r.page('result', { id: next.commands[0].id, error: 'nope' });
	await assert.rejects(failing, /nope/);
});

function cli(args, env) {
	return new Promise(resolve => execFile(process.execPath, [path.join(ROOT, 'cli.js'), ...args], { env: { ...process.env, ...env }, timeout: 60000 }, (error, stdout, stderr) => resolve({ code: error ? error.code : 0, out: stdout, err: stderr })));
}

test('the command line makes a map mod with no editor open', async () => {
	const state = tmp();
	const env = { RAGNAROKMAC_STATE: state, RAGNAROK_OFFLINE_ASSET_PORT: '1' };
	const made = await cli(['offline', '--mod', 'cli-isle', '--map', 'cli_isle', 'map.new', '--name', 'cli_isle', '--width', '40', '--height', '40'], env);
	assert.equal(made.code, 0, made.err + made.out);
	const dir = path.join(state, 'mods', 'cli-isle');
	for (const f of ['data/cli_isle.gat', 'data/cli_isle.gnd', 'data/cli_isle.rsw', 'data/texture/ui/map/cli_isle.bmp', 'npc/cli_isle.txt', 'mod.json']) assert.ok(fs.existsSync(path.join(dir, f)), f);
	const npc = await cli(['offline', '--mod', 'cli-isle', '--map', 'cli_isle', 'npc.add', '--kind', 'healer', '--x', '20', '--y', '20', '--name', 'Nurse'], env);
	assert.equal(npc.code, 0, npc.err + npc.out);
	assert.match(fs.readFileSync(path.join(dir, 'npc', 'cli_isle.txt'), 'utf8'), /cli_isle,20,20,4\tscript\tNurse#cli_isle/);
	const raise = await cli(['offline', '--mod', 'cli-isle', '--map', 'cli_isle', 'terrain.brush', '--tool', 'raise', '--x', '20', '--y', '20', '--radius', '6', '--strength', '2'], env);
	assert.equal(raise.code, 0, raise.err);
	const check = JSON.parse((await cli(['offline', '--mod', 'cli-isle', '--map', 'cli_isle', 'map.check'], env)).out);
	assert.ok(Array.isArray(check));
	assert.ok(!check.some(i => i.level === 'error'), JSON.stringify(check));
	const bad = await cli(['offline', '--mod', 'cli-isle', '--map', 'cli_isle', 'npc.add', '--kind', 'healer', '--x', '999', '--y', '1', '--name', 'X'], env);
	assert.notEqual(bad.code, 0);
	assert.match(bad.out, /off the map/);
});

test('help lists every command with its arguments', async () => {
	const out = JSON.parse((await cli(['help'], { RAGNAROKMAC_STATE: tmp() })).out);
	for (const c of ['map.open', 'terrain.brush', 'npc.add', 'view.screenshot', 'lightmap.bake']) assert.ok(out.commands[c], c);
	assert.ok(out.commands['npc.add'].args.sprite);
});

test('the MCP server offers every command as a tool', async () => {
	const child = spawn(process.execPath, [path.join(ROOT, 'cli.js'), 'mcp'], { env: { ...process.env, RAGNAROKMAC_STATE: tmp() } });
	const lines = [];
	child.stdout.on('data', d => lines.push(...String(d).split('\n').filter(Boolean)));
	const send = m => child.stdin.write(JSON.stringify(m) + '\n');
	send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } });
	send({ jsonrpc: '2.0', method: 'notifications/initialized' });
	send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
	for (let i = 0; i < 100 && lines.length < 2; i++) await new Promise(r => setTimeout(r, 50));
	child.stdin.end();
	child.kill();
	const init = JSON.parse(lines[0]), list = JSON.parse(lines[1]);
	assert.equal(init.result.protocolVersion, '2025-06-18');
	assert.match(init.result.instructions, /map editor/i);
	const names = list.result.tools.map(t => t.name);
	for (const n of ['map_open', 'terrain_brush', 'npc_add', 'view_screenshot']) assert.ok(names.includes(n), n);
	const npc = list.result.tools.find(t => t.name === 'npc_add');
	assert.ok(npc.inputSchema.required.includes('x'));
	assert.ok(!npc.inputSchema.required.includes('sprite'), 'optional arguments are optional');
});

test('Settings -> Tools lists the map editor, and its page is in the build', () => {
	const { TOOLS } = require('../electron/tools');
	const t = TOOLS.find(x => x.id === 'map-editor');
	assert.ok(t, 'listed');
	assert.ok(fs.existsSync(path.join(ROOT, t.page)));
	const pkg = require('../package.json');
	for (const glob of ['tools/**/*.js', 'tools/**/*.css', 'tools/**/package.json', 'tools/**/*.md']) assert.ok(pkg.build.files.includes(glob), `${glob} is packaged`);
	assert.equal(require(path.join(ROOT, 'package.json')).type, 'module', 'the editor\'s files are ES modules');
});

test('the agent guide documents every command it names', async () => {
	const guide = fs.readFileSync(path.join(ROOT, 'AGENTS.md'), 'utf8');
	const { COMMANDS } = await mod('lib/commands.js');
	const { PAGE_COMMANDS } = await mod('lib/page-commands.js');
	const known = new Set([...Object.keys(COMMANDS), ...Object.keys(PAGE_COMMANDS)]);
	const groups = new Set([...known].map(k => k.split('.')[0]));
	for (const m of guide.matchAll(/`([a-z]+)\.([a-z_]+)`/g)) {
		if (!groups.has(m[1])) continue; // a file name, not a command
		assert.ok(known.has(`${m[1]}.${m[2]}`), `AGENTS.md names ${m[1]}.${m[2]}, which is not a command`);
	}
});

test('the client\'s maps are read again when the asset server was not answering the first time', async () => {
	const state = tmp();
	let up = false;
	const server = http.createServer((req, res) => {
		if (!up) { res.statusCode = 503; res.end('starting'); return; }
		if (req.method === 'POST' && req.url === '/search') { res.end('data\\prontera.rsw\ndata\\payon.rsw'); return; }
		res.statusCode = 404; res.end('no');
	});
	await new Promise(r => server.listen(0, '127.0.0.1', r));
	try {
		const b = await bridgeFor(state, { base: `http://127.0.0.1:${server.address().port}` });
		const maps = async () => JSON.parse(Buffer.from((await b.handle({ method: 'GET', path: 'api/maps', query: new URLSearchParams(), body: null })).body).toString());
		assert.deepEqual(await maps(), []);
		up = true;
		assert.deepEqual((await maps()).map(m => m.map), ['payon', 'prontera']);
	} finally {
		server.close();
	}
});
