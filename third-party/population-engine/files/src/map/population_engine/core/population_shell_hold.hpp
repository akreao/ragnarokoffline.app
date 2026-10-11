// Copyright (c) rAthena Dev Teams - Licensed under GNU GPL
// For more information, see LICENCE in the main folder
//
// RAGNAROKMAC: per-shell state of the shell control API (sd->pop.hold).
#ifndef POPULATION_SHELL_HOLD_HPP
#define POPULATION_SHELL_HOLD_HPP

#include <cstdint>
#include <string>

#include <common/timer.hpp> // t_tick

/// A mod's NPC script has taken this shell over with population_hold or
/// population_spawn. Until `until` passes, the engine's own AI leaves it alone
/// (population_engine_shell_is_held) and stock unit* script commands drive it.
struct s_pop_hold {
	int32_t     npc             = 0;     ///< NPC block id holding the shell; 0 = free
	t_tick      until           = 0;     ///< gettick() at which the hold lapses
	bool        spawned         = false; ///< made by population_spawn: outside every map quota
	bool        keep            = false; ///< population_spawn flag: stays as an ambient shell once released
	bool        despawn_pending = false; ///< population_despawn has scheduled its removal
	std::string whisper_event;           ///< "<npc>::<label>" a whisper runs while the shell is held
	std::string lost_event;              ///< "<npc>::<label>" run when the shell loses whoever it follows
	// The shell's pcfollow, which the engine runs in place of rAthena's follow
	// timer: that one teleports a follower it cannot reach, and no player can
	// follow a fly wing. Where the target was last seen on the shell's map
	// tells a portal (walk to it, come through) from a teleport.
	int16_t     follow_seen_m   = -1;
	int16_t     follow_seen_x   = 0;
	int16_t     follow_seen_y   = 0;
	int32_t     follow_portal   = 0;     ///< warp NPC the shell is walking to after its target
	t_tick      follow_portal_until = 0;
	t_tick      follow_next_walk = 0;
};

#endif // POPULATION_SHELL_HOLD_HPP
