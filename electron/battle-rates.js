'use strict';
//
// Drop rate keys for the generated battle configuration.
//
// rAthena keeps three independent families of drop rate -- ordinary monsters,
// bosses, and MVPs -- and reads a separate key per item category in each.
// Only part of two families were ever written: bosses got common, equipment
// and card but not healing or usable, and MVPs got nothing at all. A player
// who raised the sliders saw them work on ordinary monsters and not on the
// monsters they most wanted them for, which is what `@rates` reported.
//
// Generated from one table so a family cannot go half-covered again, and kept
// in its own module because main.js exports nothing and so nothing here could
// be tested -- which is the reason this went out wrong.

// The five categories rAthena scales, and which slider each follows. Healing
// and usable ride the item slider alongside common: the UI offers three
// numbers, not five, and splitting them here would invent a setting.
const CATEGORY_SLIDER = {
	common: 'item_rate_common',
	heal: 'item_rate_common',
	use: 'item_rate_common',
	equip: 'item_rate_equip',
	card: 'item_rate_card',
};

// '' is ordinary monsters. rAthena spells the other two as key suffixes.
const FAMILIES = ['', '_boss', '_mvp'];

/**
 * The MVP card rate in force: the player's own number, or the card slider's.
 *
 * `null` -- the default -- means "whatever Card drops says". A default of 100
 * would have been a quiet nerf: the card slider has always driven
 * item_rate_card_mvp, so every install with raised card drops would have had
 * its MVP card rate dropped back to 1x by the upgrade, with nothing in the
 * window to show it. Anything unreadable falls back the same way.
 */
function cardMvpRate(settings) {
	const own = Number(settings.item_rate_card_mvp);
	return Number.isFinite(own) && own > 0 ? own : settings.item_rate_card;
}

// Where one family of one category is set apart from its category's slider,
// keyed as `${category}${family}`. Only MVP cards are, because that is the
// one people actually want to split: a server can be generous with ordinary
// cards and still keep an MVP card rare, and until now the two were one
// number. Everything absent here follows CATEGORY_SLIDER.
const FAMILY_RATE = {
	card_mvp: cardMvpRate,
};

/**
 * Every drop rate key, for every monster family, as battle-conf lines.
 *
 * Deliberately not included: `item_rate_mvp` is the MVP *reward* rather than a
 * drop and `item_rate_treasure` is chest contents, both of which the caller
 * sets from the item slider already; `item_rate_adddrop` scales drops granted
 * by equipment scripts, which is not what any of these sliders describes.
 */
function dropRateConf(settings) {
	return FAMILIES.flatMap(family =>
		Object.entries(CATEGORY_SLIDER).map(([category, slider]) => {
			const own = FAMILY_RATE[`${category}${family}`];
			return `item_rate_${category}${family}: ${own ? own(settings) : settings[slider]}`;
		}))
		.join('\n') + '\n';
}

// How many monsters a map spawns, as a percentage of rAthena's spawn tables.
//
// rAthena accepts anything up to INT_MAX here, which is not a limit: this
// multiplies every spawn line on every map the player walks onto, and each
// extra monster is a live entity the map server ticks inside the VM. So the
// Settings slider stops at 10x and this stops there too, which also keeps a
// hand-edited settings.json from asking for a map the server cannot walk.
//
// Anything that is not a positive number falls back to the stock 100. Nothing
// below 1% is useful: npc_parse_mob floors each spawn line at one monster
// (`mob.num < 1` -> 1), so a smaller number thins the tables without ever
// emptying a map.
const MOB_COUNT_RATE_STOCK = 100;
const MOB_COUNT_RATE_MAX = 1000;

function mobCountRateConf(settings) {
	const want = Math.round(Number(settings.mob_count_rate));
	const rate = Number.isFinite(want) && want > 0
		? Math.min(MOB_COUNT_RATE_MAX, want)
		: MOB_COUNT_RATE_STOCK;
	return `mob_count_rate: ${rate}\n`;
}

module.exports = {
	dropRateConf,
	mobCountRateConf,
	cardMvpRate,
	FAMILIES,
	CATEGORY_SLIDER,
	FAMILY_RATE,
	MOB_COUNT_RATE_MAX,
};
