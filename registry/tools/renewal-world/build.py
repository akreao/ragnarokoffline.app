#!/usr/bin/env python3
"""Build the renewal-world mod's scripts from maps.csv and gates.csv.

Pre-renewal rAthena already loads every renewal map (conf/maps_athena.conf and
db/map_cache.dat are shared by both eras), and the client reads the same GRFs
in both. What pre-renewal lacks is the way in: the warps, the boats and the
guards. This script copies those from rAthena's renewal scripts for the maps
listed in maps.csv, and writes the gates in gates.csv for the entrances that
renewal hides behind a quest, an instance or a ship NPC with a whole town's
dialogue around it.

    python3 build.py              check the CSVs, show what would be written
    python3 build.py --write      write the mod's scripts
    python3 build.py --check      fail if the mod's scripts are stale

maps.csv   the renewal-only maps the mod covers, by region. access "open":
           always reachable. "quest": an area renewal keeps behind an episode
           quest, reachable only while the mod's quest_areas setting is on.
           "staged": joined to its neighbours, but nothing leads in yet.
gates.csv  one NPC per row: where it stands, what it looks like, where it
           sends you. kind "talk" asks first; kind "touch" is a portal you walk
           into. Gates are free. switch "quest_areas" puts the gate in
           npc/when/quest_areas/, which the app loads only while that setting
           is on; renewal's own portals into a quest area go there too.

What is copied from renewal, for the maps in maps.csv:
  - every warp portal between two listed maps, or between a listed map and a
    map pre-renewal already has (splendide -> bif_fild01, juperos_01 -> ver_eju),
    except one that leads into a staged map from outside the staged maps;
  - the map flags in WANTED_FLAGS (town, nomemo, noteleport, ...).
A portal to a renewal-only map that is not listed is left out and reported.

The build fails when a gate stands on a cell that is not walkable in
pre-renewal (Alberta and Izlude have their classic layouts there), when a gate
or portal stands next to one pre-renewal already has, when a name is already
taken, when an open map cannot be reached from the old world or cannot get
back to it, when a quest map can be reached with the setting off or cannot be
reached (or left) with it on, or when a staged map can be reached at all.

The CSVs live here, beside this script, and are not shipped: the mod carries
only the scripts generated from them. After --write, run scripts/mod-index.py.

--rathena (or RATHENA_DIR) points at the checkout; the default is the app's
vendor/rathena. Python 3, no packages. Nothing here runs in the game.
"""
import argparse
import collections
import csv
import os
import re
import struct
import sys
import zlib

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.normpath(os.path.join(HERE, "../../.."))
MOD = os.path.join(ROOT, "registry/mods/renewal-world")
OUT_WARPS = "npc/renewal_world_warps.txt"
OUT_GATES = "npc/renewal_world_gates.txt"
OUT_FLAGS = "npc/renewal_world_mapflags.txt"
# The mod's yes/no setting for the quest areas. The app loads npc/when/<key>/
# only while it is on.
SWITCH = "quest_areas"
OUT_QUEST = f"npc/when/{SWITCH}/renewal_world_quest_areas.txt"

# Map flags worth carrying over. Left out: pvp off (the default), reset,
# restricted (renewal's item zones) and the private airship flags.
WANTED_FLAGS = {"town", "nomemo", "nosave", "noteleport", "nowarp", "nowarpto",
                "nobranch", "nopenalty", "nightenabled", "monster_noteleport",
                "hidemobhpbar"}
# Renewal scripts whose warps are not a way into the world.
SKIP_SCRIPTS = re.compile(r"/instances/|/custom/|/test/")
# A gate or copied portal on a pre-renewal map keeps this many cells from what
# already stands there.
KEEP_CLEAR = 2
# A gate you talk to needs a walkable cell this close to it.
TALK_REACH = 3
# rAthena's NPC_NAME_LENGTH.
NAME_MAX = 50

NPC_LINE = re.compile(r"^([\w@\-]+),(\d+),(\d+)(?:,(\d+))?\t(warp2?|script|shop|cashshop|itemshop|pointshop|marketshop|duplicate\([^)]*\))\t([^\t]+)")
WARP_TAIL = re.compile(r"^(\d+),(\d+),([\w@\-]+),(\d+),(\d+)")
FLAG_LINE = re.compile(r"^([\w@\-]+)\tmapflag\t(\w+)(?:\t(.*))?$")
SPAWN_LINE = re.compile(r"^([\w@\-]+),\d+,\d+(?:,\d+,\d+)?\t(?:boss_)?monster\t")


