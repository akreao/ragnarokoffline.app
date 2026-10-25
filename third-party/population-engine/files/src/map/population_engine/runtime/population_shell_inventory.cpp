// Copyright (c) rAthena Dev Teams - Licensed under GNU GPL
// RAGNAROKMAC (companion inventory): see population_shell_inventory.hpp.

#include "population_shell_inventory.hpp"
#include "population_shell_gear.hpp"

#include <algorithm>
#include <cinttypes>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <string>
#include <unordered_map>
#include <vector>

#include <common/showmsg.hpp>
#include <common/sql.hpp>
#include <common/timer.hpp>

#include "../../battle.hpp"
#include "../../itemdb.hpp"
#include "../../log.hpp"
#include "../../map.hpp"
#include "../../pc.hpp"
#include "../../skill.hpp"
#include "../../population_engine.hpp"

namespace {

/// The bag changes with every arrow fired and potion drunk; written at most this often unless
/// a caller asks for it now.
constexpr t_tick kSaveInterval = 10000;

/// Healing and SP items a companion drinks when its own level's potion is not in the bag,
/// strongest first: Condensed White/Yellow/Red, White, Yellow, Orange, Red, then the herbs.
constexpr t_itemid kHpItems[] = { 547, 546, 545, 504, 503, 502, 501, 509, 508, 507 };
/// Blue Potion, Grape Juice, Blue Herb.
constexpr t_itemid kSpItems[] = { 505, 533, 510 };

struct SavedBag {
	uint64 digest = 0;
	t_tick written = 0;
};

/// char_id -> what was last written for that companion.
std::unordered_map<uint32, SavedBag> g_saved;

/// What the bag holds beyond the worn gear gear_detail keeps: every unworn stack, and the worn
/// ammunition, whose amount gear_detail does not record.
bool carried(const item &it)
{
	return it.nameid != 0 && it.amount > 0 && (it.equip == 0 || (it.equip & EQP_AMMO));
}

uint64 bag_digest(const map_session_data *sd)
{
	uint64 h = 1469598103934665603ULL;
	auto mix = [&h](uint64 v) { h = (h ^ v) * 1099511628211ULL; };
	for (int16 i = 0; i < MAX_INVENTORY; ++i) {
		const item it = population_shell_gear_as_saved(sd, i); // (Equip) the normal set
		if (!carried(it))
			continue;
		mix(static_cast<uint64>(i));
		mix(it.nameid);
		mix(static_cast<uint64>(it.amount));
		mix(it.equip);
	}
	return h;
}

/// "v1", then one entry per carried stack, separated by ';': nameid, amount, equip (only
/// EQP_AMMO, else 0), identify, refine, attribute, card0-3, enchantgrade, bound, expire_time,
/// unique_id, then id,value,param for each random option.
std::string bag_detail(const map_session_data *sd)
{
	std::string out = "v1";
	char entry[512];
	for (int16 i = 0; i < MAX_INVENTORY; ++i) {
		const item it = population_shell_gear_as_saved(sd, i); // (Equip) the normal set
		if (!carried(it))
			continue;
		int n = snprintf(entry, sizeof(entry), ";%u,%d,%u,%d,%d,%d,%u,%u,%u,%u,%u,%d,%u,%" PRIu64,
			(unsigned)it.nameid, (int)it.amount, (unsigned)(it.equip & EQP_AMMO),
			(int)it.identify, (int)it.refine, (int)it.attribute,
			(unsigned)it.card[0], (unsigned)it.card[1], (unsigned)it.card[2], (unsigned)it.card[3],
			(unsigned)it.enchantgrade, (int)it.bound, (unsigned)it.expire_time, (uint64_t)it.unique_id);
		for (int o = 0; o < MAX_ITEM_RDM_OPT && n > 0 && static_cast<size_t>(n) < sizeof(entry); ++o)
			n += snprintf(entry + n, sizeof(entry) - n, ",%d,%d,%d",
				(int)it.option[o].id, (int)it.option[o].value, (int)it.option[o].param);
		if (n > 0 && static_cast<size_t>(n) < sizeof(entry))
			out += entry;
	}
	return out;
}

/// One bag_detail entry back into an item, or false when it is not one this build wrote.
bool parse_entry(const char *text, item &it)
{
	constexpr size_t kFields = 14 + 3 * MAX_ITEM_RDM_OPT;
	long long v[kFields];
	size_t count = 0;
	const char *p = text;
	while (count < kFields) {
		char *end = nullptr;
		const long long n = strtoll(p, &end, 10);
		if (end == p)
			return false;
		v[count++] = n;
		p = end;
		if (*p != ',')
			break;
		++p;
	}
	if (count != kFields || (*p != '\0' && *p != ';'))
		return false;
	it = {};
	it.nameid = static_cast<t_itemid>(v[0]);
	it.amount = static_cast<int16>(v[1]);
	it.equip = static_cast<uint32>(v[2]) & EQP_AMMO;
	it.identify = static_cast<char>(v[3]);
	it.refine = static_cast<char>(v[4]);
	it.attribute = static_cast<char>(v[5]);
	for (int c = 0; c < MAX_SLOTS; ++c)
		it.card[c] = static_cast<t_itemid>(v[6 + c]);
	it.enchantgrade = static_cast<uint8>(v[10]);
	it.bound = static_cast<char>(v[11]);
	it.expire_time = static_cast<uint32>(v[12]);
	it.unique_id = static_cast<uint64>(v[13]);
	for (int o = 0; o < MAX_ITEM_RDM_OPT; ++o) {
		it.option[o].id = static_cast<int16>(v[14 + 3 * o]);
		it.option[o].value = static_cast<int16>(v[15 + 3 * o]);
		it.option[o].param = static_cast<char>(v[16 + 3 * o]);
	}
	return it.nameid != 0 && it.amount > 0 && item_db.exists(it.nameid);
}

} // namespace

