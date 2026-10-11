-- skill-tuning: what db/skill_db.yml cannot change -- a skill's damage,
-- accuracy and element.
--
-- Every .lua file in a mod's lua/ folder runs once when the map server starts,
-- in a sandbox: arithmetic, strings and tables, but no files, no network.
-- `skill("<AegisName>", { ... })` hooks one skill by its AegisName from
-- skill_db.yml (SM_BASH, not "Bash"). It takes up to four functions:
--
--   ratio(c, stock)    the skill's damage %, after the server worked it out
--   hit(c, stock)      the attack's chance to hit, in %, for skills that can miss
--   element(c, stock)  the attack's element, an ELE_* constant
--   on_hit(c)          after each hit is dealt; see when/freezing_cold_bolt/
--
-- ratio, hit and element are handed the server's own result as `stock` and
-- return the value to use instead. Return nil (or nothing) to keep `stock`.
-- A fraction is cut toward zero. Never assume `stock` is the bare stock
-- value: if another mod hooks the same skill with a lower `priority`, you
-- receive what it returned.
--
-- They only run on skills that have their own class in the server
-- (src/map/skills/), about 1,060 of them, including every damaging player
-- skill. On a skill without one the server says, at start-up:
--   Lua: XX_SKILL has no skill class in this server, so its ratio, hit and
--   element hooks cannot run (on_hit still does).
--
-- `c` describes the attack. The fields used here: c.skill_lv (the level
-- used), c.caster and c.target (units: kind, name, level, str..luk, hp, ...,
-- and :has_status("SC_...")). docs/MODDING.md lists them all.
--
-- Settings come from mod.json through setting(<mod>, <key>, <default>). They
-- are read on every call, but they only change when the player presses Apply,
-- which restarts the server and reloads this file anyway.

local MOD = "skill-tuning"

local function trace(...)
  if setting(MOD, "log_hooks", false) then
    log(...)
  end
end

-- ---------------------------------------------------------------------------
-- Bash: more damage, and harder to miss.
-- ---------------------------------------------------------------------------
skill("SM_BASH", {
  -- 0..10, lower runs first, 5 when left out. Only matters when another mod
  -- hooks the same skill: the chain runs in this order, each hook getting the
  -- previous one's result as `stock`.
  priority = 5,

  -- Stock Bash is 100% + 30% a level (400% at level 10), the same in both
  -- eras. This multiplies whatever the server worked out, so it also keeps
  -- anything the stock formula adds.
  --
  -- To REPLACE the formula instead, return your own number, e.g.
  --   return 100 + 35 * c.skill_lv + c.caster.str
  -- The result is the skill's damage %. ATK, DEF, size, race and element
  -- modifiers are all applied around it afterwards, as in stock.
  ratio = function(c, stock)
    local bonus = setting(MOD, "bash_bonus", 30)
    if bonus <= 0 then
      return nil  -- keep stock
    end
    local ratio = stock * (100 + bonus) // 100
    trace(c.caster.name, "Bash Lv", c.skill_lv, "ratio", stock, "->", ratio)
    return ratio
  end,

  -- `stock` is the chance to hit in %, before the server applies its minimum
  -- and maximum (5..100 by default), so going over 100 does nothing. Stock
  -- Bash already adds 5% of it per level. This adds a flat 10.
  -- Skills that never miss (magic, most ground skills) never call `hit`.
  hit = function(c, stock)
    return stock + 10
  end,
})

-- ---------------------------------------------------------------------------
-- Arrow Shower turns Wind while the archer has Improve Concentration on.
-- ---------------------------------------------------------------------------
skill("AC_SHOWER", {
  -- `stock` is the element the server picked: the arrow's, the weapon's, or
  -- an endow's. Returning an ELE_* constant overrides all of them; anything
  -- that is not an element is ignored and stock is used.
  element = function(c, stock)
    if c.caster:has_status("SC_CONCENTRATE") then
      trace(c.caster.name, "Arrow Shower turns Wind")
      return const("ELE_WIND")
    end
    -- falling off the end returns nil: the arrow's element stays.
  end,
})
