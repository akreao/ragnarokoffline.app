# The GRF browser

**Settings → Tools → GRF browser** shows every file in your client's GRFs:
sprites, pictures, palettes, text, sounds, maps and models. You can find a
file, preview it, and copy it into a mod. Sprites, pictures and palettes can go
out as PNG files for any image editor, and come back in the client's own
format. It works the same on macOS, Windows, Linux and the Steam Deck. There's
nothing else to install.

It never changes your GRFs. A mod doesn't need a changed GRF anyway: anything
in a mod's `data/` folder is served **ahead of** the GRFs, so to replace a file
you put your copy in a mod at the same path
([MODDING.md](../MODDING.md#data--sprites-textures-and-map-geometry)). The
browser does exactly that, at the right path, Korean folder names included.

## Starting

The browser reads your client through the game's asset server, so press
**Play** once first. The file list takes a few seconds the first time.
Big clients have several hundred thousand files.

- **The tree** on the left is the GRF's folders, with a count of the files
  under each one.
- **The chips** above it (Sprites, Pictures, Palettes, Text, Sounds, Maps,
  Models) show only that kind of file in each folder.
- **The search box** finds files anywhere. Every word you type must appear in
  the path, so `몬스터 poring` finds the monster sprites with "poring" in the
  name. Wrap it in slashes for a regular expression: `/npc\\.*_kafra.*\.spr$/`.

A preview always shows the file **as the game gets it**. If one of your mods
replaces a file, you see the mod's copy, once that mod has been applied.

## Previews

| File | What you see |
|---|---|
| `.spr` + `.act` | the sprite, animated: pick the action (Standing, Walking, Attacking…) and the direction. Every frame is listed below, numbered, with its size |
| `.spr` alone | its frames |
| `.bmp` `.tga` `.jpg` `.png` | the picture, with magenta (the client's see-through colour) shown as transparent |
| `.pal` | the 256 colours as a grid, index 0 at the top left |
| `.txt` `.xml` `.lua` … | the text, Korean included |
| `.wav` `.mp3` | a player |
| `.lub` | nothing: compiled Lua has no text to show |

Maps open in the [map editor](MAP_EDITOR.md) instead.

## Copy to mod

**Copy to mod…** asks for a mod: one of yours, or **A new mod…** with a folder
name and a line saying what it does. The file goes to
`mods/<mod>/data/...`, at the path the client asks for. A new mod gets a
`mod.json` and is switched on.

Then **Settings → Mods → Apply** puts it in the game. Edit the copy however you
like: in the browser (below), or with any tool you already use. To share it,
see [Sharing a mod](../MODDING.md#sharing-a-mod).

A copy you don't change still replaces the stock file. That's harmless, but
it's clutter. Delete what you didn't change before you share the mod.

## Edit as PNG

For a sprite, a picture or a palette, **Edit as PNG** writes it out as PNG
files and opens their folder:

| File | What goes out |
|---|---|
| sprite (`.spr`) | one PNG per frame, `frame-000.png`, `frame-001.png`… with the frame numbers the preview shows |
| picture (`.bmp` `.tga` `.jpg` `.png`) | one PNG, transparent where the client draws magenta |
| palette (`.pal`) | a 16 × 16 grid of coloured squares, index 0 at the top left |

A `README.txt` beside them says the same. The folder is
`state/grf-browser/<file>/` in the app's data folder (on macOS,
`~/Library/Application Support/Ragnarok Offline/state/grf-browser/`).
Each export empties the folder first. On a [headless](../HEADLESS.md) server
the folder is on the server, and the browser shows its path instead of
opening it.

Edit them in anything that saves PNG: Aseprite, Photoshop, GIMP, Krita, Paint,
Preview. **Save them in the same folder, under the same names.** Then go back
to the browser and press **Bring back into a mod…**. The browser turns the
PNGs into the original format, saves the result in the mod you pick, at the
original path, and shows it as saved.

### Sprites

- **A frame you leave alone stays as it was.** You only need to keep the PNGs
  you changed, and you can delete the rest.
- **Transparent is the background.** Any pixel under half opacity becomes the
  sprite's background.
- **A frame can change size.** It stays centred where the `.act` draws it. The
  `.act` is not changed, so keep the subject where it was in the frame, or it
  will jump between frames.
- **You can't add frames.** A PNG with a number past the sprite's last frame is
  skipped, and the browser lists it. New frames need a new `.act` too. Use an
  Act Editor for that (see
  [Making the .spr and .act](../MODDING.md#making-the-spr-and-act)).

**Colours.** Most frames are palette frames: up to 256 colours, shared by every
frame. When they come back, each colour you painted becomes the nearest colour
of the sprite's own palette. That's what you want for small fixes, and for
anything the game recolours: a job's body sprite, hair and many headgear use
palette files (`data/palette/`), and those keep working only if the colours stay
where they were. The browser tells you how many pixels weren't in the palette.
If the result doesn't look like what you painted, bring it back again with
**Make a new palette from my pictures** on. That builds a palette of up to 255
colours from every frame, the most used first, the same way `scripts/mksprite.py`
does. Use that for new art in new colours, such as a blue Poring. Don't use it
on a sprite the game recolours.

Full-colour (RGBA) frames, which some newer sprites have, keep exactly what you
painted, transparency included.

### Pictures

They come back in the format they started in, under the same name:

- `.bmp`: 24-bit, transparent pixels as magenta, which the client draws
  see-through;
- `.tga`: 32-bit, transparency kept;
- `.jpg`: JPEG at high quality, with no transparency (the client's JPEGs never
  had any);
- `.png` as is.

Keep the size of textures that are tiled or mapped (ground, models). Interface
pictures and cut-ins can be any size. Leave only that one PNG in the folder, or
keep it under the name it was given.

### Palettes

Recolour the squares. The picture can be any size, since the middle of each
of the 16 × 16 squares is read. A job's clothes and hair colours are palette
files, numbered by the colour the player picks. See
[Palettes](../MODDING.md#palettes) for which file is which.

## When it doesn't work

| What you see | Why |
|---|---|
| "The game's asset server is not running" | Press **Play** once, then reopen the browser. |
| The game still shows the old file | The mod isn't applied yet (**Settings → Mods → Apply**), or the client cached the file: see [The client caches, hard](../MODDING.md#the-client-caches-hard). |
| A sprite's colours came back wrong | They weren't in its palette: bring the frames back with **Make a new palette from my pictures**, unless it's a sprite the game recolours. |
| "that folder is gone" | The PNGs were removed, or another export of the same file replaced them. Press **Edit as PNG** again. |
| A frame jumps in game | Its subject moved within the PNG. The `.act` places frames by their centre. |

## What it doesn't do

- **Change the GRFs, or make one.** A mod's `data/` folder already replaces any
  file in them, so a repacked GRF is never needed for this app. To give your
  work to someone, share the mod.
- **Edit `.act` files**: actions, frame positions, timing. Use an Act Editor
  for those ([Making the .spr and .act](../MODDING.md#making-the-spr-and-act)).
- **Edit maps or models.** Maps are the [map editor](MAP_EDITOR.md)'s job.
  Models (`.rsm`) can be copied to a mod for another tool.
- **Show files that are only in a mod.** The list is the GRFs'. A file a mod
  adds, rather than replaces, isn't in it.
