#!/usr/bin/env python3
"""Regenerate the "Client draws" column of docs/mods/MONSTER_LOOKS.md's hat effects.

    scripts/hat-effects-doc.py --iro ~/iRO/data.grf --kro ~/kRO/data.grf          # what would change
    scripts/hat-effects-doc.py --iro ~/iRO/data.grf --kro ~/kRO/data.grf --write  # change it

Run it after the roBrowserLegacy pin moves, or for a newer client. For each row
it reads what the client's own hat effect tables say about that number
(`luafiles514/lua files/hateffectinfo/` in the GRF: hateffectids.lub,
hateffectinfo.lub, footprinteffectinfo.lub) and whether roBrowser at the pinned
commit draws it (src/DB/Effects/EffectTable.js and the tables spread into it,
and src/Renderer/Effects/Footprints.js for the footprints). With
both clients, the column is iRO's and a row where kRO differs says so in
brackets; with one, it is that client's.

`--robrowser DIR` reads roBrowser's files from a checkout instead of the pin, to
see what a fork branch would change. Only the last column is written; the
constant and item columns, and the rows themselves, are left as they are.

Needs python3, node and lua5.1. It reads the player's GRFs, so it is not run
in CI.
"""
import argparse
import json
import re
import shutil
import struct
import subprocess
import sys
import tempfile
import zlib
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DOC = ROOT / "docs/mods/MONSTER_LOOKS.md"
TABLES = "data/luafiles514/lua files/hateffectinfo/"
ROW = re.compile(r"^\| (\d+) \| (.*) \| (.*) \| (.*) \|$")


def grf_files(path, wanted):
    """{name: bytes} for the files in `wanted` (lower-case, / separated) a GRF holds."""
    with open(path, "rb") as f:
        header = f.read(46)
        if header[:15].split(b"\0")[0] not in (b"Master of Magic", b"Event Horizon"):
            raise SystemExit(f"{path}: not a GRF")
        low, high, count, version = struct.unpack("<IIII", header[30:46])
        # A 0x300 archive written with the 0x200 layout (as scripts/grfls.py).
        if version == 0x300 and high >> 8:
            version = 0x200
        if version == 0x200:
            table_at, count = low + 46, count - high - 7
        elif version == 0x300:
            table_at = (high << 32) + low + 46 + 4
        else:
            raise SystemExit(f"{path}: GRF version {version:#x} unsupported")
        f.seek(table_at)
        packed, _ = struct.unpack("<II", f.read(8))
        table = zlib.decompress(f.read(packed))
        tail = 17 if version == 0x200 else 21
        found, i = {}, 0
        for _ in range(count):
            end = table.index(b"\0", i)
            raw = table[i:end]
            i = end + 1
            size, _, real, flags = struct.unpack("<IIIB", table[i:i + 13])
            offset = struct.unpack("<I" if version == 0x200 else "<Q", table[i + 13:i + tail])[0]
            i += tail
            name = raw.decode("cp949", "replace").replace("\\", "/").lower()
            if name in wanted and flags & 1:
                if flags & 6:
                    raise SystemExit(f"{path}: {name} is encrypted")
                f.seek(offset + 46)
                found[name.rsplit("/", 1)[1]] = zlib.decompress(f.read(size))
    return found


def local_size_t():
    out = subprocess.run(["lua5.1", "-e", "io.write(string.dump(function() end):sub(1, 12))"],
                         capture_output=True, check=True).stdout
    return out[8]


def widen(chunk, size_t):
    """Lua 5.1 bytecode as the local lua5.1 reads it: clients ship size_t = 4."""
    if not chunk.startswith(b"\x1bLua"):
        return chunk  # source, not bytecode
    if chunk[8] == size_t:
        return chunk
    if (chunk[8], size_t) != (4, 8):
        raise SystemExit(f"bytecode with size_t {chunk[8]}; this lua5.1 has {size_t}")
    out, p = bytearray(chunk[:12]), 12
    out[8] = 8

    def take(n):
        nonlocal p
        out.extend(chunk[p:p + n])
        p += n

    def i32():
        v = struct.unpack_from("<i", chunk, p)[0]
        take(4)
        return v

    def string():
        nonlocal p
        n = struct.unpack_from("<I", chunk, p)[0]
        p += 4
        out.extend(struct.pack("<Q", n))
        take(n)

    def function():
        string()
        i32()
        i32()
        take(4)
        take(4 * i32())
        for _ in range(i32()):
            kind = chunk[p]
            take(1)
            take({1: 1, 3: 8}.get(kind, 0)) if kind != 4 else string()
        for _ in range(i32()):
            function()
        take(4 * i32())
        for _ in range(i32()):
            string()
            i32()
            i32()
        for _ in range(i32()):
            string()

    function()
    return bytes(out)


