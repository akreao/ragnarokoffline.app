'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const crypto = require('node:crypto');
const { once } = require('node:events');
const { FriendGateway, Frames } = require('../electron/sharing/gateway');
async function fixture(t, options = {}) {
  const observed = [];
  const upstream = http.createServer((req, res) => { observed.push({ url: req.url, headers: req.headers }); res.setHeader('cache-control', 'public,max-age=99999'); res.end('asset'); });
  upstream.on('upgrade', (req, socket) => {
    const accept = crypto.createHash('sha1').update(req.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    socket.on('data', () => {}); socket.on('error', () => {}); socket.on('end', () => socket.destroy());
  });
  upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening');
  let registrations = 0;
  const gateway = new FriendGateway({ origin: 'https://play.example.com', upstreamPort: upstream.address().port, register: async () => { registrations++; }, ...options });
  const port = await gateway.start(0);
  t.after(async () => { await gateway.stop(); upstream.closeAllConnections(); await new Promise(resolve => upstream.close(resolve)); });
  const request = (url, { method = 'GET', headers = {}, body } = {}) => new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: url, method, headers: { host: 'play.example.com', ...headers } }, res => {
      let text = ''; res.on('data', chunk => text += chunk); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text }));
    }); req.on('error', reject); req.end(body);
  });
  const exchange = invite => request('/_friend/exchange', { method: 'POST', headers: { origin: gateway.origin, 'content-type': 'application/json' }, body: JSON.stringify({ invite: invite || gateway.invite }) });
  const login = async () => (await exchange()).headers['set-cookie'][0].split(';')[0];
  const socket = (cookie, origin = gateway.origin, url = '/ws/127.0.0.1:6900') => new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: url, headers: { host: 'play.example.com', origin, cookie, connection: 'Upgrade', upgrade: 'websocket', 'sec-websocket-version': '13', 'sec-websocket-key': crypto.randomBytes(16).toString('base64') } });
    req.on('upgrade', (_, socket) => resolve(socket)); req.on('response', res => { res.resume(); reject(Error(String(res.statusCode))); }); req.on('error', reject); req.end();
  });
  return { gateway, port, observed, request, exchange, login, socket, registrations: () => registrations };
}
test('all game assets, search, batches and WS require an invitation, including loopback/forged forwarded peers', async t => {
  const f = await fixture(t);
  for (const url of ['/data/a.spr', '/search', '/batch', '/list-files', '/api/health', '/api/cache-stats']) {
    const r = await f.request(url, { headers: { 'x-forwarded-for': '127.0.0.1', 'x-forwarded-host': 'localhost' } }); assert.equal(r.status, 401, url);
  }
  await assert.rejects(f.socket(''), /403/);
  assert.equal(f.observed.length, 0);
  assert.equal((await f.request('/')).status, 401);
  const health = await f.request('/_friend/health'); assert.equal(health.status, 200); assert.doesNotMatch(health.text, /state|path|version|password|token/);
});
test('exchange cookies are secure, private, bounded; proxy strips credentials/cache policy and denies private paths', async t => {
  const f = await fixture(t), auth = await f.exchange();
  assert.equal(auth.status, 200); assert.match(auth.headers['set-cookie'][0], /Secure; HttpOnly; SameSite=Strict/);
  const cookie = auth.headers['set-cookie'][0].split(';')[0];
  const response = await f.request('/data/a.spr', { headers: { cookie, authorization: 'Bearer private-sentinel', 'x-forwarded-host': 'forged' } });
  assert.equal(response.status, 200); assert.equal(response.text, 'asset'); assert.equal(response.headers['cache-control'], 'private, max-age=99999');
  assert.equal(response.headers['cdn-cache-control'], 'no-store'); assert.equal(response.headers['cloudflare-cdn-cache-control'], 'no-store');
  assert.equal(f.observed[0].headers.cookie, undefined); assert.equal(f.observed[0].headers.authorization, undefined);
  for (const url of ['/logs/a', '/%6cogs/a', '/%252e%252e/key', '/data/../.private', '/resources/a', '/data.grf', '/api/cache-stats', '/api/missing-files']) assert.equal((await f.request(url, { headers: { cookie } })).status, 404, url);
  assert.equal((await f.request('/data/a.spr', { headers: { cookie, host: 'wrong.example.com' } })).status, 421);
  assert.equal((await f.request('/batch', { method: 'POST', headers: { cookie, origin: f.gateway.origin, 'content-type': 'application/json' }, body: JSON.stringify({ files: ['data.grf'] }) })).status, 400);
});
test('game files keep their validators and a private copy of their cache policy, and 304s pass through', async t => {
  const connections = [];
  const upstream = http.createServer((req, res) => {
    if (req.url === '/Config.local.js') { res.setHeader('cache-control', 'no-store'); return res.end('config'); }
    if (req.url === '/Online.js') { res.setHeader('cache-control', 'public, max-age=0'); res.setHeader('etag', 'W/"1-2"'); }
    else { res.setHeader('cache-control', 'public, max-age=86400, immutable, s-maxage=9'); res.setHeader('etag', '"abc"'); res.setHeader('vary', 'Accept-Encoding'); }
    res.setHeader('set-cookie', 'leak=1');
    if (req.headers['if-none-match'] === res.getHeader('etag')) { res.statusCode = 304; return res.end(); }
    res.end('asset');
  });
  upstream.on('connection', socket => connections.push(socket));
  upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening');
  const f = await fixture(t, { upstreamPort: upstream.address().port });
  t.after(async () => { upstream.closeAllConnections(); await new Promise(resolve => upstream.close(resolve)); });
  const cookie = await f.login();
  const first = await f.request('/data/a.spr', { headers: { cookie } });
  assert.equal(first.status, 200); assert.equal(first.headers['cache-control'], 'private, max-age=86400, immutable');
  assert.equal(first.headers.etag, '"abc"'); assert.equal(first.headers.vary, 'Accept-Encoding'); assert.equal(first.headers['set-cookie'], undefined);
  assert.equal(first.headers['cdn-cache-control'], 'no-store');
  const again = await f.request('/data/a.spr', { headers: { cookie, 'if-none-match': '"abc"' } });
  assert.equal(again.status, 304); assert.equal(again.text, ''); assert.equal(again.headers.etag, '"abc"');
  const client = await f.request('/Online.js', { headers: { cookie, 'if-none-match': 'W/"1-2"' } });
  assert.equal(client.status, 304); assert.equal(client.headers['cache-control'], 'private, max-age=0');
  const config = await f.request('/Config.local.js', { headers: { cookie } });
  assert.equal(config.status, 200); assert.equal(config.headers['cache-control'], 'private, no-store'); assert.equal(config.headers.etag, undefined);
  assert.equal(connections.length, 1, 'upstream connections are kept alive and reused');
  f.gateway.revoke();
  assert.equal((await f.request('/data/a.spr', { headers: { cookie, 'if-none-match': '"abc"' } })).status, 401, 'revalidation still needs a current invitation');
});
test('only same-origin invited players may create one account; revocation closes active game sockets', async t => {
  const f = await fixture(t), cookie = await f.login();
  const post = origin => f.request('/_friend/register', { method: 'POST', headers: { cookie, origin, 'content-type': 'application/json' }, body: '{}' });
  assert.equal((await post('https://evil.example')).status, 403); assert.equal(f.registrations(), 0);
  assert.equal((await post(f.gateway.origin)).status, 200); assert.equal((await post(f.gateway.origin)).status, 409); assert.equal(f.registrations(), 1);
  await assert.rejects(f.socket(cookie, 'https://evil.example'), /403/);
  await assert.rejects(f.socket(cookie, f.gateway.origin, '/ws/127.0.0.1:3306'), /403/);
  const socket = await f.socket(cookie), closed = once(socket, 'close'); socket.resume();
  const invite = f.gateway.invite; f.gateway.revoke(); await closed;
  assert.equal((await f.exchange(invite)).status, 403);
  assert.equal((await f.request('/data/a.spr', { headers: { cookie } })).status, 401);
});
test('expired invitations and sessions stop HTTP and active WS access', async t => {
  const f = await fixture(t), cookie = await f.login(), socket = await f.socket(cookie); socket.resume();
  const closed = once(socket, 'close'); f.gateway.now = () => Date.now() + 24 * 60 * 60 * 1000;
  assert.equal((await f.exchange()).status, 403);
  assert.equal((await f.request('/data/a.spr', { headers: { cookie } })).status, 401);
  await closed;
});
test('slow concurrent account requests cannot bypass the one-account limit or invitation revocation', async t => {
  const f = await fixture(t), cookie = await f.login();
  async function slow() {
    let finish;
    const response = new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port: f.port, path: '/_friend/register', method: 'POST',
        headers: { host: 'play.example.com', origin: f.gateway.origin, cookie, 'content-type': 'application/json', 'content-length': 2 } }, res => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
      req.on('error', reject); req.write('{'); finish = () => req.end('}');
    });
    await new Promise(resolve => setTimeout(resolve, 20));
    return { finish, response };
  }
  const first = await slow(), second = await slow();
  first.finish(); assert.equal(await first.response, 200);
  second.finish(); assert.equal(await second.response, 409); assert.equal(f.registrations(), 1);
  const g = await fixture(t), invite = await g.login();
  let complete;
  const rejected = new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: g.port, path: '/_friend/register', method: 'POST',
      headers: { host: 'play.example.com', origin: g.gateway.origin, cookie: invite, 'content-type': 'application/json', 'content-length': 2 } }, res => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
    req.on('error', reject); req.write('{'); complete = () => req.end('}');
  });
  await new Promise(resolve => setTimeout(resolve, 20)); g.gateway.revoke(); complete();
  assert.equal(await rejected, 401); assert.equal(g.registrations(), 0);
});
test('WebSocket framing preserves split payloads and rejects oversized or unmasked client messages', async () => {
  const frame = Buffer.from([0x82, 0x83, 1, 2, 3, 4, 10, 11, 12]);
  const filter = new Frames(true), output = []; filter.on('data', chunk => output.push(chunk));
  for (const byte of frame) filter.write(Buffer.from([byte])); filter.end(); await once(filter, 'end'); assert.deepEqual(Buffer.concat(output), frame);
  for (const bad of [Buffer.from([0x82, 0]), Buffer.from([0x82, 0xff, 0, 0, 0, 0, 0, 0x20, 0, 0, 1, 2, 3, 4])]) {
    const invalid = new Frames(true); const error = once(invalid, 'error'); invalid.end(bad); assert.match((await error)[0].message, /Invalid|oversized|Incomplete/);
  }
});

