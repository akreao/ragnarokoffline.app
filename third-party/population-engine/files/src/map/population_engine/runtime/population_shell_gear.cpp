// Copyright (c) rAthena Dev Teams - Licensed under GNU GPL
// RAGNAROKMAC (companions start unequipped): see population_shell_gear.hpp.

#include "population_shell_gear.hpp"

#include <cstdarg>
#include <cstring>
#include <string>
#include <unordered_map>
#include <vector>

#include <common/showmsg.hpp>
#include <common/sql.hpp>
#include <common/strlib.hpp>
#include <common/timer.hpp>

#include "../../battle.hpp"
#include "../../chrif.hpp"
#include "../../clif.hpp"
#include "../../itemdb.hpp"
#include "../../log.hpp"
#include "../../map.hpp"
#include "../../pc.hpp"
#include "../../status.hpp"
#include "../../population_engine.hpp"
#include "../core/population_engine_core.hpp"
#include "population_shell_inventory.hpp"
#include "../strategy/population_strategy.hpp"

namespace {

/// char_id -> when it was marked. A companion's char id is its shell index, and an index is
/// handed to an ambient shell again once the companion's row is gone; a mark nobody claims as a
/// companion within kClaimMs is that kind of leftover and is dropped.
std::unordered_map<uint32, t_tick> g_bare;
constexpr t_tick kClaimMs = 5000;

uint32 index_of(const map_session_data *sd)
{
	return sd->status.char_id >= POPULATION_ENGINE_CHAR_ID_BASE ? sd->status.char_id - POPULATION_ENGINE_CHAR_ID_BASE : 0;
}

/// Everything the spawn dressed it in goes: worn or not, costume and shadow pieces too.
/// Ammunition stays (population_shell_ammo and the inventory setting look after it).
void strip(map_session_data *sd)
{
	for (int16 i = 0; i < MAX_INVENTORY; ++i) {
		const item &it = sd->inventory.u.items_inventory[i];
		if (it.nameid == 0 || it.amount <= 0)
			continue;
		const std::shared_ptr<item_data> id = itemdb_exists(it.nameid);
		if (id == nullptr || !itemdb_isequip2(id.get()) || (id->equip & EQP_AMMO))
			continue;
		if (it.equip != 0 && !pc_unequipitem(sd, i, 2))
			continue;
		pc_delitem(sd, i, sd->inventory.u.items_inventory[i].amount, 0, 1, LOG_TYPE_NONE);
	}
	status_calc_pc(sd, SCO_FORCE);
}

} // namespace

bool population_shell_gear_bare(const map_session_data *sd)
{
	if (sd == nullptr || g_bare.empty() || !population_engine_is_population_pc(sd->id))
		return false;
	const auto it = g_bare.find(sd->status.char_id);
	if (it == g_bare.end())
		return false;
	if (population_engine_is_recruited_companion(sd))
		return true;
	// Not a companion (yet): a recall marks the shell a moment before it gives it its owner.
	if (DIFF_TICK(gettick(), it->second) <= kClaimMs)
		return true;
	g_bare.erase(it);
	return false;
}

void population_shell_gear_drafted(map_session_data *shell)
{
	if (shell == nullptr || index_of(shell) == 0)
		return;
	g_bare.erase(shell->status.char_id);
	if (!battle_config.population_engine_companion_start_unequipped)
		return;
	strip(shell);
	g_bare[shell->status.char_id] = gettick();
	if (mmysql_handle != nullptr && Sql_Query(mmysql_handle,
			"UPDATE `cp_companion_persistence` SET start_unequipped=1 WHERE shell_index=%u", index_of(shell)) != SQL_SUCCESS)
		Sql_ShowDebug(mmysql_handle);
	// The row was written with what the spawn put on: write it again with nothing.
	population_engine_persist_companion_gear(shell);
	ShowInfo("population_engine: companion %u starts unequipped\n", shell->status.char_id);
}

