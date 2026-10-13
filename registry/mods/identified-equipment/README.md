# identified-equipment

Weapons, armour, pet armour and shadow gear arrive already identified. You
never need a Magnifier or Item Appraisal again.

## What changes and what does not

- **Covered:** everything the server creates through its "should this be
  unidentified?" check: monster drops, Steal, item boxes and item groups,
  quest rewards, and items NPC scripts hand out.
- **Not covered:** equipment that is *already* unidentified, in your
  inventory, cart or storage, before you install the mod. Identify it the
  usual way once.
- Cards, consumables and everything else were always identified; nothing
  changes for them.

Changes take effect when the server restarts (**Apply**).

## How it works

The mod is a single file. `db/extension_db.yml` switches on the rAthena
fork's `identified_equipment` server extension, which makes the server
create equipment identified. In game, `@extensioninfo identified_equipment`
shows it is on.

## Requirements

An app whose pinned rAthena fork has the `identified_equipment` extension
(Flux159/rathena#42). On an older one the server does not know the
extension and the mod does nothing.
