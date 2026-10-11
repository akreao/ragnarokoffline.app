# renewal-world

Renewal's new lands, in pre-renewal.

Pre-renewal rAthena already loads every renewal map, and the client already
has them. Nothing leads there. This mod adds the way in, where renewal puts
it, so the world grows past its old edges without a warper:

| Region | Way in | Maps |
|---|---|---|
| Bifrost, Mora | the bridge north of Splendide; the Dimensional Gap from Midgard Camp or the Morocc field | bif_fild01-02, mora, dali |
| El Dicastes | Kamidal Mountain from Bifrost via the Dimensional Gap; the Scaraba Hole from Manuk | dic_fild01-02, dicastes01-02, dic_in01, dic_dun01-03 |
| Eclage | a portal from the Mora field (bif_fild02) | ecl_fild01, eclage, ecl_hub01, ecl_in01-03, ecl_tdun01-04 |
| Verus | the east end of Juperos | ver_eju, ver_tunn, verus01-04 |
| Dewata, Port Malaya, Malangdo, Rockridge | ships on Alberta's piers | dewata, dew_*, malaya, ma_*, malangdo, mal_*, harboro1-2, har_in01, rockrdg1-2, rockmi1-2 |
| New dungeon floors | Niflheim town; one floor below the deepest of Izlude, Abyss Lakes, Einbroch mine and Magma dungeons | nif_dun01-02, iz_dun05, abyss_04, ein_dun03, mag_dun03 |

**This version opens the way only.** The new maps have no monsters, shops,
Kafras or quests yet. Monsters with pre-renewal stats are the next step.
Until then it is a world to walk, not to level in. You cannot save in the new
towns, so a Butterfly Wing takes you home.

With the quest areas setting on (the default), another 67 maps open too: see
[Quest areas](#quest-areas-setting-on-by-default).

## Quest areas (setting: on by default)

Renewal keeps another set of areas behind episode quests, instances and
nightmare/illusion entry NPCs. With **Open the areas renewal keeps behind
episode quests** ticked, a free gate stands where renewal's entrance is and
another leads back out. Unticked, those gates are not loaded and the areas stay
closed. Their own portals are there either way, so nothing else changes.
**Apply** restarts the server with the new choice.

| Area | Way in | Maps |
|---|---|---|
| Lasagna | a boat in Malangdo's harbour | lasagna, lasa_fild01-02, lasa_in01, conch_in, lasa_dun01-03 |
| Special Border Area, Bios Island | the east edge of Einbroch field 3 | sp_os, sp_cor, ba_* (10 maps) |
| Rudus | a Rebellion crewman on Einbroch field 5 | sp_rudus, sp_rudus2-4 |
| Amicitia | Lana on Einbroch field 8 | amicitia1-2 |
| Wolfchev's laboratory | a passage at the end of Lighthalzen B3 | lhz_dun04 |
| Nightmare dungeons | the cat in the Pyramid basement; Belljamin Button on Clock Tower 1F; Nillem and Hugin's follower at Glast Heim's gate; Ohno Tohiro and a kid in east Lighthalzen | moc_prydn1-2, c_tower2_, c_tower3_, gl_cas01_, gl_cas02_, gl_chyard_, lhz_dun_n, lhz_d_n2 |
| Illusion dungeons | inside Payon cave 3, Geffen dungeon 1, the Ice cave, Ant Hell 2, Einbroch mine 1, the Prontera labyrinth and Comodo's beach cave; Knight Aylvar in south Alberta; Gein in south Izlude | pay_d03_i, gef_d01_i, ice_d03_i, ant_d02_i, ein_d02_i, prt_mz03_i, com_d02_i, tur_d03_i, iz_d04_i, iz_d05_i |
| Bios Island temple | the Interdimensional Device in Eclage; the Dimensional Gap | moro_vol, moro_cav, dali02 |
| Oz labyrinth, Wolf village | a rope on Rachel field 10 | oz_dun01-02, gw_fild01-02, wolfvill |
| Garden of Time | the dimensional barrier on the Lutie field | t_garden, for_dun01-02 |
| Werner's laboratory | a rookie on Einbroch field 4 | que_swat, slabw01 |
| Verus bunker | Verity in Verus | un_bunker, un_myst |
| Bakonawa lake | its portal from the Malaya field | ma_scene01 |
| Eclage residence | the residence door in Eclage | ecl_in04 |
| Prontera Castle | a guard north of Prontera, beside the old castle gate | prt_cas, prt_pri00, prt_prison, prt_lib |

A few maps stay closed even with the setting on: the quest-only copies
(lasa_dun_q, que_lhz, un_bk_q, prt_cas_q, prt_lib_q, prt_q, prt_elib) and maps
no rAthena script leads into at all (treasure_n1-2, tur_d04_i). Their portals
are in place for later.

Brasilis is not here on purpose. rAthena ships a pre-renewal Brasilis that is
switched off, and a mod turns it on with `stock-npc.txt`. Copying renewal's
portals would clash with it.

## How it joins the old world

Every portal between the new maps, and from them to the old world, is copied
from rAthena's renewal scripts unchanged. Where renewal puts the way in behind
a quest, an instance or a ship, the mod has a **gate** instead: an NPC at the
same spot who asks once and sends you on, free.

- The ships stand on Alberta's piers beside the old ones, because pre-renewal
  Alberta has its classic layout and renewal's spots are in the water.
- The Hazy Forest instance between Bifrost and Mora is a Log Tunnel at each
  end.
- The checkpoints into Eclage, El Dicastes and inner Verus let you through
  without the episode quests.

The maps' town, no-memo, no-teleport and similar flags are copied from
renewal too.

## Where things are defined

Everything comes from two files in
[`registry/tools/renewal-world/`](../../tools/renewal-world/):

- `maps.csv`: the maps the mod covers, by region, each `open` (always
  reachable), `quest` (reachable while the setting is on) or `staged` (joined
  to its neighbours, no way in yet). A renewal portal to a map that is not
  listed, or into a staged map from outside, is left out.
- `gates.csv`: one row per gate, with where it stands, what it looks like and
  where it sends you. `switch` is empty for a gate that is always there, or
  `quest_areas` for one that is only loaded while the setting is on.

`build.py` beside them reads rAthena's renewal scripts and writes the mod's
scripts in `npc/`, the switched ones in `npc/when/quest_areas/`. It refuses to
write if:

- a gate stands where pre-renewal has no walkable cell, or uses a sprite
  rAthena does not know;
- a gate or portal crowds one pre-renewal already has;
- a name is taken;
- an open map has no way in from the old world, or no way back;
- a quest map can be reached with the setting off, or has no way in or back
  with it on;
- a staged map can be reached at all.

```
python3 registry/tools/renewal-world/build.py --rathena ../rathena          # check, show what changes
python3 registry/tools/renewal-world/build.py --rathena ../rathena --write  # write npc/
python3 scripts/mod-index.py
```

Point `--rathena` at a checkout of the pinned rAthena commit
(`config/VENDOR_PINS`). After a pin bump, run it again: `--check` fails when
the copied portals have changed.
