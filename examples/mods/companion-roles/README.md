# companion-roles

What each kind of recruited companion does at **any** boss, and a few things it
does in every fight. It is one table, `db/population_strategy.yml`, and nothing
else.
[docs/mods/companion-strategies/](../../../docs/mods/companion-strategies/README.md)
is the reference. [companion-tactics](../companion-tactics) adds particular
bosses on top of it.

**Status:** loaded by a real map-server in both eras, renewal and pre-renewal,
with no warnings. It comes from the Phreeoni plan, which has been played over
several rounds and reworked after each: what held up there that is not about
Phreeoni moved here. It has not been played against another boss yet. Turn on
the population engine and recruit a companion first. The table does nothing
without one.

## Who does what

A companion's role comes from its **class family**. A party-chat Duty
(`<name> support`, `attacker`, `tank`) overrides it.

| Family | Role, with no Duty given | At a boss |
|---|---|---|
| Priest (High Priest, Arch Bishop, Cardinal) | healer | heals, walls, revives, cures, buffs; never melees |
| Wizard, Sage | caster | named spells only: a bolt by element at what is on itself, on the healer, the boss, then the rest of the party's attackers; an area spell only on three or more; 6 to 8 cells off the boss, steps away when hurt, stands between casts |
| Hunter | ranged | its rotation; 4 to 8 cells off the boss |
| Knight, Crusader, Assassin, Rogue, Blacksmith, Monk, Star Gladiator | melee | its rotation while SP lasts, then plain hits until SP is back; runs the boss round the healer when hurt |
| anyone told `tank` | tank | holds the boss as its target |

A Priest told `attacker` leaves the healer plan; a Wizard told `support` leaves
the caster plan. Each role plan is a `Build` with `Requires: { Role: [..., none] }`.

## At any boss (`Mob: Boss`)

These apply while a boss-class monster is within 14 cells, whatever each
companion is fighting.

**The healer.** It acts in this order:
1. It keeps itself alive.
2. It revives the dead. With something on it, it first walls its own cell and
   casts Kyrie, so the cast is not broken. It walks toward a body that lies
   beyond Resurrection's 9 cells.
3. It cures the petrified (already while it is setting in) and the frozen.
4. It heals, walls and Kyries whoever the monsters are on.
5. It keeps Blessing, Increase AGI and Impositio up, and puts Lex Aeterna on
   the boss.

SP is kept back for Resurrection. It stands out of the boss's melee, within
Heal's reach of whoever is being hit. With nothing to cast it stands still, but
only while a monster is near. Otherwise it follows its owner.

**Everyone.** Anyone being petrified (Wide Stone Curse setting in) stands still
for the healer's Status Recovery rather than run from it. A hidden boss is
revealed at once (Ruwach, Sight). When the healer
dies and no other is up, they fall back to their owner and fight nothing until
a healer is back. A party that never had a Priest is not affected.

**Melee** with a Priest nearby, below 30 % HP, runs the boss round the Priest:
away from the boss, within Heal's reach, never onto the Priest. One of them
takes whatever is hitting the Priest off it.

## Kinds of monster (`Mob: { Race, Element }`)

These follow the monster a companion fights, or, with none, the nearest one on
the party. The rotation already picks spells by element, so these cover what it
does not:

- **Undead**, by race or by element. The healer, between the party's heals and
  its buffs:
  - Resurrection on an undead monster, which destroys it (not a boss);
  - Blessing on it, which halves its STR, INT and DEX (not a boss);
  - Sanctuary on two or more, only where no living monster stands in it;
  - Magnus Exorcismus when three are together;
  - Heal and Turn Undead as attacks;
  - Aspersio (holy) on the melee's weapons.
- **Demons**: Blessing, which halves their stats too, and Sanctuary on two or
  more, which hurts them.
- **Ghost**: a plain weapon does little or nothing to it, so the healer puts
  Aspersio on the melee.

Magnus and Aspersio are marked `Consume` (Blue Gemstone, Holy Water). Catalysts
are not paid until companions have an inventory of their own.

## In every fight (`Mob: All`)

- Nobody stands in a monster's ground spell.
- Nobody hits a boss from where it could not fight back (that makes most of them
  teleport). When a boss teleports away anyway, one says so and all regroup on
  their owner.
- A tank provokes whatever is hitting someone else, the support first.
- A Priest walls a member about to take a Stun Attack, walls anyone who types
  *wall me* in party chat, and keeps Blessing on the tank.
- A Sage that sees a Storm Gust coming lays Land Protector and calls the party
  to it; casters walk onto a party member's Land Protector and stay on it.
- A Wizard stops casting at a monster with Magic Mirror up.

## Adding to it

A boss plan in another mod (`Mob: PHREEONI`, `Encounter: true`) adds that boss's
mechanics. Give its rules priorities between 80 and 99: they then come before a
role's core (40 to 79) and after survival and resurrection (100 and up). A boss
plan that leaves `Rotation` out lets the role decide; `Rotation: false` takes
the rotation away for that boss. `Disable: [stay_back]` puts one of the role's
rules aside while the boss plan applies. The Stalactic Golem's Priest uses that
to stand 4 cells off instead of 5.

Type `<companion name> trace` in party chat to see which rule it acts on and why.
