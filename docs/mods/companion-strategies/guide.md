# Companion strategies: a guide

This page builds a plan step by step, from one rule to a state machine with
phases. Each step adds one idea. The [reference](reference.md) has every key in
full; this page only uses what each step needs.

The running example is a Priest companion. By the end it heals whoever is being
hit, keeps out of the boss's reach, revives the dead behind a Safety Wall, and
changes behaviour when the boss enters its last phase.

## 0. Where it goes

A plan lives in a mod, in `db/population_strategy.yml`:

```
my-mod/
├── mod.json
└── db/
    └── population_strategy.yml
```

```yaml
Header:
  Type: POPULATION_STRATEGY_DB
  Version: 1

Body:
  - Mob: All                 # every fight
    Jobs:
      - Job: Priest          # Priests, High Priests, Arch Bishops, Cardinals
        Rules:
          - ...              # the rules, below
```

The app merges every enabled mod's table into one. A change to the YAML needs a
server restart, not a new build. When the server starts, it checks the table and
reports anything it cannot use (an unknown skill, key or monster) with the file
and line.

## 1. One rule

```yaml
        Rules:
          - Name: heal_self
            Priority: 110
            When: self_hp_pct_lt50
            Cast: AL_HEAL
            Target: self
```

A rule has a **name**, a **priority**, **conditions** and **one action**. Every turn
(ten times a second while it fights) the companion goes down its rules, highest
priority first, and does what the **first rule that applies** says. If no rule
applies, it takes its ordinary turn, as it would without a plan.

This rule applies while its HP is below 50 %, and casts Heal on itself. If it
can't cast (no SP, casting already, Silence), the rule passes and the next one
is tried.

## 2. Choosing a target: selectors

`Target: self` is fixed. A **selector** lets the rule pick someone:

```yaml
          - Name: heal_attacked
            Priority: 78
            Cast: AL_HEAL
            Target: { Ally: attacked }          # whoever the monsters are on
            When: ally_hp_pct_lt85              # ...if they are below 85 %
```

`{ Ally: attacked }` is the party member the monsters in sight are on (a boss
counts three times). Other picks: `lowest_hp`, `nearest`, `missing` (lacks a
status), `having` (has one), `dead`. For monsters: `{ Enemy: attacking }`,
`boss`, `slaves`, `nearest`, `hidden`, and more.

With a selector, `ally_*` conditions ask about the member it picked, and
`enemy_*` ones about the monster it picked. A selector that finds nobody makes
the rule pass, so this rule simply doesn't apply while nobody is being hit.

## 3. More conditions

Conditions stack, and all must hold:

```yaml
          - Name: kyrie_attacked
            Priority: 75
            Cast: PR_KYRIE
            Target: { Ally: attacked }
            When: [not_ally_kyrie, self_sp_ge120]   # they lack Kyrie, and SP to spare
            Cooldown: 3000
```

