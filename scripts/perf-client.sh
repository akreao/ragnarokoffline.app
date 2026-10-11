#!/usr/bin/env bash
# Build a measurable client from a roBrowserLegacy fork branch and install it
# into the rotest world.
#
#   scripts/perf-client.sh build <fork-ref> <out-dir>   # <fork-ref> + the PerfProbe branch, patched, built
#   scripts/perf-client.sh install <out-dir>            # serve <out-dir>/dist/Web from the world (hold the lock)
#
# The fork checkout is ~/Projects/roBrowserLegacy (FORK to change it). The ref
# is merged with fork/perf-probe (PROBE to change it) in a throwaway worktree,
# so the measured build has window.roPerf. The app's client patches are applied
# with this repo's scripts/patch-client.sh, as the release build does.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
FORK="${FORK:-$HOME/Projects/roBrowserLegacy}"
PROBE="${PROBE:-fork/perf-probe}"
WORLD="${RO_E2E_WORLD:-$HOME/Downloads/ragnarokoffline.app/artifacts/agent-world}"

case "${1:-}" in
build)
    REF="${2:?ref}"; OUT="$(mkdir -p "${3:?out-dir}" && cd "$3" && pwd)"
    WT="$OUT/wt"; SRC="$OUT/src"
    rm -rf "$WT" "$SRC"
    git -C "$FORK" worktree add -q --detach "$WT" "$REF"
    trap 'git -C "$FORK" worktree remove --force "$WT" 2>/dev/null || true' EXIT
    if ! git -C "$WT" -c user.name=perf -c user.email=perf@local merge -q --no-edit "$PROBE"; then
        # The only expected conflict: two imports added beside each other.
        for f in $(git -C "$WT" diff --name-only --diff-filter=U); do
            sed -i '/^<<<<<<< /d; /^=======\r\?$/d; /^>>>>>>> /d' "$WT/$f"
        done
        git -C "$WT" add -A
        git -C "$WT" -c user.name=perf -c user.email=perf@local commit -q --no-edit
    fi
    mkdir -p "$SRC"
    git -C "$WT" ls-files -z | (cd "$WT" && xargs -0 cp --parents -t "$SRC")
    ln -s "$FORK/node_modules" "$SRC/node_modules"
    RAGNAROK_ROBROWSER_DIR="$SRC" bash "$ROOT/scripts/patch-client.sh" > "$OUT/patch.log" 2>&1
    (cd "$SRC" && npm run build:all) > "$OUT/build.log" 2>&1
    bash "$ROOT/scripts/patch-bundle.sh" "$SRC/dist/Web" > /dev/null
    grep -q roPerfOverlay "$SRC/dist/Web/Online.js" || { echo "built, but without PerfProbe" >&2; exit 1; }
    echo "$SRC/dist/Web"
    ;;
install)
    WEB="$(cd "${2:?out-dir}" && pwd)/src/dist/Web"
    [ -f "$WEB/Online.js" ] || { echo "no build at $WEB" >&2; exit 1; }
    DEST="$WORLD/runtime/vendor/roBrowserLegacy/dist"
    [ -d "$DEST/Web.pinned" ] || cp -r "$DEST/Web" "$DEST/Web.pinned"
    rm -rf "$DEST/Web" && cp -r "$WEB" "$DEST/Web"
    echo "world now serves $WEB"
    ;;
*) sed -n '2,12p' "$0"; exit 2 ;;
esac