DUMP = r"""
dofile(arg[1])
dofile(arg[2])
for id, v in pairs(hatEffectTable) do
	io.write("H\t", id, "\t", v.resourceFileName or "", "\t", v.hatEffectID or "", "\n")
end
if arg[3] then
	dofile(arg[3])
	for id, v in pairs(FootPrintEffectTable or {}) do
		-- Some STR footprints have only the top animation.
		local str = v.StrFile_Bottom_Left
		if str == nil or str == "" then str = v.StrFile_Top_Left end
		io.write("F\t", id, "\t", v.Type or "", "\t", v.PngFile_Left or "", "\t", str or "", "\n")
	end
end
"""


def client_tables(grf, work):
    """({hat effect: (file, effect number)}, {footprint id: (type, file)}) for one client."""
    files = grf_files(grf, {TABLES + n for n in ("hateffectids.lub", "hateffectinfo.lub", "footprinteffectinfo.lub")})
    for need in ("hateffectids.lub", "hateffectinfo.lub"):
        if need not in files:
            raise SystemExit(f"{grf}: no {TABLES}{need}")
    size_t = local_size_t()
    paths = []
    for name in ("hateffectids.lub", "hateffectinfo.lub", "footprinteffectinfo.lub"):
        if name in files:
            p = work / f"{Path(grf).parent.name}-{name}"
            p.write_bytes(widen(files[name], size_t))
            paths.append(str(p))
    script = work / "dump.lua"
    script.write_text(DUMP)
    out = subprocess.run(["lua5.1", str(script), *paths], capture_output=True, check=True).stdout
    hats, feet = {}, {}
    for line in out.decode("cp949", "replace").splitlines():
        cols = line.split("\t")
        if cols[0] == "H":
            hats[int(cols[1])] = (cols[2], int(float(cols[3])) if cols[3] else None)
        elif cols[0] == "F":
            # Type 3 is a PNG on the ground, type 4 STR animations.
            kind = int(float(cols[2])) if cols[2] else None
            feet[int(cols[1])] = (kind, cols[3] if kind == 3 else cols[4])
    return hats, feet


def robrowser_effects(source, work):
    """({effect number: EF_ name}, {numbers roBrowser's effect table has}, {footprint types it draws})."""
    def read(rel):
        if isinstance(source, Path):
            return (source / rel).read_text(encoding="utf-8", errors="replace")
        return subprocess.run(["git", "-C", str(ROOT / "vendor/roBrowserLegacy"), "show", f"{source}:{rel}"],
                              capture_output=True, check=True, text=True, errors="replace").stdout

    names = {int(n): k for k, n in re.findall(r"^\s*(EF_\w+):\s*(\d+)", read("src/DB/Effects/EffectConst.js"), re.M)}
    # Top-level entries, one tab in.
    table = read("src/DB/Effects/EffectTable.js")
    have = {int(n) for n in re.findall(r"^\t(\d+):\s*[\[{]", table, re.M)}
    # Tables spread into it from files of their own, written the same way.
    spread = set(re.findall(r"^\t\.\.\.(\w+)", table, re.M))
    for name, rel in re.findall(r"^import (\w+) from '(DB/Effects/\w+)\.js'", table, re.M):
        if name in spread and name != "LevelAuraEffects":
            have |= {int(n) for n in re.findall(r"^\t(\d+):", read(f"src/{rel}.js"), re.M)}
    # LevelAuraEffects.js builds part of its table in loops, so run it, with
    # its renderers stubbed out.
    mod = work / "aura"
    mod.mkdir()
    (mod / "stub.mjs").write_text("export default class {}\n")
    (mod / "AuraTiers.mjs").write_text(read("src/DB/Effects/AuraTiers.js"))
    level = read("src/DB/Effects/LevelAuraEffects.js")
    level = re.sub(r"from '(Renderer/Effects/\w+)\.js'", "from './stub.mjs'", level)
    level = level.replace("from 'DB/Effects/AuraTiers.js'", "from './AuraTiers.mjs'")
    (mod / "LevelAuraEffects.mjs").write_text(level)
    keys = subprocess.run(
        ["node", "-e", "import(process.argv[1]).then(m => console.log(JSON.stringify(Object.keys(m.default))))",
         (mod / "LevelAuraEffects.mjs").as_uri()],
        capture_output=True, check=True, text=True).stdout
    have |= {int(k) for k in json.loads(keys)}
    # Footprints.js draws a footprint type when FootprintTrail.drop handles it.
    try:
        footprints = read("src/Renderer/Effects/Footprints.js")
    except (OSError, subprocess.CalledProcessError):
        footprints = ""
    feet = {int(n) for n in re.findall(r"info\.type [!=]== (\d)", footprints)}
    return names, have, feet


