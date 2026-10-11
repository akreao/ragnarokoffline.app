# Custom quests

A quest that lives in the game's own quest log: it shows in the quest window
(**Alt+U**), its kill counter goes up as the player hunts, the counter is saved
on the character, and an icon over the NPC tells the player there is something
to pick up. All of it comes from a mod folder, with no server rebuild. This
page covers what such a quest is made of, what it can and cannot track, and the
traps between the three files involved. [Making mods](../MODDING.md) is the
reference for the rest of the mod format.

The simpler kind of quest — an NPC, a menu and a character variable — needs
none of this and is in
[`examples/mods/quest-npc`](../../examples/mods/quest-npc). Use the quest log
when the player should be able to *see* the quest outside the conversation, or
when the server should count kills for you.

## What goes in the mod

```
my-quests/
  mod.json
  db/
    quest_db.yml                    the quest: its id, title, kill targets, time limit, drops
  npc/
    my-quests.txt                   who gives it, checks it and pays for it
  System/
    OngoingQuestInfoList.lub        what the quest window says about it
```

Each file has a job the others cannot do:

| | read by | decides |
|---|---|---|
| `db/quest_db.yml` | the map server, at start | that the quest **exists**, what kills count for it and how many, when it expires, what extra drops it gives |
| `npc/*.txt` | the map server, at start | when a character gets it, finishes it, loses it, and the reward — rAthena gives nothing by itself |
| `System/OngoingQuestInfoList.lub` | the game client, at load | the title, summary, description, icon and *displayed* reward in the quest window — nothing else |

They are joined by one number, the **quest id**. It must be the same in all
three.

## A hunting quest, end to end

