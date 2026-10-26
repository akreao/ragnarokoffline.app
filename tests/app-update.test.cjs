'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const update = require('../electron/app-update.js');

const packaged = { packaged: true, headless: false, platform: 'darwin', appImage: false, adHocSigned: false, hasUpdateConfig: true };

test('availability: only a packaged, properly signed build with a feed updates itself', () => {
  assert.deepStrictEqual(update.availability(packaged), { ok: true, reason: '' });
  assert.strictEqual(update.availability({ ...packaged, packaged: false }).ok, false);
  assert.strictEqual(update.availability({ ...packaged, headless: true }).ok, false);
  assert.strictEqual(update.availability({ ...packaged, hasUpdateConfig: false }).ok, false);
  // A fork's ad hoc build: Squirrel.Mac would refuse every update.
  assert.match(update.availability({ ...packaged, adHocSigned: true }).reason, /Developer ID/);
  assert.strictEqual(update.availability({ ...packaged, platform: 'win32', adHocSigned: true }).ok, true);
  assert.strictEqual(update.availability({ ...packaged, platform: 'linux' }).ok, false);
  assert.strictEqual(update.availability({ ...packaged, platform: 'linux', appImage: true }).ok, true);
});

test('quitPlan: an ordinary quit installs only with the setting on', () => {
  // Setting off (the default): only Restart to install installs.
  assert.strictEqual(update.quitPlan({ ready: true, restartRequested: false, installOnQuit: false, relaunch: false }), 'exit');
  assert.strictEqual(update.quitPlan({ ready: true, restartRequested: false, installOnQuit: false, relaunch: true }), 'exit');
  assert.strictEqual(update.quitPlan({ ready: true, restartRequested: true, installOnQuit: false, relaunch: false }), 'install-relaunch');
  // Setting on.
  assert.strictEqual(update.quitPlan({ ready: true, restartRequested: false, installOnQuit: true, relaunch: false }), 'install');
  // A launch during the quit: the installer starts the new version.
  assert.strictEqual(update.quitPlan({ ready: true, restartRequested: false, installOnQuit: true, relaunch: true }), 'install-relaunch');
  // Nothing downloaded: nothing to do either way.
  for (const installOnQuit of [false, true]) {
    for (const restartRequested of [false, true]) {
      assert.strictEqual(update.quitPlan({ ready: false, restartRequested, installOnQuit, relaunch: false }), 'exit');
    }
  }
});

test('the library\'s own install-on-quit flag is never set on macOS', () => {
  assert.strictEqual(update.libraryInstallOnQuit('darwin', true), false);
  assert.strictEqual(update.libraryInstallOnQuit('darwin', false), false);
  assert.strictEqual(update.libraryInstallOnQuit('win32', true), true);
  assert.strictEqual(update.libraryInstallOnQuit('win32', false), false);
  assert.strictEqual(update.libraryInstallOnQuit('linux', true), true);
});

// electron-updater, standing in: an emitter recording what was asked of it.
function fakeLibrary() {
  const lib = new EventEmitter();
  lib.calls = [];
  lib.checkForUpdates = async () => { lib.calls.push(['check']); };
  lib.install = (silent, run) => { lib.calls.push(['install', silent, run]); return true; };
  lib.quitAndInstall = (silent, run) => { lib.calls.push(['quitAndInstall', silent, run]); };
  return lib;
}

function fakeNative() {
  const n = new EventEmitter();
  n.checks = 0;
  n.checkForUpdates = () => { n.checks++; setImmediate(() => n.emit('update-downloaded')); };
  return n;
}

function make({ platform = 'win32', installOnQuit = false, auto = true, execPath = 'D:\\Games\\Ragnarok Offline\\Ragnarok Offline.exe' } = {}) {
  const prefs = { auto, installOnQuit };
  const lib = fakeLibrary();
  const native = fakeNative();
  const timers = { setTimeout: () => 0, setInterval: () => 0, clearTimeout: () => {} };
  const u = update.createAppUpdater({
    app: { getVersion: () => '1.6.2' },
    platform,
    execPath,
    log: () => {},
    preferences: () => ({ ...prefs }),
    availability: { ok: true, reason: '' },
    load: () => lib,
    nativeUpdater: () => native,
    timers,
  });
  return { u, lib, native, prefs };
}

async function downloaded(t, version = '1.6.3') {
  await t.u.check();
  t.lib.emit('update-available', { version });
  t.lib.emit('download-progress', { percent: 42.7 });
  assert.strictEqual(t.u.status().percent, 42);
  assert.strictEqual(t.u.status().canInstall, false);
  t.lib.emit('update-downloaded', { version });
}

test('a downloaded update waits; an ordinary quit with the setting off installs nothing', async () => {
  for (const platform of ['win32', 'darwin', 'linux']) {
    const t = make({ platform, installOnQuit: false });
    await downloaded(t);
    assert.strictEqual(t.u.status().ready, '1.6.3');
    assert.strictEqual(t.u.status().canInstall, true);
    assert.strictEqual(t.lib.autoInstallOnAppQuit, false);
    assert.strictEqual(await t.u.finishQuit({ restartRequested: false, relaunch: false }), 'none');
    assert.deepStrictEqual(t.lib.calls, [['check']], platform);
    assert.strictEqual(t.native.checks, 0, `${platform}: nothing handed to Squirrel.Mac`);
  }
});

test('Restart to install: silent install, then the new version starts', async () => {
  const t = make({ platform: 'win32' });
  await downloaded(t);
  assert.strictEqual(await t.u.finishQuit({ restartRequested: true, relaunch: false }), 'handed-off');
  assert.deepStrictEqual(t.lib.calls.at(-1), ['quitAndInstall', true, true]);
});

