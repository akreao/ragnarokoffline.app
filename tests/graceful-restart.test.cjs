'use strict';
// Apply in Settings, switching a mod on and a restore all start the stack
// again while it runs. `up` replaces each server with `rm -f` (SIGKILL), so a
// map server still running at that point never saved its players: everything
// since the last autosave rolled back. These pin the graceful stop in front.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const cmds = fs.readFileSync(path.join(__dirname, '..', 'stack/src/cmds.rs'), 'utf8').replace(/\r\n/g, '\n');
const body = (start) => {
  const at = cmds.indexOf(start);
  assert.ok(at >= 0, `${start} not found`);
  const end = cmds.indexOf('\n}\n', at);
  return cmds.slice(at, end);
};

test('up stops running game servers gracefully before it replaces any of them', () => {
  const up = body('pub fn up(');
  const stop = up.indexOf('stop_game_services(cfg, dk)');
  assert.ok(stop >= 0, 'up stops the game servers itself, on every install');
  for (const later of ['credentials.write_files()', 'run_server(cfg, dk, "ragnarok-login"', 'run_server(cfg, dk, "ragnarok-map"']) {
    assert.ok(up.indexOf(later) > stop, `${later} comes after the graceful stop`);
  }
  assert.ok(up.indexOf('ensure_engine(cfg, dk, lan, ram_mib)?;') < stop, 'after the engine is up, so docker answers');
});

test('the graceful stop is SIGTERM with time to save, map server before the char server it saves through', () => {
  const stop = body('fn stop_game_services(');
  assert.match(stop, /for service in \[WEB_SERVER, "ragnarok-map", "ragnarok-char", "ragnarok-login"\]/);
  assert.match(stop, /dk\.output\(\["stop", "-t", "30", service\]\)/);
});