def load_order(rathena, era):
    """The npc files the map server loads for an era, in order, with delnpc applied."""
    files = []

    def expand(conf, seen):
        if conf in seen or not os.path.exists(f"{rathena}/{conf}"):
            return
        seen.add(conf)
        for line in open(f"{rathena}/{conf}", errors="ignore"):
            m = re.match(r"(npc|delnpc|import):\s*(\S+)", line.split("//")[0].strip())
            if not m:
                continue
            kind, path = m.groups()
            if kind == "import":
                expand(path, seen)
            elif kind == "npc":
                files.append(path)
            else:
                files[:] = [f for f in files if f != path]

    expand(f"npc/{era}/scripts_main.conf", set())
    return [f for f in files if os.path.exists(f"{rathena}/{f}")]


def unique_name(name):
    """The part of an NPC name rAthena keeps unique: after '::' if there is one."""
    return name.split("::", 1)[1] if "::" in name else name


class Scripts:
    """What an era's npc files put where."""

    def __init__(self, rathena, era):
        self.files = load_order(rathena, era)
        self.warps = []                               # (file, line, src, x, y, name, dst, dx, dy)
        self.names = set()
        self.things = collections.defaultdict(list)   # map -> [(x, y, name)] warps and NPCs on it
        self.flags = []                               # (file, map, flag, value)
        self.maps = set()                             # maps with a warp, NPC or spawn on them
        for f in self.files:
            for line in open(f"{rathena}/{f}", encoding="latin-1"):
                line = line.rstrip("\r\n")
                if line.startswith("//"):
                    continue
                m = FLAG_LINE.match(line)
                if m:
                    self.flags.append((f, m.group(1), m.group(2), (m.group(3) or "").strip()))
                    continue
                m = SPAWN_LINE.match(line)
                if m:
                    self.maps.add(m.group(1))
                    continue
                m = NPC_LINE.match(line)
                if not m:
                    if line.startswith("-\t"):
                        parts = line.split("\t")
                        if len(parts) > 2:
                            self.names.add(unique_name(parts[2]))
                    continue
                mp, x, y, _, kind, name = m.groups()
                self.names.add(unique_name(name))
                self.maps.add(mp)
                self.things[mp].append((int(x), int(y), name))
                if kind.startswith("warp"):
                    t = WARP_TAIL.match(line.split("\t")[3]) if len(line.split("\t")) > 3 else None
                    if t:
                        dst = t.group(3)
                        self.warps.append((f, line, mp, int(x), int(y), name, dst, int(t.group(4)), int(t.group(5))))
                        self.maps.add(dst)


def read_map_cache(rathena, era):
    """Walkability of every map: name -> (width, height, cells). The era's
    cache overrides the shared one (classic Alberta, Izlude, ... in pre-re)."""
    maps = {}
    for path in (f"{rathena}/db/map_cache.dat", f"{rathena}/db/{era}/map_cache.dat"):
        data = open(path, "rb").read()
        _, count = struct.unpack_from("<IH", data, 0)
        off = 8
        for _ in range(count):
            name = data[off:off + 12].split(b"\0")[0].decode(errors="replace")
            xs, ys, ln = struct.unpack_from("<hhi", data, off + 12)
            off += 20
            maps[name] = (xs, ys, data[off:off + ln])
            off += ln
    return maps


class Cells:
    def __init__(self, entry):
        self.w, self.h, packed = entry
        self.c = zlib.decompress(packed)

    def walkable(self, x, y):
        # rAthena's map_gat2cell: types 1 (wall) and 5 (gap) are the only ones you cannot walk on.
        return 0 <= x < self.w and 0 <= y < self.h and self.c[x + y * self.w] not in (1, 5)


def read_csv(name):
    with open(os.path.join(HERE, name), newline="", encoding="utf-8") as fh:
        return list(csv.DictReader(fh))


def gate_script(g):
    """One gate NPC. Its unique name is the visible one plus #rw_<id>."""
    head = f"{g['map']},{g['x']},{g['y']},{g['dir']}\tscript\t{g['name']}#rw_{g['id']}\t{g['sprite']}"
    to = f"warp \"{g['to_map']}\",{g['to_x']},{g['to_y']};"
    if g["kind"] == "touch":
        return f"{head},1,1,{{\n\tend;\nOnTouch:\n\t{to}\n\tend;\n}}\n"
    text = g["text"].replace('"', "'")
    return (f"{head},{{\n"
            f"\tmes \"[{g['name']}]\";\n"
            f"\tmes \"{text}\";\n"
            f"\tnext;\n"
            f"\tif (select(\"Yes:No\") == 2)\n"
            f"\t\tclose;\n"
            f"\tclose2;\n"
            f"\t{to}\n"
            f"\tend;\n"
            f"}}\n")


