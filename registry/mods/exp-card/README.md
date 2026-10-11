# exp-card

Every monster kill has a small chance to drop an **Exp Card**, bound to the
killer for the standard pickup window. Two families — **Base Exp Cards** and
**Job Exp Cards** — each with ten levels. Higher-level monsters drop
higher-level cards. Using a card grants a fixed chunk of experience.

The point: streamline the offline experience without touching per-mob drop
tables. Any mob, any map, one uniform bonus channel that scales with the
content the player is fighting.

## The cards

Exp per card (at a 1x rate — see [Exp rates](#exp-rates)) is about **5% of
the next level at the lowest base level that may use it**, and about 3% nine
levels later, measured against each era's own exp table for a second job. In Renewal
tiers 1 to 4 grow about 2× a level and the curve flattens from tier 5 (before
1.2.0 tiers 6–9 were 9–14% of a level each). Pre-renewal levels cost far less
early and far more late, so it has its own amounts (`pre-re/db/item_db.yml`,
laid over the mod by `prerenewalFolder`).

| Level | Exp at 1x, Renewal | Exp at 1x, pre-renewal | Required base level | Item ids (base / job) |
|---|---|---|---|---|
| 1  | 100    | 5       | 1  | 50051 / 50061 |
| 2  | 250    | 20      | 11 | 50052 / 50062 |
| 3  | 500    | 95      | 21 | 50053 / 50063 |
| 4  | 1,000  | 450     | 31 | 50054 / 50064 |
| 5  | 1,500  | 2,000   | 41 | 50055 / 50065 |
| 6  | 2,250  | 6,500   | 51 | 50056 / 50066 |
| 7  | 3,000  | 20,000  | 61 | 50057 / 50067 |
| 8  | 5,500  | 80,000  | 71 | 50058 / 50068 |
| 9  | 11,000 | 200,000 | 81 | 50059 / 50069 |
| 10 | 30,000 | 580,000 | 91 | 50060 / 50070 |

An app older than 1.4.3 does not know era folders and gives a pre-renewal
server the Renewal amounts, as before 1.2.0.

Base cards grant only base exp; Job cards grant only job exp. The two are
symmetric — a Base Lv 10 gives 30,000 base exp, a Job Lv 10 gives 30,000
job exp.

**Level gate.** Each card has an `EquipLevelMin` matching its tier — a Lv 10
card needs base level 91 to use, a Lv 5 needs 41, and so on. rAthena's
`pc_isUseitem` refuses to consume the item below the threshold, so a
low-level character who happens to pick up a high-tier card just carries
it in the bag until they reach the level. Prevents a level 20 alt from
downing a Lv 10 base card for several levels in one click.

**Untradeable.** A card stays with the character who picked it up: it cannot
be traded, dropped, vended (it cannot go in a cart), mailed, auctioned or put
in guild storage. Personal storage and selling it to an NPC still work: an
NPC pays 100z for a Lv 1 card and 100z more a level, 1,000z for Lv 10. The
drop itself lands on the ground as before, so once the killer's pickup window
is over anyone can pick it up, as with any drop.

If you want a different curve, edit the twenty scripts in `db/item_db.yml`
(and `pre-re/db/item_db.yml` for pre-renewal)
— the tooltips name no number, so nothing else needs to change.

## How drops work

The `exp_card_ctrl` NPC hooks `OnNPCKillEvent`, rolls one dice against the
configured chance, and — on a hit — picks *which* card:

- **Level** comes from the dead mob's `MOB_LV`, clamped to `1..10`:
  ```
  card_level = clamp((mob_level + 9) / 10, 1, 10)
  ```
  So mob levels 1–10 give a Lv 1 card, 11–20 give Lv 2, …, 91+ gives Lv 10.
- **Family** is a coin flip — 50% Base Exp Card, 50% Job Exp Card.

The card lands at the killer's position and is bound to their `char_id`
via `makeitemowned`. Nobody else can pick it up during the standard
`item_first_get_time` window (see `battle.conf`); after that, it's free.

The mob's own drop table is untouched.

## Settings

**Settings → Mods → exp-card** exposes one number, read through
`F_ModSetting` on each server start (so **Apply** takes effect on the
next restart):

- **Drop chance** (`drop_chance`, default 200 = 2%; 225 before 1.2.0) — in
  0.01% units, matching rAthena's drop-rate convention. 1,000 is 10%,
  10,000 is guaranteed.

  Sizing rule of thumb: at ~150 kills per hour and the 50/50 base/job
  split, 2% is about 1.5 cards an hour on whichever axis the player is
  pushing, each worth 3–5% of a level where it drops: ~4.5–7.5% of a level
  per hour at 1x (scaling with the rates, like kill exp) — meaningful
  without trivialising the grind. Bump to 500 for a more generous curve, drop to
  100 for background-noise pace.

Card exp values are hard-coded in `db/item_db.yml` (twenty scripts, one
per card). Change them there if you want a different curve.

## Exp rates

Card exp follows the server's kill-exp rates: Base cards scale with
**Base EXP**, Job cards with **Job EXP** (the app's server settings,
`base_exp_rate` / `job_exp_rate`). At 1x a Lv 10 Base card gives exactly
30,000; at 10x it gives 300,000. So a card stays the same share of what
kills pay at any rate. The rate is read when the card is used, so a rate
change applies to cards already in the bag.

The amount is granted with `getexp2`, which applies nothing further: the
**Quest EXP** rate, Battle Manuals and the guild exp tax do not touch it.
That is what lets the message after use (`Base Exp Card Lv10: +300,000
base experience.`) print the exact amount granted.

The tooltip names no amount — it is a static client file and cannot know
the server's rate. It says what the card does, that higher levels grant
more, and the base level required to use it.

## Requirements

- `requires.app` is **`>=1.3.9`** — the first release whose pinned
  rAthena ships the native `makeitemowned` script command the on-kill
  drop uses. On an older build the command does not exist and the
  on-kill event logs a one-line error per kill; nothing else on the
  mod is affected (the items still exist and can be granted with
  `@item Base_Exp_Card_1` and friends).

## Installing

**Settings → Mods → Browse**, find exp-card, install. An installed mod is on;
untick it under **Settings → Mods** to switch it off again.

Or copy this folder into your mods directory and restart the app:

    macOS    ~/Library/Application Support/Ragnarok Offline/state/mods/
    Windows  %APPDATA%\Ragnarok Offline\state\mods\
    Linux    ~/.local/share/Ragnarok Offline/state/mods/

## Checking it loaded

- The supervisor prints `mods: exp-card` on start.
- The map-server log's NPC count goes up by one (`exp_card_ctrl`). A
  parse error names the file and line.
- In game: `@item Base_Exp_Card_10` gives you one, and using it grants
  30,000 base exp at 1x; that isolates the item side from the on-kill roll.

## What to look at first

`npc/exp_card.txt` is the whole feature in one screen: an `OnInit` that
reads the chance from Settings, and an `OnNPCKillEvent` that rolls it,
picks a card level from `MOB_LV`, flips for family, and calls
`makeitemowned`. Everything else is item entries (`db/item_db.yml`,
twenty scripts) and their client-side names built with a small loop
(`System/itemInfo.lua`).
