// A small HTTP server on 127.0.0.1 for the map editor outside the app's own
// window: `ragnarok-map serve` uses it to put the editor in any browser (and
// in Playwright, for screenshots and tests), and the app uses its control
// half so the CLI and MCP clients can drive the editor window.
//
//   /                     the editor page (serve mode only)
//   /<file>               the page's own files (serve mode only)
//   /asset/..., /api/...  the bridge (serve mode only); writes need the page's
//                         token in an X-Map-Editor header, which a web page
//                         on another site can neither read nor send
//   /control/run          POST {cmd, args}: run a command in the open editor
//   /control/status       GET: is an editor open, what map
//   /control/...          Authorization: Bearer <token> for all of these
//
// A request naming any Host but ours is refused, which is what stops DNS
// rebinding from turning a web page into a client of this server.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml', '.json': 'application/json', '.md': 'text/markdown; charset=utf-8' };
const LIMIT = 300 * 1024 * 1024;

function equal(a, b) {
	const x = Buffer.from(String(a || '')), y = Buffer.from(String(b || ''));
	return x.length === y.length && crypto.timingSafeEqual(x, y);
}

/**
 * @param {object} opts
 *   bridge        createBridge(...) (serve mode), or null for control only
 *   remote        the bridge's remote (control)
 *   root          the editor's folder, to serve the page from (serve mode)
 *   token         the control token
 *   port          0 for any free port
 *   log(text)
 *   commands      extra control commands run here rather than in the page:
 *                 { name: async (args) => result }
 */
export function startServer({ bridge, remote, root, token, port = 0, log = () => {}, commands = {} }) {
	const pageToken = crypto.randomBytes(24).toString('hex');
	let actualPort = 0;
	const control = controlCalls({ remote, log, commands, port: () => actualPort });
	const server = http.createServer(async (req, res) => {
		const send = (status, body, type = 'application/json; charset=utf-8', extra = {}) => {
			const buf = Buffer.isBuffer(body) ? body : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
			res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store', 'content-length': buf.length, 'x-content-type-options': 'nosniff', ...extra });
			res.end(buf);
		};
		const hostOk = [`127.0.0.1:${actualPort}`, `localhost:${actualPort}`].includes(req.headers.host);
		if (!hostOk) return send(421, { error: 'wrong host' });
		const url = new URL(req.url, `http://127.0.0.1:${actualPort}`);
		const chunks = [];
		let size = 0;
		for await (const c of req) { size += c.length; if (size > LIMIT) return send(413, { error: 'too large' }); chunks.push(c); }
		const body = Buffer.concat(chunks);

		if (url.pathname.startsWith('/control/')) {
			const auth = String(req.headers.authorization || '');
			if (!equal(auth.replace(/^Bearer\s+/i, ''), token)) return send(401, { error: 'bad or missing token: see connection.json' });
			if (req.headers.origin) return send(403, { error: 'not from a web page' });
			const out = await control({ method: req.method, what: url.pathname.slice(9), body });
			return send(out.status, out.body);
		}

		if (!bridge) return send(404, { error: 'not found' });
		const route = url.pathname.replace(/^\/+/, '');
		if (route.startsWith('asset/') || route.startsWith('api/')) {
			// Reads of assets are open (an <audio> cannot send a header); every
			// other call needs the page's token.
			const open = req.method === 'GET' && route.startsWith('asset/');
			if (!open && !equal(req.headers['x-map-editor'], pageToken)) return send(403, { error: 'missing page token' });
			let decoded;
			try { decoded = decodeURIComponent(route); } catch { return send(400, { error: 'bad path' }); }
			const answer = await bridge.handle({ method: req.method, path: decoded, query: url.searchParams, body });
			if (!answer) return send(404, { error: 'not found' });
			return send(answer.status, answer.body, answer.type, answer.cache ? { 'cache-control': answer.cache } : {});
		}
		// The page's own files.
		const rel = route || 'map-editor.html';
		const file = path.resolve(root, rel);
		if (!file.startsWith(root + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile() || !TYPES[path.extname(file)]) return send(404, 'not found', 'text/plain');
		let content = fs.readFileSync(file);
		if (/\.html$/.test(rel)) {
			content = Buffer.from(content.toString('utf8').replace('<!--HOST-->', `<script>window.MAP_EDITOR_HOST = ${JSON.stringify({ name: 'cli', token: pageToken })};</script>`));
		}
		return send(200, content, TYPES[path.extname(file)]);
	});
	return new Promise((resolve, reject) => {
		server.once('error', reject);
		server.listen(port, '127.0.0.1', () => {
			actualPort = server.address().port;
			resolve({ server, port: actualPort, pageToken, close: () => new Promise(r => server.close(() => r())) });
		});
	});
}

/**
 * The control calls, whichever server they arrive on: this one, or the app's
 * local API for agents under /map (electron/map-editor.js).
 *
 *   status   GET: is an editor open, what map
 *   run      POST {cmd, args}: run a command in the open editor
 *
 * Resolves to { status, body }. A command that fails is still a 200, with
 * { error }, so the command line can tell it from a missing server.
 */
export function controlCalls({ remote, log = () => {}, commands = {}, port = () => null }) {
	return async ({ method, what, body }) => {
		try {
			if (what === 'status') return { status: 200, body: { connected: remote.connected(), page: remote.info(), port: port() } };
			if (what === 'run' && method === 'POST') {
				const { cmd, args } = JSON.parse(body.toString('utf8') || '{}');
				if (commands[cmd]) return { status: 200, body: { result: await commands[cmd](args || {}) } };
				log(`map editor: ${cmd} from the command line`);
				return { status: 200, body: { result: await remote.run(String(cmd), args || {}) } };
			}
			return { status: 404, body: { error: 'no such control call' } };
		} catch (e) {
			return { status: 200, body: { error: e.message } };
		}
	};
}

/** A file only the user can read: connection details with a bearer token. */
export function writePrivate(file, text) {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	const tmp = `${file}.${crypto.randomBytes(6).toString('hex')}.tmp`;
	fs.writeFileSync(tmp, text, { mode: 0o600 });
	fs.renameSync(tmp, file);
	try { fs.chmodSync(file, 0o600); } catch { /* Windows: the profile's ACL */ }
}
