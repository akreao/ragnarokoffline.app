// Guards for the skill lists of the jobs that had none.
//
// A job with no entry in population_skill_db.yml took its base job's, and the base-job lookup
// took nearly every job for a Swordsman: an expanded job (Gunslinger, Ninja, Taekwon, Star
// Gladiator, Soul Linker, Super Novice and the classes built on them) or a high first job found
// none of its own skills there and only auto-attacked. The risks these pin down: a job left
// without a list again, a list that names a skill twice, and the lookup going back to ranges.
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8').replace(/\r\n/g, '\n');
const db = read('third-party/population-engine/files/db/population_skill_db.yml');
const engine = read('third-party/population-engine/files/src/map/population_engine.cpp');

const entries = new Map();
for (const block of db.slice(db.indexOf('\nBody:')).split(/^(?=  - JobId: )/m).slice(1))
	entries.set(Number(/^  - JobId: (\d+)/.exec(block)[1]), block);
const skillsOf = (job) => [...entries.get(job).matchAll(/SkillId: (\w+)/g)].map(m => m[1]);

test('every job that had no list has one', () => {
	const jobs = {
		23: 'Super Novice', 24: 'Gunslinger', 25: 'Ninja', 4046: 'Taekwon', 4047: 'Star Gladiator',
		4048: 'Star Gladiator (flying)', 4049: 'Soul Linker', 4190: 'Super Novice (expanded)', 4211: 'Kagerou',
		4212: 'Oboro', 4215: 'Rebellion', 4218: 'Summoner', 4239: 'Star Emperor', 4240: 'Soul Reaper',
		4002: 'High Swordsman', 4003: 'High Mage', 4004: 'High Archer', 4005: 'High Acolyte', 4006: 'High Merchant',
		4007: 'High Thief',
	};
	for (const [id, name] of Object.entries(jobs)) {
		assert.ok(entries.has(Number(id)), `${name} (${id}) has an entry`);
		assert.ok(skillsOf(Number(id)).length >= 2, `${name} (${id}) lists skills`);
	}
});

test('no job is listed twice', () => {
	const ids = [...db.matchAll(/^  - JobId: (\d+)/gm)].map(m => m[1]);
	assert.equal(new Set(ids).size, ids.length);
});

test('a Gunslinger, a Rebellion and a Night Watch all have Desperado, for a pack', () => {
	for (const job of [24, 4215, 4306])
		assert.match(entries.get(job), /SkillId: GS_DESPERADO, Level: 10, Rate: 7000, Condition: enemy_count_nearby, CondValue: 2/, String(job));
});

test('a high first job has its first job\'s skills', () => {
	for (const [high, base] of [[4002, 1], [4003, 2], [4004, 3], [4005, 4], [4006, 5], [4007, 6]])
		assert.deepEqual(skillsOf(high), skillsOf(base), `${high} follows ${base}`);
});

test('the kicks wait for their combo, and Esma for its opening', () => {
	for (const job of [4046, 4047, 4239])
		for (const kick of ['TK_STORMKICK', 'TK_DOWNKICK', 'TK_TURNKICK', 'TK_COUNTER'])
			assert.match(entries.get(job), new RegExp(`SkillId: ${kick}, Level: 7, Rate: 10000, Condition: self_status, CondValue: SC_COMBO`), `${job} ${kick}`);
	for (const job of [4049, 4240])
		assert.match(entries.get(job), /SkillId: SL_SMA, Level: 10, Rate: 10000, Condition: self_status, CondValue: SC_SMA/, String(job));
});

test('the base job is rAthena\'s own answer before the ranges', () => {
	const at = engine.indexOf('static uint16_t get_base_job(uint16_t job_id) {');
	const fn = engine.slice(at, engine.indexOf('\n}\n', at));
	assert.match(fn, /pc_mapid2jobid\(mapid & MAPID_FIRSTMASK, SEX_MALE\)/);
	assert.ok(fn.indexOf('pc_jobid2mapid(job_id)') < fn.indexOf('job_id >= JOB_KNIGHT'), 'asked before the first range');
});