test('a stored invitation is reused so a shared link survives a restart', () => {
  const origin = 'https://example.invalid';
  // The shape the gateway mints: 32 random bytes, base64url, 43 characters.
  const saved = crypto.randomBytes(32).toString('base64url');
  const restarted = new FriendGateway({ origin, invite: saved });
  assert.equal(restarted.invite, saved, 'the stored token is adopted as-is');
  assert.ok(restarted.link().endsWith('#invite=' + saved));

  // Anything that is not a token of the right shape is replaced rather than
  // trusted -- a truncated or hand-edited store must not weaken the invitation.
  for (const bad of ['', 'short', null, undefined, 'x'.repeat(43) + '!', 'y'.repeat(44)]) {
    const fresh = new FriendGateway({ origin, invite: bad });
    assert.notEqual(fresh.invite, bad);
    assert.match(fresh.invite, /^[A-Za-z0-9_-]{43}$/, `replaced a bad stored value: ${bad}`);
  }

  // Replacing is still what changes it, and the new one is a different token.
  const before = restarted.invite;
  restarted.revoke();
  assert.notEqual(restarted.invite, before);
  assert.match(restarted.invite, /^[A-Za-z0-9_-]{43}$/);
});

// Host routes (electron/mod-host/): the gateway's half. The manager behind
// `modHost` has its own tests in mod-host.test.cjs.
test('a mod host route needs an invitation, a known mod, same-origin writes and a bounded body; only status/type/body come back', async t => {
  const calls = [];
  const modHost = async (name, request, meta) => {
    calls.push({ name, request, meta });
    if (name !== 'echo') return null;
    return { status: 201, type: 'application/json; charset=utf-8', body: Buffer.from(JSON.stringify({ got: request.body })) };
  };
  const f = await fixture(t, { modHost });
  const route = '/_friend/mod/echo/say/hi?x=1&y=2';
  // Before an invitation: nothing reaches a mod, whatever the peer claims.
  assert.equal((await f.request(route, { headers: { 'x-forwarded-for': '127.0.0.1' } })).status, 401);
  assert.equal(calls.length, 0);
  const cookie = await f.login();
  const post = (url, { origin = f.gateway.origin, type = 'application/json', body = '{"a":1}', method = 'POST', extra = {} } = {}) =>
    f.request(url, { method, headers: { cookie, origin, 'content-type': type, ...extra }, body });
  // Unknown mod, a name that is not a mod name, an unsupported method.
  assert.equal((await f.request('/_friend/mod/nobody/x', { headers: { cookie } })).status, 404);
  assert.equal((await f.request('/_friend/mod/../x', { headers: { cookie } })).status, 404);
  assert.equal((await f.request('/_friend/mod/echo/x', { method: 'PATCH', headers: { cookie } })).status, 404);
  const before = calls.length;
  // Cross-origin writes, wrong body types and oversized bodies never reach it.
  assert.equal((await post(route, { origin: 'https://evil.example' })).status, 403);
  assert.equal((await post(route, { method: 'DELETE', origin: 'https://evil.example', body: '' })).status, 403);
  assert.equal((await post(route, { type: 'application/x-www-form-urlencoded', body: 'a=1' })).status, 415);
  assert.equal((await post(route, { body: 'x'.repeat(201 * 1024) })).status, 413);
  assert.equal(calls.length, before);
  // A good one: what the handler sees, and what comes back.
  const ok = await post(route, { extra: { authorization: 'Bearer private-sentinel', accept: 'application/json', 'x-forwarded-for': '10.0.0.9' } });
  assert.equal(ok.status, 201);
  assert.deepEqual(JSON.parse(ok.text), { got: '{"a":1}' });
  const seen = calls.at(-1);
  assert.equal(seen.name, 'echo');
  assert.deepEqual(seen.request, { method: 'POST', path: '/say/hi', query: 'x=1&y=2', headers: { 'content-type': 'application/json', accept: 'application/json' }, body: '{"a":1}' });
  assert.equal(seen.meta.from, 'friend');
  assert.match(seen.meta.client, /^[a-f0-9]{64}$/, 'rate-limited per invitation session, by its hash');
  assert.equal(JSON.stringify(seen).includes('private-sentinel'), false);
  assert.equal(JSON.stringify(seen).includes(cookie.split('=')[1]), false, 'the session cookie never reaches a mod');
  assert.match(ok.headers['cache-control'], /no-store/);
  assert.match(ok.headers['content-security-policy'], /sandbox/);
  assert.equal(ok.headers['set-cookie'], undefined);
  assert.equal(ok.headers['content-length'], String(Buffer.byteLength(ok.text)));
  // A GET needs no Origin (the session cookie is SameSite=Strict) and has no body.
  const get = await f.request('/_friend/mod/echo', { headers: { cookie } });
  assert.equal(get.status, 201);
  assert.deepEqual({ path: calls.at(-1).request.path, body: calls.at(-1).request.body, method: calls.at(-1).request.method }, { path: '/', body: null, method: 'GET' });
});

test('without a modHost every /_friend/mod/ path is a 404, and a throwing one is a 502', async t => {
  const plain = await fixture(t);
  const cookie = await plain.login();
  assert.equal((await plain.request('/_friend/mod/echo/x', { headers: { cookie } })).status, 404);
  const broken = await fixture(t, { modHost: async () => { throw Error('secret detail'); } });
  const cookie2 = await broken.login();
  const r = await broken.request('/_friend/mod/echo/x', { headers: { cookie: cookie2 } });
  assert.equal(r.status, 502);
  assert.doesNotMatch(r.text, /secret detail/);
});