void population_shell_gear_recalled(map_session_data *shell)
{
	if (shell == nullptr || index_of(shell) == 0)
		return;
	g_bare.erase(shell->status.char_id);
	if (mmysql_handle == nullptr)
		return;
	if (Sql_Query(mmysql_handle,
			"SELECT start_unequipped FROM `cp_companion_persistence` WHERE shell_index=%u", index_of(shell)) != SQL_SUCCESS) {
		Sql_ShowDebug(mmysql_handle); // a database from before the column: dressed, as it always was
		return;
	}
	bool bare = false;
	if (Sql_NextRow(mmysql_handle) == SQL_SUCCESS) {
		char *data = nullptr;
		Sql_GetData(mmysql_handle, 0, &data, nullptr);
		bare = data != nullptr && atoi(data) != 0;
	}
	Sql_FreeResult(mmysql_handle);
	if (bare)
		g_bare[shell->status.char_id] = gettick();
}

// --- Spare gear ---------------------------------------------------------------

namespace {

/// A piece of equipment in the bag, not worn. Ammunition is not gear here.
bool is_spare(const item &it)
{
	if (it.nameid == 0 || it.amount <= 0 || it.equip != 0)
		return false;
	const std::shared_ptr<item_data> id = itemdb_exists(it.nameid);
	return id != nullptr && itemdb_isequip2(id.get()) && !(id->equip & EQP_AMMO);
}

struct SlotName {
	const char *name;
	uint32 mask;
};
/// The words "@companion gear" takes, so the two commands read alike.
const SlotName kSlots[] = {
	{ "weapon", EQP_HAND_R }, { "shield", EQP_HAND_L }, { "armor", EQP_ARMOR }, { "shoes", EQP_SHOES },
	{ "garment", EQP_GARMENT }, { "acc", EQP_ACC_L | EQP_ACC_R }, { "head", EQP_HEAD_TOP | EQP_HEAD_MID | EQP_HEAD_LOW },
};

const char *slot_name(uint32 equip)
{
	for (const SlotName &s : kSlots)
		if (equip & s.mask)
			return s.name;
	return "other";
}

/// Everything a companion that started unequipped wears is its owner's. The engine hands back,
/// and keeps through a job change, only what companion_given_mask covers, and only a trade sets
/// that; a piece put on from the bag has to be counted too.
void own_what_it_wears(map_session_data *shell)
{
	uint32 worn = 0;
	for (int16 i = 0; i < MAX_INVENTORY; ++i) {
		const item &it = shell->inventory.u.items_inventory[i];
		if (it.nameid != 0 && it.equip != 0 && !(it.equip & EQP_AMMO))
			worn |= it.equip;
	}
	shell->pop.companion_given_mask = worn;
}

/// The companion's half written now, bag and worn gear, not at the next poll.
void save_now(map_session_data *shell)
{
	own_what_it_wears(shell);
	status_calc_pc(shell, SCO_NONE);
	population_shell_inventory_save(shell, true);
	population_engine_persist_companion_gear(shell);
}

/// One bag entry to its owner: into the owner's bag, or it stays with the companion.
bool hand_back(map_session_data *owner, map_session_data *shell, int16 i)
{
	item tmp = shell->inventory.u.items_inventory[i];
	const int32 amount = tmp.amount;
	tmp.equip = 0;
	// No room or too heavy: it stays where it is. Never onto the floor, where it would expire
	// or be picked up by a passing shell.
	if (pc_additem(owner, &tmp, amount, LOG_TYPE_NPC) != ADDITEM_SUCCESS)
		return false;
	pc_delitem(shell, i, amount, 0, 1, LOG_TYPE_NPC);
	return true;
}

/// The owner's summoned companion of that name, or nullptr with `why` saying what is wrong.
map_session_data *find_companion(map_session_data *owner, const std::string &name, const char *&why)
{
	uint32_t index = 0;
	bool active = false;
	if (!population_engine_companion_find(owner->status.account_id, name.c_str(), &index, &active)) {
		why = "No companion of that name in your saved list.";
		return nullptr;
	}
	// A shell is in none of rAthena's character tables: the engine's own list is where it is found.
	map_session_data *shell = nullptr;
	for (map_session_data *cand : g_population_engine_pcs)
		if (cand != nullptr && cand->status.char_id == POPULATION_ENGINE_CHAR_ID_BASE + index)
			shell = cand;
	if (!active || shell == nullptr || !population_engine_is_recruited_companion(shell)) {
		why = "That companion is not summoned.";
		return nullptr;
	}
	return shell;
}

/// Why this companion cannot carry spares, or nullptr when it can.
const char *cannot_carry(const map_session_data *shell)
{
	if (!population_shell_gear_bare(shell))
		return "Only a companion that started unequipped can carry spare gear (Settings: Companions start unequipped).";
	if (!population_shell_has_own_inventory(shell))
		return "Spare gear needs Companion inventory (Settings): without it a companion's bag is not saved.";
	return nullptr;
}

void say(map_session_data *owner, const char *fmt, ...)
{
	char line[CHAT_SIZE_MAX];
	va_list ap;
	va_start(ap, fmt);
	vsnprintf(line, sizeof(line), fmt, ap);
	va_end(ap);
	clif_displaymessage(owner->fd, line);
}

/// What it wears and what it carries, for the player (`raw` false) or the Companions window:
///   @CPGR|<name>|<can carry 0/1>|<why not>
///   @CPGW|<slot>|<item id>|<item name>|<refine>|<card0>:<card1>:<card2>:<card3>
///   @CPGS|<bag place>|<slot>|<item id>|<item name>|<refine>|<cards>
///   @CPGREND|<worn>|<carried>
void list(map_session_data *owner, map_session_data *shell, bool raw)
{
	const char *no = cannot_carry(shell);
	if (raw)
		say(owner, "@CPGR|%s|%d|%s", shell->status.name, no == nullptr ? 1 : 0, no != nullptr ? no : "");
	else if (no != nullptr)
		say(owner, "%s", no);
	int worn = 0, carried = 0;
	// Carried pieces are listed only for a companion that started unequipped: anyone else's bag
	// holds the engine's own gear (a piece a trade pushed off, the old class's set), not spares.
	const int passes = population_shell_gear_bare(shell) ? 2 : 1;
	for (int pass = 0; pass < passes; ++pass) {
		for (int16 i = 0; i < MAX_INVENTORY; ++i) {
			const item &it = shell->inventory.u.items_inventory[i];
			if (it.nameid == 0 || it.amount <= 0)
				continue;
			const std::shared_ptr<item_data> id = itemdb_exists(it.nameid);
			if (id == nullptr || !itemdb_isequip2(id.get()) || (id->equip & EQP_AMMO) || (it.equip != 0) != (pass == 0))
				continue;
			const char *slot = slot_name(it.equip != 0 ? it.equip : id->equip);
			if (raw && pass == 0)
				say(owner, "@CPGW|%s|%u|%s|%d|%u:%u:%u:%u", slot, (unsigned)it.nameid, id->ename.c_str(), (int)it.refine,
					(unsigned)it.card[0], (unsigned)it.card[1], (unsigned)it.card[2], (unsigned)it.card[3]);
			else if (raw)
				say(owner, "@CPGS|%d|%s|%u|%s|%d|%u:%u:%u:%u", (int)i, slot, (unsigned)it.nameid, id->ename.c_str(), (int)it.refine,
					(unsigned)it.card[0], (unsigned)it.card[1], (unsigned)it.card[2], (unsigned)it.card[3]);
			else if (pass == 0)
				say(owner, "  wears (%s): +%d %s", slot, (int)it.refine, id->ename.c_str());
			else
				say(owner, "  carries #%d (%s): +%d %s", (int)i, slot, (int)it.refine, id->ename.c_str());
			++(pass == 0 ? worn : carried);
		}
	}
	if (raw)
		say(owner, "@CPGREND|%d|%d", worn, carried);
	else
		say(owner, "%s wears %d piece(s) and carries %d spare(s).", shell->status.name, worn, carried);
}

} // namespace