Kill ten Porings for Hunter Mira in Prontera, collect five Red Potions and some
experience. Quest id `105001` (see [Quest ids](#quest-ids) for why).

### db/quest_db.yml

```yaml
Header:
  Type: QUEST_DB
  Version: 3

Body:
  - Id: 105001
    Title: Mira's Poring Problem
    Targets:
      - Mob: PORING
        Count: 10
```

`Mob` is the monster's **AegisName**, the `AegisName:` in `mob_db.yml`
(`PORING`, not `Poring`, not `1002`). A monster your mod adds in its own
`db/mob_db.yml` works too: monsters are loaded before quests.

### npc/my-quests.txt

```
prontera,155,185,4	script	Hunter Mira#myq	4_F_KAFRA1,{
	mes "[Hunter Mira]";
	switch (checkquest(105001)) {
	case -1:	// never taken
		mes "The Porings outside the south gate are eating my garden.";
		mes "Ten of them would teach the rest a lesson.";
		next;
		if (select("I'll do it:Not now") == 2)
			close;
		setquest 105001;
		mes "[Hunter Mira]";
		mes "Thank you! Your quest log will keep count.";
		close;

	case 0:		// taken, and set inactive in the quest window
	case 1:		// taken, active
		if (checkquest(105001, HUNTING) != 2) {
			mes "Still Porings in my garden. Check your quest log (Alt+U).";
			close;
		}
		mes "Ten! The garden is safe. Here, take these.";
		completequest 105001;
		getexp 1000, 500;
		getitem Red_Potion, 5;
		close;

	case 2:		// completed
		mes "My garden has never looked better.";
		close;
	}
	end;

OnInit:
	// The first condition that holds decides the icon.
	questinfo QTYPE_QUEST, QMARK_YELLOW, "checkquest(105001) == -1";
	questinfo QTYPE_QUEST2, QMARK_YELLOW, "checkquest(105001,HUNTING) == 2";
	end;
}
```

The fields of the header line are separated by **tabs**, as in every NPC
script.

### System/OngoingQuestInfoList.lub

```lua
QuestInfoList = {
	[105001] = {
		Title = "Mira's Poring Problem",
		Summary = "Kill 10 Porings for Mira.",
		IconName = "ico_nq.bmp",
		Description = { "Hunter Mira in Prontera wants ^0000FF10 Porings^000000 gone from her garden. They roam the fields south of the city." },
		RewardEXP = "1000",
		RewardJEXP = "500",
		RewardItemList = {
			{ ItemID = 501, ItemNum = 5 },
		},
	},
}
```

Only your own quests go in this file. The app keeps it aside as
`OngoingQuestInfoList-<mod>.lub` and has the client load it after the stock
table, so every other quest keeps its text. Write it in **ASCII** (see
[pitfalls](#the-client-table)).

### Applying it

`db/` and `npc/` are read when the **server** starts and `System/` when the
**client** loads. Switch the mod on in **Settings → Mods**, restart the server,
and reload the game window.

What the player then sees:

- A yellow `!` over Mira, and a yellow dot on the minimap where she stands.
- After accepting: the quest in the quest window, and `Poring ( 0 / 10 )` in
  its details. A line in chat on the quest channel, and yellow text over the
  character, every time a Poring dies: `Poring [3/10]`, then
  `Poring [Completed]`.
- If the window's *show* checkbox is on, the quest in the on-screen tracker
  beside the game view: title, summary and the count.
- Once ten have died: a `?` over Mira. Talking to her completes the quest; it
  leaves the log, and the icon goes away.

## quest_db.yml

rAthena's own format, unchanged; the stock tables are in
`vendor/rathena/db/re/quest_db.yml` and `…/pre-re/quest_db.yml` and are worth
reading for real examples. A mod's file is added to `db/import/quest_db.yml`
like any other table ([db/](../MODDING.md#db--changing-the-worlds-numbers)), so
the header is `Type: QUEST_DB`, `Version: 3`.

| Field | |
|---|---|
| `Id` | the quest id. Required. |
| `Title` | required for a new quest. The server's own name for it, used in its log messages; the player sees the `.lub` title instead. |
| `TimeLimit` | when the quest runs out. See [Time limits](#time-limits). |
| `Targets` | up to **three** kill counters. See below. |
| `Drops` | extra items that monsters drop while the quest is in the log. See below. |

### Targets: what counts as a kill

A target is either **one specific monster** or **a filter**:

```yaml
    Targets:
      # One monster, anywhere.
      - Mob: PORING
        Count: 10

      # A filter: any monster that passes every condition given.
      - Id: 1                       # 1, 2 or 3; any positive number unique in this quest
        Count: 30
        MapName: Plants of Payon    # what the quest window calls this target
        Race: Plant                 # Formless, Undead, Brute, Plant, Insect, Fish, Demon, Demihuman, Angel, Dragon
        Size: Small                 # Small, Medium, Large
        Element: Earth              # Neutral, Water, Earth, Fire, Wind, Poison, Holy, Dark, Ghost, Undead
        MinLevel: 10
        MaxLevel: 40
        Location: pay_fild01        # only kills on this map (or an instance of it)

      # A filter can also be a list of monsters, usually with a map.
      - Id: 2
        Count: 20
        MapName: Prontera Fields
        Location: prt_fild08
        MapMobTargets:
          PORING: true
          LUNATIC: true
          FABRE: true
```

- **`Count` stops counting at its value.** Kills past it are not counted, and
  `checkquest(<id>, HUNTING)` returns `2` once *every* target has reached its
  count.
- **A kill counts for the party.** When a party member kills a target, every
  member within sight of the monster who has the quest gets the kill. A kill
  by your homunculus, pet, mercenary or elemental counts as yours. Nothing
  configures this.
- **The quest window names the target** with the monster's name for a `Mob`
  target. A filter target is named after `MapName`, then race, size and
  element, separated by commas and cut to 23 characters.
- **The counter is per character, in the database** (the `quest` table,
  `count1`–`count3`), saved with the character. It survives logout, restarts
  and app updates.

### Drops

```yaml
    Drops:
      - Mob: PORING          # or leave Mob out: every monster
        Item: Jellopy        # AegisName
        Count: 1
        Rate: 5000           # out of 10000, so 50%
```

While the quest is in the character's log and not completed, each kill of that
monster rolls for the item, which goes straight into the inventory. **The
server's drop rates do not apply** to it, and it keeps rolling after the kill
counters are full. Like kills, it is shared: every party member nearby who has
the quest rolls for their own. One drop entry per monster: a second entry for
the same `Mob` changes the first.

### Time limits

```yaml
    TimeLimit: +2h        # two hours after setquest
    TimeLimit: +30mn      # minutes are "mn"; also s, h, d
    TimeLimit: 4h         # NO "+": the next 04:00, server time
    TimeLimit: 7d 4h      # 04:00, seven days on
    TimeLimit: Monday 4h  # next Monday, 04:00
```

**The `+` matters.** With it, the time is a duration; without it, it is a time
of day. `4h` is the stock "daily reset at 4 AM" — 696 stock quests use it — and
is not "four hours".

Running out does not remove the quest or stop the kill counter. It changes
what `checkquest` returns (`PLAYTIME` → `2`; `HUNTING` → `1` while the targets
are unfinished), and the script decides what that means. The quest window shows
a quest with a time limit differently; see [the client](#the-quest-window).

## The script side

These are rAthena's quest commands, all documented in
`vendor/rathena/doc/script_commands.txt` (section *Quest Log commands*). Each
takes an optional character id at the end, to act on someone other than the
attached player.

| | |
|---|---|
| `setquest <id>;` | add the quest to the log, active, counters at 0 |
| `completequest <id>;` | mark it completed; it leaves the quest window but the server keeps it |
| `erasequest <id>;` | forget it entirely, as if never taken |
| `changequest <old>,<new>;` | replace an active quest with another, counters at 0 — the next step of a chain |
| `checkquest(<id>)` | `-1` not taken, `0` inactive, `1` active, `2` completed |
| `checkquest(<id>, HUNTING)` | `2` all targets met, `1` not met and the time ran out, `0` otherwise, `-1` not taken |
| `checkquest(<id>, PLAYTIME)` | `2` the time ran out, `1` completed in time, `0` otherwise, `-1` not taken |
| `isbegin_quest(<id>)` | `0` not taken, `1` taken (active or inactive), `2` completed |
| `questinfo <icon>, <mark>, "<condition>";` | in `OnInit` only: an icon over this NPC, and a minimap mark, for every player for whom the condition holds |
| `questinfo_refresh;` | re-check the icons now, after something the server does not watch changed |
| `open_quest_ui <id>;` | open the quest window on that quest (`0` for the list) |

**rAthena gives no reward.** Experience, items and zeny are whatever your
script hands out after `completequest`. `getexp` is scaled by the **Quest
experience** rate in the app's server settings (rAthena's `quest_exp_rate`);
`RewardEXP` in the `.lub` is only text, so keep the two in step by hand.

**Errors do not stop the script.** `setquest` on a quest the character already
has (completed included), or `erasequest` on one they do not, prints an error
naming the script to the map server log and carries on. Check with `checkquest`
first, as the example does.

### Icons over the NPC

`questinfo` is checked again whenever the player gains or loses an item,
levels, changes job, kills a quest target, warps, or has a quest set, completed
or erased; anything else (a variable your script set) needs
`questinfo_refresh`. An NPC can have several; the **first** whose condition
holds is shown. The client draws:

| icon | |
|---|---|
| `QTYPE_QUEST` / `QTYPE_QUEST2` | `!` / `?`, quest colours |
| `QTYPE_JOB` / `QTYPE_JOB2` | `!` / `?`, job-quest colours |
| `QTYPE_EVENT` / `QTYPE_EVENT2` | `!` / `?`, event colours |
| `QTYPE_CLICKME` | "click me" |

`QTYPE_DAILYQUEST`, `QTYPE_EVENT3`, `QTYPE_JOBQUEST` and `QTYPE_JUMPING_PORING`
exist in rAthena but **draw nothing** in this client. The marks are
`QMARK_YELLOW`, `QMARK_GREEN`, `QMARK_PURPLE`, or `QMARK_NONE` for none. Write
the quest id as a number inside the condition: it is evaluated on its own,
where your script's `.@` variables do not exist.

### Patterns

**Repeatable.** `completequest` keeps the quest on the character, and
`setquest` refuses a quest the character has, so `erasequest` first:

```
	erasequest 105001;
	setquest 105001;
```

**Daily, the stock way.** Stock rAthena pairs each repeatable hunt with a
"Standby" quest whose only job is the cooldown. On turn-in, complete the hunt
and set the standby; next time, let the player in once it has run out:

```yaml
  - Id: 105002
    Title: Mira's Poring Problem - Standby
    TimeLimit: 4h
```

```
	// turning in
	completequest 105001;
	setquest 105002;

	// at the start of the conversation
	if (checkquest(105002, PLAYTIME) == 2) {
		erasequest 105002;
		erasequest 105001;     // so it can be set again
	}
	if (checkquest(105002) != -1) {
		mes "Come back tomorrow.";
		close;
	}
```

The standby quest shows in the quest window's **Cooldown** tab until 04:00.

**Chains.** `changequest 105010, 105011;` swaps step one for step two in place.
Give each step its own id, its own `quest_db` entry and its own `.lub` text.

**Collecting items.** The server counts kills, not items. A "bring me ten
Jellopy" quest is a quest with no `Targets` and a `countitem` in the script;
say what to bring in the `.lub` description. `Drops` can make the item drop
only while the quest is taken.

## The quest window

The `.lub` is read by the game client and only by it. It gives the quest its
words and pictures; it changes nothing on the server.

| Field | shown |
|---|---|
| `Title` | in the list, the tracker and the details. Cut to 30 characters in the list, 25 in the tracker |
| `Summary` | under the title in the list and the tracker, cut the same way. Not in the details |
| `Description` | in the details |
| `IconName` | the list icon, from `data/texture/유저인터페이스/renew_questui/`. `ico_nq.bmp` is the plain quest icon; the stock table uses `ico_ep.bmp` (episode), `ico_jq.bmp` (job), `ico_ee.bmp` (event) and others |
| `RewardEXP`, `RewardJEXP` | in the details, when above 0 |
| `RewardItemList` | in the details, with each item's name and icon from the client's item table |

`NpcSpr`, `NpcNavi`, `NpcPosX`, `NpcPosY` and `CoolTimeQuest`, which the stock
table has, are read and ignored. The kill targets and their counts never come
from this file: they come from the server.

Text can use `^RRGGBB` colours and two tags, in `Description` only:

```
<ITEM>Red Potion<INFO>501</INFO></ITEM>          a link that opens the item's window
<NAVI>Mira<INFO>prontera,155,185,0,000,0</INFO></NAVI>   a link that opens navigation to that spot
```

A quest the character has but the client has no text for is listed as
**Unknown Quest**, with its kill counters and nothing else. That is what a
missing, misnamed or unparseable `.lub` looks like.

The window has four tabs: active quests, inactive ones (the player toggles a
quest between them with the lock button; inactive quests still count kills),
an empty one, and **Cooldown**. Completed quests are not shown anywhere.

## Quest ids

**Nothing reserves a range for mods, and nothing warns about a clash.** The
app reports two mods that define the same item or monster; quests are not
checked. When two mods use the same id:

- on the server, both entries are loaded in mod order, and the later one
  **updates** the earlier field by field. Its `Title` replaces the first's; a
  target for a different monster is **added** to the first quest's targets.
  The result is one quest neither author wrote.
- on the client, the later mod's `.lub` entry **replaces** the earlier one
  whole.
- in the database, both mods' NPCs read and write the same row on the
  character. One mod's `completequest` finishes the other's quest.

The ids already taken:

| | |
|---|---|
| up to 62238 | rAthena's own quests (`db/re`, `db/pre-re`) |
| up to 70250 | the English translation's quest text, which this app uses — including `70001` |

So:

- **Use ids from 100000 to 1999999**, well clear of both and of anything
  official servers add. Stay **under two million**: the server tells the
  client about each kill target as `quest id × 1000 + target` in a 32-bit
  number, and a larger id overflows it.
- **Pick a block per mod, not per quest.** A round number derived from
  something unique to you — `100000 + 1000 × n` — and every quest that mod will
  ever have inside it. Write the block in your mod's README so the next author
  can avoid it.
- **Never reuse an id** for a different quest, even after deleting the old
  one: characters that took the old quest still have it.
- **Before publishing, search** the registry for your range:
  `grep -rn "Id: 1050" registry/mods/*/db/quest_db.yml`.

Overriding a stock quest on purpose, by using its id, is possible for the same
reason. Prefer a new id: an override changes a quest players may be in the
middle of.

## Limits

What the native quest system **cannot** do, so that you can design around it
instead of discovering it:

- **Three kill counters per quest**, and only kills. No "talk to", "reach",
  "collect" or "use" objectives: those are a character variable your script
  keeps, explained to the player in the description.
- **A script cannot read or set a counter.** It only gets `HUNTING` → done or
  not. There is no command to give progress for something other than a kill,
  and no event label when a counter goes up. `OnNPCKillEvent` fires on every
  kill and can count anything, but that count does not appear in the quest
  window.
- **Party kills cannot be switched off**, or narrowed to the killer.
- **The `.lub` cannot change at runtime.** A quest's text is the same for every
  player and every state; put state-dependent text in the NPC's dialogue.
- **No quest text from Lua hooks or plugins.** There is no plugin event for
  quest progress and no API to read the quest log; `api.actions.perform('window',
  { name: 'Quest' })` only opens the window.
- **Per era.** Renewal and pre-renewal are separate databases: a quest taken in
  one has not been taken in the other.

## Pitfalls

### quest_db.yml

- **A `Mob` target ignores every filter.** `Location`, `Race`, `Size`,
  `Element`, `MinLevel` and `MaxLevel` are read only for a target **without**
  `Mob`. This loads without a word and counts Porings on every map:

  ```yaml
      - Mob: PORING
        Count: 10
        Location: prt_fild08     # ignored
  ```

  For "Porings on this map", use a filter with `MapMobTargets`:

  ```yaml
      - Id: 1
        Count: 10
        MapName: Poring
        Location: prt_fild08
        MapMobTargets:
          PORING: true
  ```

- **Give every filter target a `MapName`.** The window names a filter target
  from `MapName`, race, size and element. A `MapMobTargets`-only target with
  none of those has an empty name: ` ( 3 / 10 )`.
- **A broken entry is skipped, not the file.** An unknown monster or item, a
  bad `TimeLimit`, a fourth target: the map server log names the line and moves
  on, and `setquest` on that id then fails with `quest_add: quest 105001 not
  found in DB`. Settings → Mods shows import-table errors under the mod;
  read the map server log for the rest.
- **Era folders, not `db/re/`.** A mod's `db/re/quest_db.yml` ends up at
  `db/import/re/quest_db.yml`, which rAthena never reads, and nothing says so.
  A quest for one era only goes in the mod's
  [era folder](../MODDING.md#renewalfolder--prerenewalfolder--one-mod-for-both-eras)
  (`renewal/db/quest_db.yml`), and that file **replaces** the mod's own
  `db/quest_db.yml` for that era; it is not added to it.

### The client table

- **ASCII only.** The client reads quest tables in the game's codepage
  (Korean or Western, depending on the setting), never as UTF-8. An accented
  letter or a typographic quote comes out as garbage. Use `'` and `"`, not
  `’` and `“`. Item tables are different and do take UTF-8.
- **One table, named `QuestInfoList`.** The client runs your file and reads
  the global `QuestInfoList`. A file that defines a table under another name
  re-registers the *previous* file's quests, and a syntax error loads nothing
  without saying so. Copy the example's first line.
- **The file goes directly in `System/`**, named `OngoingQuestInfoList.lub`
  (`.lua` and `_True`/`_Sakray` variants are taken too). In a subfolder, it is
  not read.
- **Write `Description` as one string.** It is a list of lines in the stock
  format, but this client joins the lines with commas and no line breaks:
  `{ "Hello.", "Bye." }` shows as `Hello.,Bye.`.
- **An entry replaces, not merges.** A mod that redefines a stock quest to fix
  its title has to give the whole entry, description and rewards included.
- **`^000000` means black**, not "back to normal". Colours do not end; the next
  `^RRGGBB` starts another.
- **The client caches files by name.** Switching a mod on or off clears that
  cache; editing the `.lub` inside an installed mod may not. If the old text
  persists, restart the app.

### The quest window

- **A quest with a `TimeLimit` is shown in the Cooldown tab** for as long as
  its time has not run out — even a hunt the player is in the middle of. It has
  no lock or display button there, and it is not in the on-screen tracker. The
  details still show the counters and a deadline. That suits a standby quest;
  for a timed hunt, say so in the summary so players know where to look.
- **Only four quests fit the tracker.** It shows the first four active,
  non-cooldown quests, unless the player hides some with their display buttons.
- **A just-set quest says `(0/10)` in chat** right away. That is the server
  sending the starting count, not a kill.
- **The details window does not refresh live.** It is filled when the player
  clicks a quest; the list, chat line and tracker update on every kill.

### The quest's life on a character

- **Switching the mod off can delete players' progress.** With the mod off, its
  `quest_db` entries are gone at the next server start. The server then drops
  those quests from each character as it logs in, with
  `intif_parse_QuestLog: quest 105001 not found in DB` in the log, and the next
  save of that character **deletes the rows**. Switching the mod back on later
  does not bring them back. Character variables your script set are not
  affected, so a quest whose state also matters long-term should keep it in a
  variable too.
- **Changing a quest's targets** in an update keeps the counters by position:
  `count1` is whatever the first target is now. Reorder targets only in a new
  quest id.
- **A completed quest stays on the character forever** unless your script
  erases it. That is what lets `checkquest(<id>) == 2` mean "has done this
  before" — and it is why `setquest` on it fails.

## When it does not work

| What you see | Why |
|---|---|
| `quest_add: quest 105001 not found in DB` in the map server log | the `quest_db.yml` entry did not load: the mod is off, the server was not restarted, the entry has an error (look higher in the log), or the file is in `db/re/` |
| `quest_add: Character … already has quest 105001` | `setquest` on a quest the character has, completed included: `erasequest` it first, or check `checkquest` |
| **Unknown Quest** in the window | the `.lub` was not read, or has no entry for that id: wrong folder or name, not called `QuestInfoList`, a Lua syntax error, or the client was not reloaded |
| garbage letters in the window | non-ASCII text in the `.lub` |
| the counter does not move | the kill does not match: a filter whose conditions this monster fails, the wrong map, a `Count` already reached, or the quest is completed |
| it counts kills everywhere | a `Mob` target with a `Location`: see [pitfalls](#quest_dbyml) |
| the quest is not in the Active tab | it has a `TimeLimit`: it is in **Cooldown** |
| a quest has text from another mod, or extra targets | another mod uses the same id: see [Quest ids](#quest-ids) |
| no icon over the NPC | `questinfo` outside `OnInit`, a condition using a `.@` variable, or an icon this client does not draw |
| progress gone after switching mods | see [the quest's life on a character](#the-quests-life-on-a-character) |

To see what the server holds for a character, open **Settings → Tools →
Database** and pick the `quest` table: one row per quest per character, `state`
`0` inactive, `1` active, `2` completed, and the three counters.
[DATABASE.md](../DATABASE.md#the-database-tool) has the rest.
