-- skill-tuning: Cold Bolt can freeze.
--
-- This file only runs while the "freezing_cold_bolt" setting is ticked:
-- everything under lua/when/<setting key>/ works that way. It is loaded as
-- its own part, "skill-tuning/freezing_cold_bolt", which is the name its log
-- lines and errors carry.
--
-- on_hit runs after each hit of a skill is calculated, for ANY skill, even
-- one without a class of its own. It returns nothing. Instead it asks for
-- actions, which the server applies once the hit has been dealt (and not at
-- all if the unit has died by then):
--
--   c:status("SC_...", rate, ms, val1, who)  rate out of 10000; who "target" or "caster"
--   c:heal(hp, sp, who)                      who "caster" (default) or "target"
--   c:drain()                                the caster's HP/SP drain card bonuses
--   c:cast("SKILL", level, who)              like bAutoSpell
--   c:polymorph()                            Hylozoist Card's effect
--
-- That list is all there is. Anything else (knock back, teleport, change the
-- damage of this hit) needs a change to the server.
--
-- Extra fields an on_hit hook gets: c.damage (this hit's final damage),
-- c.connected, c.critical, c.element, c.weapon_type ("weapon", "magic", "misc").

local MOD = "skill-tuning"

skill("MG_COLDBOLT", {
  on_hit = function(c)
    -- A bolt's ten hits at level 10 are calculated as ONE attack, so this runs
    -- once per cast, not once per bolt. c.damage is the whole cast's damage.
    if c.damage <= 0 then
      return
    end

    -- 500 in 10000 = 5%. This is the chance to TRY: the server still applies
    -- the target's resistance. Freeze is resisted by MDEF, undead and boss
    -- monsters are immune, and the 3000 ms is shortened the same way.
    -- (c:chance(n) rolls the same kind of number yourself, if you need to
    -- decide something before asking.)
    c:status("SC_FREEZE", 500, 3000)

    if setting(MOD, "log_hooks", false) then
      log(c.caster.name, "Cold Bolt hit", c.target.name, "for", c.damage, "- rolled freeze")
    end
  end,
})
