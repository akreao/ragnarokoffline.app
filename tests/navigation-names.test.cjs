'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { spawnSync } = require('node:child_process');
const { IMPLEMENTATION, patchLoader } = require('../scripts/navigation-names.cjs');

const why = result => result.stderr || (result.error && result.error.message) || `exit code ${result.status}`;

const LOADER = [
  'function loadLuaValue(file_path, variable_name, callback, onEnd) {',
  '\t\t\t\tawait lua.doFile(file_path);',
  '\t\t\t\t\t\t\textractValue(to_json(${variable_name}))',
  '}'
].join('\n');

test('the loader is patched once, and refuses a loader it does not recognise', () => {
  const patched = patchLoader(LOADER);
  assert.ok(patched.startsWith(IMPLEMENTATION));
  assert.match(patched, /if \(NAVIGATION_NAME_COLUMNS\[variable_name\] \|\| variable_name === "Navi_Distance"\) await navigationNamesTurn\(\);\n\t+await lua\.doFile\(file_path\);/);
  assert.match(patched, /\$\{navigationServerLinks\(variable_name\)\}\$\{navigationNameSwap\(variable_name\)\}\n\t+extractValue\(to_json\(\$\{variable_name\}\)\)/);
  assert.throws(() => patchLoader(LOADER.replace('await lua.doFile(file_path);', '')), /load call not found/);
  assert.throws(() => patchLoader(LOADER.replace('extractValue(', 'extract(')), /extraction not found/);
});

// The renderer crashed when the tables, all waiting on the dictionary, resumed
// together and ran lua.doFile interleaved on the one Lua state. Here doFile
// takes a few microtasks, as wasmoon's does, and two at once fail the test.
test('the tables waiting on the dictionary run their Lua one at a time', async () => {
  let running = 0, overlapped = false, dictionaryLoaded = false;
  const order = [];
  const lua = {
    mountFile() {}, unmountFile() {},
    async doFile(file) {
      running += 1; overlapped = overlapped || running > 1;
      for (let i = 0; i < 3; i++) await Promise.resolve();
      if (file === 'SystemEN/Navi_Data.lub') dictionaryLoaded = true;
      order.push(file); running -= 1;
    }
  };
  const Client = { loadFile(file, ok) { setTimeout(() => ok(new ArrayBuffer(1)), 5); } };
  const context = { Client, lua, setTimeout, console, DB: { LUA_PATH: 'data/luafiles514/lua files/' } };
  vm.runInNewContext(IMPLEMENTATION + ';this.turn = navigationNamesTurn;', context);
  await Promise.all(['Navi_Map', 'Navi_Npc', 'Navi_Mob', 'Navi_Link'].map(async name => {
    await context.turn();
    assert.ok(dictionaryLoaded, name + ' ran before the dictionary was loaded');
    await lua.doFile(name);
  }));
  assert.equal(overlapped, false, 'two Lua chunks ran at once: ' + order.join(', '));
  assert.deepEqual(order, [
    'SystemEN/Navi_Data.lub', 'data/luafiles514/lua files/navigation/navi_link_server.lub',
    'Navi_Map', 'Navi_Npc', 'Navi_Mob', 'Navi_Link'
  ]);
});

function serverLinks(variableName) {
  const context = {};
  vm.runInNewContext(IMPLEMENTATION + ';this.links = navigationServerLinks;', context);
  return context.links(variableName);
}

// navigation-server-warps: the server's portals replace the GRF's, its other
// links stay, and the GRF's distances, which name its portals, are set aside.
// Without the server's table, nothing changes.
test('the server\'s portals replace the GRF\'s, and only while there are some', t => {
  const luaBin = ['lua5.1', 'lua'].find(bin => spawnSync(bin, ['-v'], { encoding: 'utf8' }).status === 0);
  if (!luaBin) {
    assert.ok(!process.env.REQUIRE_LUA, 'REQUIRE_LUA is set, and there is no lua5.1 or lua');
    return t.skip('no Lua interpreter');
  }
  assert.equal(serverLinks('Navi_Map'), '');
  const run = server => {
    const script = [
      server,
      'Navi_Link = { { "prontera", 1, 200, 99999, "kRO gate", "", 1, 1, "prt_fild08", 2, 2 },',
      '  { "alberta", 2, 204, 100, "Sailor", "", 3, 3, "izlude", 4, 4 } }',
      'Navi_Distance = { "prontera", 1, { { 1, { "prt_fild08", 1, 10 } } } }',
      serverLinks('Navi_Link'),
      serverLinks('Navi_Distance'),
      'for _, r in ipairs(Navi_Link) do io.write(r[5], "|", r[3], "\\n") end',
      'io.write("distance ", #Navi_Distance, "\\n")'
    ].join('\n');
    const result = spawnSync(luaBin, ['-'], { input: script, encoding: 'latin1' });
    assert.equal(result.status, 0, why(result));
    return result.stdout.trim().split('\n');
  };
  assert.deepEqual(
    run('Navi_Link_Server = { { "prontera", 1000000, 200, 99999, "prt001", "", 5, 5, "prt_fild08", 6, 6 } }'),
    ['Sailor|204', 'prt001|200', 'distance 0']
  );
  assert.deepEqual(run(''), ['kRO gate|200', 'Sailor|204', 'distance 3'], 'no server table: the GRF\'s routes as they were');
  assert.deepEqual(run('Navi_Link_Server = {}'), ['kRO gate|200', 'Sailor|204', 'distance 3'], 'an empty one changes nothing');
});

