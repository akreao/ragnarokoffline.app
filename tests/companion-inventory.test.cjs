// Guards the companion inventory: a recruited companion owns what is in its bag.
//
// Every shell has rAthena's inventory, but the engine used it as a virtual supply: ammo and
// potions were topped up for free, catalysts were waived in skill_get_requirement, and only worn
// gear was saved. A companion now lives on what it carries: nothing refills it, rAthena takes its
// item and ammo costs (patch 0033), a trade leaves consumables with it, and the whole bag is
// saved in cp_companion_persistence.inventory_detail and put back on recall. Ambient shells keep
// the virtual supply. Settings -> Population -> Companion inventory switches it on; off is the
// default and the behaviour before.
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');

const ROOT = path.join(__dirname, '..');
// Windows checks out CRLF; the patterns below are written against LF.
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8').replace(/\r\n/g, '\n');
const MAP = 'third-party/population-engine/files/src/map/';
const patch = read('third-party/population-engine/patches/0033-companion-inventory.patch');
const inventory = read(MAP + 'population_engine/runtime/population_shell_inventory.cpp');
const engine = read(MAP + 'population_engine.cpp');
const ammo = read(MAP + 'population_engine/runtime/population_shell_ammo.cpp');
const combat = read(MAP + 'population_engine/runtime/population_engine_combat.cpp');
const strategy = read(MAP + 'population_engine/strategy/population_strategy.cpp');
const factory = read(MAP + 'population_engine/population_engine_factory.cpp');
const schema = read('third-party/population-engine/files/sql-files/population_engine/cp_companion_persistence.sql');
const cmds = read('stack/src/cmds.rs');
const settings = read('src/settings.html');
const main = read('electron/main.js');
const { lines, companionInventory } = require('../electron/population-conf');

const body = (src, signature) => {
	const start = src.indexOf(signature);
	assert.ok(start >= 0, `${signature} exists`);
	const open = src.indexOf('\n{', start);
	const close = src.indexOf('\n}', open);
	return src.slice(open, close);
};

test('the module is part of the engine build', () => {
	assert.match(factory, /^#include "runtime\/population_shell_inventory\.cpp"/m);
});

test('the server option is registered, off by default, 0 to 1', () => {
	assert.match(patch, /^\+\{ "population_engine_companion_inventory",&battle_config\.population_engine_companion_inventory,0,0,1,\},$/m);
	assert.match(patch, /^\+int32 population_engine_companion_inventory;$/m);
});

test('everything hangs on the option: off, a companion keeps the free supply and its saved bag', () => {
	assert.match(body(inventory, 'bool population_shell_has_own_inventory('),
		/return battle_config\.population_engine_companion_inventory && population_engine_is_recruited_companion\(sd\);/);
	assert.match(body(inventory, 'void population_shell_inventory_restore('),
		/if \(!battle_config\.population_engine_companion_inventory \|\|/);
});

test('Settings offers the choice, off by default, and writes it', () => {
	assert.match(main, /population_companion_inventory: false,/);
	assert.match(settings, /id="population_companion_inventory"/);
	assert.match(settings, /settings\.population_companion_inventory = \$\('population_companion_inventory'\)\.checked;/);
	assert.match(settings, /\$\('population_companion_inventory'\)\.checked = s\.population_companion_inventory === true;/);
	assert.match(settings, /id="companion-inventory-note"/);
	assert.equal(companionInventory({}), 0);
	assert.equal(companionInventory({ population_companion_inventory: true }), 1);
	const base = { population_enable: true, population_max: 1500, population_density: 100 };
	assert.match(lines(base), /^population_engine_companion_inventory: 0$/m);
	assert.match(lines({ ...base, population_companion_inventory: true }), /^population_engine_companion_inventory: 1$/m);
});

test('a companion falls through to the full requirement; ambient shells keep the waiver', () => {
	assert.match(patch, /^\+\tif \(population_engine_is_population_pc\(sd->id\) && !population_shell_has_own_inventory\(sd\)\) \{$/m);
	assert.match(patch, /^\+\tpopulation_shell_inventory_relax_requirement\(sd, req\);\n\+\n \treturn req;\n \}$/m);
});

test('the relaxation keeps items and ammunition, and the weapon under Weapon rules', () => {
	const relax = body(inventory, 'void population_shell_inventory_relax_requirement(');
	assert.ok(!/req\.(ammo|ammo_qty|itemid|amount)\b/.test(relax), 'items and ammo are paid');
	assert.match(relax, /if \(!battle_config\.population_engine_skill_weapon_check\)\n\t\treq\.weapon = 0;/);
});

test('nothing refills a companion', () => {
	assert.match(body(engine, 'static void pop_shell_stock_potions('), /if \(population_shell_has_own_inventory\(sd\)\)\n\t\treturn;/);
	assert.match(body(ammo, 'static void pe_shell_stock_ammo('), /\tif \(!sd \|\| population_shell_has_own_inventory\(sd\)\)\n\t\treturn;/);
});

test('a companion fires any ammunition it carries, not only the engine\'s lists', () => {
	assert.match(body(ammo, 'static bool pe_shell_ammochange('),
		/if \(bestIndex < 0\)[^\n]*\n\t\treturn population_shell_inventory_equip_carried_ammo\(sd, 1 << choices\[0\]\.subtype, rqAmount\);/);
	assert.match(body(ammo, 'bool population_shell_equip_ammo_for_skill('),
		/\treturn population_shell_inventory_equip_carried_ammo\(sd, ammo_mask, amount\);$/);
	// Ambient shells keep the lists alone.
	assert.match(body(inventory, 'bool population_shell_inventory_equip_carried_ammo('),
		/if \(!population_shell_has_own_inventory\(sd\) \|\| ammo_mask == 0\)\n\t\treturn false;/);
});

test('a skill whose items are not carried is passed over, Resurrection too', () => {
	assert.match(body(combat, 'static bool pop_skill_state_ok('), /if \(!population_shell_inventory_can_pay_skill\(sd, skill_id, skill_lv\)\)\n\t\treturn false;/);
	assert.match(body(combat, 'static bool population_shell_try_party_resurrection('), /population_shell_inventory_can_pay_skill\(sd, skill_id, skill_lv\)/);
	// rAthena takes the items now; the strategy paying as well would charge twice.
	assert.match(strategy, /^constexpr bool kPayCatalysts = false;$/m);
});

test('a trade leaves consumables and ammunition in the companion\'s bag', () => {
	assert.match(body(engine, 'void population_engine_companion_equip_traded('), /\} else if \(!population_shell_has_own_inventory\(shell\)\) \{/);
	// Ammunition too: equipping each traded stack handed the previous one back.
	assert.match(body(engine, 'void population_engine_companion_equip_traded('), /if \(id->equip && !\(\(id->equip & EQP_AMMO\) && population_shell_has_own_inventory\(shell\)\)\) \{/);
});

test('the bag is saved with the companion and put back on recall', () => {
	assert.match(body(engine, 'void population_engine_persist_companion_gear('), /population_shell_inventory_save\(sd, true\);/);
	assert.match(engine, /population_shell_inventory_restore\(shell\);\n\tstatus_calc_pc\(shell, SCO_NONE\);/);
	assert.match(schema, /^ {2}`inventory_detail` TEXT {10}NULL DEFAULT NULL,/m);
	assert.match(cmds, /\("inventory_detail", "TEXT NULL DEFAULT NULL"\),/);
});