bool population_shell_has_own_inventory(const map_session_data *sd)
{
	return battle_config.population_engine_companion_inventory && population_engine_is_recruited_companion(sd);
}

void population_shell_inventory_relax_requirement(const map_session_data *sd, s_skill_condition &req)
{
	if (!population_shell_has_own_inventory(sd))
		return;
	req.mhp = 0;
	req.status.clear();
	req.eqItem.clear();
	if (!battle_config.population_engine_skill_weapon_check)
		req.weapon = 0;
}

bool population_shell_inventory_can_pay_skill(map_session_data *sd, uint16 skill_id, uint16 skill_lv)
{
	if (!population_shell_has_own_inventory(sd))
		return true;
	// rAthena's own list, with its exceptions (Mistress card, gemstone-saving partners, traps).
	const s_skill_condition req = skill_get_requirement(sd, skill_id, skill_lv);
	for (int i = 0; i < MAX_SKILL_ITEM_REQUIRE; ++i) {
		if (req.itemid[i] == 0)
			continue;
		// The stack skill_check_condition_castend looks at: the first one.
		const int16 idx = pc_search_inventory(sd, req.itemid[i]);
		if (idx < 0 || sd->inventory.u.items_inventory[idx].amount < req.amount[i])
			return false;
	}
	return true;
}

bool population_shell_inventory_equip_carried_ammo(map_session_data *sd, int ammo_mask, int amount)
{
	if (!population_shell_has_own_inventory(sd) || ammo_mask == 0)
		return false;
	amount = std::max(amount, 1);
	auto fits = [sd, ammo_mask, amount](int16 i) {
		const item_data *id = sd->inventory_data[i];
		const item &it = sd->inventory.u.items_inventory[i];
		return id != nullptr && id->type == IT_AMMO && (ammo_mask & (1 << id->subtype))
			&& it.amount >= amount && sd->status.base_level >= id->elv;
	};
	const int16 worn = sd->equip_index[EQI_AMMO];
	if (worn >= 0 && fits(worn))
		return true;
	// No swapping yet (Desperado, Arrow Vulcan), as in population_shell_ammo.
	if (DIFF_TICK(sd->canequip_tick, gettick()) > 0)
		return false;
	int16 best = -1;
	for (int16 i = 0; i < MAX_INVENTORY; ++i) {
		if (!fits(i) || pc_isequip(sd, i) != ITEM_EQUIP_ACK_OK)
			continue;
		if (best < 0 || sd->inventory_data[i]->atk > sd->inventory_data[best]->atk)
			best = i;
	}
	return best >= 0 && pc_equipitem(sd, best, EQP_AMMO);
}

int16 population_shell_inventory_find_potion(map_session_data *sd, t_itemid preferred, bool hp)
{
	const int16 idx = pc_search_inventory(sd, preferred);
	if (idx >= 0 || !population_shell_has_own_inventory(sd))
		return idx;
	auto first_carried = [sd](const auto &list) -> int16 {
		for (const t_itemid nameid : list) {
			const int16 other = pc_search_inventory(sd, nameid);
			if (other >= 0)
				return other;
		}
		return -1;
	};
	return hp ? first_carried(kHpItems) : first_carried(kSpItems);
}

