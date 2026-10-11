#!/usr/bin/env python3
"""Build the friendlier-refine mod's refine tables from rAthena's own.

rAthena keeps one refine table per era (db/re/refine.yml, db/pre-re/refine.yml).
For each era this writes, into the mod's era folder:

    db/refine.yml                          rAthena's whole table with every
                                           BreakingRate taken out, and Clear: true
                                           so it replaces the stock one: the file
                                           a player edits
    db/when/allow_break/refine.yml         rAthena's BreakingRate values, put back
    db/when/revert_from_NN/refine.yml      DowngradeAmount 0 below +NN, 1 from +NN up

The app merges a ticked setting's db/when/<key>/ copy after the mod's own, and
rAthena reads a repeated entry as an update of the fields it names, so each
switched part only carries the one field it is about.

Breaking is the switch that adds, not the one that takes away, because an
import cannot set a BreakingRate back to 0: rAthena refuses a rate of 0 ("needs
to be at least 1") and drops the whole entry. A rate that was never written is
0, so the cleared table without them is the one where nothing breaks.

    python3 build_refine.py            show what would be written
    python3 build_refine.py --write    write the mod's tables
    python3 build_refine.py --check    fail if the mod's tables are stale

--rathena (or RATHENA_DIR) points at the checkout; the default is the app's
vendor/rathena. Python 3, no packages. Nothing here runs in the game.
"""
import argparse
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.normpath(os.path.join(HERE, "../../.."))
MOD = os.path.join(ROOT, "registry/mods/friendlier-refine")
# rAthena's folder for each era, and the mod's era folder (mod.json
# "renewalFolder" / "prerenewalFolder") its tables go into.
ERAS = {"re": "renewal", "pre-re": "pre-renewal"}
# The refine levels a "revert_from_NN" setting can start at. Keep in step with
# the settings in mod.json; a level an era does not reach writes no file.
REVERT_FROM = [5, 7, 9, 11]

HEADER = """Header:
  Type: REFINE_DB
  Version: 2
"""
# The main table replaces rAthena's instead of adding to it, so the breaking
# rates it leaves out are gone rather than kept from the stock table.
HEADER_CLEAR = """Header:
  Type: REFINE_DB
  Version: 2
  Clear: true
"""


def parse(path):
    """rAthena's refine.yml as [(group, item level, refine level, type, fields)].

    The file is regular enough to read by indentation, which keeps this free
    of a YAML package. Anything it does not expect is an error, not a guess.
    """
    rows = []
    group = item_level = refine_level = None
    chance = None
    for number, line in enumerate(open(path, encoding="utf-8"), 1):
        text = line.split("#", 1)[0].rstrip()
        if not text.strip():
            continue
        indent = len(text) - len(text.lstrip())
        key, _, value = text.strip().lstrip("- ").partition(":")
        value = value.strip()
        dash = text.strip().startswith("- ")
        if indent == 2 and dash and key == "Group":
            group = value
        elif indent == 6 and dash and key == "Level":
            item_level = int(value)
        elif indent == 10 and dash and key == "Level":
            refine_level = int(value)
        elif indent == 14 and dash and key == "Type":
            chance = {"Type": value}
            rows.append((group, item_level, refine_level, value, chance))
        elif indent == 16 and chance is not None:
            chance[key] = value
        elif indent >= 12 and key not in ("Bonus", "RandomBonus", "BlacksmithBlessingAmount",
                                          "BroadcastSuccess", "BroadcastFailure", "Chances"):
            sys.exit(f"{path}:{number}: unexpected {key!r}; the refine.yml layout changed")
    if not rows:
        sys.exit(f"{path}: no refine chances found")
    return rows


def table(rows, field, value_of, intro):
    """A refine.yml holding one field per chance, in rAthena's own order.

    value_of may return a list of (field, value) pairs instead of one value,
    to write several fields per chance.
    """
    out = [intro, HEADER, "Body:"]  # adds to the mod's own table
    last_group = last_level = last_refine = None
    for group, item_level, refine_level, kind, chance in rows:
        value = value_of(refine_level, chance)
        if value is None:
            continue
        if group != last_group:
            out.append(f"  - Group: {group}\n    Levels:")
            last_level = last_refine = None
        if item_level != last_level:
            out.append(f"      - Level: {item_level}\n        RefineLevels:")
            last_refine = None
        if refine_level != last_refine:
            out.append(f"          - Level: {refine_level}\n            Chances:")
        pairs = value if isinstance(value, list) else [(field, value)]
        out.append(f"              - Type: {kind}")
        out.extend(f"                {name}: {v}" for name, v in pairs)
        last_group, last_level, last_refine = group, item_level, refine_level
    return "\n".join(out) + "\n"


def stock_breaks(rows, refine_level):
    return any(r[2] == refine_level and int(r[4].get("BreakingRate", 0)) > 0 for r in rows)


