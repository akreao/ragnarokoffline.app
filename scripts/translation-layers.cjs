#!/usr/bin/env node
/**
 * The ROenglishRE Compatibility files the app ships, one path per line,
 * relative to Translation/: what config/TRANSLATION_LAYERS takes from every
 * layer a packet version in config/PACKETVERS could stack (both eras), and the
 * sources config/TRANSLATION_EXTRAS names.
 *
 *   node scripts/translation-layers.cjs <root>              list them
 *   node scripts/translation-layers.cjs <root> <out.tar>    pack them
 *
 * Which of them a player gets is decided at link time by stack/src/assets.rs,
 * from the packet version and era they chose; this only decides what is in the
 * payload, so it keeps every layer up to the newest packet version.
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');

function lines(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split(/\r?\n/).map(l => l.trim()).filter(l => l && !l.startsWith('#'));
}

function shippedFiles(root) {
  const translation = path.join(root, 'vendor/ROenglishRE/Translation');
  const take = [], skip = [];
  for (const line of lines(path.join(root, 'config/TRANSLATION_LAYERS'))) {
    const [kind, prefix] = line.split('\t').map(c => c.trim()).filter(Boolean);
    if (kind === 'take' && prefix) take.push(prefix);
    if (kind === 'skip' && prefix) skip.push(prefix);
  }
  const newest = lines(path.join(root, 'config/PACKETVERS')).map(l => l.split(/\s+/)[0]).sort().pop() || '';
  const out = [];
  const walk = (dir, layerRel, rel) => {
    for (const name of fs.readdirSync(dir).sort()) {
      const full = path.join(dir, name);
      const inLayer = rel ? `${rel}/${name}` : name;
      if (fs.lstatSync(full).isDirectory()) {
        const prefix = inLayer + '/';
        if (take.some(t => t.startsWith(prefix) || prefix.startsWith(t))) walk(full, layerRel, inLayer);
      } else if (take.some(t => inLayer.startsWith(t)) && !skip.some(s => inLayer.startsWith(s))) {
        out.push(`${layerRel}/${inLayer}`);
      }
    }
  };
  const compatibility = path.join(translation, 'Compatibility');
  if (fs.existsSync(compatibility)) {
    for (const date of fs.readdirSync(compatibility).sort()) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || date.replace(/-/g, '') > newest) continue;
      const layer = path.join(compatibility, date);
      if (!fs.statSync(layer).isDirectory()) continue;
      const eras = ['Renewal', 'Pre-Renewal'].filter(e => fs.existsSync(path.join(layer, e)));
      if (eras.length) for (const era of eras) walk(path.join(layer, era), `Compatibility/${date}/${era}`, '');
      else walk(layer, `Compatibility/${date}`, '');
    }
  }
  for (const line of lines(path.join(root, 'config/TRANSLATION_EXTRAS'))) {
    const source = line.split('\t')[0].trim();
    if (fs.existsSync(path.join(translation, source))) out.push(source);
    else process.stderr.write(`warning: TRANSLATION_EXTRAS names ${source}, which the pinned ROenglishRE lacks\n`);
  }
  return [...new Set(out)];
}

// A tar the shell's extractTarLatin1 reads the same everywhere: names as UTF-8
// bytes, a GNU long-name record for any longer than the 100-byte field. Written
// here rather than by system tar, which on macOS stores such names in pax
// headers the extractor does not read, and on Windows has already decoded these
// names through three different codepages.
function tar(entries) {
  const BLOCK = 512;
  const header = (name, size, type) => {
    const h = Buffer.alloc(BLOCK);
    name.copy(h, 0, 0, Math.min(name.length, 100));
    h.write('0000644\0', 100, 'ascii');
    h.write('0000000\0', 108, 'ascii');
    h.write('0000000\0', 116, 'ascii');
    h.write(size.toString(8).padStart(11, '0') + '\0', 124, 'ascii');
    h.write('00000000000\0', 136, 'ascii');
    h.write(type, 156, 'ascii');
    h.write('ustar  \0', 257, 'ascii');
    h.fill(' ', 148, 156);
    let sum = 0;
    for (const byte of h) sum += byte;
    h.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 'ascii');
    return h;
  };
  const pad = data => Buffer.concat([data, Buffer.alloc((BLOCK - (data.length % BLOCK)) % BLOCK)]);
  const parts = [];
  for (const [name, data] of entries) {
    const bytes = Buffer.from(name, 'utf8');
    if (bytes.length > 100) {
      const long = Buffer.concat([bytes, Buffer.from([0])]);
      parts.push(header(Buffer.from('././@LongLink'), long.length, 'L'), pad(long));
    }
    parts.push(header(bytes, data.length, '0'), pad(data));
  }
  parts.push(Buffer.alloc(BLOCK * 2));
  return Buffer.concat(parts);
}

if (require.main === module) {
  const root = path.resolve(process.argv[2] || path.join(__dirname, '..'));
  const files = shippedFiles(root);
  if (process.argv[3]) {
    const translation = path.join(root, 'vendor/ROenglishRE/Translation');
    fs.writeFileSync(process.argv[3], tar(files.map(f => [f, fs.readFileSync(path.join(translation, f))])));
    process.stderr.write(`compatibility layers: ${files.length} files\n`);
  } else {
    process.stdout.write(files.map(f => f + '\n').join(''));
  }
}

module.exports = { shippedFiles, tar };
