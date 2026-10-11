# friendlier-refine

Refining without the dread. A failed refine no longer has to destroy your
equipment, and you choose from which refine level a failure costs a level
instead.

Install it from **Settings → Mods → Browse**. The options are under the mod's
row in **Settings → Mods**; **Apply** restarts the server with them.

## Settings

| Setting | Default | What it does |
|---|---|---|
| Failed refines can break items | off | Off, a failed refine never destroys the item, its cards or its enchantments. On, items break as often as rAthena says. |
| Revert from +5 / +7 / +9 | off | A failed attempt at that level or higher takes the item down one level. Below it, a failure keeps the item's level. |
| Revert from +11 (renewal) | off | The same from +11. Pre-renewal stops at +10, so it does nothing there. |

The settings also apply to the two Advanced Refiners. See
[Which refiners it covers](#which-refiners-it-covers).

- Tick one "Revert from" option. If several are ticked, the highest wins.
- The break check comes first. With breaking on, gear that can break still
  breaks, and "Revert from" only decides what happens when it doesn't.
- With no "Revert from" option ticked, a failure does what rAthena does by
  default. In pre-renewal the item keeps its level. In renewal, HD ores take
  off 1 level, and Normal ore past +10 takes off 3 (with breaking on, Normal
  ore past +10 breaks the item instead).

A "level" here means the level the refine is trying to reach. "+7" is the
attempt that takes a +6 item to +7.

## Changing the chances, and how many levels a failure takes off

These can't be changed from the settings, because the app copies a mod's
tables to the server as they are and can't write a setting into them. They
live in one file per era, in the mod's folder inside the mods directory:

| | |
|---|---|
| Windows | `%APPDATA%\Ragnarok Offline\state\mods\friendlier-refine` |
| macOS | `~/Library/Application Support/Ragnarok Offline/state/mods/friendlier-refine` |
| Linux | `~/.local/share/Ragnarok Offline/state/mods/friendlier-refine` |

- **`renewal/db/refine.yml`** and **`pre-renewal/db/refine.yml`** are
  rAthena's own refine table, which they replace, minus its breaking chances.
  They list every refine attempt: the group (`Armor`, `Weapon`, `Shadow_Armor`,
  `Shadow_Weapon`), the item's level (a weapon's level), the refine level it
  is trying to reach, and the ore (`Normal`, `Enriched`, and `HD` in renewal).
  - `Rate` is the chance of success out of 10000. 6000 is 60%, so the chance
    of failure is 10000 minus this. 1 is the lowest; rAthena refuses 0.
  - `DowngradeAmount` is how many levels a failure takes off when the item
    doesn't break.

  Every value starts at rAthena's own. The other fields (`Bonus`, `Price`,
  `Material`, ...) are there too and can be edited the same way.
- **`<era>/db/when/allow_break/refine.yml`** holds rAthena's breaking chances
  (`BreakingRate`, out of 10000). They apply while "Failed refines can break
  items" is ticked, so edit them there.
- **`<era>/db/when/revert_from_NN/refine.yml`** replaces `DowngradeAmount`
  while its "Revert from" option is ticked. To lose more than one level from
  that point on, change every `DowngradeAmount: 1` in it to the number you
  want.

**Restart the server after editing** (Apply in Settings, or quit and start the
game again). rAthena reads the refine table only when it starts.

An update of this mod replaces these files, so keep a copy of your edits.

## Which refiners it covers

- **The refine window.** Every town blacksmith opens it: Hollgrehenn, Aragham,
  Antonio, Fredrik and the rest. The window reads the refine table, so
  everything above applies to it, for all ore types (Normal, Enriched and, in
  renewal, HD) and for shadow gear. The app runs with the refine window on,
  which also takes rAthena's separate HD refiners (Mighty Hammer, Basta) out
  of the game and sends the Shadow Blacksmith's customers to the window.
- **The Advanced Refiners**, Suhnbi in Payon (both eras) and Holink in
  Malangdo (renewal), refine by script, and stock they break the item on
  every failure. The mod switches them off and puts copies in the same
  spots. The copies keep the same prices, the same words and the same
  chances (the table's Enriched rates, so edits to `Rate` reach them too),
  but a failure follows the settings. A script can't read `DowngradeAmount`,
  so at these two a "Revert from" failure always costs exactly one level.

### Refines inside quests

Three quests refine an item themselves. The mod leaves their NPCs as they
are, but two of them read the refine table, so part of the mod reaches them
anyway:

| Quest | NPC | Chance | On failure |
|---|---|---|---|
| Mjolnir seal | Vestri (`Dwarf Blacksmith#west`), refines a level 4 weapon | the table's Normal `Rate`, **so your edits apply** | the weapon **breaks**, whatever the settings say. Vestri also refuses a refine that can't fail, so raising a `Rate` to 10000 makes him turn that weapon away |
| Kagerou/Oboro job change | `Refinement Tools#ko_01`, refines the job weapon | its own, fixed in the script: 100% up to +5, then 40/30/20/10/5%, 2% past +10. **Your edits don't apply** | always drops one level; it never breaks, but ignores "Revert from" |
| Novice Academy | Refining Machine Wagjak, refines a level 1 weapon | the table's Normal `Rate`, **so your edits apply** | the weapon **breaks**, whatever the settings say |

## For maintainers

The tables are generated from rAthena's own `db/re/refine.yml` and
`db/pre-re/refine.yml`, so they can follow an rAthena update:

```
python3 registry/tools/friendlier-refine/build_refine.py --rathena ../rathena --write
python3 scripts/mod-index.py
```

`--check` fails when the tables are stale. Point `--rathena` at a checkout
of the commit `config/VENDOR_PINS` pins.

The main table replaces rAthena's (`Clear: true`) rather than adding to it.
An import can't set a `BreakingRate` back to 0: rAthena refuses a rate of 0
and drops the whole entry. So the table that can't break is rAthena's
without those lines, and breaking is the switch that puts them back. Two
consequences:

- After an rAthena update, regenerate. Until then the mod keeps the older
  table, including any refine changes the update made.
- Another mod's `db/refine.yml` is still combined with this one, but the
  clear applies to the result, so that mod's entries count and rAthena's
  stock entries don't.

The NPC scripts
(`npc/suhnbi.txt`, `renewal/npc/holink.txt`) are hand-made copies of
rAthena's `npc/merchants/advanced_refiner.txt` and
`npc/re/merchants/advanced_refiner.txt`. After an rAthena update, compare
them against those files.
