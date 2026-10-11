# How companions fight: strategies

A recruited companion normally casts from its class's skill list in rotation,
whatever it is fighting. A mod can give it a **plan** instead: rules for a
particular monster (or any boss, or a kind of monster), job and build, in a table
the population engine reads, `db/population_strategy.yml`. Each plan can be a
small state machine with phases. Plans from several mods combine, so one mod can
teach roles and another a particular boss.

By default only recruited companions use plans. A plan marked `For: shells` or
`For: all` is used by the AI characters around the world as well. With no plans
loaded the engine behaves exactly as before; it ships the table empty.

## The pages

| Page | For |
|---|---|
| [Guide](guide.md) | building a plan step by step, from one rule to a state machine |
| [Team play](team.md) | how a party's plans fit together: layers, roles, priorities, coordination, with the Phreeoni fight as the worked example |
| [Cookbook](cookbook.md) | short recipes by goal: heal whoever is hit, kite round the healer, bolts by element, phases, signals ... |
| [Reference](reference.md) | every key, event, selector and condition, with an index at the top |
| [FAQ](faq.md) | when a rule doesn't fire, a companion stays behind, the healer doesn't revive ... |

New to it: read the guide, then copy from the cookbook. Designing a boss fight:
team play. Looking something up: the reference.

## How a turn works, in short

Ten times a second, a companion in a fight:

1. collects every plan that matches: the monster it fights, an encounter boss
   near it, that monster's kind, any boss near it, every fight; its job, family,
   1st class, every job; the builds it qualifies for;
2. goes down all their rules by priority and does what the **first rule that
   applies** says: a cast, a move, standing still;
3. if no rule acted, takes its ordinary turn (rotation, heals, buffs, plain
   attacks, following its owner), limited by the plans' `Rotation`, `Allow`,
   `Ban` and `Attack`.

Nothing is random: the same situation always gives the same decision.

## The example mods

- [`examples/mods/companion-roles`](../../../examples/mods/companion-roles): what each
  kind of companion does at any boss and in every fight. A Priest heals, walls,
  revives and cures; casters keep their distance and pick bolts by element; melee
  focuses the boss and kites round the healer. Plus undead, demons and ghosts.
- [`examples/mods/companion-tactics`](../../../examples/mods/companion-tactics):
  particular bosses on top. Phreeoni's phases, which a party of a Priest, a
  Wizard and an Assassin has beaten, and Monk and Ninja builds against the
  Stalactic Golem.

## See also

- [Companion development notes](../../COMPANION_DEVELOPMENT.md): where the engine
  calls into the strategy module, and what the playtests taught about the engine.
- [Roadmap](../../COMPANION_STRATEGY_ROADMAP.md): what comes next.