def build(rathena):
    errors, notes = [], []
    re_s = Scripts(rathena, "re")
    pre = Scripts(rathena, "pre-re")
    cache = read_map_cache(rathena, "pre-re")
    cells = {}

    def walkable(mp, x, y):
        if mp not in cache:
            return False
        if mp not in cells:
            cells[mp] = Cells(cache[mp])
        return cells[mp].walkable(x, y)

    rows = read_csv("maps.csv")
    listed = {r["map"]: r["region"] for r in rows}
    access = {r["map"]: r["access"] for r in rows}
    quest = {m for m, a in access.items() if a == "quest"}
    staged = {m for m, a in access.items() if a == "staged"}
    closed = quest | staged
    for r in rows:
        if r["access"] not in ("open", "quest", "staged"):
            errors.append(f"maps.csv: {r['map']}: access must be open, quest or staged, not {r['access']!r}")
    old = pre.maps
    for mp in listed:
        if mp not in cache:
            errors.append(f"maps.csv: {mp} is not in rAthena's map cache")
        if mp in old:
            errors.append(f"maps.csv: {mp} already has warps, NPCs or monsters in pre-renewal")

    def crowded(mp, x, y, me):
        return [t for t in pre.things.get(mp, []) if t[2] != me and max(abs(t[0] - x), abs(t[1] - y)) <= KEEP_CLEAR]

    # --- portals copied from renewal ---------------------------------------
    # Always on: portals among the listed maps and out to the old world.
    # Behind the switch: renewal's portals into a quest map from outside.
    # Never: a portal into a staged map from outside.
    pre_lines = {w[1] for w in pre.warps}
    warps, switched, dropped, seen = [], [], collections.Counter(), set()
    for f, line, src, x, y, name, dst, dx, dy in re_s.warps:
        if SKIP_SCRIPTS.search(f) or line in pre_lines:
            continue
        if not ((src in listed and (dst in listed or dst in old)) or (src in old and dst in listed)):
            if src in listed or dst in listed:
                dropped[(src, dst, "not listed")] += 1
            continue
        if line in seen:
            continue
        seen.add(line)
        w = (f, line, src, x, y, name, dst, dx, dy)
        if dst in staged and src not in staged:
            dropped[(src, dst, "into a staged map")] += 1
        elif dst in quest and src not in closed:
            busy = crowded(src, x, y, name) if src in old else []
            if busy:
                dropped[(src, dst, f"crowds pre-renewal's {busy[0][2]}; needs a gate")] += 1
            else:
                switched.append(w)
        else:
            warps.append(w)
    for (src, dst, why), n in sorted(dropped.items()):
        notes.append(f"left out: {n} portal(s) {src} -> {dst} ({why})")

    sprites = set(re.findall(r"export_constant_npc\(JT_(\w+)\)",
                             open(f"{rathena}/src/map/script_constants.hpp", errors="ignore").read()))
    gates = read_csv("gates.csv")
    for g in gates:
        if not g["sprite"].isdigit() and g["sprite"] not in sprites:
            errors.append(f"gate {g['id']}: rAthena has no NPC sprite {g['sprite']!r}")
        for k in ("x", "y", "to_x", "to_y"):
            g[k] = int(g[k])
        if g["switch"] not in ("", SWITCH):
            errors.append(f"gate {g['id']}: switch must be empty or {SWITCH}, not {g['switch']!r}")

    # --- names --------------------------------------------------------------
    ours = collections.Counter([unique_name(w[5]) for w in warps + switched] + [f"{g['name']}#rw_{g['id']}" for g in gates])
    for n, c in ours.items():
        if c > 1:
            errors.append(f"name used {c} times by this mod: {n}")
        if n in pre.names:
            errors.append(f"name already taken in pre-renewal: {n}")
        if len(n) > NAME_MAX:
            errors.append(f"name longer than {NAME_MAX}: {n}")

    # --- cells --------------------------------------------------------------
    for g in gates:
        where = f"gate {g['id']} ({g['map']},{g['x']},{g['y']})"
        if g["map"] not in listed and g["map"] not in old:
            errors.append(f"{where}: stands on {g['map']}, which is neither listed nor in pre-renewal")
        if g["to_map"] not in listed and g["to_map"] not in old:
            errors.append(f"{where}: sends to {g['to_map']}, which is neither listed nor in pre-renewal")
        if g["to_map"] in staged and g["map"] not in staged:
            errors.append(f"{where}: leads into staged {g['to_map']}; make the map open or quest first")
        if g["to_map"] in quest and g["map"] not in closed and not g["switch"]:
            errors.append(f"{where}: leads into quest map {g['to_map']}, so it needs switch {SWITCH}")
        # A portal must have a cell you can step on in its area. Someone you
        # talk to may stand on a wall or a pier's edge, as long as you can get close.
        near = 1 if g["kind"] == "touch" else TALK_REACH   # a portal's area reaches 1 cell out
        if not any(walkable(g["map"], g["x"] + dx, g["y"] + dy)
                   for dx in range(-near, near + 1) for dy in range(-near, near + 1)):
            errors.append(f"{where}: no walkable cell within {near} in pre-renewal")
        if not walkable(g["to_map"], g["to_x"], g["to_y"]):
            errors.append(f"{where}: destination {g['to_map']},{g['to_x']},{g['to_y']} is not walkable")
        if g["map"] in old:
            for t in crowded(g["map"], g["x"], g["y"], None):
                errors.append(f"{where}: within {KEEP_CLEAR} cells of pre-renewal's {t[2]} at {t[0]},{t[1]}")
    for f, line, src, x, y, name, dst, dx, dy in warps + switched:
        if src in old and line not in {s[1] for s in switched}:
            for t in crowded(src, x, y, name):
                errors.append(f"portal {name} ({src},{x},{y}): within {KEEP_CLEAR} cells of pre-renewal's {t[2]} at {t[0]},{t[1]}")
        if not walkable(dst, dx, dy):
            if dst in old and src not in staged:
                errors.append(f"portal {name}: lands on an unwalkable cell {dst},{dx},{dy} in pre-renewal")
            else:
                notes.append(f"portal {name}: lands on an unwalkable cell {dst},{dx},{dy}"
                             + (" in pre-renewal; fix before opening" if dst in old else " (as in renewal)"))

    # --- the world graph, with the switch off and on ------------------------
    OLD = "<pre-renewal world>"
    node = lambda mp: OLD if mp in old else mp

    def world(with_switch):
        fwd, back = collections.defaultdict(set), collections.defaultdict(set)
        edges = [(w[2], w[6]) for w in warps + (switched if with_switch else [])]
        edges += [(g["map"], g["to_map"]) for g in gates if with_switch or not g["switch"]]
        for a, b in edges:
            fwd[node(a)].add(node(b))
            back[node(b)].add(node(a))
        return reach(fwd), reach(back)

    def reach(edges):
        seen, todo = {OLD}, [OLD]
        while todo:
            for v in edges.get(todo.pop(), ()):
                if v not in seen:
                    seen.add(v)
                    todo.append(v)
        return seen

    off_in, off_out = world(False)
    on_in, on_out = world(True)
    for mp in listed:
        if mp in staged:
            if mp in on_in:
                errors.append(f"{mp}: staged, but a way in from the pre-renewal world reaches it")
            elif mp not in on_out:
                notes.append(f"{mp}: staged, and no way back to the pre-renewal world once opened")
        elif mp in quest:
            if mp in off_in:
                errors.append(f"{mp}: quest map, but it can be reached with {SWITCH} off")
            if mp not in on_in:
                errors.append(f"{mp}: quest map with no way in, even with {SWITCH} on")
            if mp not in on_out:
                errors.append(f"{mp}: quest map with no way back to the pre-renewal world")
        else:
            if mp not in off_in:
                errors.append(f"{mp}: no way in from the pre-renewal world")
            if mp not in off_out:
                errors.append(f"{mp}: no way back to the pre-renewal world")

    # --- map flags ----------------------------------------------------------
    have = {(m, fl, v) for _, m, fl, v in pre.flags}
    flags, fseen = [], set()
    for f, m, fl, v in re_s.flags:
        key = (m, fl, v)
        if m in listed and fl in WANTED_FLAGS and key not in have and key not in fseen:
            fseen.add(key)
            flags.append(key)

    # --- render -------------------------------------------------------------
    gen = "// Generated by registry/tools/renewal-world/build.py from rAthena's renewal scripts. Do not edit:\n" \
          "// change maps.csv / gates.csv there and run it with --write.\n"
    order = {r["map"]: i for i, r in enumerate(rows)}
    sort_key = lambda w: (order.get(w[2], -1), w[2], w[0], w[3], w[4])
    by_region = collections.defaultdict(list)
    for w in sorted(warps, key=sort_key):
        by_region[listed.get(w[2]) or listed.get(w[6])].append(w)
    out_w = [gen, "// Warp portals, copied from renewal as they are. A portal into a quest area\n"
                  f"// from outside is in when/{SWITCH}/ instead, with that area's gates.\n"]
    for region in dict.fromkeys(r["region"] for r in rows):
        if by_region.get(region):
            maps_of = [m for m, r in listed.items() if r == region]
            tag = (" (staged: no way in yet)" if all(m in staged for m in maps_of) else
                   f" (quest area: way in behind {SWITCH})" if all(m in closed for m in maps_of) else "")
            out_w.append(f"\n//== {region}{tag} " + "=" * 50 + "\n")
            out_w += [w[1] + "\n" for w in by_region[region]]
    out_g = [gen, "// Gates: the entrances renewal keeps behind a quest, an instance or a ship.\n"]
    for g in gates:
        if not g["switch"]:
            out_g.append("\n" + gate_script(g))
    out_q = [gen, f"// Loaded only while the mod's \"{SWITCH}\" setting is on: the ways into the\n"
                  "// areas renewal keeps behind episode quests.\n"]
    if switched:
        out_q.append("\n// Renewal's own portals into them.\n")
        out_q += [w[1] + "\n" for w in sorted(switched, key=sort_key)]
    for g in gates:
        if g["switch"]:
            out_q.append("\n" + gate_script(g))
    out_f = [gen, "// Map flags, copied from renewal.\n\n"]
    for m, fl, v in sorted(flags, key=lambda k: (order[k[0]], k[1])):
        out_f.append(f"{m}\tmapflag\t{fl}" + (f"\t{v}" if v else "") + "\n")

    files = {OUT_WARPS: "".join(out_w), OUT_GATES: "".join(out_g), OUT_FLAGS: "".join(out_f),
             OUT_QUEST: "".join(out_q)}
    n_sw = sum(1 for g in gates if g["switch"])
    summary = (f"{len(listed)} maps in {len(set(listed.values()))} regions "
               f"({len(listed) - len(closed)} open, {len(quest)} quest, {len(staged)} staged); "
               f"{len(warps)} portals and {len(gates) - n_sw} gates always on, "
               f"{len(switched)} portals and {n_sw} gates behind {SWITCH}; {len(flags)} map flags")
    return files, errors, notes, summary


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--rathena", default=os.environ.get("RATHENA_DIR", os.path.join(ROOT, "vendor/rathena")))
    ap.add_argument("--write", action="store_true", help="write the mod's scripts")
    ap.add_argument("--check", action="store_true", help="fail if the mod's scripts are stale")
    ap.add_argument("-v", "--verbose", action="store_true", help="also list what was left out")
    a = ap.parse_args()
    if not os.path.isdir(f"{a.rathena}/npc/re"):
        sys.exit(f"no rAthena checkout at {a.rathena} (use --rathena or RATHENA_DIR)")
    files, errors, notes, summary = build(a.rathena)
    if a.verbose:
        for n in notes:
            print("  " + n)
    for e in errors:
        print("ERROR: " + e, file=sys.stderr)
    print(summary)
    if errors:
        sys.exit(f"{len(errors)} error(s); nothing written")
    stale = [p for p, text in files.items()
             if not os.path.exists(os.path.join(MOD, p)) or open(os.path.join(MOD, p), encoding="utf-8").read() != text]
    if a.check:
        if stale:
            sys.exit("stale: " + ", ".join(stale) + " (run build.py --write)")
        print("up to date")
    elif a.write:
        for p, text in files.items():
            os.makedirs(os.path.dirname(os.path.join(MOD, p)), exist_ok=True)
            with open(os.path.join(MOD, p), "w", encoding="utf-8", newline="\n") as fh:
                fh.write(text)
        print("wrote " + ", ".join(files))
    else:
        print("would write " + ", ".join(files) + (" (changed: " + ", ".join(stale) + ")" if stale else " (unchanged)"))


if __name__ == "__main__":
    main()
