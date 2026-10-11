#!/usr/bin/env bash
# Regenerate the navigation mods' indexes of the stock rAthena scripts.
#
#   scripts/navigation-index.sh
#
# mods/navigation-server-npcs/npc-index.tsv lists what the pinned rAthena's
# scripts place, mods/navigation-server-monsters/mob-index.tsv what they spawn
# and its mob_db, and mods/navigation-server-warps/warp-index.tsv their portals,
# read from the tree the server image is built from: the pin with
# scripts/apply-server-mods.sh applied. vendor-bump.sh runs it when the rathena
# pin moves; run it yourself after changing the server mods' scripts. CI's
# server-language job fails while an index is stale.
#
# Works in a scratch checkout, so vendor/rathena is left as it is.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
bash "$ROOT/scripts/vendor-fetch.sh" rathena "$TMP/rathena"
bash "$ROOT/scripts/apply-server-mods.sh" "$TMP/rathena" >/dev/null
cargo build --locked --quiet --manifest-path "$ROOT/stack/Cargo.toml"
STACK="$ROOT/stack/target/debug/ragnarok-stack"
"$STACK" navigation-npc-index "$TMP/rathena" > "$ROOT/mods/navigation-server-npcs/npc-index.tsv"
echo "wrote mods/navigation-server-npcs/npc-index.tsv"
"$STACK" navigation-mob-index "$TMP/rathena" > "$ROOT/mods/navigation-server-monsters/mob-index.tsv"
echo "wrote mods/navigation-server-monsters/mob-index.tsv"
"$STACK" navigation-warp-index "$TMP/rathena" > "$ROOT/mods/navigation-server-warps/warp-index.tsv"
echo "wrote mods/navigation-server-warps/warp-index.tsv"