void population_shell_inventory_save(map_session_data *sd, bool now)
{
	if (!population_shell_has_own_inventory(sd) || mmysql_handle == nullptr
		|| sd->status.char_id < POPULATION_ENGINE_CHAR_ID_BASE)
		return;
	const t_tick tick = gettick();
	const uint64 digest = bag_digest(sd);
	auto found = g_saved.find(sd->status.char_id);
	if (found != g_saved.end()) {
		if (found->second.digest == digest)
			return;
		if (!now && DIFF_TICK(tick, found->second.written) < kSaveInterval)
			return;
	}
	const uint32 index_ = sd->status.char_id - POPULATION_ENGINE_CHAR_ID_BASE;
	const std::string detail = bag_detail(sd);
	std::vector<char> q(256 + detail.size());
	const int written = snprintf(q.data(), q.size(),
		"UPDATE `cp_companion_persistence` SET inventory_detail='%s'"
		" WHERE owner_account_id=%u AND owner_char_id=%u AND shell_index=%u",
		detail.c_str(), sd->pop.companion_owner_account, sd->pop.companion_owner_char, index_);
	if (written <= 0 || static_cast<size_t>(written) >= q.size())
		return;
	// Through "%s": the statement is data here, never a format.
	if (Sql_Query(mmysql_handle, "%s", q.data()) != SQL_SUCCESS) {
		Sql_ShowDebug(mmysql_handle);
		ShowError("population_engine: saving the bag of companion %u FAILED\n", index_);
		return;
	}
	g_saved[sd->status.char_id] = { digest, tick };
}

void population_shell_inventory_restore(map_session_data *sd)
{
	// Off, the companion has the free supply and its saved bag waits in the row, untouched,
	// for the setting to come back on.
	if (!battle_config.population_engine_companion_inventory || sd == nullptr || mmysql_handle == nullptr
		|| sd->status.char_id < POPULATION_ENGINE_CHAR_ID_BASE)
		return;
	const uint32 index_ = sd->status.char_id - POPULATION_ENGINE_CHAR_ID_BASE;
	if (Sql_Query(mmysql_handle,
			"SELECT inventory_detail FROM `cp_companion_persistence` WHERE shell_index=%u", index_) != SQL_SUCCESS) {
		Sql_ShowDebug(mmysql_handle);
		return;
	}
	std::string detail;
	if (Sql_NextRow(mmysql_handle) == SQL_SUCCESS) {
		char *data = nullptr;
		Sql_GetData(mmysql_handle, 0, &data, nullptr);
		if (data != nullptr)
			detail = data;
	}
	Sql_FreeResult(mmysql_handle);
	g_saved.erase(sd->status.char_id);
	// NULL arrives as an empty string: a row saved before inventories keeps the spawn's bag.
	if (detail.compare(0, 2, "v1") != 0)
		return;

	// What the spawn stocked (ammo, traps, the bag of the shell it was) is not this companion's.
	for (int16 i = 0; i < MAX_INVENTORY; ++i) {
		const item &it = sd->inventory.u.items_inventory[i];
		if (!carried(it))
			continue;
		if (it.equip != 0 && !pc_unequipitem(sd, i, 2))
			continue;
		pc_delitem(sd, i, it.amount, 0, 1, LOG_TYPE_NONE);
	}
	// The saved bag fitted the companion's own limit; the spawn may have left max_weight at its
	// level-99 or raised value, and the caller's status_calc_pc puts it right afterwards.
	sd->max_weight = 2000000;
	int restored = 0;
	for (const char *p = strchr(detail.c_str(), ';'); p != nullptr; p = strchr(p + 1, ';')) {
		item saved;
		if (!parse_entry(p + 1, saved))
			continue;
		const uint32 equip = saved.equip;
		saved.equip = 0;
		if (pc_additem(sd, &saved, saved.amount, LOG_TYPE_NONE) != ADDITEM_SUCCESS) {
			ShowWarning("population_engine: could not restore %d x item %u to companion %u\n",
				(int)saved.amount, (unsigned)saved.nameid, index_);
			continue;
		}
		++restored;
		if (equip == 0)
			continue;
		const int16 idx = pc_search_inventory(sd, saved.nameid);
		if (idx >= 0)
			(void)pc_equipitem(sd, idx, EQP_AMMO);
	}
	g_saved[sd->status.char_id] = { bag_digest(sd), gettick() };
	ShowInfo("population_engine: restored %d stack(s) to the bag of companion %u\n", restored, index_);
}
