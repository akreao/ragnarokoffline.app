'use strict';
// Switching era relinks the assets without a restart, but the client keeps its own copy of every
// file it has fetched, so a window left open kept showing the other era's item text and signboards
// (the pre-renewal Jacket read "Defense: 15").
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8').replace(/\r\n/g, '\n');
const main = read('electron/main.js');
const settings = read('src/settings.html');

const applied = main.slice(main.indexOf('async function saveSettings'), main.indexOf('function scanClientDir'));

test('Apply drops the stale client cache once the assets are relinked, and only with no game window open', () => {
  const link = applied.indexOf('await linkClient(client)');
  const drop = applied.indexOf('await dropStaleClientCache()');
  assert.ok(link > -1 && drop > link, 'after the relink, so the new overlay.id is the one compared');
  assert.match(applied, /if \(!\(windows\.game && !windows\.game\.isDestroyed\(\)\)\) await dropStaleClientCache\(\);/);
});

test('an open game window is told it still shows the old era, and can be reopened from the status line', () => {
  assert.match(settings, /invoke\('game_status'\)\.then\(g => g\.open, \(\) => false\)/);
  assert.match(settings, /The open game still shows the old era's items and signs/);
  assert.match(settings, /reopen\.id = 'era-reopen';/);
  assert.match(settings, /reopen\.onclick = async \(\) => \{[^]*?await invoke\('open_game'\)/, 'the same handler as the Mods tab Reopen game');
  assert.match(settings, /if \(gameOpen\) \{[^]*?status\.append\(reopen\);/, 'only offered when a game window is open');
});
