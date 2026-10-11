# companion-tactics

Plans for recruited companions against particular bosses. It builds on
[companion-roles](../companion-roles), which has to be on as well. That mod makes
Priests heal, casters keep their distance and melee keep SP back at any boss.
This one adds what is particular to each boss. It is one table,
`db/population_strategy.yml`, and nothing else.
[docs/mods/companion-strategies/](../../../docs/mods/companion-strategies/README.md)
is the reference.

**Status:** loaded by a real map-server in both eras, renewal and pre-renewal,
with no warnings. The Phreeoni plan has been played in several rounds and
reworked after each (the lessons are in
[Writing plans that hold up in a fight](../../../docs/mods/companion-strategies/reference.md#writing-plans-that-hold-up-in-a-fight)).
Since then, everything in it that is not about Phreeoni has moved to
companion-roles. The Stalactic Golem plans are worked examples of the format,
not yet played.

## Phreeoni

Written for a Wizard, a Priest and an Assassin beside their owner. It is an
`Encounter`: the plan applies while Phreeoni is near, whatever each companion is
fighting. Its phases are strategies switched on the boss's HP:

- `opening`, above 80 %;
- `stone`, below 80 %: Wide Stone Curse every 20 s. It cannot be outrun, so the
  healer from companion-roles undoes it with Status Recovery, and someone calls
  it out;
- `last`, below 30 %: Power Up, then Hiding below 20 %. The Priest puts
  Assumptio on whoever it is on, and companion-roles reveals it.

In every phase:
- the Wizard puts Meteor Storm (or Storm Gust) on the boss as it summons, so the
  Sandmen arrive in it, and again once three slaves stand around it (its Call
  Slave is instant, so only the result can be seen);
- nobody uses Fire Wall, which sets off its Heaven's Drive.

## The Stalactic Golem

It has very high defence, a 1.5 s Stun Attack, and Endure and Auto Guard when it
is hit from range. It is an `Encounter`, so a Priest with no target of its own
still plays its part.

- *Every Monk and Champion* (`Job: Monk` is the whole family) never throws
  spirit spheres at it (`Ban`), and steps out of its Stun Attack.
- *An Asura Monk or Champion* (`Build: asura`) is a four-state machine:
  - `approach`: it arrives with 5 spheres while the golem walks over;
  - `fight`: Investigate, which does more the higher the defence;
  - `finish`: Fury, which costs all 5 spheres, then it **charges again** and
    uses Asura Strike;
  - `recover`: Steel Body, and it calls for help.

  A Monk casts Asura plainly. A Champion recharges with Zen (5 at once), hits
  plainly to open a combo, and strikes Asura straight out of Combo Finish or
  Chain Crush, where it has no cast time and needs fewer spheres. Its rotation is
  off (`Rotation: false`): every sphere is counted.
- *A combo Monk or Champion* (`Build: combo`, which `Lacks` Asura Strike) only
  hits plainly, so Triple Attack opens the combo. It then chains Chain Combo,
  Combo Finish, and Glacier Fist and Chain Crush if it has them. The steps are
  listed last first, and rAthena refuses one out of order.
- *A Final Strike Ninja and a Priest*, as a duo. Final Strike hits for the
  Ninja's current HP and leaves it at 1 HP (1 % in renewal), ending Soul. The
  Ninja first casts Soul. Once nearly full, it asks for Kyrie
  (`Signal: kyrie_me`). It strikes at full HP behind Kyrie or Cicada, signals
  `struck`, then keeps its distance from the slow golem until healed. The Priest
  answers both signals. It stands 4 cells off the slow golem rather than the
  role's 5 (`Disable: [stay_back]` and a `stay_back` of its own).
- *A magic Ninja* stands in the middle of its own Blaze Shield and draws the
  golem in with a level 1 Freezing Spear, so that the golem walks over the fire
  to reach it. It then uses Exploding Dragon. Blaze Shield and Exploding Dragon
  are marked `Consume`. Catalysts are not paid yet (companions have no
  inventory of their own), so the marks take effect once inventories exist.

## Also in it

- **Porings and friends:** plain hits only, so neither companions nor the AI
  characters around them spend SP on them.
- **Regular AI characters** (`For: shells`): Wizards around the world keep Storm
  Gust, Meteor Storm, Lord of Vermilion and Heaven's Drive for packs of three or
  more.

## Things worth knowing before copying it

- Cicada Skin Shed knocks the Ninja back each time it blocks, which moves it off
  the centre of its ring.
- A Defensive companion never starts a fight. The Ninja's pull only happens in
  Attack mode, or once the owner has hit the golem. Defensive is also what keeps
  a companion off monsters nobody is fighting.
- The golem's Endure starts when it is hit from range, and Endure is what lets a
  monster walk over Blaze Shield without being held on a pillar.

Type `<companion name> trace` in party chat to see which rule it acts on and why.
