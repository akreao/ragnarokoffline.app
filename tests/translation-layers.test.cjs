'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { shippedFiles, tar } = require('../scripts/translation-layers.cjs');

// The shell's own extractor, taken from electron/main.js as it is.
function appExtractor() {
  const src = fs.readFileSync(path.join(__dirname, '../electron/main.js'), 'utf8');
  const start = src.indexOf('function extractTarLatin1(');
  let depth = 0, i = src.indexOf('{', start);
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) break;
  }
  return new Function('fs', 'path', src.slice(start, i + 1) + ';return extractTarLatin1;')(fs, path);
}

const UI = 'À¯ÀúÀÎÅÍÆäÀÌ½º';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ro-layers-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const write = (rel, body) => {
    const p = path.join(root, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, body);
  };
  const c = 'vendor/ROenglishRE/Translation/Compatibility';
  write(`${c}/2017-06-14/data/texture/${UI}/basic_interface/rodexsystem/renewal/btn_reply_out.bmp`, 'reply');
  write(`${c}/2017-06-14/data/texture/${UI}/basic_interface/rodexsystem/renewal/btn_listtab_admin_out.bmp`, 'too wide');
  write(`${c}/2017-12-13/Renewal/data/texture/${UI}/era.bmp`, 'renewal');
  write(`${c}/2017-12-13/Pre-Renewal/data/texture/${UI}/era.bmp`, 'pre-renewal');
  write(`${c}/2018-06-20/Renewal/data/luafiles514/lua files/skillinfoz/skilltreeview.lub`, 'not taken');
  write(`${c}/2019-06-05/SystemEN/mapInfo.lub`, 'map names');
  write(`${c}/2023-08-02/data/simplemsg/msg_emotion.csv`, 'emotions');
  write(`${c}/2025-12-17/data/texture/${UI}/future.bmp`, 'newer than every packet version');
  write(`${c}/notes/data/texture/undated.bmp`, 'not a layer');
  write('config/PACKETVERS', '# comment\n20221005     default\n20250402     experimental\n');
  write('config/TRANSLATION_LAYERS',
    `take\tdata/texture/\ntake\tdata/simplemsg/msg_emotion.csv\n` +
    `skip\tdata/texture/${UI}/basic_interface/rodexsystem/renewal/btn_listtab_\n`);
  write('config/TRANSLATION_EXTRAS',
    'Compatibility/2019-06-05/SystemEN/mapInfo.lub\tSystemEN/mapInfo.lub\n' +
    `Compatibility/2017-06-14/data/texture/${UI}/basic_interface/rodexsystem/renewal/btn_reply_out.bmp\tx\n`);
  return root;
}

test('every layer up to the newest packet version, both eras, as the rules take them', t => {
  const root = fixture(t);
  assert.deepEqual(shippedFiles(root), [
    `Compatibility/2017-06-14/data/texture/${UI}/basic_interface/rodexsystem/renewal/btn_reply_out.bmp`,
    `Compatibility/2017-12-13/Renewal/data/texture/${UI}/era.bmp`,
    `Compatibility/2017-12-13/Pre-Renewal/data/texture/${UI}/era.bmp`,
    'Compatibility/2023-08-02/data/simplemsg/msg_emotion.csv',
    'Compatibility/2019-06-05/SystemEN/mapInfo.lub'
  ]);
});

test('the tar comes back byte for byte through the shell\'s extractor', t => {
  const root = fixture(t);
  const translation = path.join(root, 'vendor/ROenglishRE/Translation');
  const files = shippedFiles(root);
  // Past the 100-byte name field, so the GNU long-name record is exercised.
  assert.ok(files.some(f => Buffer.byteLength(f) > 100));
  const archive = path.join(root, 'compatibility.tar');
  fs.writeFileSync(archive, tar(files.map(f => [f, fs.readFileSync(path.join(translation, f))])));
  const out = path.join(root, 'out');
  appExtractor()(archive, out);
  for (const f of files) {
    assert.deepEqual(fs.readFileSync(path.join(out, f)), fs.readFileSync(path.join(translation, f)), f);
  }
  const unpacked = [];
  const walk = dir => fs.readdirSync(dir, { withFileTypes: true }).forEach(e =>
    e.isDirectory() ? walk(path.join(dir, e.name)) : unpacked.push(path.relative(out, path.join(dir, e.name)).split(path.sep).join('/')));
  walk(out);
  assert.deepEqual(unpacked.sort(), [...files].sort());
});
