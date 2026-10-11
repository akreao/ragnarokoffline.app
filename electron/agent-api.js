'use strict';
// The app's local API for AI agents: one HTTP listener on 127.0.0.1.
//
//   POST /v1/command   {"cmd": "walk", "args": ["150", "180"], "agent": 2}  -- the CLI
//   POST /mcp          MCP, streamable HTTP, JSON responses, agent 1       -- MCP clients
//   POST /mcp/<n>      the same for agent n, when the player allows several
//
// Those are the game agent's (#187), and answer only while the player has
// "Let an AI agent play" on. Other parts of the app add their own routes with
// `addRoute`, each with its own token: the map editor's MCP is /mcp/map and its
// command line /map/control/... (electron/map-editor.js).
//
// Every route needs `Authorization: Bearer <token>`. The token and port are written to
// a file only the user can read (see agent-play.js), so another user on the
// machine cannot drive the player's game, and a web page cannot either: a
// browser request carries an Origin, and one that names any Host but ours is
// refused, which is what stops DNS rebinding.
//
// MCP is hand-rolled, as the rest of the app's protocols are: the whole of what
// a tool server needs is initialize, tools/list and tools/call.

const http = require('node:http');
const crypto = require('node:crypto');
const { COMMANDS } = require('./agent-driver');

const PROTOCOLS = ['2025-06-18', '2025-03-26', '2024-11-05'];
const LIMIT = 64 * 1024;

function equal(a, b) {
	const x = Buffer.from(String(a)), y = Buffer.from(String(b));
	return x.length === y.length && crypto.timingSafeEqual(x, y);
}

// Named MCP arguments to the positional ones the commands take.
function positional(cmd, input) {
	const spec = COMMANDS[cmd];
	const args = [];
	for (const [name] of spec.args) {
		const v = input?.[name];
		if (v === undefined || v === null || v === '') continue;
		if (name === 'rest' || name === 'text' || name === 'name') args.push(...String(v).split(/\s+/).filter(Boolean));
		else args.push(String(v));
	}
	return args;
}

function toolList() {
	return Object.entries(COMMANDS).map(([name, spec]) => ({
		name,
		description: spec.description,
		inputSchema: {
			type: 'object',
			properties: Object.fromEntries(spec.args.map(([arg, type, description]) => [arg, { type, description }])),
			required: spec.args.filter(a => !a[3]).map(a => a[0]),
			additionalProperties: false,
		},
	}));
}

/**
 * A JSON-RPC body (one message or a batch) through `handle(message)`, as the
 * MCP streamable HTTP transport wants it: notifications get no reply, and a
 * body of nothing but notifications is a 202.
 */
async function mcpBody(body, handle) {
	const messages = Array.isArray(body) ? body : [body];
	const replies = (await Promise.all(messages.map(m => handle(m || {})))).filter(Boolean);
	if (!replies.length) return { status: 202 };
	return { status: 200, body: Array.isArray(body) ? replies : replies[0] };
}

/**
 * @param {object} opts
 *   run(cmd, args, agent) -> Promise<result>  runs one command against one agent's game
 *   token                                     the game agent's bearer token
 *   agents() -> number                        how many agents the player allows
 *   enabled() -> bool                         whether the game agent's routes answer
 *   log(text)
 */
