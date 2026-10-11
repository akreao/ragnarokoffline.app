// Copyright (c) rAthena Dev Teams - Licensed under GNU GPL
// For more information, see LICENCE in the main folder
//
// RAGNAROKMAC (companion strategies): per-monster, per-job rules for recruited
// companions, read from db/population_strategy.yml and every mod's copy of it.
//
// The whole feature lives in this file and population_strategy.cpp. The engine
// reaches it through the functions below, each called from one marked line:
//
//   population_engine.cpp   load, reload and final; party chat; the companion's target;
//                           owner-follow and the idle formation step (holding position)
//   population_engine_combat.cpp   the companion's turn; the skill rotation's filter
//
// With no rules loaded (the shipped table is empty) every hook returns at once and
// the engine behaves exactly as it did without it. Regular shells are touched only
// by plans a mod marks For: shells or For: all; the rest is for companions.
#pragma once

#include <common/cbasetypes.hpp>
#include <common/timer.hpp>

class map_session_data;
struct block_list;

/// Load db/population_strategy.yml (and the db/import copy mods arrive through).
bool population_strategy_load();
/// Reload it; runtime state (events, strategies, cooldowns) is reset.
bool population_strategy_reload();
void population_strategy_final();
/// Rules loaded, across all monsters and jobs.
size_t population_strategy_rule_count();

/// The companion's turn. Runs its rules in priority order; true when one of them
/// acted (cast, moved), which ends the turn. Say and Switch never end it.
bool population_strategy_turn(map_session_data *sd, t_tick tick, bool do_skills, bool attack_only);

/// Whether the companion's plan revives the fallen with its own rule (a Resurrection rule it
/// can cast): then the engine's built-in Party Resurrection stands aside for it.
bool population_strategy_handles_resurrection(map_session_data *sd);

/// Whether a rule is positioning the companion right now (Hold, MoveTo, KeepDistance,
/// Retreat, Leave): owner-follow's leash and the idle formation step leave it where it is.
/// The warps (another map, out of sight) are not affected.
/// A Sit rule has the companion seated: the follow code leaves it down while its owner stands still.
bool population_strategy_keeps_seated(const map_session_data *sd);
bool population_strategy_holds_position(const map_session_data *sd, t_tick tick);
/// Whether the companion's rules have yet to see its fight end: a monster it was fighting or an
/// encounter it was in is gone and no turn has noticed, or an event rule that answers that is
/// still waiting to act. The engine lets such a companion take its turn before it sits down to
/// rest: the tick a lone boss dies is the tick nothing needs the companion any more, so one below
/// its rest mark sat down at once and its rules never saw encounter_ended.
bool population_strategy_wants_turn(const map_session_data *sd, t_tick tick);

/// Whether the skill rotation may use `skill_id` against `target`: false when a rule
/// set bans it for that monster, or turns the rotation off there.
bool population_strategy_rotation_allows(map_session_data *sd, block_list *target, uint16 skill_id);
/// Whether the plans that apply let the engine's own heals and buffs use this skill (Allow, Ban).
bool population_strategy_skill_allowed(map_session_data *sd, block_list *target, uint16 skill_id);
/// Whether the plans that apply let the shell make plain attacks (Attack: false = skill_only).
bool population_strategy_attack_allowed(map_session_data *sd);

/// The companion's target after Targeting: (Priority, Ignore) has had its say over
/// what the party controller chose (`desired`).
uint32 population_strategy_target(map_session_data *sd, map_session_data *owner, uint32 desired);

/// Every party-chat line a real player sends (the engine's party-chat hook): queued for
/// `On: party_chat` rules, and "<companion name> trace" from its owner toggles tracing.
void population_strategy_on_party_chat(map_session_data *from_sd, const char *message);