The main ones:
- `When`: HP, SP, distance, statuses, spirit spheres. See
  [`When:` conditions](reference.md#when-conditions).
- `Count`: how many monsters are around.
- `Present` / `Absent`: whether a selector finds someone.
- `Field`: ground spells nearby.
- `Requires`: what the companion must have (skills, a role).
- `InStrategy`, `InFight`: how long the current phase, or the fight, has lasted
  ("after a minute in this phase", "in the first 5 s").
- `Cooldown` ("every 30 s" is `Cooldown: 30000`), `OnePerParty`.
- `Claim`: pass over a target another companion has claimed, so two of a kind
  split their targets (see [team play](team.md#the-tools-for-working-together)).

For a buff, `Target: { Ally: missing, Status: SC_BLESSING, Expiring: 3000 }`
picks whoever lacks it **or** has under 3 s of it left, so it is renewed before
it lapses.

`self_sp_ge120` keeps 120 SP back, here for Resurrection. Absolute numbers
work better than percentages for that.

## 4. Reacting to something: events

A condition asks about **now**. An event reacts to **something that happened**:

```yaml
          - Name: wall_the_stunned
            Priority: 80
            On: { Event: monster_casts, Skill: NPC_STUNATTACK, At: party }
            Cast: MG_SAFETYWALL
            Target: event                       # whoever the stun is aimed at
            OnePerParty: true
```

The rule may fire once, within a short window after the event (3 s unless you
set `Within`). `Target: event` is who the event was about; `Target: source` is
who caused it. Events: a cast starting, a party-chat line, a death, a signal
from another companion, a boss gone. See [Events](reference.md#events).

**An event starts something; a condition keeps it going.** An event rule counts
as done after its first action. For anything that takes several turns, such as
walking to a body, use a condition that holds until the goal is met
([cookbook](cookbook.md#walk-to-the-fallen-and-revive)).

## 5. Where to stand

Movement is an action like any other:

```yaml
          - Name: stay_back
            Priority: 74
            Target: { Enemy: boss, Range: 14 }
            KeepDistance: 5                     # at least 5 cells from the boss
          - Name: stay_near_the_hit
            Priority: 73
            Target: { Ally: attacked, NotSelf: true, Range: 14 }
            KeepDistance: { Min: 1, Max: 7 }    # within Heal's reach of them
```

`KeepDistance` with one number is "at least"; with `Min` and `Max` it's a band.
Inside the band, the rule passes and the next one runs, typically a cast. Other
movement: `Kite`, `Retreat`, `MoveTo`, `Leave`, `Hold` (stand still) and `Sit`
(sit down to regenerate; it stands up again by itself).

A positioning rule also stops the companion following its owner while it holds.
That's what lets it stand its ground in a fight.

**End a caster's rules with `Hold`.** Without a plan, a turn with nothing to do
walks up to the target and hits it. A Priest would melee the boss with its
staff:

```yaml
          - Name: no_melee
            Priority: 1                         # last
            Present: { Enemy: nearest, Range: 14 }   # only with a monster near
            Hold: true
```

The `Present` matters. Without it the Priest would hold even when the fight has
moved on, and get left behind.

## 6. Phases: strategies

A plan can be a **state machine**. `Strategies` are its states, `Start` is the
first one, and a rule with `Switch` moves to another. Rules under `Rules:` apply
in every state; rules inside a strategy only while it's active.

```yaml
- Mob: PHREEONI
  Encounter: true                 # applies while Phreeoni is near, whatever the target
  Jobs:
    - Job: Priest
      Start: opening
      Rules:
        - ...                     # heals, walls, positioning: every phase
      Strategies:
        - Name: opening
          Rules:
            - Name: to_last
              Target: { Enemy: boss }
              When: enemy_hp_pct_lt30
              Switch: last
              Say: "Below 30%, it powers up!"
        - Name: last
          Rules:
            - Name: assumptio_the_attacked
              Priority: 82
              Cast: HP_ASSUMPTIO
              Target: { Ally: attacked }
              When: not_ally_assumptio
```

The names are yours. A switch takes effect in the same turn. Each new boss
starts again at `Start`. A strategy can also change the plan's settings while
it's active (`Rotation`, `Allow`, `Ban`, `Attack`, `Disable`). For example, a
Wizard can have a `mirrored` strategy with `Rotation: false` while the boss
reflects magic.

## 7. Which plans apply

A companion uses **every plan that matches**, at once. Their rules go into one
list by priority. Plans match by:

- **Monster:** the one it targets; any `Encounter` monster near it; that
  monster's kind (`Mob: { Race: Undead }`); `Mob: Boss` while a boss is near;
  `Mob: All`, always.
- **Job:** its job, its family (`Job: Priest` covers High Priests), its 1st
  class, `Job: All`. `Job: [Wizard, Sage]` lists several.
- **Build:** `Build: healer` with `Requires: { Role: [support, none] }` only
  applies to companions that meet it.

So a general healer can sit under `Mob: All`, its boss behaviour under
`Mob: Boss`, and Phreeoni's specifics under `Mob: PHREEONI`, all in different
mods. The more specific plan wins ties. It can also switch a broader rule off
by name (`Disable: [stay_back]`), or ban a skill for everyone (`Ban`).
[Team play](team.md) shows how to lay this out for a party.

## 8. What the engine still does on its own

Rules come first, but whenever no rule acts, the engine takes its ordinary
turn: its skill rotation, its own heals and buffs, plain attacks, following the
owner. Four settings narrow that:

| Setting | Effect |
|---|---|
| `Rotation: false` | no skill rotation: it casts what the rules name. The default under a plan for one particular monster |
| `Allow: [..]` | the only skills the engine may cast on its own (rotation, heals, buffs). `Allow: []`: none |
| `Ban: [..]` | skills nobody casts, not even another plan's rule |
| `Attack: false` | no plain attacks |

A class with a full rules plan (like the Priest here) usually wants `Allow: []`.
A class without one keeps the engine's rotation, and a short `Allow` or `Ban`
keeps it sensible.

## 9. Testing it

In party chat, type the companion's name and `trace`:

    Seraphina trace

It then reports each rule it acts on, each event it notices, each strategy
change, and why a cast failed. Each cast line shows its SP. Type it again to
turn the trace off. The same lines appear in the map-server log, prefixed
`[strategy]`.

The [FAQ](faq.md) covers what usually goes wrong, and
[Writing plans that hold up](reference.md#writing-plans-that-hold-up-in-a-fight)
lists the lessons from the playtests.