test('the setting on: an ordinary quit installs, without starting the app again', async () => {
  const win = make({ platform: 'win32', installOnQuit: true });
  await downloaded(win);
  assert.strictEqual(win.lib.autoInstallOnAppQuit, true);
  assert.strictEqual(await win.u.finishQuit({ restartRequested: false, relaunch: false }), 'installed');
  assert.deepStrictEqual(win.lib.calls.at(-1), ['install', true, false]);

  // macOS: staged with Squirrel.Mac at quit, and only then.
  const mac = make({ platform: 'darwin', installOnQuit: true });
  await downloaded(mac);
  assert.strictEqual(mac.lib.autoInstallOnAppQuit, false);
  assert.strictEqual(mac.native.checks, 0);
  assert.strictEqual(await mac.u.finishQuit({ restartRequested: false, relaunch: false }), 'installed');
  assert.strictEqual(mac.native.checks, 1);
  assert.deepStrictEqual(mac.lib.calls, [['check']]);
});

test('turning the setting on or off applies at once', async () => {
  const t = make({ platform: 'win32', installOnQuit: false });
  await downloaded(t);
  assert.strictEqual(t.lib.autoInstallOnAppQuit, false);
  t.prefs.installOnQuit = true;
  t.u.preferencesChanged();
  assert.strictEqual(t.lib.autoInstallOnAppQuit, true);
  t.prefs.installOnQuit = false;
  t.u.preferencesChanged();
  assert.strictEqual(t.lib.autoInstallOnAppQuit, false);
  assert.strictEqual(await t.u.finishQuit({ restartRequested: false, relaunch: false }), 'none');
});

test('a newer release replaces the waiting one', async () => {
  const t = make();
  await downloaded(t, '1.6.3');
  t.lib.emit('update-available', { version: '1.6.4' });
  // While it downloads there is nothing whole to install.
  assert.strictEqual(t.u.status().canInstall, false);
  assert.strictEqual(await t.u.finishQuit({ restartRequested: true, relaunch: false }), 'none');
  t.lib.emit('update-downloaded', { version: '1.6.4' });
  assert.strictEqual(t.u.status().ready, '1.6.4');
  assert.strictEqual(t.u.status().canInstall, true);
});

test('errors are reported quietly, in a short line', async () => {
  const t = make();
  t.lib.checkForUpdates = async () => { throw new Error('getaddrinfo ENOTFOUND github.com'); };
  const s = await t.u.check();
  assert.strictEqual(s.phase, 'error');
  assert.match(s.error, /offline/);
  assert.match(update.shortError(new Error('Cannot find latest-mac.yml ... ERR_UPDATER_CHANNEL_FILE_NOT_FOUND')), /no update files/);
});

test('disabled: no checks, nothing installed', async () => {
  const lib = fakeLibrary();
  const u = update.createAppUpdater({
    app: { getVersion: () => '1.6.2' }, log: () => {}, preferences: () => ({ auto: true, installOnQuit: true }),
    availability: { ok: false, reason: 'running from source' }, load: () => lib, nativeUpdater: () => null,
  });
  u.start();
  assert.strictEqual((await u.check()).phase, 'disabled');
  assert.strictEqual(await u.finishQuit({ restartRequested: true, relaunch: false }), 'none');
  assert.deepStrictEqual(lib.calls, []);
});

// What the macOS half rests on: electron-updater hands a download to
// Squirrel.Mac (which then installs it on any exit) only when its
// autoInstallOnAppQuit is set, or from quitAndInstall. A version of the
// library that stages unconditionally would make an ordinary quit install.
// Skipped where the root dependencies are not installed (test.yml's shell
// suite runs without them); `npm install` and it runs.
const macUpdater = path.join(__dirname, '..', 'node_modules', 'electron-updater', 'out', 'MacUpdater.js');
test('electron-updater stages with Squirrel.Mac only when told to', { skip: !fs.existsSync(macUpdater) && 'electron-updater is not installed' }, () => {
  const src = fs.readFileSync(macUpdater, 'utf8');
  const calls = [...src.matchAll(/this\.nativeUpdater\.checkForUpdates\(\)/g)].map(m => m.index);
  assert.strictEqual(calls.length, 2, 'two places hand the update to Squirrel.Mac');
  const before = i => src.slice(Math.max(0, i - 900), i);
  // In the download path, behind `if (this.autoInstallOnAppQuit)`.
  assert.match(before(calls[0]), /if \(this\.autoInstallOnAppQuit\) \{[^}]*$/);
  // In quitAndInstall, only when the flag was off (so the download path did not).
  assert.match(before(calls[1]), /quitAndInstall\(\) \{[\s\S]*if \(!this\.autoInstallOnAppQuit\) \{[^}]*$/);
});

test('Windows: the update installs over the folder this copy runs from, even on another drive (#632)', async () => {
  const t = make({ platform: 'win32' });
  await downloaded(t);
  assert.strictEqual(t.lib.installDirectory, 'D:\\Games\\Ragnarok Offline');
  assert.strictEqual(update.windowsInstallDirectory('C:\\Users\\p\\AppData\\Local\\Programs\\ragnarokoffline\\Ragnarok Offline.exe'),
    'C:\\Users\\p\\AppData\\Local\\Programs\\ragnarokoffline');
  assert.strictEqual(update.windowsInstallDirectory(''), null);
  for (const platform of ['darwin', 'linux']) {
    const other = make({ platform });
    await downloaded(other);
    assert.strictEqual(other.lib.installDirectory, undefined, platform);
  }
});