int population_shell_gear_return_spares(map_session_data *owner, map_session_data *shell)
{
	if (owner == nullptr || shell == nullptr || !population_shell_gear_bare(shell))
		return 0;
	int returned = 0, left = 0;
	for (int16 i = 0; i < MAX_INVENTORY; ++i)
		if (is_spare(shell->inventory.u.items_inventory[i]))
			++(hand_back(owner, shell, i) ? returned : left);
	if (left > 0 && owner->fd > 0)
		say(owner, "%s still carries gear your bag has no room for. Make room and take it again.", shell->status.name);
	if (returned > 0) {
		// Owner first: if a crash falls between the two saves, the piece is doubled, not lost.
		chrif_save(owner, CSAVE_INVENTORY);
		save_now(shell);
	}
	return returned;
}

void population_shell_gear_owned(map_session_data *shell)
{
	if (shell != nullptr && population_shell_gear_bare(shell))
		own_what_it_wears(shell);
}

bool population_shell_gear_keeps_spares(map_session_data *owner, const map_session_data *shell)
{
	if (shell == nullptr || !population_shell_gear_bare(shell))
		return false;
	int left = 0;
	for (int16 i = 0; i < MAX_INVENTORY; ++i)
		if (is_spare(shell->inventory.u.items_inventory[i]))
			++left;
	// With Companion inventory off the saved bag is not loaded, so its spares are in the row only:
	// removing the companion would delete them with it.
	if (left == 0 && !population_shell_has_own_inventory(shell) && population_shell_gear_row_has_spares(index_of(shell))) {
		if (owner != nullptr && owner->fd > 0)
			say(owner, "%s keeps spare gear of yours in its saved bag, so it is not removed. Turn Companion inventory back on and take it first.",
				shell->status.name);
		return true;
	}
	if (left > 0 && owner != nullptr && owner->fd > 0)
		say(owner, "%s keeps %d piece(s) of yours that did not fit in your bag, so it is not removed. Make room and remove it again.",
			shell->status.name, left);
	return left > 0;
}

