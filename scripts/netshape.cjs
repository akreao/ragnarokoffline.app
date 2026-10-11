#!/usr/bin/env node
// netshape -- a TCP proxy that makes a local server look remote: round-trip
// latency and a shared bandwidth limit, for measuring how the browser client
// loads over a real connection.
//
//   node scripts/netshape.cjs --listen 13400 --target 127.0.0.1:3338 --mbps 50 --rtt 40 [--up-mbps 10]
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
'use strict';
const net = require('node:net');

const argv = process.argv.slice(2);
const flag = (name, fallback) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : fallback; };
const LISTEN = Number(flag('--listen', 13400));
const [HOST, PORT] = flag('--target', '127.0.0.1:3338').split(':');
const MBPS = Number(flag('--mbps', 50));
const UP_MBPS = Number(flag('--up-mbps', MBPS));
const RTT = Number(flag('--rtt', 40));
const PIECE = 16 * 1024; // split chunks so connections interleave on the link

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
// one-way delay and the link's queue.
function pipe(from, to, dir, opened) {
    let last = 0;
    from.on('data', data => {
        for (let i = 0; i < data.length; i += PIECE) {
            const piece = data.subarray(i, i + PIECE);
            const at = Math.max(dir(piece.length, Math.max(now(), opened) + RTT / 2), last);
            last = at;
            setTimeout(() => { if (!to.destroyed) to.write(piece); }, Math.max(0, at - now()));
        }
    });
    from.on('end', () => setTimeout(() => to.end(), Math.max(0, last - now()) + 1));
    from.on('error', () => to.destroy());
}

const server = net.createServer(client => {
    // The handshake: nothing passes for one round trip.
    const opened = now() + RTT;
    const upstream = net.connect(Number(PORT), HOST);
    client.setNoDelay(true);
    upstream.setNoDelay(true);
    pipe(client, upstream, up, opened);
    pipe(upstream, client, down, opened);
    upstream.on('error', () => client.destroy());
    client.on('close', () => upstream.destroy());
});
server.listen(LISTEN, '127.0.0.1', () => console.log(`netshape :${LISTEN} -> ${HOST}:${PORT}, ${MBPS} Mbps down / ${UP_MBPS} up, ${RTT} ms RTT`));
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => process.exit(0));
