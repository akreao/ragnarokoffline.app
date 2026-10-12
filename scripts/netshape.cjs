#!/usr/bin/env node
// netshape -- a TCP proxy that makes a local server look remote: round-trip
// latency and a shared bandwidth limit, for measuring how the browser client
// loads over a real connection.
//
//   node scripts/netshape.cjs --listen 13400 --target 127.0.0.1:3338 --mbps 50 --rtt 40 [--up-mbps 10]
//                             [--request-header 'X-Compact-Images: 1'] [--h2]
//
// The client is same-origin (Config.local.js: remoteClient '/', the socket
// proxy on location.host), so pointing the browser at the listen port shapes
// everything it does: the page, the map worker's file fetches, BGM and the
// game's WebSocket.
//
// The model is one bottleneck link. Every chunk waits half the RTT in its
// direction, then queues for the link, which is shared FIFO by all
// connections in that direction. A new connection pays one RTT before its
// first byte goes through, for the TCP handshake. It does not model loss,
// slow start or the browser's own connection limits; the browser applies those.
//
// --request-header adds a header to every HTTP request on its way up, the way
// the app's friends gateway does (X-Compact-Images). It reads request heads
// and Content-Length bodies, and passes a connection through untouched once
// it upgrades to a WebSocket.
//
// --h2 serves HTTPS with HTTP/2, as Cloudflare's edge does for invite-link
// friends: one connection carries every request, so the browser's six
// connections per host no longer queue them. The certificate is self-signed
// for 127.0.0.1, made with openssl at start; the browser has to ignore
// certificate errors (rotest does for an https game URL on 127.0.0.1). The
// shaping applies to the TLS bytes, so the TLS handshake costs its round trip
// too. WebSockets arrive over HTTP/1.1 on their own connection.
'use strict';
const net = require('node:net');
const http = require('node:http');
const http2 = require('node:http2');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const argv = process.argv.slice(2);
const flag = (name, fallback) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : fallback; };
const LISTEN = Number(flag('--listen', 13400));
const [TARGET_HOST, TARGET_PORT] = flag('--target', '127.0.0.1:3338').split(':');
const H2 = argv.includes('--h2');
let [HOST, PORT] = [TARGET_HOST, TARGET_PORT];
const MBPS = Number(flag('--mbps', 50));
const UP_MBPS = Number(flag('--up-mbps', MBPS));
const RTT = Number(flag('--rtt', 40));
const PIECE = 16 * 1024; // split chunks so connections interleave on the link
const HEADER = flag('--request-header', '');
if (HEADER && !/^[!#-'*+.0-9A-Z^-z|~-]+: [\x20-\x7e]*$/.test(HEADER)) throw Error('--request-header wants "Name: value"');

// One direction of the link: a FIFO that frees at `free` (ms, performance time).
function link(mbps) {
    const bytesPerMs = (mbps * 1e6) / 8 / 1000;
    let free = 0;
    return (bytes, ready) => {
        const start = Math.max(ready, free);
        free = start + bytes / bytesPerMs;
        return free;
    };
}
const down = link(MBPS);
const up = link(UP_MBPS);
const now = () => performance.now();

// Deliver chunks from `from` to `to` through `dir`, in order, after the
// one-way delay and the link's queue. One timer per direction drains a FIFO:
// separate timers per chunk can fire out of order when their delays round to
// the same millisecond, which reorders a stream (TLS rejects it outright).
function pipe(from, to, dir, opened, transform = data => data) {
    const queue = [];
    let last = 0, timer = null, ended = false;
    const drain = () => {
        timer = null;
        while (queue.length && queue[0].at <= now()) { const { piece } = queue.shift(); if (!to.destroyed) to.write(piece); }
        if (queue.length) timer = setTimeout(drain, Math.max(0, queue[0].at - now()));
        else if (ended && !to.destroyed) to.end();
    };
    const schedule = () => { if (!timer) timer = setTimeout(drain, queue.length ? Math.max(0, queue[0].at - now()) : 0); };
    from.on('data', data => {
        data = transform(data);
        for (let i = 0; i < data.length; i += PIECE) {
            const piece = data.subarray(i, i + PIECE);
            last = Math.max(dir(piece.length, Math.max(now(), opened) + RTT / 2), last);
            queue.push({ piece, at: last });
        }
        schedule();
    });
    from.on('end', () => { ended = true; schedule(); });
    from.on('error', () => to.destroy());
}

// A stream of HTTP requests with HEADER added to each head.
function addHeader() {
    let buffered = Buffer.alloc(0), body = 0, raw = false;
    return data => {
        if (raw) return data;
        const out = [];
        buffered = Buffer.concat([buffered, data]);
        while (buffered.length) {
            if (body > 0) {
                const n = Math.min(body, buffered.length);
                out.push(buffered.subarray(0, n)); buffered = buffered.subarray(n); body -= n;
                continue;
            }
            const end = buffered.indexOf('\r\n\r\n');
            if (end < 0) break;
            const head = buffered.subarray(0, end).toString('latin1');
            buffered = buffered.subarray(end + 4);
            const line = head.indexOf('\r\n');
            out.push(Buffer.from(`${head.slice(0, line)}\r\n${HEADER}${head.slice(line)}\r\n\r\n`, 'latin1'));
            if (/^upgrade:/im.test(head)) { raw = true; out.push(buffered); buffered = Buffer.alloc(0); break; }
            body = Number((/^content-length:\s*(\d+)/im.exec(head) || [])[1] || 0);
        }
        return Buffer.concat(out);
    };
}

// --h2: a TLS server terminating HTTP/2 (and HTTP/1.1 for WebSockets) that
// forwards each request to the target. netshape shapes the bytes in front of it.
const HOP = new Set(['connection', 'keep-alive', 'proxy-connection', 'transfer-encoding', 'upgrade', 'http2-settings', 'te', 'host']);
function forwardHeaders(headers) {
    const out = {};
    for (const [k, v] of Object.entries(headers)) if (!k.startsWith(':') && !HOP.has(k)) out[k] = v;
    out.host = headers[':authority'] || headers.host;
    if (HEADER) { const i = HEADER.indexOf(': '); out[HEADER.slice(0, i).toLowerCase()] = HEADER.slice(i + 2); }
    return out;
}
function frontEnd(ready) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'netshape-'));
    const [key, cert] = [path.join(dir, 'key.pem'), path.join(dir, 'cert.pem')];
    const made = spawnSync('openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes', '-days', '1',
        '-subj', '/CN=127.0.0.1', '-addext', 'subjectAltName=IP:127.0.0.1', '-keyout', key, '-out', cert], { encoding: 'utf8' });
    if (made.status !== 0) throw Error('--h2 needs openssl: ' + (made.stderr || made.error));
    const tls = { key: fs.readFileSync(key), cert: fs.readFileSync(cert) };
    fs.rmSync(dir, { recursive: true, force: true });
    const agent = new http.Agent({ keepAlive: true, maxSockets: Infinity });
    const front = http2.createSecureServer({ ...tls, allowHTTP1: true }, (req, res) => {
        const up = http.request({ host: TARGET_HOST, port: Number(TARGET_PORT), method: req.method, path: req.url, headers: forwardHeaders(req.headers), agent }, r => {
            const headers = {};
            for (const [k, v] of Object.entries(r.headers)) if (!HOP.has(k)) headers[k] = v;
            res.writeHead(r.statusCode, headers);
            r.pipe(res);
        });
        up.on('error', () => { if (!res.headersSent) res.writeHead(502); res.end(); });
        req.pipe(up);
    });
    front.on('upgrade', (req, socket, head) => {
        const upstream = net.connect(Number(TARGET_PORT), TARGET_HOST, () => {
            const headers = forwardHeaders(req.headers);
            headers.connection = 'Upgrade';
            headers.upgrade = req.headers.upgrade;
            upstream.write(`${req.method} ${req.url} HTTP/1.1\r\n${Object.entries(headers).map(([k, v]) => `${k}: ${v}`).join('\r\n')}\r\n\r\n`);
            upstream.write(head);
            socket.pipe(upstream).pipe(socket);
        });
        upstream.on('error', () => socket.destroy());
        socket.on('error', () => upstream.destroy());
    });
    front.listen(0, '127.0.0.1', () => { [HOST, PORT] = ['127.0.0.1', String(front.address().port)]; ready(); });
}

const server = net.createServer(client => {
    // The handshake: nothing passes for one round trip.
    const opened = now() + RTT;
    const upstream = net.connect(Number(PORT), HOST);
    client.setNoDelay(true);
    upstream.setNoDelay(true);
    pipe(client, upstream, up, opened, HEADER && !H2 ? addHeader() : undefined);
    pipe(upstream, client, down, opened);
    upstream.on('error', () => client.destroy());
    client.on('close', () => upstream.destroy());
});
const listen = () => server.listen(LISTEN, '127.0.0.1', () => console.log(`netshape ${H2 ? 'https+h2' : 'http'} :${LISTEN} -> ${TARGET_HOST}:${TARGET_PORT}, ${MBPS} Mbps down / ${UP_MBPS} up, ${RTT} ms RTT`));
if (H2) frontEnd(listen); else listen();
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => process.exit(0));