bool population_shell_gear_row_has_spares(uint32 shell_index)
{
	if (mmysql_handle == nullptr || shell_index == 0)
		return false;
	if (Sql_Query(mmysql_handle,
			"SELECT inventory_detail FROM `cp_companion_persistence` WHERE shell_index=%u AND start_unequipped=1",
			shell_index) != SQL_SUCCESS) {
		Sql_ShowDebug(mmysql_handle);
		return false;
	}
	std::string detail;
	if (Sql_NextRow(mmysql_handle) == SQL_SUCCESS) {
		char *data = nullptr;
		Sql_GetData(mmysql_handle, 0, &data, nullptr);
		if (data != nullptr)
			detail = data;
	}
	Sql_FreeResult(mmysql_handle);
	// The bag as population_shell_inventory writes it: "v1", then ";<item id>,<amount>,<equip>,...".
	if (detail.compare(0, 2, "v1") != 0)
		return false;
	for (size_t at = detail.find(';'); at != std::string::npos; at = detail.find(';', at + 1)) {
		const t_itemid nameid = static_cast<t_itemid>(strtoul(detail.c_str() + at + 1, nullptr, 10));
		const std::shared_ptr<item_data> id = itemdb_exists(nameid);
		if (id != nullptr && itemdb_isequip2(id.get()) && !(id->equip & EQP_AMMO))
			return true;
	}
	return false;
}

