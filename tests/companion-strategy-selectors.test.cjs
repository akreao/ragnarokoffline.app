// Guards for what the party-plan tests asked of companion strategies: selectors that say who
// (a Role list, NotOwner, the skill being cast), encounter_ended telling a boss apart, Requires
// reading the owner's skill selection, Reach asking rAthena's own question, and UseItem.
//
// The risks these pin down: a key that only one of the parser and the runtime knows; Reach
// reading the pause every attack brings as "cannot walk"; an item-cast left armed with no
// client to make it.
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');

const engine = path.join(__dirname, '..', 'third-party', 'population-engine');
const read = (...p) => fs.readFileSync(path.join(engine, ...p), 'utf8').replace(/\r\n/g, '\n');
const src = read('files', 'src', 'map', 'population_engine', 'strategy', 'population_strategy.cpp');

const body = (signature) => {
	const i = src.indexOf(signature);
	assert.ok(i >= 0, `${signature} not found`);
	return src.slice(i, src.indexOf('\n}\n', i));
};

test('an Ally selector takes a list of roles, and can leave the owner out', () => {
	const parse = body('bool StrategyDatabase::parse_selector(');
	assert.match(parse, /for \(const std::string &name : scalars\(node\["Role"\]\)\)/);
	assert.match(parse, /sel\.roles \|= static_cast<uint8>\(1u << role\)/);
	assert.match(parse, /"NotOwner"/);
	const pick = body('static block_list *select_ally(');
	assert.match(pick, /sel\.not_owner && m == t\.owner/);
	assert.match(pick, /sel\.roles & \(1u << static_cast<uint8>\(m->pop\.role\)\)/);
});

test('Enemy: casting can ask which skill, in a selector and in Count', () => {
	assert.match(body('static bool enemy_matches('), /sel\.skills\.empty\(\)[\s\S]*md->ud\.skill_id/);
	assert.match(body('bool StrategyDatabase::parse_selector('), /Skill belongs to Enemy: casting/);
	assert.match(src, /rule->count_sel\.skills\.push_back\(id\)/);
});

test('an Enemy selector and Count can name the monster', () => {
	assert.match(body('static bool enemy_matches('), /!sel\.mobs\.empty\(\) && std::find\(sel\.mobs\.begin\(\), sel\.mobs\.end\(\), md->mob_id\)/);
	assert.match(body('bool StrategyDatabase::parse_selector('), /Mob narrows an Enemy selector/);
	assert.match(src, /rule->count_sel\.mobs\.push_back\(id\)/);
});

test('MoveTo Depth keeps the cells inside the field, and the deepest of a small one', () => {
	const deep = body('static void keep_deep_cells(');
	assert.match(deep, /rule\.move_within \+ 2 \* rule\.move_depth/);
	assert.match(deep, /if \(r\.first >= best\)/);
	assert.match(body('static const char *move_to('), /if \(rule\.move_depth > 0\)\n\t\t\tkeep_deep_cells\(sd, rule, cells\);/);
});

test('encounter_ended knows a boss, noted while the monster is still there', () => {
	assert.match(body('static void track_fight('), /st\.last_bosses\.count\(instance\) != 0/);
	assert.match(body('static void track_fight('), /em->status\.class_ == CLASS_BOSS/);
	assert.match(body('static void poll_event('), /rule\.ev_boss >= 0 && o\.boss != \(rule\.ev_boss == 1\)/);
});

test('Requires reads the skill selection: an unticked skill counts as lacking', () => {
	const req = body('static bool requires_ok(const map_session_data *sd, const Requirements &req)');
	assert.match(req, /pc_checkskill\(sd, id\) == 0 \|\| !population_shell_skill_selected\(sd, id\)/);
	assert.match(req, /pc_checkskill\(sd, id\) > 0 && population_shell_skill_selected\(sd, id\)/);
});

test('Reach asks what rAthena asks: held by a status, not paused by an attack', () => {
	const held = body('static bool mob_held(');
	assert.match(held, /DIFF_TICK\(gettick\(\), md->ud\.canmove_tick\) <= 0/);
	assert.match(held, /SC_SPIDERWEB/);
	// Neither reach check may read unit_can_move alone again.
	for (const fn of ['static bool mob_reaches_cell(', 'static bool mob_reaches('])
		assert.doesNotMatch(body(fn), /unit_can_move/);
	// Reach: false also needs an answer: a rudeattacked skill for the state it will be in.
	assert.match(body('static bool mob_answers_rude('), /ms->cond1 != MSC_RUDEATTACKED/);
	assert.match(src, /mob_reaches\(md, sd\) \|\| !mob_answers_rude\(md, sd\)/);
});

