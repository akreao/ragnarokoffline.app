'use strict';
// The app's one local API for AI agents: the game agent's routes (#187) and
// the map editor's (/mcp/map, /map/control/...) on the same listener, each
// with its own token.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');

const { createAgentApi } = require('../electron/agent-api');
const { createAgentPlay } = require('../electron/agent-play');
const { createMapEditor } = require('../electron/map-editor');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'agent-listener-'));
const AGENT = 'a'.repeat(64);
const OTHER = 'b'.repeat(64);

const call = (port, route, token, body, method = 'POST') => fetch(`http://127.0.0.1:${port}${route}`, {
	method,
	headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
	body: method === 'POST' ? JSON.stringify(body) : undefined,
});
const init = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } };

test('another feature\'s route takes only its own token, and answers with the game agent off', async () => {
	let on = false;
	const api = createAgentApi({ token: AGENT, enabled: () => on, run: async cmd => ({ ok: true, cmd }) });
	const port = await api.listen(0);
	try {
		api.addRoute({ match: p => p === '/mcp/x', token: () => OTHER, handle: async ({ body }) => ({ status: 200, body: { got: JSON.parse(body) } }) });
		assert.equal((await call(port, '/mcp/x', AGENT, {})).status, 401, 'the game agent\'s token does not open it');
		assert.deepEqual(await (await call(port, '/mcp/x', OTHER, { a: 1 })).json(), { got: { a: 1 } });
		assert.equal((await call(port, '/mcp', OTHER, init)).status, 401, 'nor does its token open the game\'s');
		assert.equal((await call(port, '/mcp', AGENT, init)).status, 404, 'the game\'s routes are off with the setting');
		on = true;
		assert.equal((await call(port, '/mcp', AGENT, init)).status, 200);
		api.setToken('c'.repeat(64));
		assert.equal((await call(port, '/mcp', AGENT, init)).status, 401, 'a replaced token stops working at once');
		assert.equal((await call(port, '/mcp', 'c'.repeat(64), init)).status, 200);
		assert.equal((await call(port, '/mcp/x', OTHER, {})).status, 200, 'and the other route keeps its own');
	} finally {
		await api.close();
	}
});

function agentPlayIn(state) {
	return createAgentPlay({
		stateDir: () => state, stackBin: () => '/nonexistent/ragnarok-stack', port: () => 0,
		hosting: () => false, runAccount: async () => {}, era: () => 'renewal', log: () => {},
	});
}

test('the map editor\'s MCP and command line are on the agent listener while the player allows it', async () => {
	const state = tmp();
	const agents = agentPlayIn(state);
	const editor = createMapEditor({
		stateDir: () => state, runtimeDir: () => null, assetPort: () => 1,
		net: { fetch: () => Promise.reject(new Error('no asset server')) }, shell: {}, log: () => {},
		stackBin: () => '/nonexistent/ragnarok-stack', stackEnv: () => ({ env: {} }), execPath: process.execPath,
		openWindow: async () => { throw new Error('no window in a test'); },
		addRoute: (route, options) => agents.addRoute(route, options),
	});
	assert.equal(editor.agentInfo(), null, 'nothing until the player turns it on');
	await editor.setAgentAccess(true);
	const registered = await editor.ensureControl();
	const conn = JSON.parse(fs.readFileSync(path.join(state, 'map-editor', 'connection.json'), 'utf8'));
	try {
		assert.equal(conn.base, '/map');
		assert.equal(conn.port, registered.port);
		assert.equal(conn.mcp, `http://127.0.0.1:${registered.port}/mcp/map`);
		assert.match(editor.agentInfo().claudeCommand, /^claude mcp add --transport http ragnarok-map http:\/\/127\.0\.0\.1:\d+\/mcp\/map --header "Authorization: Bearer [0-9a-f]{64}"$/);

		// MCP, at /mcp/map.
		const hello = await (await call(conn.port, '/mcp/map', conn.token, init)).json();
		assert.equal(hello.result.serverInfo.name, 'ragnarok-map');
		const list = await (await call(conn.port, '/mcp/map', conn.token, { jsonrpc: '2.0', id: 2, method: 'tools/list' })).json();
		assert.ok(list.result.tools.some(t => t.name === 'map_open'));
		assert.equal((await call(conn.port, '/mcp/map', conn.token, { jsonrpc: '2.0', method: 'notifications/initialized' })).status, 202);
		// A tool with no editor open asks the app to open one first.
		const tool = await (await call(conn.port, '/mcp/map', conn.token, { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'map_info', arguments: {} } })).json();
		assert.equal(tool.result.isError, true);
		assert.match(tool.result.content[0].text, /no window in a test/);

		// The game agent is off: its routes refuse, the map editor's do not.
		assert.equal((await call(conn.port, '/mcp', conn.token, init)).status, 401);
		const status = await (await call(conn.port, '/map/control/status', conn.token, undefined, 'GET')).json();
		assert.equal(status.connected, false);

		// The command line finds the app's control calls under /map.
		const out = await new Promise(resolve => execFile(process.execPath, [path.join(__dirname, '..', 'tools', 'map-editor', 'cli.js'), 'map.info'],
			{ env: { ...process.env, RAGNAROKMAC_STATE: state } }, (err, stdout) => resolve(stdout)));
		assert.match(out, /no window in a test/);

		// Turning the game agent on and off leaves the map editor's routes alone.
		await agents.start({ show: false });
		const game = JSON.parse(fs.readFileSync(path.join(state, 'agent', 'connection.json'), 'utf8'));
		assert.equal(game.port, conn.port, 'one listener');
		assert.equal((await call(conn.port, '/mcp', game.token, init)).status, 200);
		await agents.stop();
		assert.equal((await call(conn.port, '/mcp', game.token, init)).status, 404);
		assert.equal((await call(conn.port, '/mcp/map', conn.token, init)).status, 200);
	} finally {
		await editor.setAgentAccess(false);
	}
	// Off: the route, the file and its token are gone, and with nothing else
	// using it the listener closes.
	assert.equal(fs.existsSync(path.join(state, 'map-editor', 'connection.json')), false);
	assert.equal(editor.agentInfo(), null);
	await assert.rejects(fetch(`http://127.0.0.1:${conn.port}/mcp/map`, { method: 'POST' }));
	// On again: a new token.
	await editor.setAgentAccess(true);
	const again = JSON.parse(fs.readFileSync(path.join(state, 'map-editor', 'connection.json'), 'utf8'));
	assert.notEqual(again.token, conn.token);
	await editor.setAgentAccess(false);
});

test('opening the map editor opens its agent routes unless the player turned them off', () => {
	const tools = fs.readFileSync(path.join(__dirname, '..', 'electron', 'tools.js'), 'utf8');
	const editor = fs.readFileSync(path.join(__dirname, '..', 'electron', 'map-editor.js'), 'utf8');
	const main = fs.readFileSync(path.join(__dirname, '..', 'electron', 'main.js'), 'utf8');
	// The one place that opens them with the editor checks the setting first.
	const opens = tools.split('\n').filter(l => l.includes('ensureControl'));
	assert.equal(opens.length, 1);
	assert.match(opens[0], /mapEditorAgentAllowed\(\)\)\) mapEditor\.ensureControl/);
	const route = editor.slice(editor.indexOf('async function route('), editor.indexOf('function writeLauncher'));
	assert.doesNotMatch(route, /ensureControl/, 'nor does any request from the editor page');
	assert.match(main, /map_editor_agent: true,/, 'on unless turned off');
	assert.match(main, /mapEditorAgentAllowed: \(\) => getSettings\(\)\.map_editor_agent !== false/);
});