function swap(variableName) {
  const context = {};
  vm.runInNewContext(IMPLEMENTATION + ';this.swap = navigationNameSwap;', context);
  return context.swap(variableName);
}

test('only the four named tables are renamed', () => {
  assert.equal(swap('SKID'), '');
  assert.equal(swap('Navi_Distance'), '');
  assert.match(swap('Navi_Map'), /local names = Navi_Data_Map\b[\s\S]*row\[2\]/);
  assert.match(swap('Navi_Npc'), /local names = Navi_Data_NPC\b[\s\S]*row\[5\][\s\S]*true and row\[4\] == 99999/);
});

// The Lua itself, run where a Lua 5.1 is installed. The Korean name is EUC-KR
// bytes, as kRO's tables and ROenglishRE's dictionary both hold it.
test('Korean names are translated and every other name is left as it is', t => {
  const luaBin = ['lua5.1', 'lua'].find(bin => spawnSync(bin, ['-v'], { encoding: 'utf8' }).status === 0);
  if (!luaBin) {
    assert.ok(!process.env.REQUIRE_LUA, 'REQUIRE_LUA is set, and there is no lua5.1 or lua');
    return t.skip('no Lua interpreter');
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ro-navi-names-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const kafra = Buffer.from([0xc4, 0xab, 0xc7, 0xc1, 0xb6, 0xf3]); // 카프라
  const guard = Buffer.from([0xb0, 0xe6, 0xba, 0xf1, 0xba, 0xb4]); // 경비병
  const lua = Buffer.concat([
    Buffer.from('Navi_Data_NPC = { ["'), kafra, Buffer.from('"] = "Kafra Employee" }\n'),
    Buffer.from('Navi_Npc = {\n'),
    Buffer.from('\t{ "prontera", 1, 101, 112, "'), kafra, Buffer.from('", "", 146, 89 },\n'),
    Buffer.from('\t{ "prontera", 2, 101, 105, "'), guard, Buffer.from('", "", 160, 330 },\n'),
    Buffer.from('\t{ "prontera", 3, 101, 112, "Kafra Employee", "", 151, 29 },\n'),
    Buffer.from('\t{ "prontera", 4, 101, 99999, "'), kafra, Buffer.from('", "", 1, 1 },\n'),
    Buffer.from('}\n'),
    Buffer.from(swap('Navi_Npc')),
    Buffer.from('\nNavi_Map = { { "prontera", "Prontera", 5001, 400, 400 } }\n'),
    Buffer.from(swap('Navi_Map')),
    Buffer.from('\nfor _, r in ipairs(Navi_Npc) do io.write(r[5], "\\n") end\nio.write(Navi_Map[1][2], "\\n")\n')
  ]);
  fs.writeFileSync(path.join(dir, 'check.lua'), lua);
  const result = spawnSync(luaBin, [path.join(dir, 'check.lua')]);
  assert.equal(result.status, 0, why({ ...result, stderr: result.stderr && result.stderr.toString() }));
  const lines = result.stdout.toString('latin1').trim().split('\n');
  assert.equal(lines[0], 'Kafra Employee');
  assert.equal(lines[1], guard.toString('latin1'), 'a name the dictionary lacks stays Korean');
  assert.equal(lines[2], 'Kafra Employee', 'an English name passes through');
  assert.equal(lines[3], kafra.toString('latin1'), 'class 99999 is skipped, as navi_f does');
  assert.equal(lines[4], 'Prontera', 'no Navi_Data_Map loaded: unchanged');
});
