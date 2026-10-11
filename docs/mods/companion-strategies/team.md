# Companion strategies: team play

There is no party brain. Each companion runs its own plans and decides alone,
ten times a second. They work as a team because their rules look at the same
things: who the monsters are on, who is hurt, who is dead, who is the healer.
They can also tell each other things (signals) and avoid doubling up
(`OnePerParty`).

This page shows how to lay plans out so a party plays together, with the
Phreeoni fight from the example mods as the worked case. The [guide](guide.md)
covers the basics; the [reference](reference.md) has every key.

## Layers: roles at the bottom, bosses on top

Write a team's behaviour in layers, from general to specific. Each layer is a
`Mob:` scope, and they can live in different mods:

| Layer | `Mob:` | What goes there | Example mod |
|---|---|---|---|
| Every fight | `All` | habits: leave hostile ground, don't make a boss teleport, gather on a signal | companion-roles |
| Any boss | `Boss` | each **role**'s boss behaviour: the healer heals and revives, casters keep their distance, melee kites round the healer | companion-roles |
| A kind of monster | `{ Race, Element }` | what changes against undead, demons, ghosts | companion-roles |
| One boss | `PHREEONI` | that boss's **mechanics**: phases, its summon, what not to do | companion-tactics |

A companion uses every layer that matches at once. Their rules go into one list
by priority, so the layers need a shared priority scale. These bands let a boss
mod slot in without knowing the role mod's numbers:

| Priority | For |
|---|---|
| 100 and up | survival and resurrection |
| 80 – 99 | a boss's own mechanics |
| 40 – 79 | the role's core: heals, position, buffs, damage |
| below 40 | filler, and the closing `Hold` |

A boss layer that needs to *replace* a role rule, rather than outrank it, uses
`Disable: [rule_name]`. To forbid a skill for everyone it uses `Ban`.

## Roles: who does what

A plan is written per job, but a team thinks in roles: who heals, who tanks, who
deals damage. Roles come from two sources:

1. **The class family, by default.** In companion-roles, the healer plan is for
   `Job: Priest`, the caster plan for `Job: [Wizard, Sage]`, the melee plan for a
   list of melee families.
2. **The party-chat Duty, as an override.** `<name> support`, `attacker` or
   `tank`. Each role plan is a `Build` with `Requires: { Role: [support, none] }`
   (or `[attacker, none]`). A companion with no Duty (`none`) uses its family's
   plan; a Duty moves it to another.

```yaml
- Mob: Boss
  Jobs:
    - Job: Priest
      Build: healer
      Requires: { Role: [support, none] }   # a Priest heals unless told otherwise
      Rules: [...]
    - Job: All
      Build: tank
      Requires: { Role: tank }              # whoever is told "tank"
      Rules: [...]
```

A rule about *another* member should name what it actually needs. "Whatever is
hitting the healer" is `{ Enemy: attacking, Job: Priest }`: it finds a Priest
with or without a Duty. `Who: support` only finds a member whose Duty is set to
support.

## The tools for working together

| Need | Tool | Example |
|---|---|---|
| Help whoever is in trouble | `{ Ally: attacked }`, `{ Ally: lowest_hp }` | the healer heals, walls and Kyries whoever the monsters are on |
| Protect a member | `{ Enemy: attacking, Job: Priest }` + `SetTarget` | a melee takes the slaves off the healer |
| Not all do the same | `OnePerParty: true` | one companion says "it teleported", one takes the slaves |
| Split the targets | `Claim: name` | two Wizards freeze two monsters, not the same one; one Lex Aeterna per boss |
| Tell each other | `Signal: name` / `On: { Event: signal, Name }` | "on me" (gather on a Land Protector), "kyrie me", "struck" |
| Stay where the healer can help | `KeepDistance` / `Kite` with `Target: { Ally: nearest, Job: Priest }` | melee runs the boss round the healer |
| Notice a missing member | `Absent:` / `Present:` | no living Priest: fall back to the owner |
| Share the boss | `Targeting: { MaxAttackers }` | at most two on a boss that punishes crowds |
| Talk to the player | `On: { Event: party_chat, Match }`, `Say` | "wall me" in chat gets a Safety Wall |

`OnePerParty` and signals only work between companions of one party. The owner
takes part through chat and through what the rules see: who you are fighting,
whether you are hurt or dead.

## Worked example: Phreeoni

The party: the owner (a magic Ninja), a **Priest**, a **Wizard** and an
**Assassin Cross**, all with no Duty. The mods: companion-roles and
companion-tactics.

