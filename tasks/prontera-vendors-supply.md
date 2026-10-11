# prontera-vendors: a market supplied by simulated hunting

*Implemented (branch `prontera-vendors-supply`), except the backlog at the end.*

Today a Pool stall shuffles its theme's fixed list and lists each line at its
YAML `Amount` (`population_engine.cpp`, the `PopulationVendorType::Pool`
branch). Nothing is ever used up: a rare-card stall or a Glast Heim loot stall
can open at any moment whether anyone hunted there or not. This plan gives the
market a finite supply that fills from simulated parties hunting the world.

---

## Shape

- **Supply ledger** in the mod store (`docs/MOD_STORE.md`, `global` scope):
  one aggregate per item, never one batch per hour.
  - `supply.<id>.qty` (×1000, so fractions survive decay), `supply.<id>.t`
  - `maps.<map>.last` (coverage), `mvp.<id>.last` (MvP caps)
  - Roughly 2,000 items × ~25 B plus ~500 maps: ~60–70 KB of the 1 MiB budget.
- **Hand-off to the engine:** the store is script/Lua only, so the market
  script mirrors it each minute into `$@pop_item_supply[<id>]`, like
  `$@pop_item_pct`. The store is the truth; the `$@` array is the exchange.
- **Simulation in mod script** (the market script's existing tick), no C++:
  - `build_vendors.py` generates a per-map yield table into
    `market-data.txt`: mobs, spawn counts, respawn times, relevant drops.
  - Drop rates follow the server: `getbattleflag("item_rate_common")`,
    `item_rate_card`, `item_rate_mvp`, …
  - Per map and hour: `kills = min(parties × kill_rate, spawns × 3600 /
    respawn)`, then per drop an integer draw around `kills × rate`.
- **Engine hook** (app's `third-party/population-engine`, next to
  `pop_item_price_pct`), read-only and general so any mod could use it:
  `$@pop_item_supply[<id>]` caps how many of an item a mod's stalls list.
  The cap is the value minus what shells on the map already list (the
  undercut pass already walks those stalls). Unset means no cap, so existing
  mods are unaffected. The engine never writes it: the script lowers supply
  from `picklog` purchases, as the market does for prices. Propose this on an
  issue before writing it (app `CLAUDE.md`, "Where a change belongs").

## Decay (replaces a hard 48 h reset)

Each item's stock halves every half-life ("other players bought it").
Steady-state stock = hourly inflow × half-life × 1.44, reached to ~90 % after
~3.3 half-lives; the market can't overfill. Category multipliers live in the
generated data, not settings: loot ×1, equipment ×3, cards and MvP items ×5.
A per-item cap keeps junk from piling up.

## Gating: per line, by source

The generator records each line's source. A theme can mix sources, so the
gate is per line:

| Source | Gate |
|---|---|
| `npc` (an NPC sells it) | never: infinite, as on a real server |
| `drop` | supply |
| `crafted`, `carded`, `refined`, `forged` | ungated now; crafter output once the backlog below lands |

A theme with little supply just lists fewer lines. Rerolling a theme that
comes up with fewer than ~3 would be more engine logic: leave it out unless
thin stalls look wrong in play. The script sets `$@pop_item_supply` only for gated items, so the
engine needs no notion of sources and no new YAML key. Since a `$@` value of
0 reads as unset, a gated item stores supply + 1 (1 = gated, none left).

## Map coverage

- Map weight = popularity × (1 + hours since last visit / T). Neglected maps
  climb until picked; optional hard floor ("every map once every 3 days").
- Parties match maps by level band; sessions last 1–4 h; active parties
  scale with real time of day and weekends.
- Excluded: towns, PvP/GvG, instances, event maps, maps without spawns.
  Excluded items: NoTrade, bound, event- or quest-only.
- Market news drives the simulation (a "Glast Heim purge" sends parties
  there) and prices follow supply.

## MvPs

- At most one kill attempt per respawn window, a success chance from
  difficulty vs. the population's level, and a hard per-MvP daily cap.
- Rewards and drops roll normally, so MvP cards appear about once in several
  months. That allows lifting "never MVP cards" for supply-driven stalls.
- The real MvP spawn is never touched. Optional broadcast of a simulated kill.

## Player trades

- Loot sold to a fake buying store joins supply and decays like any other.
- Buying from a stall removes it from supply. Nothing is duplicated.
- Guard: one trade's price move must stay below the buyer/stall gap
  (5–25 %), so selling and buying back never pays.

## Settings

| Setting | Default |
|---|---|
| Simulated hunting parties | 20 |
| How long loot stays on the market (half-life, days) | 2 |
| Start with a filled market (off: start empty) | on |
| MvP kills (cap per MvP per day) | 1 |
| Drop rates | follow the server (no setting) |

"Start filled" sets each item to its steady state directly; no warm-up
simulation needed. Staples keep the street alive while an empty market grows.

---

## Backlog: simulated crafters

The same pattern for everything that isn't a drop: a crafter takes inputs out
of supply and puts the product in. Ingredients an NPC sells are free. Runs
after the hourly drop pass; a "Crafters" setting scales how many work per day.
Once a crafter type exists, its source stops being ungated.

- **Forgers (Blacksmith):** Iron + elemental stone + Star Crumbs (+ base
  weapon) → forged weapons, "Very Strong" by Star Crumb count, VVS
  Fire/Ice/Earth/Wind. Forged weapons get scarce when Star Crumbs are.
- **Refiners:** base gear + Elunium/Oridecon from supply, attempts rolled
  against rAthena's refine table (pre-re destroys on failure; renewal's own
  rules). Yields the real +N spread: many +4/+7, few +9/+10. Oridecon demand
  becomes real, and a "refining fever" event consumes it.
- **Carders:** a card + a slotted base item from supply → carded piece,
  weighted by `carded.json` (the builds iRO players listed). Cards for sale
  and carded gear then compete for the same drops. Messed-up cardings stay a
  small share.
- **Brewers (Alchemist), later:** herbs and bottles → potions, slim potions.
  Low value; only once the rest works.
- **Still not simulated:** cash-shop and costume items, event and quest
  rewards. Keep them as staples, or give them a small fixed trickle into
  supply.
