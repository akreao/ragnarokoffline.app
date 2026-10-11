# Editing Ragnarok Offline maps as an AI agent

You are working in the **Ragnarok Offline map editor**: a map editor for
Ragnarok Online maps that saves its work as a mod for the player's own server.
The player may be watching the editor window while you work, and they can undo
anything you do — so work in visible, sensible steps, and look at what you made
before saying it is done.

This file sits in `<state>/map-editor/` next to `connection.json` and the
`ragnarok-map` launcher (`ragnarok-map.cmd` on Windows). In a source checkout
the command is `node tools/map-editor/cli.js`.

## Connecting

- **MCP** (Claude Code, Codex, other MCP clients): the app serves it over
  HTTP at `http://127.0.0.1:<port>/mcp/map` (usually 7490, the same address as
  the game agent's `/mcp`), with `Authorization: Bearer <token>`; the address
  and token are in `connection.json` here, and Settings → Play with an AI agent
  shows the `claude mcp add` command. `ragnarok-map mcp` is the same tools on
  stdio. Every command below is a tool, with `.` replaced by `_` (`map.open` is
  `map_open`). Screenshots come back as images.
- **Command line**: `ragnarok-map <command> --arg value ...`, one JSON answer
  per call. `ragnarok-map help` lists every command with its arguments.

Commands go to the open map editor (Settings → Tools → Map editor in the app).
When none is open, `ragnarok-map` asks the app to open one, or starts a
headless one of its own (Chromium through Playwright, in a source checkout).
`ragnarok-map serve` puts the editor in any browser.

`ragnarok-map offline --mod M --map X <command> ...` edits a mod's files
directly with no editor at all: every editing command, `map.new`,
`map.save`, `map.check` and `batch`. No screenshots or model shadows there.

## Coordinates and units

- **x, y are server cells**, the numbers `/where` and `@warp` use. x grows to
  the east, **y grows to the north**. The map is `width × height` cells
  (`map.info`).
- **Heights are in cells, up.** A cell is 1 across, so `height: 5` is a cliff
  five cells tall. (The files store -5× that; you never need to.)
- `radius` is in cells, angles in degrees. Facing (`dir`) is rAthena's: 0 north,
  2 west, 4 south, 6 east (counter-clockwise).
- Objects (models, lights, sounds, effects) are addressed by **index** (from
  `objects.list`, or what the add command returned). Removing one shifts the
  indexes after it. NPCs, warps and spawns have **ids** like `npc-3`.

## A good way to work

1. `status` — is a map open? `projects.list` and `maps.search` show what exists.
2. Open or make one:
   - `map.new --mod my-isle --name my_isle --width 80 --height 80 --texture '필드바닥\prt_초원01.bmp'`
   - `map.open --map izlude --mod my-izlude --as my_izlude` (an official map as a new one)
3. Shape it, a few commands at a time, then **look**:
   `view.camera --x 40 --y 40 --distance 70 --pitch 50` and `view.screenshot`
   (`ragnarok-map shot --out f.png` on the command line).
4. `map.check` — fix every problem it lists.
5. `map.save` — writes the mod. `map.test` (in the app) switches the mod on,
   restarts the server and puts the player's character on the map. **Ask the
   player first**: it restarts their server.

## What you can do

| Area | Commands |
|---|---|
| Map | `map.info`, `map.rename`, `map.resize`, `map.crop`, `map.new`, `map.open`, `map.save`, `map.check`, `map.test`, `map.set_start` |
| Ground | `terrain.brush` (raise, lower, smooth, flatten, set, noise), `terrain.rect` (plateau/cliff, raise, lower, ramp, smooth), `terrain.corner`, `terrain.height` |
| Textures | `textures.search`, `texture.list`, `texture.add`, `texture.paint` (brush or rectangle, turn, mirror, span), `texture.color`, `walls.auto` |
| Walkability | `gat.paint` (0 walkable, 1 blocked, 3 water, 5 cliff), `gat.auto` |
| Water, light | `water.set`, `light.global`, `light.add`, `lightmap.bake`, `lightmap.reset` |
| Objects | `models.search`, `model.add`, `sounds.search`, `sound.add`, `effect.add`, `objects.list`, `object.update`, `object.move`, `object.duplicate`, `object.align`, `object.remove`, `object.copy`, `object.copy_area`, `object.paste`, `prefab.save`, `prefab.place`, `prefab.list` |
| Gameplay | `npc.add` (script, sign, healer, warper, shop), `warp.add` (two-way too), `spawn.add`, `marker.update`, `marker.remove`, `signboard.set`, `population.set`, `gameplay.list`, `npcs.search`, `mobs.search`, `items.search`, `dialogue.open` |
| Properties | `props.set` (sky, clouds, weather, bgm, displayName), `bgm.list` |
| View | `view.camera`, `view.show`, `view.select`, `view.tool`, `view.screenshot`, `view.minimap` |
| History | `undo`, `redo` |

## Things that trip people up

- **Map names are at most 11 characters**: lowercase letters, digits, `_`, `-`.
- **A warp must not land inside another warp**, or players bounce straight
  back; `map.check` catches it. `warp.add --twoWay true` places the way back
  for you, beside the arrival point.
- **Steep ground and cliff edges become blocked** automatically. rAthena's
  pathing ignores heights, so a cliff players could walk off has to be. Paint
  with `gat.paint` to override; painted cells stay painted.
- **Scripted NPCs call a function you write** in `npc/<map>_dialogue.txt`
  (made from a template on save). The editor never rewrites that file. For a
  merchant, healer, warper or sign, use those kinds instead: no script needed.
- **NPC sprites** are client names like `4_F_KAFRA1` (`npcs.search`).
  **Monsters** are ids or AegisNames (`mobs.search`).
- **Textures and models are paths in the player's client**, from
  `textures.search` / `models.search`, Korean folder names and all. A map
  refers to them; it does not copy them.
- **An official map opened without `as`** saves as an override that changes it
  for everyone with the mod on; `map.save` refuses unless you pass
  `override: true`. Prefer `as` and a new name.
- **Lightmaps**: after placing models and lights, `lightmap.bake` for shadows
  and coloured light. It is one undo step.
- **Unsaved work**: `map.open` and `map.new` refuse while the open map has
  unsaved changes; save first, or pass `discard: true` only if the player said so.

## Be considerate

The editor may be the player's, open on their screen. Don't discard their
unsaved work, don't overwrite an official map without being asked, and don't
run `map.test` (it restarts their server) without asking. Say what you changed.