**Who uses which plans near Phreeoni:**

| | Every fight (`All`) | Any boss (`Boss`) | Phreeoni |
|---|---|---|---|
| Priest | survival and revive, stun walls, "wall me" | healer: heal, wall, Kyrie, cure, position, buffs, Lex | Assumptio in the last phase |
| Wizard | Land Protector, Magic Mirror | caster: bolts by element, area spells on packs, 6–8 cells off | Meteor on the summon, on a pack of slaves |
| Assassin | – | melee: focus the boss, guard the healer, kite round it; Assassin skills | – |
| All of them | leave hostile ground, no rude attack, boss gone | reveal a hidden boss, healer-down fallback, hold still when petrified | phases (`opening`, `stone`, `last`), no Fire Wall |

**How the fight goes:**

1. **The pull.** The Assassin targets Phreeoni (`focus_boss`). The Wizard keeps
   6–8 cells off and bolts it. The Priest stays 5 cells from the boss and
   within 7 of whoever is hit, and opens with Lex Aeterna.
2. **The summon.** Phreeoni starts casting its summon. Each companion sees the
   cast (`On: casts`), and the Wizard holds the window open until three slaves
   stand around the boss, then drops Meteor Storm on them. Sandmen on the
   Priest are taken off by the Assassin (`guard_the_healer`, one per party).
   Sandmen on the Wizard get her bolts, and if she drops below 50 % she steps
   away.
3. **80 %: Wide Stone Curse.** A rule in every companion's Phreeoni plan sees the
   boss below 80 % and switches to `stone`. Each of them says so; add
   `OnePerParty: true` to have only one speak. When the curse is cast, they call
   "Wide Stone!". Petrified members stand still (`wait_for_the_cure`), and the
   Priest cures them, already while it sets in.
4. **Someone dies.** The Priest walks toward the body until it is within 8 cells.
   With the boss on her, she walls her own cell and casts Kyrie first, then
   revives.
5. **The healer dies.** Every other companion sees a dead Priest and no living
   one (`Present` + `Absent`), and switches its Boss plan to `fallback`: back to
   the owner, fight nothing, until a Priest is up again.
6. **30 %: the last phase.** The plans switch to `last`. The Priest puts Assumptio
   on whoever the boss is on. When Phreeoni hides, whoever has Ruwach or Sight in
   reach reveals it.

None of them knows the others' plans. They react to the same fight.

## Swapping a member

A Knight instead of the Assassin, or any other melee family in the melee list:
everything above still holds. The Priest heals whoever is hit, the Wizard bolts
whatever is on the party, and the Knight gets the melee role's rules: focus the
boss, guard the healer, kite round it. The difference is its **skills**. The
Assassin family has named skills at a boss (`Allow: []` plus rules). Families
without them use their own rotation minus a short ban list, until someone writes
theirs.

A class outside every role list (a Ninja, a Gunslinger, a Super Novice, for
now) gets no role plan at a boss: it plays as the engine does by default. Adding
it to a list is a YAML change.

## Writing a boss plan for a team

1. **Start from the roles.** Check what companion-roles already does at any boss,
   and only write what this boss changes.
2. **List the boss's mechanics** (its `mob_skill_db` entries): what it casts,
   when (HP thresholds), what it summons, what punishes the party (Phreeoni
   answers Fire Wall with Heaven's Drive).
3. **Phases become strategies**, switched on the boss's HP
   (`Target: { Enemy: boss }` + `When: enemy_hp_pct_lt80`).
4. **Visible casts become events** (`On: casts`). Instant skills can't be seen
   coming, so react to their result instead (a `Count` of slaves around it).
5. **Put mechanics at 80–99**, so they come before the role's routine.
6. **`Encounter: true`**, so the plan applies to the healer too, who has no target.
7. **`Ban` what must never happen** (Fire Wall at Phreeoni); `Disable` a role
   rule this boss needs done differently.
8. **Play it with traces on.** Each playtest of Phreeoni changed the plan; the
   lessons are in
   [Writing plans that hold up](reference.md#writing-plans-that-hold-up-in-a-fight).

## Planned: roles that change during a fight

Today a role is the Duty, or the class family through `Requires`. Planned is a
`Roles:` step that works roles out every turn from job, status and stats.
Examples: a Monk under Steel Body becomes the tank, and the Priest's tank rules
follow it; an Assassin with enough Flee tanks. It would also give the regular AI
characters roles. See the
[roadmap](../../COMPANION_STRATEGY_ROADMAP.md).
