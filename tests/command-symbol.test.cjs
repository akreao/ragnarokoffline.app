'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { commandSymbolConf, symbol, SYMBOLS, DEFAULT } = require('../electron/command-symbol');

const html = () => fs.readFileSync(path.join(__dirname, '../src/settings.html'), 'utf8');

// An install that never opens this setting must write what rAthena ships, so
// upgrading to the version that added it changes nothing for anybody.
test('an untouched install writes the stock symbol', () => {
	assert.equal(commandSymbolConf({}), 'atcommand_symbol: @\n');
	assert.equal(DEFAULT, '@');
});

test('each offered symbol is written as asked', () => {
	for (const command_symbol of SYMBOLS) {
		assert.equal(commandSymbolConf({ command_symbol }), `atcommand_symbol: ${command_symbol}\n`);
	}
});

// rAthena keeps the symbol it has when it does not like the new one, with no
// message -- so a damaged value has to land on '@', which is what the server
// would then be running on.
test('a damaged or unknown symbol falls back to the stock one', () => {
	for (const command_symbol of ['', '@@', 'storage', 64, null, undefined, [], {}, 'constructor', '__proto__']) {
		assert.equal(commandSymbolConf({ command_symbol }), 'atcommand_symbol: @\n', String(command_symbol));
	}
});

// The value is interpolated into a config file the map server reads, so a
// symbol carrying a newline would be extra battle settings -- rates included.
// The allowlist is what prevents it; this is the test that says so.
test('a symbol cannot smuggle further settings into battle_conf.txt', () => {
	for (const command_symbol of ['@\nbase_exp_rate: 10000', '!\nimport: /etc/passwd', '@ \n']) {
		const conf = commandSymbolConf({ command_symbol });
		assert.equal(conf.trim().split('\n').length, 1, command_symbol);
		assert.equal(conf, 'atcommand_symbol: @\n', command_symbol);
	}
});

// battle.cpp's battle_config_read rejects a control character, '/' (the
// client's own commands), '%' (party chat), '$' (guild chat) and whatever
// charcommand_symbol is -- '#', which the app never changes. Offering one of
// those would be offering a setting that does nothing.
test('no offered symbol is one the server refuses', () => {
	for (const s of SYMBOLS) {
		assert.equal(s.length, 1, s);
		const code = s.charCodeAt(0);
		assert.ok(code > 0x20 && code < 0x7f, `${s} is not printable ASCII`);
		assert.ok(!['/', '%', '$', '#'].includes(s), `${s} is reserved`);
	}
	assert.equal(new Set(SYMBOLS).size, SYMBOLS.length, 'the list repeats a symbol');
});

test('the stock symbol is offered, so a player can put it back', () => {
	assert.ok(SYMBOLS.includes(DEFAULT));
});

// The Settings window cannot require the module, so it carries its own copy of
// the list. Checked here so adding a symbol to one cannot leave the other
// behind -- which would show an option the server ignores, or hide one it takes.
test('the Settings window offers exactly the symbols the module allows', () => {
	const page = html();
	const copy = page.match(/^const COMMAND_SYMBOLS = \[([^\]]*)\];/m);
	assert.ok(copy, 'the window has no COMMAND_SYMBOLS list');
	assert.deepEqual(copy[1].split(',').map(s => s.trim().replace(/^'|'$/g, '')), SYMBOLS);

	const picker = page.match(/<select id="command_symbol">([\s\S]*?)<\/select>/);
	assert.ok(picker, 'the window has no command_symbol picker');
	const offered = [...picker[1].matchAll(/<option value="([^"]*)"/g)].map(m => m[1]);
	assert.deepEqual(offered, SYMBOLS, 'the picker and the module disagree');
});

// The one setting in this panel that is a string rather than a number or a
// checkbox, so it is the one most likely to be read but never written.
test('the Settings window both saves and loads the setting', () => {
	const page = html();
	assert.match(page, /settings\.command_symbol = \$\('command_symbol'\)\.value;/);
	assert.match(page, /\$\('command_symbol'\)\.value =/);
});

test('main.js writes it into battle_conf.txt and defaults it to the stock symbol', () => {
	const main = fs.readFileSync(path.join(__dirname, '../electron/main.js'), 'utf8');
	assert.match(main, /require\('\.\/command-symbol'\)\.commandSymbolConf\(s\)/,
		'toBattleConf does not write the symbol');
	assert.match(main, /command_symbol: '@',/, 'SETTINGS_DEFAULTS does not carry the symbol');
});

test('symbol() is the one gate, and it is total', () => {
	assert.equal(symbol('!'), '!');
	assert.equal(symbol('/'), DEFAULT);
});

// The AI agent types its travel commands as chat, so the prefix has to reach
// it. A command typed with the wrong one is not refused -- rAthena does not
// see a command at all and says the words in local chat -- so an agent left on
// '@' against a server running on '!' announces its plans and never moves.
// Enough of an Electron webContents for the constructor: it subscribes to two
// events and to the session's failed requests.
const driver = opts => {
	const { AgentDriver } = require('../electron/agent-driver');
	const wc = { id: 1, on() {}, session: { webRequest: { onCompleted() {} } } };
	return new AgentDriver(wc, { shotsDir: '/tmp', credentials: async () => ({}), ...opts });
};

test('the agent driver reports the prefix it was given', () => {
	for (const s of SYMBOLS) {
		assert.equal(driver({ commandPrefix: () => s }).prefix(), s);
	}
});

test('the agent driver falls back to the stock prefix', () => {
	// No thunk: scripts/rotest and any other caller that predates this.
	assert.equal(driver({}).prefix(), DEFAULT);
	// A damaged settings.json must not take `state` down with it.
	assert.equal(driver({ commandPrefix: () => { throw new Error('unreadable'); } }).prefix(), DEFAULT);
	assert.equal(driver({ commandPrefix: () => '' }).prefix(), DEFAULT);
});

// The agent reads AGENT.md and the `say` tool description; both used to spell
// the travel commands with a hard '@'.
test('nothing tells the agent to type a fixed prefix', () => {
	const { COMMANDS } = require('../electron/agent-driver');
	assert.match(COMMANDS.say.description, /commandPrefix/,
		'the say tool does not point the agent at the reported prefix');
	const md = fs.readFileSync(path.join(__dirname, '../electron/AGENT.md'), 'utf8');
	assert.match(md, /commandPrefix/, 'AGENT.md does not mention the reported prefix');
	assert.doesNotMatch(md, /`@warp <map>/, 'AGENT.md still spells @warp as the command');
});

test('main.js hands the agent the prefix, read per call', () => {
	const main = fs.readFileSync(path.join(__dirname, '../electron/main.js'), 'utf8');
	assert.match(main, /commandPrefix: \(\) => require\('\.\/command-symbol'\)\.symbol\(getSettings\(\)\.command_symbol\)/);
	const play = fs.readFileSync(path.join(__dirname, '../electron/agent-play.js'), 'utf8');
	assert.match(play, /commandPrefix: deps\.commandPrefix/);
});

// Telling a player to type "@warp" on a server running on "!" sends them to a
// command that does nothing and says nothing.
test('the map editor names the prefix the server is on', () => {
	const main = fs.readFileSync(path.join(__dirname, '../electron/main.js'), 'utf8');
	assert.match(main, /As a GM: \$\{prefix\}warp/);
	assert.doesNotMatch(main, /As a GM: @warp/);
});
