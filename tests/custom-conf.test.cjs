'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { parse, customConf, overrides, report, keysIn, MAX_BYTES } = require('../electron/custom-conf');

const read = f => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
const names = text => parse(text).settings.map(s => s.key);

test('ordinary lines become settings', () => {
	const { settings, notes } = parse('drop_rate_cap: 10000\nmax_walk_path: 24\n');
	assert.deepEqual(settings, [
		{ key: 'drop_rate_cap', value: '10000', at: 1 },
		{ key: 'max_walk_path', value: '24', at: 2 },
	]);
	assert.deepEqual(notes, []);
});

// rAthena skips a comment only when '//' is at column 0, so an indented one
// would be read as a setting whose name starts with slashes. Comments are
// dropped here and the rest is written back trimmed.
test('comments, blank lines and indentation are handled', () => {
	const { settings, notes } = parse('// a note\n\n   // indented note\n   drop_rate_cap: 10000   \n');
	assert.deepEqual(settings, [{ key: 'drop_rate_cap', value: '10000', at: 4 }]);
	assert.deepEqual(notes, []);
	assert.equal(customConf({ custom_battle_conf: '   drop_rate_cap: 10000' }).split('\n')[1], 'drop_rate_cap: 10000');
});

test('a textarea saved on Windows parses the same', () => {
	assert.deepEqual(names('drop_rate_cap: 10000\r\nmax_walk_path: 24\r\n'), ['drop_rate_cap', 'max_walk_path']);
});

// `import` is the one battle-config key that reads another file, which is the
// only way a line here could reach outside the config the app generates.
test('import is refused by name', () => {
	for (const text of ['import: /etc/passwd', 'IMPORT: conf/x.txt', '  import:conf/x.txt  ']) {
		const { settings, notes } = parse(text);
		assert.deepEqual(settings, [], text);
		assert.match(notes[0], /not allowed here/, text);
	}
});

test('a line the server could not read is named, not dropped in silence', () => {
	for (const [text, pattern] of [
		['this is not a setting', /not a setting/],
		['drop rate cap: 1', /is not a setting name/],
		['9lives: 1', /is not a setting name/],
		['drop_rate_cap:', /no value the server could read/],
		[': 100', /not a setting/],
	]) {
		const { settings, notes } = parse(text);
		assert.deepEqual(settings, [], text);
		assert.equal(notes.length, 1, text);
		assert.match(notes[0], pattern, text);
	}
});

// The value is interpolated into a file the map server parses line by line, so
// a value carrying a newline would be a setting the player never typed.
test('a value cannot smuggle a second setting onto the next line', () => {
	assert.deepEqual(names('drop_rate_cap: 1 1\nbase_exp_rate: 9999'), ['base_exp_rate']);
	for (const { value } of parse(read('electron/custom-conf.js').slice(0, 0) + 'a: 1').settings) {
		assert.doesNotMatch(value, /[\r\n]/);
	}
	const written = customConf({ custom_battle_conf: 'drop_rate_cap: 10000' });
	assert.equal(written.trim().split('\n').length, 2, 'a header comment and one setting');
});

// rAthena's sscanf reads one token, so the rest of the line is ignored. A
// trailing comment is the normal use of that; a value with a space in it is a
// player losing half of what they typed, and is worth saying.
test('only the first token of a value is read, and a lost tail is reported', () => {
	assert.deepEqual(parse('idletime_mer_option: 0x1F // bitmask').notes, []);
	const { settings, notes } = parse('start_items: 1101 1 0');
	assert.deepEqual(settings, [{ key: 'start_items', value: '1101 1 0', at: 1 }]);
	assert.match(notes[0], /is set to "1101"; the server reads only up to the first space/);
});

test('the same name twice says which one wins', () => {
	const { settings, notes } = parse('drop_rate_cap: 1\ndrop_rate_cap: 2');
	assert.equal(settings.length, 2, 'both are written, as rAthena would read them');
	assert.match(notes[0], /already set on line 1, and this one wins/);
});

test('nothing at all writes nothing at all', () => {
	for (const custom_battle_conf of ['', '   \n\n', '// only a note', null, undefined, 42, {}]) {
		assert.equal(customConf({ custom_battle_conf }), '', String(custom_battle_conf));
		assert.deepEqual(parse(custom_battle_conf).notes, [], String(custom_battle_conf));
	}
});

