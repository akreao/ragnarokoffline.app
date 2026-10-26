'use strict';
// scripts/compress-bundle.cjs: the .br/.gz copies the asset server sends in
// place of a client file, and the minifier's promise to keep class names.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const { execFileSync } = require('node:child_process');

const script = path.join(__dirname, '..', 'scripts', 'compress-bundle.cjs');
const web = () => fs.mkdtempSync(path.join(os.tmpdir(), 'compress-bundle-'));
const big = text => (text + '\n').repeat(Math.ceil(4096 / (text.length + 1)));
let terser = null;
try { terser = require.resolve('terser', { paths: [path.join(__dirname, '..', 'vendor', 'roBrowserLegacy')] }); } catch {}

test('--precompress-only writes fresh .br/.gz copies of what it serves, and nothing else', t => {
  const dir = web(); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  for (const name of ['Online.js', 'api.html', 'Config.local.js', 'endpoint.json']) fs.writeFileSync(path.join(dir, name), big('var ' + name.replace(/\W/g, '_') + ' = 1;'));
  fs.writeFileSync(path.join(dir, 'Config.js'), 'small');
  fs.writeFileSync(path.join(dir, 'icon.png'), big('png'));
  // A copy that lands older than its file (a plain cp, a CI artifact) is
  // replaced, not kept.
  fs.writeFileSync(path.join(dir, 'Online.js.br'), 'stale');
  fs.utimesSync(path.join(dir, 'Online.js.br'), new Date(0), new Date(0));
  execFileSync(process.execPath, [script, '--precompress-only', dir]);
  for (const name of ['Online.js', 'api.html']) {
    const source = fs.readFileSync(path.join(dir, name));
    assert.deepEqual(zlib.brotliDecompressSync(fs.readFileSync(path.join(dir, name + '.br'))), source, name);
    assert.deepEqual(zlib.gunzipSync(fs.readFileSync(path.join(dir, name + '.gz'))), source, name);
    for (const ext of ['.br', '.gz']) assert.ok(fs.statSync(path.join(dir, name + ext)).mtimeMs >= fs.statSync(path.join(dir, name)).mtimeMs, name + ext);
  }
  // Rewritten at runtime, too small to matter, or not compressible.
  for (const name of ['Config.local.js', 'endpoint.json', 'Config.js', 'icon.png']) {
    assert.ok(!fs.existsSync(path.join(dir, name + '.br')) && !fs.existsSync(path.join(dir, name + '.gz')), name);
  }
});

test('minifying keeps the names constructor.name reads, and license comments', { skip: !terser && 'terser is installed with roBrowserLegacy' }, t => {
  const dir = web(); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  // The shape rolldown emits: module classes hoisted to the top level and
  // assigned an anonymous class, which takes its name from that binding.
  const source = `/*! Bundled license information: example MIT */
var StrEffect, Cylinder;
var init = () => { StrEffect = class { constructor() {} }; Cylinder = class extends StrEffect {}; };
function PACKET_ZC_NOTIFY() {}
export function names(longParameterName) { init(); var Local = class {}; return [new StrEffect().constructor.name, new Cylinder().constructor.name, PACKET_ZC_NOTIFY.name, longParameterName]; }
console.log(import.meta.url);
`;
  fs.writeFileSync(path.join(dir, 'Online.js'), source);
  execFileSync(process.execPath, [script, dir], { stdio: 'pipe' });
  const out = fs.readFileSync(path.join(dir, 'Online.js'), 'utf8');
  assert.ok(out.length < source.length);
  assert.match(out, /StrEffect=class/); assert.match(out, /Cylinder=class extends StrEffect/); assert.match(out, /function PACKET_ZC_NOTIFY\(/);
  assert.doesNotMatch(out, /longParameterName/, 'locals are still mangled');
  assert.match(out, /Bundled license information/);
  assert.match(out, /import\.meta\.url/);
});