def draws(hats, feet, names, have, drawn_feet, i):
    if i not in hats and i in feet:
        kind, file = feet[i]
        what = {3: "a PNG footprint", 4: "a STR footprint"}.get(kind, "a footprint")
        if kind in drawn_feet and file:
            return f"{what}, `" + file.replace("\\", "/") + "`"
        return f"nothing: {what}, which roBrowser does not draw yet"
    if i not in hats:
        return "nothing: no entry in the client's table"
    res, eff = hats[i]
    if res:
        return "`" + res.replace("\\", "/") + "`"
    name = names.get(eff)
    if eff in have:
        return f"`{name}` (effect {eff})" if name else f"effect {eff}"
    if name:
        return f"nothing: `{name}` is not in roBrowser's effect table"
    return f"nothing: effect {eff} is not in roBrowser's effect table"


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--iro", help="an iRO data.grf")
    ap.add_argument("--kro", help="a kRO data.grf")
    ap.add_argument("--robrowser", type=Path, help="a roBrowserLegacy checkout to read instead of the pin")
    ap.add_argument("--doc", type=Path, default=DOC)
    ap.add_argument("--write", action="store_true", help="rewrite the column instead of listing changes")
    args = ap.parse_args()
    clients = [(tag, grf) for tag, grf in (("iRO", args.iro), ("kRO", args.kro)) if grf]
    if not clients:
        ap.error("give --iro, --kro or both")
    for tool in ("lua5.1", "node", "git"):
        if not shutil.which(tool):
            raise SystemExit(f"{tool} is not installed")

    if args.robrowser:
        source = args.robrowser.resolve()
    else:
        pins = (ROOT / "config/VENDOR_PINS").read_text()
        source = re.search(r"^roBrowserLegacy\s+\S+\s+([0-9a-f]{40})", pins, re.M).group(1)
        repo = ROOT / "vendor/roBrowserLegacy"
        if subprocess.run(["git", "-C", str(repo), "cat-file", "-e", source], capture_output=True).returncode:
            subprocess.run(["git", "-C", str(repo), "fetch", "-q", "origin", source], check=True)

    with tempfile.TemporaryDirectory() as tmp:
        work = Path(tmp)
        names, have, drawn_feet = robrowser_effects(source, work)
        tables = [(tag, *client_tables(grf, work)) for tag, grf in clients]

    lines = args.doc.read_text(encoding="utf-8").split("\n")
    changed, drawn, rows = [], 0, 0
    for n, line in enumerate(lines):
        m = ROW.match(line)
        if not m:
            continue
        rows += 1
        i = int(m.group(1))
        first = draws(*tables[0][1:], names, have, drawn_feet, i)
        new = first
        for tag, hats, feet in tables[1:]:
            other = draws(hats, feet, names, have, drawn_feet, i)
            if other != first:
                new = f"{first} ({tag}: {other})"
        drawn += not first.startswith("nothing")
        if new != m.group(4):
            changed.append((i, m.group(2), m.group(4), new))
            lines[n] = f"| {i} | {m.group(2)} | {m.group(3)} | {new} |"

    print(f"{rows} hat effects, {drawn} drawn on {tables[0][0]}; "
          f"roBrowser at {source if isinstance(source, Path) else source[:12]}")
    for i, const, old, new in changed:
        print(f"  {i} {const}\n    was: {old}\n    now: {new}")
    if args.write:
        args.doc.write_text("\n".join(lines), encoding="utf-8")
        print(f"{len(changed)} rows written to {args.doc.relative_to(ROOT) if args.doc.is_relative_to(ROOT) else args.doc}")
    elif changed:
        print(f"{len(changed)} rows would change; --write to write them")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
