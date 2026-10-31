'use strict';
//
// Advanced: extra server settings, typed by the player.
//
// Settings -> Rates covers the dozen rAthena settings most people want, and
// rAthena has several hundred. Rather than grow the window a checkbox at a
// time -- and leave everything else out of reach, since the shell regenerates
// conf/import/battle_conf.txt on every start and a hand edit there does not
// survive -- the Advanced accordion takes `key: value` lines and appends them
// to that file.
//
// Everything rAthena's `battle_config_read` accepts is in reach, which is most
// of conf/battle/*.conf: that whole directory is one namespace to it. An
// unknown key is not fatal -- it logs `Unknown setting 'x' in file ...` and
// carries on -- so a typo costs a line in the server log, not a start. The log
// is where to look when a line here seems to do nothing.
//
// What this is not: a general way into char_conf.txt or login_conf.txt. Those
// hold start_point, char_ip and login_ip. Everything here goes to
// battle_conf.txt, which the map server parses into `battle_config` as
// numbers, except the few character-name keys in CHAR_KEYS: the supervisor
// (stack/src/custom_conf.rs) reads those from settings.json and writes them to
// char_conf.txt, because the character server is the one that checks a new
// name. Any other character or login server key is reported and left out,
// rather than written where the map server only logs "Unknown setting" and the
// player is left believing it worked. The one battle key that reaches the
// filesystem is `import:`, and it is refused -- see REFUSED.

// How rAthena reads the file, which is what every rule below follows from:
//
//   if (line[0] == '/' && line[1] == '/') continue;
//   if (sscanf(line, "%1023[^:]:%1023s", w1, w2) != 2) continue;
//
// So a key is everything before the first colon, a value is one
// whitespace-delimited token, and a comment is skipped *only* when the line
// starts with '//' at column 0 -- an indented one is read as a setting whose
// name begins with slashes. Lines are written back trimmed for that reason.

// A page of settings is generous; this is a text box, not a config file.
const MAX_BYTES = 8 * 1024;

// rAthena's own setting names are lowercase ASCII with underscores. Letting
// anything else through only produces "Unknown setting" in the server log.
const KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;

// Printable ASCII, so nothing can carry a newline into the generated file and
// become a second setting the player never typed.
const VALUE = /^[ -~]+$/;

// `import` is how battle_config_read reads another file, which is the one way
// a line here could reach outside the config the app generates.
const REFUSED = new Set(['import']);

// Character-server keys this box may set. They go to char_conf.txt, not to
// battle_conf.txt. stack/src/custom_conf.rs holds the same list and the same
// checks, and the test suite compares the two.
const CHAR_KEYS = new Set(['char_name_option', 'char_name_letters', 'char_name_min_length']);

// rAthena's char_config_read reads the whole rest of the line as the value, so
// a list of letters may contain spaces. Each key's own check, by name.
const CHAR_VALUE = {
	// 0: any name, 1: only char_name_letters, 2: anything but char_name_letters.
	char_name_option: v => /^[012]$/.test(v),
	char_name_letters: v => v.length <= 1023,
	// Counted in bytes, against a 23-byte name.
	char_name_min_length: v => /^\d+$/.test(v) && Number(v) >= 1 && Number(v) <= 23,
};

// Keys the character and login servers read (conf/char_athena.conf and
// conf/login_athena.conf at the pinned rAthena) that this box cannot set. None
// of them is a battle setting, so written to battle_conf.txt they would do
// nothing at all. Named instead.
const OTHER_SERVER_KEYS = new Set([
	// char_athena.conf
	'autosave_time', 'bind_ip', 'char_checkdb', 'char_del_delay', 'char_del_level', 'char_del_option',
	'char_del_restriction', 'char_ip', 'char_maintenance', 'char_move_enabled', 'char_moves_unlimited',
	'char_movetoused', 'char_new', 'char_new_display', 'char_port', 'char_rename_guild', 'char_rename_party',
	'clan_remove_inactive_days', 'clear_parties', 'db_path', 'default_map', 'default_map_x', 'default_map_y',
	'fame_list_alchemist', 'fame_list_blacksmith', 'fame_list_taekwon', 'gm_allow_group', 'guild_exp_rate',
	'log_char', 'login_ip', 'login_port', 'mail_delete_days', 'mail_retrieve', 'mail_return_days',
	'mail_return_empty', 'max_connect_user', 'name_ignoring_case', 'passwd', 'pincode_allow_repeated',
	'pincode_allow_sequential', 'pincode_changetime', 'pincode_enabled', 'pincode_force', 'pincode_maxtry',
	'save_log', 'server_name', 'start_items', 'start_items_doram', 'start_items_pre', 'start_point',
	'start_point_doram', 'start_point_pre', 'start_zeny', 'unknown_char_name', 'userid', 'wisp_server_name',
	// login_athena.conf
	'allowed_regs', 'chars_per_account', 'client_hash_check', 'date_format', 'disable_webtoken_delay',
	'dnsbl_servers', 'group_id_to_connect', 'hash_passwords', 'ipban_cleanup_interval',
	'ipban_dynamic_pass_failure_ban', 'ipban_dynamic_pass_failure_ban_duration',
	'ipban_dynamic_pass_failure_ban_interval', 'ipban_dynamic_pass_failure_ban_limit', 'ipban_enable',
	'log_login', 'login_log_filename', 'login_tokens', 'min_group_id_to_connect', 'new_account',
	'start_limited_time', 'time_allowed', 'use_dnsbl', 'use_web_auth_token', 'usercount_disable',
	'usercount_high', 'usercount_low', 'usercount_medium', 'vip_char_increase', 'vip_group',
]);

