// Guards for companion strategies' time conditions and buff renewal (roadmap item 5, step 1),
// and for the owner's skill selection binding a plan's rules.
//
// The risks these pin down: time must be measured from timestamps, so a companion that took no
// turns (resting, frozen, unwatched) still sees it pass; a status without a timer must never
// count as "about to lapse"; and a skill the owner unticked must not come back through a rule.
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');

const src = fs.readFileSync(path.join(__dirname, '..', 'third-party', 'population-engine', 'files', 'src',
	'map', 'population_engine', 'strategy', 'population_strategy.cpp'), 'utf8').replace(/\r\n/g, '\n');

const body = (signature) => {
	const i = src.indexOf(signature);
	assert.ok(i >= 0, `${signature} not found`);
	return src.slice(i, src.indexOf('\n}\n', i));
};

test('InStrategy is measured from when the strategy became active, not counted in turns', () => {
	// Both places that make a strategy active stamp the time.
	assert.match(src, /ps\.active = rule\.switch_to;\n\t\tps\.entered = t\.tick;/);
	assert.match(src, /ps\.active = p\.plan->start;\n\t\t\tps\.fight = p\.instance;\n\t\t\tps\.entered = tick;/);
	assert.match(src, /DIFF_TICK\(t\.tick, ps\.entered\)/);
});

test('InFight is measured from timestamps, and a fight ends 5 s after the last engagement', () => {
	assert.match(src, /t\.st->fight_since = tick;/);
	assert.match(src, /t\.st->last_engaged = tick;/);
	assert.match(src, /DIFF_TICK\(t\.tick, st\.last_engaged\) <= 5000/);
	assert.match(src, /DIFF_TICK\(t\.tick, st\.fight_since\)/);
});

test('a status without a timer never counts as expiring', () => {
	const left = body('static int64 status_left_ms(');
	assert.match(left, /sce->timer != INVALID_TIMER \? get_timer\(sce->timer\) : nullptr/);
	assert.match(left, /: INT64_MAX;/, 'no timer: never lapses');
});

test('Expiring only widens Ally: missing, and only by the time left', () => {
	assert.match(src, /Expiring belongs to Ally: missing/);
	assert.match(src, /sce != nullptr && !\(sel\.expiring_ms > 0 && status_left_ms\(sce, t\.tick\) < sel\.expiring_ms\)/);
});

test('a rule never casts a skill its owner deselected', () => {
	const may = body('static bool may_cast(');
	assert.match(may, /population_shell_skill_selected\(sd, id\)/);
	const req = body('static bool requires_ok(const map_session_data *sd, const Rule &rule)');
	assert.match(req, /may_cast\(sd, id\)/, 'a Cast list');
	assert.match(req, /!may_cast\(sd, rule\.cast_skill\)/, 'a single Cast');
	assert.match(body('static uint16 best_against('), /population_shell_skill_selected\(sd, id\)/);
});

test('a plan only stands the engine\'s Resurrection aside for a revive rule it can cast', () => {
	assert.match(body('bool population_strategy_handles_resurrection('),
		/\(r->cast_skill == ALL_RESURRECTION \|\| r->cast_skill == WM_DEADHILLHERE\) && requires_ok\(sd, \*r\)/);
});

test('the new rule keys are known, so the parser does not drop them as typos', () => {
	for (const key of ['"Sit"', '"Claim"', '"InStrategy"', '"InFight"'])
		assert.ok(src.includes(key + ','), `${key} missing from the rule keys`);
});