void population_shell_gear_command(map_session_data *owner, const char *param)
{
	static const char *usage = "Usage: @companion spare <name> list | stow <weapon|shield|armor|shoes|garment|acc|head> | wear <#> | take <#>";
	if (owner == nullptr)
		return;
	// "<name> <action> [argument]": a name may hold spaces, so the action is looked for from the end.
	std::vector<std::string> words;
	for (const char *p = param != nullptr ? param : ""; *p != '\0';) {
		while (*p == ' ' || *p == '\t') ++p;
		const char *start = p;
		while (*p != '\0' && *p != ' ' && *p != '\t') ++p;
		if (p > start)
			words.emplace_back(start, p);
	}
	static const char *actions[] = { "list", "raw", "stow", "wear", "take" };
	size_t at = words.size();
	for (size_t i = words.size(); i-- > 1;) {
		for (const char *a : actions)
			if (strcmpi(words[i].c_str(), a) == 0)
				at = i;
		if (at != words.size())
			break;
	}
	if (at == words.size()) {
		say(owner, "%s", usage);
		return;
	}
	std::string name;
	for (size_t i = 0; i < at; ++i)
		name += (i > 0 ? " " : "") + words[i];
	const std::string action = words[at];
	const char *why = nullptr;
	map_session_data *shell = find_companion(owner, name, why);
	if (shell == nullptr) {
		say(owner, strcmpi(action.c_str(), "raw") == 0 ? "@CPGRFAIL|%s" : "%s", why);
		return;
	}
	if (strcmpi(action.c_str(), "list") == 0 || strcmpi(action.c_str(), "raw") == 0) {
		list(owner, shell, strcmpi(action.c_str(), "raw") == 0);
		return;
	}
	if (strcmpi(action.c_str(), "stow") == 0) {
		if (const char *no = cannot_carry(shell); no != nullptr) {
			say(owner, "%s", no);
			return;
		}
		uint32 mask = 0;
		for (size_t i = at + 1; i < words.size(); ++i)
			for (const SlotName &s : kSlots)
				if (strcmpi(words[i].c_str(), s.name) == 0)
					mask |= s.mask;
		if (mask == 0) {
			say(owner, "%s", usage);
			return;
		}
		int stowed = 0;
		for (int16 i = 0; i < MAX_INVENTORY; ++i) {
			const item &it = shell->inventory.u.items_inventory[i];
			if (it.nameid != 0 && (it.equip & mask) != 0 && !(it.equip & EQP_AMMO) && pc_unequipitem(shell, i, 2))
				++stowed;
		}
		if (stowed > 0)
			save_now(shell);
		say(owner, stowed > 0 ? "%s now carries %d more piece(s) as spare." : "%s wears nothing there.", shell->status.name, stowed);
		return;
	}
	// wear <#> / take <#>: a place in the bag, as "list" shows it. Only a companion that started
	// unequipped: in a dressed one's bag, an unworn piece is the engine's (pushed off by a trade,
	// or left from its old class), and "take" would hand the owner gear nobody gave it.
	if (!population_shell_gear_bare(shell)) {
		say(owner, "%s", cannot_carry(shell));
		return;
	}
	char *end = nullptr;
	const long place = at + 1 < words.size() ? strtol(words[at + 1].c_str(), &end, 10) : -1;
	if (place < 0 || place >= MAX_INVENTORY || end == nullptr || *end != '\0'
			|| !is_spare(shell->inventory.u.items_inventory[place])) {
		say(owner, "%s carries no spare there. \"@companion spare %s list\" shows what it carries.", shell->status.name, shell->status.name);
		return;
	}
	const int16 i = static_cast<int16>(place);
	const std::shared_ptr<item_data> id = itemdb_exists(shell->inventory.u.items_inventory[i].nameid);
	if (strcmpi(action.c_str(), "take") == 0) {
		if (!hand_back(owner, shell, i)) {
			say(owner, "Your bag has no room for it (or it is too heavy); it stays with %s.", shell->status.name);
			return;
		}
		chrif_save(owner, CSAVE_INVENTORY);
		save_now(shell);
		say(owner, "%s handed back the %s.", shell->status.name, id->ename.c_str());
		return;
	}
	// wear: what it pushes off stays in the bag, as a spare.
	if (!population_shell_gear_bare(shell)) {
		say(owner, "%s", cannot_carry(shell));
		return;
	}
	if (!pc_equipitem(shell, i, id->equip, false)) {
		say(owner, "%s cannot wear the %s (its class or level).", shell->status.name, id->ename.c_str());
		return;
	}
	save_now(shell);
	say(owner, "%s put on the %s.", shell->status.name, id->ename.c_str());
}

// --- Switching gear in a plan ---------------------------------------------------

bool population_shell_gear_can_switch(const map_session_data *sd)
{
	return sd != nullptr && cannot_carry(sd) == nullptr;
}

bool population_shell_gear_put_on(map_session_data *shell, int16 index, uint32 pos)
{
	if (shell == nullptr || index < 0 || index >= MAX_INVENTORY || !is_spare(shell->inventory.u.items_inventory[index]))
		return false;
	const std::shared_ptr<item_data> id = itemdb_exists(shell->inventory.u.items_inventory[index].nameid);
	if (id == nullptr || !pc_equipitem(shell, index, pos != 0 ? pos : id->equip, false))
		return false;
	own_what_it_wears(shell);
	return true;
}

bool population_shell_gear_take_off(map_session_data *shell, int16 index)
{
	if (shell == nullptr || index < 0 || index >= MAX_INVENTORY)
		return false;
	const item &it = shell->inventory.u.items_inventory[index];
	if (it.nameid == 0 || it.equip == 0 || (it.equip & EQP_AMMO) || !pc_unequipitem(shell, index, 2))
		return false;
	own_what_it_wears(shell);
	return true;
}

item population_shell_gear_as_saved(const map_session_data *sd, int16 index)
{
	item it = sd->inventory.u.items_inventory[index];
	if (it.nameid != 0 && !(it.equip & EQP_AMMO))
		it.equip = population_strategy_normal_equip(sd, index);
	return it;
}