/** Which server reads a setting from this box: 'char' or 'battle'. */
function serverOf(key) {
	return CHAR_KEYS.has(key.toLowerCase()) ? 'char' : 'battle';
}

/**
 * What the player typed, as settings and complaints.
 *
 * Total: anything it cannot read becomes a note naming the line, never an
 * exception. A damaged settings.json must not stop the app from starting, and
 * a line silently dropped is the failure mode this whole feature invites.
 *
 * @returns {{settings: {key: string, value: string, at: number}[], notes: string[]}}
 */
function parse(text) {
	const out = { settings: [], notes: [] };
	if (typeof text !== 'string' || !text.trim()) return out;
	if (Buffer.byteLength(text, 'utf8') > MAX_BYTES) {
		out.notes.push(`the advanced settings are longer than ${MAX_BYTES} bytes, so none of them were written`);
		return out;
	}
	const seen = new Map();
	text.split(/\r?\n/).forEach((raw, index) => {
		const line = raw.trim();
		const at = index + 1;
		if (!line || line.startsWith('//')) return;
		const colon = line.indexOf(':');
		if (colon < 1) {
			out.notes.push(`line ${at}: not a setting -- write "name: value", or "// a note"`);
			return;
		}
		const key = line.slice(0, colon).trim();
		const value = line.slice(colon + 1).trim();
		if (!KEY.test(key)) {
			out.notes.push(`line ${at}: "${key}" is not a setting name`);
			return;
		}
		if (REFUSED.has(key.toLowerCase())) {
			out.notes.push(`line ${at}: "${key}" is not allowed here -- it would read another file`);
			return;
		}
		if (!VALUE.test(value)) {
			out.notes.push(`line ${at}: "${key}" has no value the server could read`);
			return;
		}
		const lower = key.toLowerCase();
		if (OTHER_SERVER_KEYS.has(lower)) {
			out.notes.push(`line ${at}: "${key}" is read by the character or login server, which this box cannot set, so it was left out`);
			return;
		}
		if (CHAR_KEYS.has(lower) && !CHAR_VALUE[lower](value)) {
			out.notes.push(`line ${at}: "${value}" is not a value "${key}" accepts, so it was left out`);
			return;
		}
		// rAthena's battle-config sscanf takes one token, so the rest is
		// ignored rather than refused -- which is how a trailing comment works,
		// and how a value with a space in it quietly loses half of itself. The
		// character server reads the whole line, so its keys are exempt.
		if (!CHAR_KEYS.has(lower) && /\s/.test(value) && !value.slice(value.search(/\s/)).trim().startsWith('//')) {
			out.notes.push(`line ${at}: "${key}" is set to "${value.split(/\s+/)[0]}"; the server reads only up to the first space`);
		}
		if (seen.has(lower)) {
			out.notes.push(`line ${at}: "${key}" was already set on line ${seen.get(lower)}, and this one wins`);
		}
		seen.set(lower, at);
		out.settings.push({ key, value, at });
	});
	return out;
}

/**
 * The lines to append to the generated battle configuration.
 *
 * Last in the file on purpose: rAthena applies settings in the order it reads
 * them, so a key the player repeats here beats the one a slider wrote. That is
 * the point -- it is what makes a setting the window has no control for
 * reachable -- and `overrides` is how Apply says it happened out loud.
 */
function customConf(settings) {
	// Character-server keys are the supervisor's to write; see CHAR_KEYS.
	const list = parse(settings.custom_battle_conf).settings.filter(({ key }) => serverOf(key) === 'battle');
	if (!list.length) return '';
	return '// Advanced settings, from Settings -> Rates -> Advanced.\n'
		+ list.map(({ key, value }) => `${key}: ${value}\n`).join('');
}

/** Every setting name in a generated battle config, lowercased. */
function keysIn(generated) {
	return new Set(String(generated).split('\n')
		.map(line => line.trim())
		.filter(line => line && !line.startsWith('//') && line.includes(':'))
		.map(line => line.slice(0, line.indexOf(':')).trim().toLowerCase())
		.filter(Boolean));
}

/**
 * The generated settings the player's own lines replace, by name.
 *
 * Worth saying out loud: a player who sets `base_exp_rate` here and then
 * wonders why the EXP slider does nothing has a window that disagrees with
 * their server and no way to tell.
 */
function overrides(generated, text) {
	const own = keysIn(generated);
	return parse(text).settings
		.filter(({ key }) => own.has(key.toLowerCase()))
		.map(({ key }) => key);
}

/** One line for Apply's status, or '' when there is nothing to say. */
function report(generated, text) {
	const { notes } = parse(text);
	const shadowed = overrides(generated, text);
	const parts = [];
	if (shadowed.length) {
		parts.push(`Advanced settings override what Rates sets for ${shadowed.join(', ')}; those sliders no longer describe your server.`);
	}
	if (notes.length) parts.push(`Advanced settings: ${notes.join('; ')}.`);
	return parts.join(' ');
}

module.exports = { parse, customConf, overrides, report, keysIn, serverOf, MAX_BYTES, REFUSED, CHAR_KEYS, OTHER_SERVER_KEYS };
