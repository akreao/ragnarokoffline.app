// Copyright (c) rAthena Dev Teams - Licensed under GNU GPL
// RAGNAROKMAC (companion inventory): a recruited companion owns what is in its bag.
//
// Every shell has rAthena's inventory, but the engine treated it as a virtual supply: ammo
// and potions were topped up for free, catalysts were waived (patch 0001,
// skill_get_requirement), and nothing but worn gear was saved. A recruited companion now
// lives on what it carries, as a player does: no top-ups, item costs paid through rAthena,
// and the whole bag saved with its row (cp_companion_persistence.inventory_detail) and put
// back on recall. Refilling it is the owner's job, by trade. Ambient shells keep the
// virtual supply.
//
// Settings -> Population -> Companion inventory (population_engine_companion_inventory, off by
// default). Off, companions have the free supply too, and a bag saved while it was on stays in
// the row until it is turned on again.
#pragma once

#include <common/cbasetypes.hpp>
#include <common/mmo.hpp>

class map_session_data;
struct s_skill_condition;

/// True for a recruited companion while Companion inventory is on: its bag is real, nothing
/// refills it and item costs apply.
bool population_shell_has_own_inventory(const map_session_data *sd);

/// skill_get_requirement hook (patch 0033). A companion pays items and ammunition as a player
/// does; the rest of what the waiver relaxed stays relaxed (max-HP triggers, required
/// statuses and equipped items, and the weapon unless Weapon rules is on).
void population_shell_inventory_relax_requirement(const map_session_data *sd, s_skill_condition &req);

/// Whether the bag holds the items a skill costs, the check rAthena makes when the cast ends.
/// True for any shell without its own inventory. Lets the engine pass a skill over instead of
/// having rAthena refuse it on every try.
bool population_shell_inventory_can_pay_skill(map_session_data *sd, uint16 skill_id, uint16 skill_lv);

/// Equip ammunition the companion carries of a kind in `ammo_mask` (1 << e_ammo_type), at least
/// `amount` of it, when the engine's own lists (population_shell_ammo) had nothing for it: an
/// arrow or bullet they leave out, or a Mechanic's cannonballs and a Genetic's throwing items.
/// The strongest stack is taken; the one already worn stays if it fits. False for any shell
/// without its own inventory, as before.
bool population_shell_inventory_equip_carried_ammo(map_session_data *sd, int ammo_mask, int amount);

/// The healing (`hp`) or SP item to drink: `preferred` when carried, otherwise, for a
/// companion, any other one it carries, strongest first. -1 when there is none.
int16 population_shell_inventory_find_potion(map_session_data *sd, t_itemid preferred, bool hp);

/// Write the companion's bag to its row when it changed. `now` writes at once (trade, gear
/// changes, logout); otherwise at most every few seconds, since every arrow and potion
/// changes the bag.
void population_shell_inventory_save(map_session_data *sd, bool now);

/// Recall: replace what the spawn put in the bag with the saved one. A row saved before
/// inventories (NULL) keeps what the spawn gave, which the next save makes its own. The caller
/// recalculates the status afterwards (max_weight is raised while the items go in).
void population_shell_inventory_restore(map_session_data *sd);
