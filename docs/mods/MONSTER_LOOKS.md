# Monster looks

A monster does not have to look like the rest of its kind: an event boss drawn
larger, a rare variant with an effect around it, an orc dressed as a knight.
This page is every way to change how a monster looks **with what the app
already ships**: no change to the server, the client or the app, only a mod's
`db/` and `npc/` folders.
[Making mods](../MODDING.md) is the reference for the mod format itself.

| | Set when | Lasts | Changes gameplay? |
|---|---|---|---|
| [Another sprite](#another-sprite-mob_availyml) (`mob_avail.yml`) | server start, for every monster of that id | always | no |
| [Another sprite for one monster](#one-monster-after-it-spawns-setunitdata) (`setunitdata`) | any time | until it dies | no |
| [Small or large](#small-or-large) | when it spawns | until it dies | no, in this app |
| [A hat effect](#a-lasting-effect-hateffect) | any time | until it dies or you switch it off | no |
| [Frozen, poisoned, …](#status-colours-that-update-at-once) | any time | the status's duration | **yes** |
| [Energy Coat, Assumptio, …](#skill-colours-that-only-show-on-arrival) | any time | the status's duration | **yes** |
| [Emotes and shouted text](#things-that-come-and-go) | any time | a moment | no |

Most of these act on **one monster**, by its game id (GID). `monster` puts the
ids of what it spawned in `$@mobid[]`, so the line after it can use them:

```
	monster "prt_fild08",0,0,"Poring",1002,1;
	.@gid = $@mobid[0];
```

Monsters from a permanent spawn line (`prt_fild08,0,0	monster	Poring	1002,40,…`)
have no such moment, and respawn without anything a script gave them. Only
`mob_avail.yml` and the [size](#small-or-large) carry over to a permanent
spawn. For anything else, spawn the monster from a script that also brings it
back; [the worked example](#putting-it-together) at the end does that.

## Another sprite: mob_avail.yml

`db/mob_avail.yml` tells the server to send another id in place of a
monster's own. The client draws that sprite; the monster keeps its own name,
stats, skills and drops.

```yaml
# my-mod/db/mob_avail.yml
Header:
  Type: MOB_AVAIL_DB
  Version: 1

Body:
  - Mob: PORING
    Sprite: ANGELING
```

`Sprite:` can also be a **player job**, and then the monster is drawn as a
character, dressed by the rest of the entry:

```yaml
Body:
  - Mob: ORC_WARRIOR
    Sprite: JOB_KNIGHT
    Sex: Male
    HairStyle: 5
    HairColor: 3
    ClothColor: 1
    Weapon: Claymore
    Shield: Guard
    HeadTop: Helm
    HeadMid: Sunglasses
    HeadLow: Cigar
    Options:
      Wedding: true
```

| Key | Means, for a player sprite |
|---|---|
| `Sex`, `HairStyle`, `HairColor`, `ClothColor` | the body. `Sex` defaults to `Female`, the rest to `0` |
| `Weapon`, `Shield`, `HeadTop`, `HeadMid`, `HeadLow`, `Robe` | the equipment shown, by item AegisName |
| `Options:` | an `OPTION_*` name without the prefix, `true` or `false`. The ones the client draws on someone else are the mounts (`Riding`, `Dragon1`…`Dragon5`, `Wugrider`, `Madogear`) and the costumes (`Wedding`, `Xmas`, `Summer`) |

Hiding options (`Hide`, `Cloak`, `Invisible`, `Chasewalk`) are taken out
again by the server (`MobAvailDatabase::parseBodyNode`, `src/map/mob.cpp`), so
`mob_avail.yml` cannot make an invisible monster.

**This is per monster id, not per monster.** Every Poring on every map
changes. To change one Poring and not the others, either give that one
another sprite after it spawns (next section), or make it
[a new monster](../MODDING.md#a-new-monster) with an id of its own: a copy of
Poring's `mob_db.yml` entry under a new id, and this file pointing the new id
at whatever it should look like.

Take `Version:` from `vendor/rathena/db/import-tmpl/mob_avail.yml`, as for
every table.

## One monster, after it spawns: setunitdata

`setunitdata <GID>,<field>,<value>` changes one monster while it lives, and
the server tells everyone who can see it at once.

| Field | What it shows |
|---|---|
| `UMOB_CLASS` | another sprite, by monster id: `setunitdata .@gid,UMOB_CLASS,1096;` draws a Poring as an Angeling. Only the look changes: the server calls `status_set_viewdata`, and stats, name, skills and drops stay the Poring's |
| `UMOB_LOOKDIR` | which way it faces, 0–7 |
| `UMOB_HAIRSTYLE`, `UMOB_HAIRCOLOR`, `UMOB_CLOTHCOLOR`, `UMOB_HEADTOP`, `UMOB_HEADMIDDLE`, `UMOB_HEADBOTTOM`, `UMOB_WEAPON`, `UMOB_SHIELD`, `UMOB_ROBE`, `UMOB_BODY2`, `UMOB_SEX` | the same as the `mob_avail.yml` keys above: they only show on a monster that `mob_avail.yml` already draws as a player |

`setunitname <GID>,"<name>"` renames it, and the new name is sent to everyone
nearby. Players see a monster's name when they point at it.

Two fields have names that promise more than they do:

- **`UMOB_SIZE` is not the sprite size.** It sets the size *class*, small,
  medium or large, that weapon size modifiers read. Nothing about the picture
  changes. The sprite size is the [spawn argument](#small-or-large) below.
- **`UMOB_SCOPTION` sends nothing.** It sets the monster's option flags on the
  server, and no packet goes out, so nobody sees a change.

## Small or large

`monster` and `areamonster` take a size after the event label:

```
	monster "prt_fild08",0,0,"Giant Poring",1002,1,"",Size_Large;
```

So does a permanent spawn line, as the field after its event. There the event
cannot be left empty (`npc_parse_mob` stops reading at an empty field, and the
size with it), so point it at a label that does nothing:

```
prt_fild08,0,0	monster	Giant Poring	1002,5,60000,0,MyModSpawns::OnNothing,2

-	script	MyModSpawns	-1,{
OnNothing:
	end;
}
```

| Constant | Value | The sprite is drawn |
|---|---|---|
| `Size_Small` | 0 | at its normal size (the default) |
| `Size_Medium` | 1 | at **half** size |
| `Size_Large` | 2 | at **one and a half** times its size |

Yes, `Size_Small` is the normal one and `Size_Medium` is the small one.
The names are rAthena's, and they are wrong in a way that will cost you a
test run.

The server marks the monster with `EF_BABYBODY2` or `EF_GIANTBODY2` whenever
it comes into someone's view (`clif_spawn`, and `clif_getareachar_unit` for players who arrive later), and
the client scales the sprite (`EffectTable.js`, effects 421 and 423). So the
size holds for players who arrive later, and a permanent spawn line respawns
at the same size.

**The size is chosen at spawn and cannot be changed afterwards.** There are
only the three steps: no 1.1×, no 2×.

**In this app it changes nothing but the picture.** Stock rAthena can give a
large monster twice the HP, stats, drops and experience, and a small one half,
through `mob_size_influence` in `conf/battle/monster.conf`. That is off by
default, and [`conf/`](../MODDING.md#conf--a-few-server-settings) does not let
a mod switch it on.

To see it before writing a script: `@monsterbig poring` and
`@monstersmall poring`.

## A lasting effect: hateffect

A hat effect is the looping visual effect some headgears carry: butterflies,
falling snow, a magic circle. rAthena puts one on any unit, monsters
included:

```
	hateffect HAT_EF_MAGICCIRCLE_BLUE_TW,true,.@gid;	// on
	hateffect HAT_EF_MAGICCIRCLE_BLUE_TW,false,.@gid;	// off
```

It has no effect on the fight, and it stays visible:

- everyone who can see the monster sees it at once (`clif_hat_effect_single`);
- everyone who walks up later sees it too, because the server sends a unit's
  hat effects with the unit itself (`clif_hat_effects` in
  `clif_getareachar_unit`);
- a monster can wear several at once. They end when it dies.

rAthena knows 292 of them. **About half draw nothing in this app**, because
the client has no picture for them. [All hat effects](#all-hat-effects), at the
end of this page, lists every one and says which. Some that do draw:

| Constant | From the item |
|---|---|
| `HAT_EF_MAGICCIRCLE`, `HAT_EF_MAGICCIRCLE_BLUE_TW`, `HAT_EF_MAGICCIRCLERAINBOW` | Costume Magic Circle, Magic Star Array, Costume Magic Circle Rainbow |
| `HAT_EF_GLOW_OF_NEW_YEAR`, `HAT_EF_MIDGARTS_GLORY` | Costume New Year Shine, Costume Rune-Midgarts Glory |
| `HAT_EF_C_POPPING_PORING_AURA` | Costume Popping Poring Aura |
| `HAT_EF_LJOSALFAR`, `HAT_EF_MANYSTARS`, `HAT_EF_STRANGELIGHTS` | Twinkle Effect, Costume Group of Stars, The Spirit Of World |
| `HAT_EF_C_GHOST_EFFECT`, `HAT_EF_GOLD_SHOWER` | Costume Ghost Effect, Costume Golden Shower |
| `HAT_EF_FLUTTER_BUTTERFLY`, `HAT_EF_FALLING_SNOW`, `HAT_EF_BLOSSOM_FLUTTERING` | Flutter Butterfly, Costume Falling Snow, Costume Dancing Fallen Sakura |

roBrowser reads the hat effect tables for packet versions from 2015-05-07 on,
which is every version the app offers. The pictures themselves come from the
player's own client data, so look at an effect before building on it: a test
NPC that runs `monster` and then `hateffect` on `$@mobid[0]` is three lines.
If nothing shows, **Settings → Tools → Log viewer** names the file the client
could not find.

`specialeffect`, the command for one-off effects, **cannot** do this: it plays
on an NPC, by name, never on a monster.

## Status colours that update at once

Some statuses tint or decorate whoever has them, and the server sends the
change to everyone nearby the moment it happens (`clif_changeoption`, which
the client handles as `ZC_STATE_CHANGE3`):

```
	sc_start SC_FREEZE,10000,0,10000,SCSTART_NOAVOID,.@gid;
```

| Status | Looks like | Does |
|---|---|---|
| `SC_FREEZE` | blue, standing still | cannot act; turns the monster Water 1 |
| `SC_STONE` | grey, standing still | cannot act; turns it Earth 1 |
| `SC_SLEEP` | "Zzz" above it | cannot act until hit |
| `SC_STUN` | stars above it | cannot act |
| `SC_POISON` | purple | loses HP; lower defence |
| `SC_CURSE` | dark red | slower; lower LUK and ATK |

These are real statuses: a frozen Poring cannot move. Bosses resist most of
them.

## Skill colours that only show on arrival

The self-buff skills tint the caster, and a few add an outline or after-images
(`EntityState.js`, `EntityRender.js`):

| Status | Looks like | Does |
|---|---|---|
| `SC_ENERGYCOAT` | blue-grey, with after-images | takes less damage, paid for in SP |
| `SC_ASSUMPTIO` | a white outline around the body | takes half damage |
| `SC_EXPLOSIONSPIRITS` | pink | more critical hits |
| `SC_OVERTHRUST` | pink, like Explosion Spirits | more ATK |
| `SC_BERSERK` | red | much stronger, loses HP |
| `SC_MARIONETTE` | pink, half transparent | stats moved to another unit |
| `SC_TWOHANDQUICKEN` | yellowish, with after-images | attacks faster |

Two things to know before using them on a monster:

1. **Players already looking at the monster do not see the change.** For a
   monster, these statuses reach the client in one place only: the packet that
   brings the monster into view. The packet the server sends when one starts
   or ends, `ZC_NPC_SHOWEFST_UPDATE` (`0x28a`), is registered in roBrowser and
   never handled. The status icon packet that would also carry it is not sent
   for monsters at all, because none of these statuses has `BlEffect:` in
   `db/re/status.yml`. A player standing there when `sc_start` runs sees the
   colour only after walking out of range and back. A player who arrives
   later sees it from the start, and still sees it after it has ended.
2. **They do what the skill does.** An Assumptio Poring takes half damage.

They show reliably on a monster that has the status from before anyone can
see it.

## Things that come and go

For a moment's attention rather than a lasting mark:

| Command | Shows |
|---|---|
| `emotion ET_SURPRISE,.@gid;` | an emote bubble over the monster |
| `unittalk .@gid,"Catch me!";` | a line of speech over it, also in chat |
| `showscript "Catch me!",.@gid;` | the same line over it, not in chat |

Each is seen by whoever is nearby when it is sent, and by nobody else. Sent
on a timer, they repeat for whoever is there at the time.

## Putting it together

A large Poring with a blue magic circle under it, somewhere on the map. It
gives five Jellopy on top of its normal drops to whoever kills it, and comes
back a minute after it dies:

```
// my-mod/npc/shiny-poring.txt
-	script	MyModShinyPoring	-1,{
OnInit:
	callsub S_Spawn;
	end;

OnDead:
	if (playerattached())
		getitem 909,5;		// Jellopy, on top of its normal drops
	detachrid;
	sleep 60000;
	callsub S_Spawn;
	end;

S_Spawn:
	monster "prt_fild08",0,0,"Shiny Poring",1002,1,strnpcinfo(3) + "::OnDead",Size_Large;
	hateffect HAT_EF_MAGICCIRCLE_BLUE_TW,true,$@mobid[0];
	return;
}
```

The fields in the header line are separated by **tabs**. The label runs with
the killer attached, which is why `getitem` reaches them; `playerattached()`
covers a monster killed by something that is not a player. Prefix the NPC's
name with your mod's, as with variables: two mods with a `ShinyPoring` NPC
collide.

## All hat effects

Every `HAT_EF_*` and `FOOTPRINT_EF_*` constant rAthena accepts, in the order of
its enum in `src/map/script.hpp`. The number is what the server sends.

- **Item** is every item in rAthena's item tables (both eras) whose script
  switches the effect on. A dash means no item uses it, and the effect is
  still there for scripts.
- **Client draws** is what the client shows for it, read from the player's
  own hat effect table (`luafiles514/lua files/hateffectinfo/hateffectinfo.lub`
  and `footprinteffectinfo.lub` in their GRF). The app serves no copy of its
  own: ROenglishRE's is older and replaces the client's list of effect names
  with a shorter one. A drawn effect is either an animation file under
  `data/texture/effect/`, which comes from the player's client data, or one
  of roBrowser's numbered effects (`EffectTable.js`). A footprint is drawn
  from `footprinteffectinfo.lub` as the wearer walks, and the column names the
  animation (STR) or image (PNG) it leaves on the ground. **Nothing** means the
  table has no entry for that number, the entry names a numbered effect that
  roBrowser has not implemented, or the effect is a kind of footprint
  roBrowser does not draw yet. In every case `hateffect` succeeds and nothing
  appears.
  The column is for an iRO client. iRO and kRO number every effect the same
  way, but each has entries the other lacks; where a kRO client draws
  something different, the row says so in brackets.

The list was generated from the rAthena and roBrowserLegacy commits in
`config/VENDOR_PINS`, an October 2026 iRO `data.grf` and a 2025-11-05 kRO
`data.grf`. A later pin or a newer client can add constants, and can turn a
"nothing" into a picture. `scripts/hat-effects-doc.py` regenerates the **Client
draws** column from the pins and the two GRFs: with `--iro` and `--kro` it lists
the rows that would change, and with `--write` as well it rewrites them.

| # | Constant | Item | Client draws |
|---|---|---|---|
| 1 | `HAT_EF_BLOSSOM_FLUTTERING` | Costume Dancing Fallen Sakura | `efst_blossom_fluttering/sakura.str` |
| 2 | `HAT_EF_MERMAID_LONGING` | — | `efst_mermaid_loging/bubblebubble.str` |
| 3 | `HAT_EF_RL_BANISHING_BUSTER` | — | `rl_banishing_buster/vanishing1.str` |
| 4 | `HAT_EF_LJOSALFAR` | Twinkle Effect | `efst_ljosalfar/ljosalfar.str` |
| 5 | `HAT_EF_CLOCKING` | — | `EF_CLOAKING` (effect 120) |
| 6 | `HAT_EF_SNOW` | — | `EF_SNOW` (effect 162) |
| 7 | `HAT_EF_MAKEBLUR` | — | `EF_MAKEBLUR` (effect 166) |
| 8 | `HAT_EF_SLEEPATTACK` | — | `EF_SLEEPATTACK` (effect 197) |
| 9 | `HAT_EF_GUMGANG` | — | `EF_GUMGANG` (effect 203) |
| 10 | `HAT_EF_TALK_FROSTJOKE` | — | `EF_TALK_FROSTJOKE` (effect 295) |
| 11 | `HAT_EF_DEMONSTRATION` | — | `EF_DEMONSTRATION` (effect 302) |
| 12 | `HAT_EF_FLUTTER_BUTTERFLY` | Costume Flutter Butterfly, Flutter Butterfly | `efst_Flutter_Butterfly/Flutter_Butterfly.str` |
| 13 | `HAT_EF_ANGEL_FLUTTERING` | Costume Fluttering Angel's Wing | `efst_Angel_Fluttering/Angel_Fluttering.str` |
| 14 | `HAT_EF_BLESSING_OF_ANGELS` | Costume Blessing of Angel | `efst_blessing_of_angels/tensi3.str` |
| 15 | `HAT_EF_ELECTRIC` | Electric Effect | `EF_STEELBODY` (effect 254) |
| 16 | `HAT_EF_GREEN_FLOOR` | Green Flare Effect | nothing: `EF_GREEN99_6` is not in roBrowser's effect table |
| 17 | `HAT_EF_SHRINK` | Shrink Effect | `EF_BABYBODY2` (effect 421) |
| 18 | `HAT_EF_VALHALLA_IDOL` | Valhalla Idol, Costume Valhalla Idol, Valhalla Effect Effect | `efst_valhalla_idol/odl2.str` |
| 19 | `HAT_EF_ANGEL_STAIRS` | — | `cloudh.str` |
| 20 | `HAT_EF_GLOW_OF_NEW_YEAR` | Costume New Year Shine | `efst_GlowOfNewYear/halo.str` |
| 21 | `HAT_EF_BOTTOM_FORTUNEKISS` | — | `EF_BOTTOM_FORTUNEKISS` (effect 293) |
| 22 | `HAT_EF_PINKBODY` | — | nothing: `EF_PINKBODY` is not in roBrowser's effect table |
| 23 | `HAT_EF_DOUBLEGUMGANG` | Costume Flaming Burst Wave(Garment), Crimson Wave Effect | nothing: `EF_DOUBLEGUMGANG` is not in roBrowser's effect table |
| 24 | `HAT_EF_GIANTBODY` | — | `EF_GIANTBODY2` (effect 423) |
| 25 | `HAT_EF_GREEN99_6` | — | nothing: `EF_GREEN99_6` is not in roBrowser's effect table |
| 26 | `HAT_EF_CIRCLEPOWER` | Blue Aura Effect | nothing: effect 1122 is not in roBrowser's effect table |
| 27 | `HAT_EF_BOTTOM_BLOODYLUST` | — | `EF_BOTTOM_BLOODYLUST` (effect 829) |
| 28 | `HAT_EF_WATER_BELOW` | — | nothing: `EF_WATER_BELOW` is not in roBrowser's effect table |
| 29 | `HAT_EF_LEVEL99_150` | — | `EF_LEVEL99_150` (effect 881) |
| 30 | `HAT_EF_YELLOWFLY3` | — | nothing: `EF_YELLOWFLY3` is not in roBrowser's effect table |
| 31 | `HAT_EF_KAGEMUSYA` | Shadow Effect | nothing: `EF_KAGEMUSYA` is not in roBrowser's effect table |
| 32 | `HAT_EF_CHERRYBLOSSOM` | Pink Glow Effect | nothing: `EF_CHERRYBLOSSOM` is not in roBrowser's effect table |
| 33 | `HAT_EF_STRANGELIGHTS` | The Spirit Of World, [Not For Sale] The Spirit Of World | `efst_STRANGELIGHTS/strangelights.str` |
| 34 | `HAT_EF_WL_TELEKINESIS_INTENSE` | — | `EF_WL_TELEKINESIS_INTENSE` (effect 1048) |
| 35 | `HAT_EF_AB_OFFERTORIUM_RING` | — | `EF_AB_OFFERTORIUM_RING` (effect 1057) |
| 36 | `HAT_EF_WHITEBODY2` | White Body Effect | nothing: `EF_WHITEBODY` is not in roBrowser's effect table |
| 37 | `HAT_EF_SAKURA` | — | `EF_SAKURA` (effect 163) |
| 38 | `HAT_EF_CLOUD2` | — | `EF_CLOUD2` (effect 230) |
| 39 | `HAT_EF_FEATHER_FLUTTERING` | Costume Fluttering Feathers | `efst_feather_fluttering/feath.str` |
| 40 | `HAT_EF_CAMELLIA_HAIR_PIN` | Camellia Hair Ornament, Costume Camellia Hair Pin | `efst_flowersmoke/flowersmoke.str` |
| 41 | `HAT_EF_JP_EV_EFFECT01` | — | `EF_BOTTOM_FORTUNEKISS` (effect 293) |
| 42 | `HAT_EF_JP_EV_EFFECT02` | — | `EF_BOTTOM_FORTUNEKISS` (effect 293) |
| 43 | `HAT_EF_JP_EV_EFFECT03` | — | `EF_BOTTOM_FORTUNEKISS` (effect 293) |
| 44 | `HAT_EF_FLORAL_WALTZ` | Costume Floral Waltz | `efst_Floral_Waltz/Floral_Waltz.str` |
| 45 | `HAT_EF_MAGICAL_FEATHER` | Magical Feather, Costume Magical Feather | `efst_magical_feather/magical_feather.str` |
| 46 | `HAT_EF_HAT_EFFECT` | — | nothing: `EF_HAT_EFFECT` is not in roBrowser's effect table |
| 47 | `HAT_EF_BAKURETSU_HADOU` | Costume Furious Wave, Costume Exploding Crimson Flame | `EF_BAKURETSU_HADOU` (effect 1130) |
| 48 | `HAT_EF_GOLD_SHOWER` | Costume Golden Shower, Costume Show Me The Zeny | `efst_Gold_Shower/coin2.str` |
| 49 | `HAT_EF_WHITEBODY` | — | nothing: effect 1131 is not in roBrowser's effect table |
| 50 | `HAT_EF_WATER_BELOW2` | — | nothing: `EF_WATER_BELOW` is not in roBrowser's effect table |
| 51 | `HAT_EF_FIREWORK` | — | `efst_firework/firework.str` |
| 52 | `HAT_EF_RETURN_TW_1ST_HAT` | — | `EFST_Return_TW_1st_Hat/tensi3.str` |
| 53 | `HAT_EF_C_FLUTTERBUTTERFLY_BL` | Costume Black Swallowtail Wings | `efst_FlutterButterfly_BL/Flutter_Butterfly.str` |
| 54 | `HAT_EF_QSCARABA` | Costume Queen Scaraba Helm | `EFST_Qscaraba/Qscaraba.str` |
| 55 | `HAT_EF_FSTONE` | — | `efst_fstone/stoneofint.str` |
| 56 | `HAT_EF_MAGICCIRCLE` | Costume Magic Circle | `efst_Magiccircle/mc.str` |
| 57 | `HAT_EF_BRYSINGGAMEN` | — | nothing: effect 1193 is not in roBrowser's effect table |
| 58 | `HAT_EF_MAGINGIORDE` | — | nothing: effect 1194 is not in roBrowser's effect table |
| 59 | `HAT_EF_LEVEL99_RED` | — | effect 1164 |
| 60 | `HAT_EF_LEVEL99_ULTRAMARINE` | — | effect 1165 |
| 61 | `HAT_EF_LEVEL99_CYAN` | — | effect 1166 |
| 62 | `HAT_EF_LEVEL99_LIME` | — | effect 1167 |
| 63 | `HAT_EF_LEVEL99_VIOLET` | — | effect 1168 |
| 64 | `HAT_EF_LEVEL99_LILAC` | — | effect 1169 |
| 65 | `HAT_EF_LEVEL99_SUN_ORANGE` | — | effect 1170 |
| 66 | `HAT_EF_LEVEL99_DEEP_PINK` | — | effect 1171 |
| 67 | `HAT_EF_LEVEL99_BLACK` | — | effect 1172 |
| 68 | `HAT_EF_LEVEL99_WHITE` | — | effect 1173 |
| 69 | `HAT_EF_LEVEL160_RED` | — | effect 1174 |
| 70 | `HAT_EF_LEVEL160_ULTRAMARINE` | — | effect 1175 |
| 71 | `HAT_EF_LEVEL160_CYAN` | — | effect 1176 |
| 72 | `HAT_EF_LEVEL160_LIME` | — | effect 1177 |
| 73 | `HAT_EF_LEVEL160_VIOLET` | — | effect 1178 |
| 74 | `HAT_EF_LEVEL160_LILAC` | — | effect 1179 |
| 75 | `HAT_EF_LEVEL160_SUN_ORANGE` | — | effect 1180 |
| 76 | `HAT_EF_LEVEL160_DEEP_PINK` | — | effect 1181 |
| 77 | `HAT_EF_LEVEL160_BLACK` | — | effect 1182 |
| 78 | `HAT_EF_LEVEL160_WHITE` | — | effect 1183 |
| 79 | `HAT_EF_FULL_BLOOMCHERRY_TREE` | Costume Full Bloom Cherry Tree, Rental Costume Full Bloom Cherry Tree, Costume Cookie Party | `efst_Full_BloomCherry_Tree/Full_BloomCherry_Tree.str` |
| 80 | `HAT_EF_C_BLESSINGS_OF_SOUL` | Costume Blessings Of Soul | `efst_C_Blessings_Of_Soul/blessingsofsoul.str` |
| 81 | `HAT_EF_MANYSTARS` | Costume Group of Stars | `efst_ManyStars/hikariga.str` |
| 82 | `HAT_EF_SUBJECT_AURA_GOLD` | — | effect 1211 |
| 83 | `HAT_EF_SUBJECT_AURA_WHITE` | — | effect 1212 |
| 84 | `HAT_EF_SUBJECT_AURA_RED` | — | effect 1213 |
| 85 | `HAT_EF_C_SHINING_ANGEL_WING` | Costume Shining Angel Wings | `efst_C_Shining_Angel_Wing/C_Shining_Angel_Wing.str` |
| 86 | `HAT_EF_MAGIC_STAR_TW` | Costume Illusion Crystal | `efst_Mstone/stoneofint2.str` |
| 87 | `HAT_EF_DIGITAL_SPACE` | Costume Digital Space | `EF_DIGITAL_SPACE` (effect 1240) |
| 88 | `HAT_EF_SLEIPNIR` | — | nothing: effect 1241 is not in roBrowser's effect table |
| 89 | `HAT_EF_C_MAPLE_WHICH_FALLS_RD` | Costume Falling Red Foliage, Costume Fallen Leaves Falling (Red) | `efst_C_Maple_Which_Falls_Rd/C_Maple_Which_Falls_Rd.str` |
| 90 | `HAT_EF_MAGICCIRCLERAINBOW` | Costume Magic Circle Rainbow | `efst_MagiccircleRainbow/mcr.str` |
| 91 | `HAT_EF_SNOWFLAKE_TIARA` | Costume Snow Flower | `efst_SnowFlake_Tiara/nnnaaa.str` |
| 92 | `HAT_EF_MIDGARTS_GLORY` | Costume Rune-Midgarts Glory | `efst_Midgarts_Glory/halo_2.str` |
| 93 | `HAT_EF_LEVEL99_TIGER` | — | effect 1291 |
| 94 | `HAT_EF_LEVEL160_TIGER` | — | effect 1292 |
| 95 | `HAT_EF_FLUFFYWING` | Costume: Wing of Harmony, Costume Urd Wings | `efst_FluffyWing/ypen.str` |
| 96 | `HAT_EF_C_GHOST_EFFECT` | Costume Ghost Effect, Ghost Effect | `efst_C_Ghost_Effect/C_Ghost_Effect.str` |
| 97 | `HAT_EF_C_POPPING_PORING_AURA` | Costume Popping Poring Aura | `efst_C_Popping_Poring_Aura/C_Popping_Poring_Aura.str` |
| 98 | `HAT_EF_RESONATETAEGO` | Ancient Resonance, Costume Ancient Resonance, Rumble Effect | `efst_ResonateTaego/youmei.str` |
| 99 | `HAT_EF_99LV_RUNE_RED` | — | effect 1325 |
| 100 | `HAT_EF_99LV_ROYAL_GUARD_BLUE` | — | effect 1326 |
| 101 | `HAT_EF_99LV_WARLOCK_VIOLET` | — | effect 1327 |
| 102 | `HAT_EF_99LV_SORCERER_LBLUE` | — | effect 1328 |
| 103 | `HAT_EF_99LV_RANGER_GREEN` | — | effect 1329 |
| 104 | `HAT_EF_99LV_MINSTREL_PINK` | — | effect 1330 |
| 105 | `HAT_EF_99LV_ARCHBISHOP_WHITE` | — | effect 1331 |
| 106 | `HAT_EF_99LV_GUILL_SILVER` | — | effect 1332 |
| 107 | `HAT_EF_99LV_SHADOWC_BLACK` | — | effect 1333 |
| 108 | `HAT_EF_99LV_MECHANIC_GOLD` | — | effect 1334 |
| 109 | `HAT_EF_99LV_GENETIC_YGREEN` | — | effect 1335 |
| 110 | `HAT_EF_160LV_RUNE_RED` | Costume Red Aura | effect 1336 |
| 111 | `HAT_EF_160LV_ROYAL_G_BLUE` | — | effect 1337 |
| 112 | `HAT_EF_160LV_WARLOCK_VIOLET` | — | effect 1338 |
| 113 | `HAT_EF_160LV_SORCERER_LBLUE` | — | effect 1339 |
| 114 | `HAT_EF_160LV_RANGER_GREEN` | — | effect 1340 |
| 115 | `HAT_EF_160LV_MINSTREL_PINK` | — | effect 1341 |
| 116 | `HAT_EF_160LV_ARCHB_WHITE` | — | effect 1342 |
| 117 | `HAT_EF_160LV_GUILL_SILVER` | — | effect 1343 |
| 118 | `HAT_EF_160LV_SHADOWC_BLACK` | — | effect 1344 |
| 119 | `HAT_EF_160LV_MECHANIC_GOLD` | Costume Gold Aura | effect 1345 |
| 120 | `HAT_EF_160LV_GENETIC_YGREEN` | — | effect 1346 |
| 121 | `HAT_EF_WATER_BELOW3` | — | `efst_Waterfield/waterfield2.str` |
| 122 | `HAT_EF_WATER_BELOW4` | Water Field Effect | `efst_Waterfield2/waterfield3.str` |
| 123 | `HAT_EF_C_VALKYRIE_WING` | Costume Valkyrie Wings | effect 1377 |
| 124 | `HAT_EF_2019RTC_CELEAURA_TW` | — | `efst_2019RTC_CeleAura_TW/poporingb.str` |
| 125 | `HAT_EF_2019RTC1ST_TW` | — | `efst_2019RTC1ST_TW/kporingbg.str` |
| 126 | `HAT_EF_2019RTC2ST_TW` | — | `efst_2019RTC2ST_TW/angelpo.str` |
| 127 | `HAT_EF_2019RTC3ST_TW` | — | `efst_2019RTC3ST_TW/dringbg.str` |
| 128 | `HAT_EF_CONS_OF_WIND` | — | effect 1531 |
| 129 | `HAT_EF_MAPLE_FALLS` | — | `efst_maple_falls/maple_falls.str` |
| 130 | `HAT_EF_BJ_HEADSETB` | Costume OnAir BJ Headset | `BJ_HeadsetB/rhythmageruyo.str` |
| 131 | `HAT_EF_VIP_HAIR` | Costume: Blue Devil Wig, Costume: Red Lotus Demon Wig | `efst_VIP_Hair/rainbow_2.str` |
| 132 | `HAT_EF_C_MAGIC_HEIR_TW` | — | `efst_C_Magic_Heir_TW/moonstar2.str` |
| 133 | `HAT_EF_C_SUDDEN_WEALTH_TW` | Costume Sudden Wealth | `efst_C_Sudden_Wealth_TW/wonbo.str` |
| 134 | `HAT_EF_C_ROMANCE_ROSE_TW` | Costume Romantic Rose, Costume Pretty Rose | `efst_C_Romance_Rose_TW/losttime.str` |
| 135 | `HAT_EF_C_DISAPEAR_TIME_TW` | Costume Lost Time | `efst_C_Disapear_Time_TW/cdhs.str` |
| 136 | `HAT_EF_2020RTC_01` | 2020RTC Gold Naughty Ghost | `2020RTC_01/mcgold.str` |
| 137 | `HAT_EF_2020RTC_02` | 2020RTC Silver Naughty Ghost | `2020RTC_02/mcblack.str` |
| 138 | `HAT_EF_2020RTC_03` | 2020RTC Bronze Naughty Ghost | `2020RTC_03/mcred.str` |
| 139 | `HAT_EF_C_2020RTC_IMP_TW` | — | `C_2020RTC_Imp_TW/mc.str` |
| 140 | `HAT_EF_SUBJECT_AURA_BLACK` | — | effect 2281 |
| 141 | `HAT_EF_2020RTC_EFFECT_01` | — | effect 2281 |
| 142 | `HAT_EF_2020RTC_EFFECT_02` | — | effect 2281 |
| 143 | `HAT_EF_2020RTC_EFFECT_03` | — | effect 2281 |
| 144 | `HAT_EF_99LV_STAR_E_MBLUE` | Costume Midnight Blue Energy | effect 2281 |
| 145 | `HAT_EF_160LV_STAR_E_MBLUE` | Costume Midnight Blue Aura | effect 2282 |
| 146 | `HAT_EF_99LV_SOUL_R_GRAY` | Costume Gray Energy | effect 2283 |
| 147 | `HAT_EF_160LV_SOUL_R_GRAY` | Costume Gray Aura | effect 2284 |
| 148 | `HAT_EF_GEARWHEEL` | Costume Rotating Gears | `C_Rotating_Gears/gearwheel.str` |
| 149 | `HAT_EF_GIFT_OF_SNOW` | Costume Gift of Snow | `efst_gift_of_snow/gift_of_snow.str` |
| 150 | `HAT_EF_SNOW_POWDER` | Costume Snow Powder | `efst_Snow_Powder/ssnnnn2.str` |
| 151 | `HAT_EF_FALLING_SNOW` | Costume Falling Snow | `efst_Falling_Snow/Falling_Snow.str` |
| 152 | `HAT_EF_C_PHIGASIA_SCARF_EXE` | — | `efst_C_Phigasia_Scarf_EXE/singa.str` |
| 153 | `HAT_EF_C_KYEL_HYRE_ULTI_TW` | — | `EFST_Kyel_hyre_Ulti_TW/tentaKaiser.str` |
| 154 | `HAT_EF_C_MASTER` | Costume Master | `efst_C_Master/13123123.str` |
| 155 | `HAT_EF_C_TIME_ACCESSORY` | — | `efst_time_accessory/time_accessory.str` |
| 156 | `HAT_EF_C_HELM_OF_RA` | — | `C_Helm_Of_Ra/HelmOfSun3.str` |
| 157 | `HAT_EF_C_2021RTC_HEADSET_TW` | — | `C_2021RTC_Headset_TW/hd.str` |
| 158 | `HAT_EF_C_MOONSTAR_ACCESSORY` | — | `moonstar.str` |
| 159 | `HAT_EF_BLACK_THUNDER` | Costume Black Thunder, Eye of the Storm, [Not For Sale] Eye of the Storm | effect 2346 |
| 160 | `HAT_EF_BLACK_THUNDER_DARK` | — | effect 2347 |
| 161 | `HAT_EF_C_RELEASED_GROUND` | — | `C_Released_Ground/ki.str` |
| 162 | `HAT_EF_C_SAMBA_CARNIVAL` | Costume Samba Carnival | `efst_C_Samba_Carnival/twinklestar.str` |
| 163 | `HAT_EF_POISON_MASTER` | Costume Cons of Poison | effect 2310 |
| 164 | `HAT_EF_C_SWIRLING_FLAME` | — | `C_Swirling_Flame/vortexf2.str` |
| 165 | `HAT_EF_C_2021RTC_HEADSET_1_TW` | — | `C_2021RTC_Headset_1_TW/hd.str` |
| 166 | `HAT_EF_C_2021RTC_HEADSET_2_TW` | — | `C_2021RTC_Headset_2_TW/hd.str` |
| 167 | `HAT_EF_C_2021RTC_HEADSET_3_TW` | — | `C_2021RTC_Headset_3_TW/hd.str` |
| 168 | `HAT_EF_SUBJECT_AURA_WHITE_ALPHA` | — | nothing: effect 2370 is not in roBrowser's effect table |
| 169 | `HAT_EF_GC_DARKCROW` | — | nothing: effect 1184 is not in roBrowser's effect table |
| 170 | `HAT_EF_DIABOLUS_RING` | — | nothing: effect 2309 is not in roBrowser's effect table |
| 171 | `HAT_EF_MAGICCIRCLE_BLUE_TW` | Magic Star Array | `efst_magiccircle_Blue_TW/bluemc.str` |
| 172 | `HAT_EF_C_DISAPEAR_TIME_TW_2` | — | `efst_C_Disapear_Time_TW/cdhs.str` |
| 173 | `HAT_EF_C_MELODY_WING` | Costume Melody Wings | `C_Melody_Wing/notetama.str` |
| 174 | `HAT_EF_C_SPOT_LIGHT` | Costume Spotlight | `C_Spot_Light/Spotlight.str` |
| 175 | `HAT_EF_C_ASTRA_BLESSING` | — | `efst_C_Astra_Blessing/astra.str` |
| 176 | `HAT_EF_EFST_C_20TH_ANNIVERSARY_HAT` | Costume 20th Anniversary Hat | `efst_C_20th_Anniversary_Hat/20th_f.str` |
| 177 | `HAT_EF_SUBJECT_AURA_NAVY` | — | nothing: effect 2301 is not in roBrowser's effect table |
| 178 | `HAT_EF_20TH_SCARF_J` | Costume Memorial Claus | `efst_20th_Scarf_J/singa.str` |
| 179 | `HAT_EF_GHOST_FIRE` | — | `Efst_Ghost_Fire/strangelights2.str` |
| 180 | `HAT_EF_SERPENT_SHADOW` | Costume Serpentine Vision | effect 2394 |
| 181 | `HAT_EF_C_1ST_EVT_HAT_MSP` | Costume GGH 1st Anniversary Hat | `efst_C_1st_Evt_Hat_MSP/firework.str` |
| 182 | `HAT_EF_C_1ST_EVT_BALLOON_MSP` | Costume GGH 1st Anniversary Balloons | `efst_C_1st_Evt_Balloon_MSP/ggh1st.str` |
| 183 | `HAT_EF_RABBIT_AURA` | — | `efst_rabbit_aura/toto.str` |
| 184 | `HAT_EF_ALICE_TEA` | — | `efst_alice_tea/Alice02.str` |
| 185 | `HAT_EF_C_DARK_LORD_CLOAK` | Costume Dark Lord Cloak | `efst_C_Dark_Lord_Cloak/darklordcloak.str` |
| 186 | `HAT_EF_C_SAKURA_FUBUKI` | Costume Sakura Falling | `efst_c_sakura_fubuki/sakura_fubuki.str` |
| 187 | `HAT_EF_C_DARK_LORD_MANTEAU` | Costume Dark Lord Manteau | `C_Dark_Lord_Manteau/darklordcloak02.str` |
| 188 | `HAT_EF_DECORATION_OF_MUSIC` | — | `efst_decoration_of_music/note_1.str` |
| 189 | `HAT_EF_2023RTC_S_ROBE1` | — | `2023RTC_S_Robe1/gold1.str` |
| 190 | `HAT_EF_2023RTC_S_ROBE2` | — | `2023RTC_S_Robe2/Silverlightning.str` |
| 191 | `HAT_EF_2023RTC_S_ROBE3` | — | `2023RTC_S_Robe3/bronz.str` |
| 192 | `HAT_EF_C_CONSECRATE_F_AUREOLA` | Costume Sacred Religious Decoration | `efst_C_Consecrate_F_Aureola/ConsecrateAureola.str` |
| 193 | `HAT_EF_C_BULB_WREATH` | Costume Neon Poring Circlet | `efst_C_Bulb_Wreath/TFireworks.str` |
| 194 | `HAT_EF_MD_HOL_BARRIER1` | — | `efst_MD_Hol_Barrier/1mon.str` |
| 195 | `HAT_EF_MD_HOL_BARRIER2` | — | `efst_MD_Hol_Barrier/2mon.str` |
| 196 | `HAT_EF_MD_HOL_BARRIER3` | — | `efst_MD_Hol_Barrier/3mon.str` |
| 197 | `HAT_EF_MD_HOL_BARRIER4` | — | `efst_MD_Hol_Barrier/4mon.str` |
| 198 | `HAT_EF_MD_HOL_BARRIER5` | — | `efst_MD_Hol_Barrier/5mon.str` |
| 199 | `HAT_EF_MD_HOL_BARRIER6` | — | `efst_MD_Hol_Barrier/6mon.str` |
| 200 | `HAT_EF_MD_HOL_BARRIER7` | — | `efst_MD_Hol_Barrier/7mon.str` |
| 201 | `HAT_EF_MD_HOL_BARRIER8` | — | `efst_MD_Hol_Barrier/8mon.str` |
| 202 | `HAT_EF_MD_HOL_BARRIER9` | — | `efst_MD_Hol_Barrier/9mon.str` |
| 203 | `HAT_EF_MD_HOL_BARRIER10` | — | `efst_MD_Hol_Barrier/10mon.str` |
| 204 | `HAT_EF_MD_HOL_BARRIER11` | — | `efst_MD_Hol_Barrier/11mon.str` |
| 205 | `HAT_EF_MD_HOL_BARRIER12` | — | `efst_MD_Hol_Barrier/12mon.str` |
| 206 | `HAT_EF_MD_HOL_BARRIER13` | — | `efst_MD_Hol_Barrier/13mon.str` |
| 207 | `HAT_EF_MD_HOL_BARRIER14` | — | `efst_MD_Hol_Barrier/14mon.str` |
| 208 | `HAT_EF_MD_HOL_BARRIER15` | — | `efst_MD_Hol_Barrier/15mon.str` |
| 209 | `HAT_EF_MD_HOL_BARRIER16` | — | `efst_MD_Hol_Barrier/16mon.str` |
| 210 | `HAT_EF_MD_HOL_BARRIER17` | — | `efst_MD_Hol_Barrier/17mon.str` |
| 211 | `HAT_EF_MD_HOL_BARRIER18` | — | `efst_MD_Hol_Barrier/18mon.str` |
| 212 | `HAT_EF_MD_HOL_BARRIER19` | — | `efst_MD_Hol_Barrier/19mon.str` |
| 213 | `HAT_EF_MD_HOL_BARRIER20` | — | `efst_MD_Hol_Barrier/20mon.str` |
| 214 | `HAT_EF_C_FLUTTERING_HAZE` | Costume Fluttering Haze | `efst_C_Fluttering_Haze/skaura33.str` |
| 215 | `HAT_EF_EFST_CINNAMON` | — | `efst_cinnamon/san.str` |
| 216 | `HAT_EF_AUTUMN_FULL_MOON` | Costume Autumn Fullmoon, Costume Autumn Full Moon | `efst_Autumn_Full_Moon/han.str` |
| 217 | `HAT_EF_NIFLHEIM_NIGHT_SKY` | — | `efst_Niflheim_Night_Sky/halloween.str` |
| 218 | `HAT_EF_C_ROS2023_CAPE_1` | Costume Star Champion's Manteau | `efst_C_ROS2023_Cape_1/ros2023_1st.str` |
| 219 | `HAT_EF_BLACK_THUNDER_` | — | `efst_black_thunder/ros2023_f.str` |
| 220 | `HAT_EF_C_ROS2023_CAPE_2` | 2023 ROS Winning Prize Manteau | `efst_C_ROS2023_Cape_2/ros2023_2nd.str` |
| 221 | `HAT_EF_C_15TH_NOV_HELMET` | Costume 15th Nov Helmet | `efst_C_15th_Nov_Helmet/tai.str` |
| 222 | `HAT_EF_COSMIC_CONNECTION` | Costume Cosmic Connection (Garment), Cosmic Connection, Costume Cosmic Connection | `efst_Cosmic_Connection/strbright.str` |
| 223 | `HAT_EF_C_BABY_GLOOM` | Costume Baby Gloom Under Night | `efst_C_Baby_Gloom/gloom.str` |
| 224 | `HAT_EF_WINTERNIGHTBELLS` | Costume Winter Night Bells | `efst_WinterNightBells/christmasx4.str` |
| 225 | `HAT_EF_NIGHTSKYOFRUTIE` | Costume Night Sky of Lutie | `efst_NightSkyOfRutie/christmasx3.str` |
| 226 | `FOOTPRINT_EF_BASE` | Footprint Effect | a PNG footprint, `footprint0.png` |
| 227 | `FOOTPRINT_EF_STR_BASE` | Whirlwind Footprint | a STR footprint, `footprint/bottom_crack.str` |
| 228 | `FOOTPRINT_EF_PURPLESTAR` | Purple Star Footprint | a STR footprint, `footprint_purplestar/footprint_bottom_purplestar/footprint_bottom_purple.str` |
| 229 | `FOOTPRINT_EF_YELLOWSTAR` | Yellow Star Footprint | a STR footprint, `footprint_yellowstar/footprint_bottom_yellowstar/footprint_bottom_yellow.str` |
| 230 | `FOOTPRINT_EF_REDSTAR` | Red Star Footprint | a STR footprint, `footprint_redstar/footprint_bottom_redstar/footprint_bottom_red.str` |
| 231 | `HAT_EF_RAINBOW_POISON_MASTER` | Charm of Anywhere | effect 2413 |
| 232 | `HAT_EF_C_ANCIENT_RUNE` | Costume Ancient Runes | `efst_C_Ancient_Rune/sangorunic1.str` |
| 233 | `HAT_EF_C_DRAGON_GREEN_AURA` | Costume Green Aura Dragon | `efst_C_Dragon_Green_Aura/gryoumei.str` |
| 234 | `HAT_EF_C_DRAGON_RED_AURA` | Costume Red Aura Dragon | `efst_C_Dragon_Red_Aura/redyoumei.str` |
| 235 | `HAT_EF_C_DRAGON_YELLOW_AURA` | Costume Yellow Aura Dragon | `efst_C_Dragon_Yellow_Aura/redyoumei2.str` |
| 236 | `HAT_EF_INTERDIMENSIONAL_RIFT` | Interdimensional Rift, Costume Interdimensional Rift, Costume Interdimensional Rift (Garment) | `efst_Interdimensional_Rift/Blackhole.str` |
| 237 | `HAT_EF_C_CLB_SS_LL` | Costume Shiba Says Luke | `efst_C_CLB_SS_LL/bbcat.str` |
| 238 | `HAT_EF_VACATION` | Costume Summer Beach | `efst_Vacation/vacation.str` |
| 239 | `HAT_EF_C_FH_LOSTWING` | Costume Fallen Heaven Lost Wing | `efst_C_FH_Lostwing/fhlostwing.str` |
| 240 | `FOOTPRINT_EF_DOGFOOT` | Puppy Footprint | a STR footprint, `footprint_DogFoot/footprint_bottom_DogFoot/footprint_shibasays.str` |
| 241 | `HAT_EF_C_AUSPICLOUD` | Costume Auspicious Clouds | `C_Auspicloud/sucloud.str` |
| 242 | `HAT_EF_AURA_OF_GHOST_S` | Costume Aura of Ghost Ship | effect 2424 |
| 243 | `HAT_EF_C_ROS2024_WING_1` | 2024 ROS Winner Wing | `efst_C_ROS2024_Wing_1/2024win.str` |
| 244 | `FOOTPRINT_EF_DUMPLING` | Dumpling Footprint | a STR footprint, `footprint_dumpling/footprint_bottom_dumpling/footprint_dumpling_bottom.str` |
| 245 | `FOOTPRINT_EF_PANDA_BASIC` | Panda Basic Footprint | a STR footprint, `footprint_panda/footprint_panda_bottom_basic/footprint_bottom_panda_basic.str` |
| 246 | `FOOTPRINT_EF_PANDA_COLOR` | Panda Color Footprint | a STR footprint, `footprint_panda/footprint_panda_bottom_color/footprint_panda_bottom_color.str` |
| 247 | `HAT_EF_ATQUE_POENITENTIA` | Costume Atokwe Poenitentia | effect 2428 |
| 248 | `HAT_EF_PERM_FROST_OBLIVION` | Costume Permafrost Oblivion | effect 2429 |
| 249 | `HAT_EF_ATQUE_POENITENTIA2` | — | nothing: no entry in the client's table (kRO: `efst_Atque_Poenitentia2/caeffect.str`) |
| 250 | `HAT_EF_GUIDE_OF_DEAD_TEXT` | Costume Guide's Letter | effect 2430 |
| 251 | `HAT_EF_MEDJED_TEXT` | Costume Guardian's Letter | effect 2431 |
| 252 | `HAT_EF_INKPAINTING_DAY` | Costume Ink Painting (Daytime) | `efst_InkPainting_Day/bushinkpaint1.str` |
| 253 | `HAT_EF_INKPAINTING_NIGHT` | Costume Ink Painting (Night) | `efst_InkPainting_Night/bushinkpaint2.str` |
| 254 | `HAT_EF_KUNG_FU_PANDA` | — | `efst_Kung_Fu_Panda/redyoumei2.str` |
| 255 | `HAT_EF_C_MGSGPH_POTARL` | — | `efst_c_mysgph_portal/potal.str` |
| 256 | `HAT_EF_C_IGUAZU_FALLS` | — | nothing: no entry in the client's table (kRO: `efst_C_Iguazu_Falls/Waterfall.str`) |
| 257 | `FOOTPRINT_EF_BLOSSOM` | — | a STR footprint, `footprint_blossom/footprint_blossom_bottom/footprint_blossom_bottom.str` |
| 258 | `FOOTPRINT_EF_BUD` | — | nothing: no entry in the client's table (kRO: a STR footprint, `footprint_bud/footprint_bud/footprint_bud.str`) |
| 259 | `FOOTPRINT_EF_BUTTERFLY_BLUE` | Blue Butterfly Footprint | nothing: no entry in the client's table (kRO: a STR footprint, `footprint_butterfly/footprint_butterfly_blue/footprint_butterfly_blue.str`) |
| 260 | `FOOTPRINT_EF_BUTTERFLY_PURPLE` | Purple Butterfly Footprints | a STR footprint, `footprint_butterfly/footprint_butterfly_purple/footprint_butterfly_purple.str` |
| 261 | `FOOTPRINT_EF_BUTTERFLY_YELLOW` | Yellow Butterfly Footprints | a STR footprint, `footprint_butterfly/footprint_butterfly_yellow/footprint_butterfly_yellow.str` |
| 262 | `HAT_EF_HANMAC_MUNCH` | Costume Successful Munch | nothing: no entry in the client's table (kRO: `efst_hanmac_munch/munch.str`) |
| 263 | `FOOTPRINT_EF_VICTORY2025` | ROS 2025 Footprint | nothing: no entry in the client's table (kRO: a STR footprint, `footprint_victory2025/footprint_victory2025_bottom/footprint_victory_bottom.str`) |
| 264 | `FOOTPRINT_EF_DRAGON_FACE_2D` | Footprint (2D) | a STR footprint, `footprint_dragon_face_2d/footprint_dragon_face_2d_bottom/fp_dragon_face_basic_bottom_pink.str` |
| 265 | `FOOTPRINT_EF_DRAGON_FACE_3D` | Footprint (3D) | a STR footprint, `footprint_dragon_face_3d/footprint_dragon_face_3d_bottom/fp_dragon_face_3d_bottom.str` |
| 266 | `HAT_EF_C_OVER_CLOUD` | Costume Over the Clouds | `efst_C_Over_Cloud/drgbgeffect.str` |
| 267 | `HAT_EF_C_AURORA_ON_CLOUDS` | Costume Aurora on Clouds | `efst_C_Aurora_On_Clouds/drgauroraeffect.str` |
| 268 | `HAT_EF_ROS_REDSPIRIT` | — | nothing: no entry in the client's table (kRO: `efst_ROS_RedSpirit/kiaura1.str`) |
| 269 | `HAT_EF_ROS_BLUESPIRIT` | — | nothing: no entry in the client's table (kRO: `efst_ROS_BlueSpirit/kiaura2.str`) |
| 270 | `HAT_EF_DIVINE_SKY_INVITE` | Costume Divine Invitation | `efst_Divine_Sky_Invite/Midgard2.str` |
| 271 | `FOOTPRINT_EF_DIVINE` | Divine Light Footprints | a STR footprint, `footprint_divine/footprint_divine_bottom/footprint_divine_bottom.str` |
| 272 | `FOOTPRINT_EF_NYAR_BLUE` | Nyar's Blue Footprints | a STR footprint, `footprint_nyar_blue/footprint_nyar_blue_bottom/footprint_nyar_blue_bottom.str` |
| 273 | `FOOTPRINT_EF_NYAR_PURPLE` | Nyar's Purple Footprints | a STR footprint, `footprint_nyar_purple/footprint_nyar_purple_bottom/footprint_nyar_purple_bottom.str` |
| 274 | `HAT_EF_C_NIGHTMARE_CHAIN` | Costume Nightmare Chain | `efst_C_Nightmare_Chain/rrrooo2.str` |
| 275 | `HAT_EF_C_SPOT_MIKE` | Costume Idol Standing Mic | `C_Spot_Mike/Spotlight2.str` |
| 276 | `HAT_EF_C_SPOT_FLOWER` | Costume Idol's Flower Stage | nothing: no entry in the client's table (kRO: `C_Spot_Flower/Spotlight1.str`) |
| 277 | `HAT_EF_C_2025ROSFESTA` | Costume ROS 2025 Champion Coat | nothing: no entry in the client's table (kRO: nothing: effect 2443 is not in roBrowser's effect table) |
| 278 | `HAT_EF_GOLDEN_AURA_TW` | — | nothing: no entry in the client's table (kRO: `efst_Golden_Aura_TW/fhlostwing2.str`) |
| 279 | `HAT_EF_C_S_BEELZEBUB_WING` | — | effect 2458 |
| 280 | `FOOTPRINT_EF_FEATHER` | Costume Celestial Integrity | a STR footprint, `footprint_feather/footprint_feather/footprint_feather.str` |
| 281 | `HAT_EF_SOLID_STATE_RECOGNITION` | — | nothing: no entry in the client's table (kRO: `Solid_State_Recognition/mdenv.str`) |
| 282 | `HAT_EF_C_CURSED_SERPENT` | Costume Cursed Serpent | `efst_C_Cursed_Serpent/encro.str` |
| 283 | `FOOTPRINT_EF_BASIC` | — | nothing: no entry in the client's table |
| 284 | `HAT_EF_C_GGH_ANNIVERSARY` | — | nothing: no entry in the client's table |
| 285 | `FOOTPRINT_EF_DIVINE_BLUE` | Sacred Blue Light Footprints | a STR footprint, `footprint_divine_blue/footprint_divine_blue_bottom/footprint_divine_blue_bottom.str` (kRO: nothing: no entry in the client's table) |
| 286 | `FOOTPRINT_EF_BLUESTAR` | Blue Star Footprints | a STR footprint, `footprint_bluestar/footprint_bottom_bluestar/footprint_bottom_blue.str` (kRO: nothing: no entry in the client's table) |
| 287 | `FOOTPRINT_EF_PHOENIX` | Phoenix Operation Footprints | a STR footprint, `footprint_phoenix/footprint_bottom_phoenix/footprint_bottom_phoenix.str` (kRO: nothing: no entry in the client's table) |
| 288 | `HAT_EF_C_CLB_GAT_DOC` | Costume Emergency Communication | `efst_C_CLB_GAT_doc/Gatchamanvi.str` (kRO: nothing: no entry in the client's table) |
| 289 | `HAT_EF_C_EYE_OF_NECROMANCER` | Costume Eye of Necromancer | nothing: no entry in the client's table |
| 290 | `HAT_EF_C_JAOW_PIRUN` | Costume Jaow Pirun Sra Yok | nothing: no entry in the client's table |
| 291 | `FOOTPRINT_EF_FLOWER_GARDEN` | Flower Garden | a STR footprint, `footprint_flower_garden/footprint_flower_garden_left/footprint_flower_garden_left.str` (kRO: nothing: no entry in the client's table) |
| 292 | `HAT_EF_C_ANGEL_GIFT` | Costume Angel's Gift | `efst_C_Angel_Gift/hikariri.str` (kRO: nothing: no entry in the client's table) |
