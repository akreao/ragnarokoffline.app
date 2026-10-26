'use strict';
//
// The character a command starts with: `@storage`, or `!storage`.
//
// Discord request: players coming from other private servers expect `!`, and
// `@` is awkward on some keyboard layouts. rAthena has always supported it --
// `battle_config_read` (src/map/battle.cpp) reads `atcommand_symbol` out of any
// battle config file -- but the app regenerates battle_conf.txt from
// settings.json on every start, so there was no edit a player could make that
// survived a restart. Hence a setting.
//
// `charcommand_symbol` is deliberately left alone at '#'. It is the
// per-character form (`#name command`), almost nobody types it, and rAthena
// refuses an atcommand symbol equal to it -- so leaving it fixed is also what
// keeps the list below safe.
//
// A fixed list rather than a text box, because rAthena *silently ignores* a
// symbol it does not like and keeps the one it has: a control character, '/',
// '%' (party chat), '$' (guild chat), or charcommand_symbol. A refusal with no
// message looks exactly like the setting doing nothing, so the only symbols
// offered are ones the server will take.
//
// '/' could not work even if rAthena allowed it: it is the one prefix
// roBrowser handles itself (ChatBox.js routes it to ProcessCommand and sends
// anything else to the server as talk).
//
// One thing breaks on any symbol but '@', and it is upstream's: an NPC script
// calling `atcommand "@foo"` goes through the same is_atcommand symbol check,
// so the literal stops being recognised. In the pinned fork exactly one script
// the server loads does that -- npc/re/merchants/clothing_buff_removal.txt,
// Derek Shot in Prontera, `atcommand "@changedress"` -- and the other three
// hits are under npc/custom/ and npc/test/, which are not loaded. Group 0 has
// @changedress itself, so a player can do what he was going to do for them.
const SYMBOLS = ['@', '!', '.', '-'];

const DEFAULT = '@';

// Anything else -- a hand-edited settings.json, a symbol from a later version
// -- writes '@' rather than refusing to start. The allowlist is also what
// makes this safe to interpolate into a config file: a value carrying a
// newline would otherwise be extra battle settings.
function symbol(value) {
	return SYMBOLS.includes(value) ? value : DEFAULT;
}

// Read once when the map server boots, so Apply's restart is what applies it.
function commandSymbolConf(settings) {
	return `atcommand_symbol: ${symbol(settings.command_symbol)}\n`;
}

module.exports = { commandSymbolConf, symbol, SYMBOLS, DEFAULT };