test('UseItem uses what is in the bag, and makes the cast an item only arms', () => {
	assert.match(body('static bool requires_ok(const map_session_data *sd, const Rule &rule)'), /carried_item\(sd, rule\) == 0/);
	const use = body('static bool use_item(');
	assert.match(use, /pc_useitem\(sd, idx\)/);
	assert.match(use, /sd->skillitem != 0/);
	assert.match(use, /unit_skilluse_id\(sd, at->id, id, lv\)/);
	assert.match(use, /sd->skillitem = sd->skillitemlv = 0;/);
	// It counts as the rule's one turn-ending action.
	assert.match(src, /\+ rule->leave \+ rule->kite \+ \(rule->use_item != 0\)/);
});

test('the ladder skips jobs this era lacks', () => {
	const eng = read('files', 'src', 'map', 'population_engine.cpp');
	assert.match(eng, /if \(!job_db\.exists\(target\)\)\n\t\t\tcontinue;/);
});

test('a refused cast says why, and a ground skill asks for its cell before it is cast', () => {
	const cast = body('static const char *cast(');
	// No bare reason is left in the cast path.
	assert.doesNotMatch(cast, /return "(refused|cannot use it now|out of range|not enough SP)";/);
	assert.match(cast, /why\("out of range: %d > %d"/);
	assert.match(cast, /why\("on cooldown, %\.1f s left"/);
	assert.match(cast, /why_cell\(sd, id, lv, ax, ay\)/);
	assert.match(cast, /return why_unit_refused\(/);
	// The cell check is rAthena's own, which it runs only when the cast ends.
	assert.match(body('static const char *why_cell('), /skill_pos_maxcount_check\(sd, x, y, id, lv, BL_PC, false\)/);
	assert.match(body('static const char *why_requirement('), /a catalyst is missing: %d %s/);
});

test('MoveTo Sight walks to a clear line within range, and is there only with both', () => {
	const move = body('static const char *move_to(');
	assert.match(move, /clear_line\(sd, sd->x, sd->y, to\) && distance_bl\(sd, to\) <= rule\.move_range/);
	assert.match(move, /far > rule\.move_range \|\| far < 1 \|\| !clear_line\(/);
	// The test is rAthena's own for a shot: path_search_long over walls.
	assert.match(body('static bool clear_line('), /path_search_long\(nullptr, sd->m, x, y, to->x, to->y, CELL_CHKWALL\)/);
	// Standing in the clear does not pin the companion: following still applies.
	assert.match(src, /rule\.move != Move::Reachable && rule\.move != Move::Sight\)/);
});

test('Aim puts a ground cast on a cell of its own, and Lead on where a walking target will be', () => {
	const cast = body('static const char *cast(');
	assert.match(cast, /const bool aimed = \(at_field \|\| rule\.aim\) && \(inf & INF_GROUND_SKILL\) != 0 && target != sd;/);
	// Every use of the landing cell goes through the aimed one.
	assert.match(cast, /why_cell\(sd, id, lv, ax, ay\)/);
	assert.match(cast, /unit_skilluse_pos\(sd, ax, ay, id, lv\)/);
	assert.doesNotMatch(cast, /unit_skilluse_pos\(sd, target->x/);
	const aim = body('static const char *aim_cell(');
	assert.match(aim, /rule\.aim_lead \? cell_after\(target, skill_castfix\(sd, id, lv\), tx, ty\) : 0/);
	assert.match(aim, /map_getcell\(sd->m, x, y, CELL_CHKPASS\)/);
	// The walk is read from the unit's own path, at its own speed.
	const after = body('static int cell_after(');
	assert.match(after, /ud->walkpath\.path_pos/);
	assert.match(after, /\(dir & 1\) \? speed \* 14 \/ 10 : speed/);
	// Aim is refused at load on anything but a ground Cast.
	assert.match(src, /Aim belongs to a Cast of a ground skill/);
});

test('a fight that has just ended is seen by the rules before the engine rests the companion', () => {
	const eng = read('files', 'src', 'map', 'population_engine.cpp');
	assert.match(eng, /if \(!population_strategy_wants_turn\(sd, now\) && pop_shell_rest\(sd, owner, desired_target, now\)\)\n\t\t\tcontinue;/);
	const wants = body('bool population_strategy_wants_turn(');
	// Nothing loaded, nothing asked for: the hook costs a stock server nothing.
	assert.match(wants, /if \(g_db\.rule_count == 0 \|\| !takes_part\(sd\)\)\n\t\treturn false;/);
	// Only for a monster that is really gone, and only until the next turn has compared.
	assert.match(wants, /gone_died\(sd, e\.second, gone\) \|\| gone/);
	assert.match(wants, /DIFF_TICK\(tick, st\.last_seen\) > 2000/);
	// And a bounded while after an ending for the rule it woke.
	assert.match(src, /st\.answer_until = t\.tick \+ 3000;/);
});

test('Target: { Field } aims a ground cast at the middle of a field someone else laid', () => {
	const parse = body('RulePtr StrategyDatabase::parse_rule(');
	assert.match(parse, /this->warn_unknown_keys\(f, \{ "Field", "Owner", "Within" \}, "Target"\);/);
	// Only for a ground Cast, and the enemy's by default.
	assert.match(parse, /Target: \{ Field \} is the cell of a ground field, for a ground Cast/);
	assert.match(src, /Who tfield_owner = Who::Enemy;/);
	assert.match(body('static block_list *resolve_target('), /if \(rule\.tfield_skill != 0\)\n\t\treturn field_target\(/);
	// The nearest field, then that field's middle unit: never a cell of another field.
	const pick = body('static block_list *field_target(');
	assert.match(pick, /if \(u->group != nearest->group\)\n\t\t\tcontinue;/);
	// A field is a cell: nobody's state is asked about, and Aim has no say.
	const cast = body('static const char *cast(Turn &t, const Rule &rule, block_list *target, uint16 id)');
	assert.match(cast, /const bool at_field = target->type == BL_SKILL;/);
	assert.match(cast, /if \(aimed && !at_field\)/);
	assert.match(cast, /if \(at_field\) \{\n\t\tif \(!status_check_skilluse\(sd, nullptr, id, 0\)\)/);
});

test('Equip is worn while its rule applies, whatever else takes the turn, and comes off after', () => {
	// Every Equip rule is run before the turn's own, and skipped in it.
	assert.match(src, /if \(!c\.rule->equip_items\.empty\(\)\)\n\t\t\t\t\(void\)run_rule\(t, \*c\.rule, \*c\.plan, \*c\.state, do_skills, attack_only\);/);
	assert.match(src, /if \(!c\.rule->equip_items\.empty\(\)\)\n\t\t\t\tcontinue;/);
	// Only a companion that started unequipped, holding the piece.
	assert.match(body('static bool requires_ok(const map_session_data *sd, const Rule &rule)'),
		/!population_shell_gear_can_switch\(sd\) \|\| equip_piece\(sd, rule, true\) < 0/);
	const back = body('static void put_gear_back(');
	assert.match(back, /if \(DIFF_TICK\(s->until, tick\) > 0\)/);
	assert.match(back, /population_shell_gear_put_on\(sd, std::get<0>\(b\), std::get<2>\(b\)\)/);
	// Before the plans are worked out, so it happens with no plan left to apply; and a
	// companion that would rest takes that turn first.
	assert.match(src, /put_gear_back\(sd, gs->second, tick\);\n\n\tblock_list \*enemy = same_map_bl\(sd, sd->pop\.target_id\);/);
	assert.match(body('bool population_strategy_wants_turn('), /for \(const GearSwap &s : st\.swaps\)\n\t\tif \(DIFF_TICK\(s\.until, tick\) <= 0\)\n\t\t\treturn true;/);
});

test('the save records the normal set: a fight\'s piece as carried, what it replaced as worn', () => {
	const normal = body('uint32 population_strategy_normal_equip(');
	assert.match(normal, /if \(s\.on_index == index && it\.nameid == s\.on_id && it\.equip != 0\)\n\t\t\treturn 0;/);
	assert.match(normal, /return std::get<2>\(b\);/);
	// Once the owner has moved the switched piece, what is worn is what is saved.
	assert.match(normal, /if \(on\.nameid != s\.on_id \|\| on\.equip == 0\)\n\t\t\tcontinue;/);
	// Every writer of the row asks: the slot columns (twice), gear_detail, the bag and its digest.
	const count = (text) => (text.match(/population_shell_gear_as_saved\(sd, i\)/g) || []).length;
	assert.equal(count(read('files', 'src', 'map', 'population_engine.cpp')), 3);
	assert.equal(count(read('files', 'src', 'map', 'population_engine', 'runtime', 'population_shell_inventory.cpp')), 2);
	assert.match(read('files', 'src', 'map', 'population_engine', 'runtime', 'population_shell_gear.cpp'),
		/if \(it\.nameid != 0 && !\(it\.equip & EQP_AMMO\)\)\n\t\tit\.equip = population_strategy_normal_equip\(sd, index\);/);
});

test('Equip asks for the card with a plain loop, and reads Item without overwriting the node', () => {
	const piece = body('static int16 equip_piece(');
	assert.match(piece, /carded = it\.card\[c\] == rule\.equip_card;/);
	assert.doesNotMatch(piece, /none_of\(std::begin\(it\.card\)/);
	assert.match(src, /keyed \? scalars\(e\["Item"\]\) : scalars\(e\)/);
	assert.doesNotMatch(src, /names = e\["Item"\]/);
	// Any worn piece may be named, a weapon too; ammunition stays the engine's.
	assert.doesNotMatch(src, /data->type == IT_WEAPON/);
	assert.match(src, /!itemdb_isequip2\(data\.get\(\)\) \|\| \(data->equip & EQP_AMMO\)/);
});
