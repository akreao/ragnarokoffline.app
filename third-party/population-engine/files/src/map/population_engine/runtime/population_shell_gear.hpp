// Copyright (c) rAthena Dev Teams - Licensed under GNU GPL
// RAGNAROKMAC (companions start unequipped): a companion the engine never dresses.
//
// The engine dresses a drafted companion from its job's gear set, and again at a job change
// and wherever a slot is found empty. Settings -> Population -> Companions start unequipped
// (population_engine_companion_start_unequipped, off by default) drafts a companion with
// nothing on instead, and from then on the engine gives that companion no gear at all: what it
// wears is what its owner gave it. The companion remembers how it was drafted
// (cp_companion_persistence.start_unequipped), so the setting changes no existing companion.
//
// It is also what lets a plan switch gear later: with nothing of the engine's on it, every
// piece a companion wears or carries is its owner's, and none has to be told apart.
//
// Ammunition and potions are not gear here; they keep their own settings.
#pragma once

#include <common/cbasetypes.hpp>
#include <common/mmo.hpp>

class map_session_data;

/// True for a companion that was drafted unequipped: the engine dresses it nowhere.
bool population_shell_gear_bare(const map_session_data *sd);
/// A companion has just been drafted and its row exists. With the setting on, it loses what
/// the spawn dressed it in and is marked, in memory and in its row.
void population_shell_gear_drafted(map_session_data *shell);
/// A saved companion has just been spawned for a recall, before the recall dresses it: reads
/// how it was drafted from its row.
void population_shell_gear_recalled(map_session_data *shell);

/// Everything a companion that started unequipped wears is its owner's, however it got there (a
/// trade, the Gear tab, a script's equip): marks it so in companion_given_mask, which is what
/// "take back" and the removal check read. Does nothing for a companion the engine dressed.
void population_shell_gear_owned(map_session_data *shell);

// --- Spare gear (the roadmap's "Switching gear", step 2) ----------------------
// A companion that started unequipped can carry pieces it does not wear. Trading still puts a
// piece on; "@companion spare <name> stow <slot>" moves a worn piece into its bag, "wear" puts
// a carried one on, "take" hands a carried one back to the owner. The Companions window's Gear
// tab sends these. It needs Companion inventory, which is what saves the bag.

/// "@companion spare <name> list|raw|stow <slots>|wear <n>|take <n>". Answers `owner` itself.
void population_shell_gear_command(map_session_data *owner, const char *param);
/// Every carried piece of equipment goes back to the owner: "take everything", and a companion
/// about to be removed. Returns how many; one the owner's bag has no room for stays with the
/// companion. Nothing for a companion the engine dressed.
int population_shell_gear_return_spares(map_session_data *owner, map_session_data *shell);
/// Whether a summoned companion still carries spares after they were asked back: the owner's
/// bag had no room, and a piece is never dropped on the floor. With `owner`, says so: the
/// remove command then leaves the companion be.
bool population_shell_gear_keeps_spares(map_session_data *owner, const map_session_data *shell);
/// Whether a saved companion's row holds carried equipment: one that is not summoned cannot
/// hand it back, so it is not removed until it has been.
bool population_shell_gear_row_has_spares(uint32 shell_index);

// --- Switching gear in a plan (step 3) -----------------------------------------
// What the strategy module's Equip rule needs: whether this companion may switch at all, and
// one piece on or off with the owner's custody kept in step. Neither writes the row; the
// engine's own gear poll does.

/// A companion that started unequipped, with a bag of its own: the only kind a plan may dress.
bool population_shell_gear_can_switch(const map_session_data *sd);
/// Puts the bag's piece at `index` on (at `pos`, or where the item goes with 0). What it
/// replaces stays in the bag.
bool population_shell_gear_put_on(map_session_data *shell, int16 index, uint32 pos);
/// Takes the worn piece at `index` off, into the bag.
bool population_shell_gear_take_off(map_session_data *shell, int16 index);

// --- What the save records (step 4) ---------------------------------------------
/// The item at `index` as the companion's row should keep it: a copy whose `equip` is its place
/// in the companion's normal set. A piece an Equip rule has on for a fight is saved as carried,
/// and the piece it took off as worn where it was, so a companion saved in mid-fight comes back
/// in its own gear with the fight's piece in its bag. Any other item is returned as it is.
item population_shell_gear_as_saved(const map_session_data *sd, int16 index);