function createAgentApi({ run, token, agents = () => 1, enabled = () => true, log = () => {} }) {
	// Other features' routes: { match(path), token(), limit, handle({ method, path, body }) -> { status, body } }
	const routes = [];
	// One command at a time per agent: each game has one mouse. Different
	// agents play side by side.
	const queues = new Map();
	const exec = (cmd, args, n) => {
		const queue = queues.get(n) || Promise.resolve();
		const next = queue.then(() => run(cmd, args, n), () => run(cmd, args, n));
		queues.set(n, next.catch(() => {}));
		return next;
	};

	async function mcp(message, n) {
		const { id, method, params } = message;
		const reply = result => ({ jsonrpc: '2.0', id, result });
		const fail = (code, text) => ({ jsonrpc: '2.0', id, error: { code, message: text } });
		switch (method) {
			case 'initialize': {
				const asked = params?.protocolVersion;
				return reply({
					protocolVersion: PROTOCOLS.includes(asked) ? asked : PROTOCOLS[0],
					capabilities: { tools: { listChanged: false } },
					serverInfo: { name: 'ragnarok-offline', title: 'Ragnarok Offline', version: '1' },
					instructions: `You are playing Ragnarok Online on the player's own server, in your own game window, as the account "${n === 1 ? 'aiagent' : 'aiagent' + n}". Start with login, then characters, then char (or create). Use state often: it includes chat said to you or near you. Use shot when you need to see. Read AGENT.md for how to play well.`,
				});
			}
			case 'ping': return reply({});
			case 'tools/list': return reply({ tools: toolList() });
			case 'tools/call': {
				const name = params?.name;
				if (!COMMANDS[name]) return fail(-32602, `unknown tool ${name}`);
				try {
					const result = await exec(name, positional(name, params.arguments || {}), n);
					if (name === 'shot') {
						return reply({ content: [
							result.jpeg
								? { type: 'image', data: result.jpeg.toString('base64'), mimeType: 'image/jpeg' }
								: { type: 'image', data: result.png.toString('base64'), mimeType: 'image/png' },
							{ type: 'text', text: JSON.stringify({ file: result.file }) },
						] });
					}
					return reply({ content: [{ type: 'text', text: JSON.stringify(result) }] });
				} catch (e) {
					return reply({ content: [{ type: 'text', text: e.message }], isError: true });
				}
			}
			default:
				return id === undefined ? null : fail(-32601, `method not found: ${method}`);
		}
	}

	const server = http.createServer((req, res) => {
		const send = (code, body, headers = {}) => {
			const text = body === undefined ? '' : JSON.stringify(body);
			res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store', 'content-length': Buffer.byteLength(text), ...headers });
			res.end(text);
		};
		const port = server.address()?.port;
		const hostOk = [`127.0.0.1:${port}`, `localhost:${port}`].includes(req.headers.host);
		const origin = req.headers.origin;
		if (!hostOk || (origin && origin !== 'null' && !/^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(origin))) return send(403, { error: 'forbidden' });
		const auth = /^Bearer (.+)$/.exec(req.headers.authorization || '');
		const path = req.url.split('?')[0];
		const other = routes.find(r => r.match(path));
		if (other) {
			const want = other.token();
			if (!auth || !want || !equal(auth[1], want)) return send(401, { error: 'missing or wrong token; see the connection file' }, { 'www-authenticate': 'Bearer' });
			return readBody(req, other.limit || LIMIT, send, async raw => {
				try {
					const out = await other.handle({ method: req.method, path, body: raw });
					return send(out.status, out.body);
				} catch (e) {
					return send(500, { error: e.message });
				}
			});
		}
		if (!auth || !equal(auth[1], token)) return send(401, { error: 'missing or wrong token; see the connection file' }, { 'www-authenticate': 'Bearer' });
		if (!enabled()) return send(404, { error: 'the AI agent is off: turn on "Let an AI agent play" in Settings' });
		const route = /^\/mcp(?:\/([1-9]))?$/.exec(req.url);
		if (req.method !== 'POST' || !(route || req.url === '/v1/command')) return send(405, { error: 'POST /v1/command or /mcp' }, { allow: 'POST' });
		const mcpAgent = route ? Number(route[1] || 1) : null;
		if (mcpAgent && mcpAgent > agents()) return send(404, { error: `there is no agent ${mcpAgent}; the player allowed ${agents()}` });

		readBody(req, LIMIT, send, async raw => {
			let body;
			try { body = JSON.parse(raw.toString('utf8') || '{}'); } catch { return send(400, { error: 'not JSON' }); }
			if (req.url === '/v1/command') {
				const { cmd, args } = body;
				const n = body.agent === undefined ? 1 : Number(body.agent);
				if (!Number.isInteger(n) || n < 1 || n > agents()) return send(400, { error: `there is no agent ${body.agent}; the player allowed ${agents()}` });
				if (!COMMANDS[cmd]) return send(400, { error: `unknown command ${cmd}`, commands: Object.keys(COMMANDS) });
				if (args !== undefined && (!Array.isArray(args) || args.some(a => typeof a !== 'string' && typeof a !== 'number'))) return send(400, { error: 'args must be a list of strings' });
				log(`agent ${n}: ${cmd} ${JSON.stringify(args || [])}`);
				try {
					const out = await exec(cmd, (args || []).map(String), n);
					if (cmd === 'shot') return send(200, { file: out.file });
					return send(200, out);
				} catch (e) {
					return send(500, { error: e.message });
				}
			}
			// MCP: one message or a batch; notifications get no reply.
			const messages = Array.isArray(body) ? body : [body];
			if (messages.some(m => m?.method === 'tools/call')) log(`agent ${mcpAgent} (mcp): ${messages.filter(m => m?.method === 'tools/call').map(m => m.params?.name).join(', ')}`);
			const out = await mcpBody(body, m => mcp(m, mcpAgent));
			return send(out.status, out.body);
		});
	});

	function readBody(req, limit, send, then) {
		let size = 0;
		const chunks = [];
		req.on('data', c => { size += c.length; if (size > limit) { send(413, { error: 'too large' }); req.destroy(); } else chunks.push(c); });
		req.on('end', () => { if (size <= limit) then(Buffer.concat(chunks)); });
	}

	return {
		listen: (port = 0) => new Promise((resolve, reject) => {
			server.once('error', reject);
			server.listen(port, '127.0.0.1', () => resolve(server.address().port));
		}),
		close: () => new Promise(resolve => server.close(() => resolve())),
		/** The game agent's token, replaced in place: the old one stops working at once. */
		setToken: next => { token = next; },
		/** Another feature's route on this listener; returns a function that removes it. */
		addRoute: route => {
			routes.push(route);
			return () => { const i = routes.indexOf(route); if (i >= 0) routes.splice(i, 1); };
		},
		hasRoutes: () => routes.length > 0,
		server,
	};
}

module.exports = { createAgentApi, mcpBody, positional, toolList };