def rates_intro(era, rows):
    top = max(r[2] for r in rows)
    return f"""# friendlier-refine: the refine table, {era}.
#
# This is rAthena's own refine table (db/{"re" if era == "renewal" else "pre-re"}/refine.yml), which this one
# replaces, with every BreakingRate taken out. It is the file to edit to
# change refine chances. Each entry is one refine attempt: Group (Armor,
# Weapon, Shadow_Armor, Shadow_Weapon), the item's Level (a weapon's level,
# 1-{5 if era == "renewal" else 4}), the refine Level it is trying to reach (Level: 5 is the attempt
# from +4 to +5, up to +{top}), and the ore used (Type: Normal, Enriched{", HD" if era == "renewal" else ""}).
#
#   Rate             chance of success, out of 10000. 10000 never fails,
#                    6000 is 60%, so the failure chance is 10000 minus this.
#                    The lowest rAthena accepts is 1; it refuses 0.
#   DowngradeAmount  refine levels a failed attempt takes off, when the item
#                    does not break. 0 keeps its level.
#
# The other fields (Bonus, Price, Material, ...) are rAthena's too, and are
# described at the top of rAthena's own copy.
#
# Change any value, then restart the server (Settings -> Mods -> Apply, or
# quit and start the game again): the table is read once, when the server
# starts. An update of this mod replaces this file, so keep a copy of your
# changes.
#
# The mod's settings add to this file (db/when/ in this folder):
# "Failed refines can break items" puts rAthena's BreakingRate values back,
# from db/when/allow_break/refine.yml, and a ticked "Revert from +N" replaces
# every DowngradeAmount here with its own, from db/when/revert_from_NN/
# refine.yml. To change how many levels a failure takes off while one of
# those is ticked, edit that file instead: replace "DowngradeAmount: 1" with
# the number of levels (up to {top}).
"""


def main_table(path, era, rows):
    """rAthena's table as it is, but with Clear: true and no BreakingRate.

    Copied line by line rather than rebuilt, so every field rAthena has, now
    or later, comes across unchanged.
    """
    text = open(path, encoding="utf-8").read().replace("\r\n", "\n")
    body = text[text.index("\nBody:\n") + 1:]
    # A Footer would carry Imports, and this file is the import.
    if "\nFooter:" in body:
        body = body[:body.index("\nFooter:")]
    kept = [line for line in body.split("\n") if line.strip().split(":")[0] != "BreakingRate"]
    return rates_intro(era, rows) + "\n" + HEADER_CLEAR + "\n" + "\n".join(kept).rstrip("\n") + "\n"


def build(rathena):
    files = {}
    for src, era in ERAS.items():
        path = os.path.join(rathena, "db", src, "refine.yml")
        if not os.path.isfile(path):
            sys.exit(f"{path} not found; pass --rathena or set RATHENA_DIR")
        rows = parse(path)
        top = max(r[2] for r in rows)
        files[f"{era}/db/refine.yml"] = main_table(path, era, rows)
        files[f"{era}/db/when/allow_break/refine.yml"] = table(
            rows, "BreakingRate", lambda _, c: c.get("BreakingRate"),
            "# friendlier-refine, \"Failed refines can break items\": rAthena's own\n"
            "# breaking chances, out of 10000, put back into the mod's table.\n"
            "# Generated by registry/tools/friendlier-refine/build_refine.py.\n")
        for start in REVERT_FROM:
            if start > top:
                continue
            files[f"{era}/db/when/revert_from_{start:02}/refine.yml"] = table(
                rows, "DowngradeAmount", lambda level, _: 1 if level >= start else 0,
                f"# friendlier-refine, \"Revert from +{start}\": a failed attempt at +{start} or higher\n"
                f"# takes the item down one level; below +{start} a failure keeps its level.\n"
                f"# To lose more than one level, replace every \"DowngradeAmount: 1\" below\n"
                f"# with the number of levels, then restart the server.\n"
                "# Generated by registry/tools/friendlier-refine/build_refine.py.\n")
    return files


def main():
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--rathena", default=os.environ.get("RATHENA_DIR", os.path.join(ROOT, "vendor/rathena")))
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--write", action="store_true")
    mode.add_argument("--check", action="store_true")
    args = parser.parse_args()

    files = build(args.rathena)
    stale = []
    for rel, body in files.items():
        dst = os.path.join(MOD, rel)
        current = open(dst, encoding="utf-8").read() if os.path.isfile(dst) else None
        if current == body:
            continue
        stale.append(rel)
        if args.write:
            os.makedirs(os.path.dirname(dst), exist_ok=True)
            with open(dst, "w", encoding="utf-8", newline="\n") as f:
                f.write(body)
    for rel in sorted(files):
        state = ("written" if args.write else "stale") if rel in stale else "up to date"
        print(f"{rel}: {files[rel].count(chr(10))} lines, {state}")
    if args.check and stale:
        sys.exit("friendlier-refine: tables are stale; run build_refine.py --write")


if __name__ == "__main__":
    main()