test('an oversized box writes nothing and says so', () => {
	const text = 'drop_rate_cap: 10000\n'.repeat(Math.ceil(MAX_BYTES / 21) + 1);
	assert.ok(Buffer.byteLength(text) > MAX_BYTES);
	const { settings, notes } = parse(text);
	assert.deepEqual(settings, []);
	assert.match(notes[0], new RegExp(`longer than ${MAX_BYTES} bytes, so none of them were written`));
	assert.equal(customConf({ custom_battle_conf: text }), '');
});

// The box is applied last, so a name also written by a slider wins. That is
// the point of it; a player left guessing why their slider does nothing is
// the cost, so Apply says it out loud.
test('a name that overrides a slider is reported', () => {
	const generated = '// Generated by Ragnarok Offline.\nbase_exp_rate: 500\nitem_rate_card_mvp: 100\n';
	assert.deepEqual(overrides(generated, 'base_exp_rate: 9999\ndrop_rate_cap: 10000'), ['base_exp_rate']);
	assert.deepEqual(overrides(generated, 'drop_rate_cap: 10000'), []);
	const said = report(generated, 'base_exp_rate: 9999\nnonsense');
	assert.match(said, /override what Rates sets for base_exp_rate/);
	assert.match(said, /not a setting/);
	assert.equal(report(generated, 'drop_rate_cap: 10000'), '', 'nothing to say when nothing clashes');
});

test('keysIn ignores the generated header comment', () => {
	assert.deepEqual([...keysIn('// Generated by Ragnarok Offline. Edits here are overwritten.\na: 1\nb: 2\n')], ['a', 'b']);
});

// ---------------------------------------------------------------------------
// How it is wired in
// ---------------------------------------------------------------------------

test('the generated settings come first and the player\'s own last', () => {
	const main = read('electron/main.js');
	assert.match(main, /function toBattleConf\(s\) \{\r?\n\treturn generatedBattleConf\(s\) \+ require\('\.\/custom-conf'\)\.customConf\(s\);/,
		'custom lines must be appended after the generated ones, or they could not override a slider');
	assert.match(main, /custom_battle_conf: '',/, 'SETTINGS_DEFAULTS does not carry the box');
	assert.match(main, /require\('\.\/custom-conf'\)\.report\(generatedBattleConf\(settings\), settings\.custom_battle_conf\)/,
		'saveSettings does not report what the box did');
});

test('the Settings window saves and loads the box', () => {
	const page = read('src/settings.html');
	assert.match(page, /<textarea id="custom_battle_conf"/);
	assert.match(page, /settings\.custom_battle_conf = \$\('custom_battle_conf'\)\.value;/);
	assert.match(page, /\$\('custom_battle_conf'\)\.value = s\.custom_battle_conf \|\| '';/);
	// Restored settings behind a closed accordion are settings nobody can see.
	assert.match(page, /\$\('advanced-conf-options'\)\.open = !!\$\('custom_battle_conf'\)\.value\.trim\(\);/);
});

// The requirement that is easy to miss: stack/src/world.rs backs up an
// allowlist of paths, so anything the shell derives from settings.json has to
// be one of them or a restore silently loses it. Both features here live in
// settings.json, which is on the list -- this is the test that notices if that
// stops being true.
test('everything the shell writes from settings is in the backup allowlist', () => {
	const world = read('stack/src/world.rs');
	const allow = [...world.matchAll(/\("settings\/([^"]+)",\s*"([^"]+)"\)/g)].map(m => m[2]);
	assert.ok(allow.includes('settings.json'), `settings.json is not backed up: ${allow}`);

	const main = read('electron/main.js');
	const written = [...main.matchAll(/writeFileSync\(path\.join\(state, '([^']+)'\)/g)].map(m => m[1]);
	const derived = written.filter(f => f.startsWith('conf/'));
	assert.ok(derived.length, 'writeSettingsFiles no longer writes a conf file; check this test still means something');
	for (const file of derived) assert.ok(allow.includes(file), `${file} is written from settings but not backed up`);
});
