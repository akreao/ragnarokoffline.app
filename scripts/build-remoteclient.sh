#!/usr/bin/env bash
# Build the exact RemoteClient revision the shell's managed protocol expects,
# or fetch it when that revision is a release (scripts/pinned-release.sh).
# Source pinning lets an app PR consume an unmerged dependency PR reproducibly.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REF="$(tr -d '\r\n' < "$ROOT/config/REMOTECLIENT_PIN")"
if [[ ! "$REF" =~ ^[0-9a-f]{40}$ ]]; then
    echo 'config/REMOTECLIENT_PIN must contain one full commit SHA' >&2
    exit 1
fi
EXE=''
case "$(uname -s)" in MINGW*|MSYS*|CYGWIN*) EXE='.exe';; esac
DEST="${1:-$ROOT/bin/robrowser-remoteclient$EXE}"
REPO=Flux159/roBrowserLegacy-RemoteClient-Rust
. "$ROOT/scripts/pinned-release.sh"
case "$(pinned_host)" in
    macos/arm64) ASSET=robrowser-remoteclient-aarch64-apple-darwin ;;
    linux/x86_64) ASSET=robrowser-remoteclient-x64-unknown-linux ;;
    windows/x86_64) ASSET=robrowser-remoteclient-x64-pc-windows.exe ;;
    *) ASSET='' ;;
esac
SRC="$(mktemp -d)"
trap 'rm -rf "$SRC"' EXIT
mkdir -p "$(dirname "$DEST")"
TAG="$(pinned_release_tag "$REPO" "$REF")"
if [ -n "$TAG" ] && [ -n "$ASSET" ] && pinned_release_fetch "$REPO" "$TAG" "$ASSET" "$SRC/$ASSET"; then
    cp "$SRC/$ASSET" "$DEST"
    chmod +x "$DEST"
else
    git -C "$SRC" init -q
    git -C "$SRC" fetch --quiet --depth 1 "https://github.com/$REPO.git" "$REF"
    git -C "$SRC" checkout --quiet --detach FETCH_HEAD
    test "$(git -C "$SRC" rev-parse HEAD)" = "$REF"
    export CARGO_TARGET_DIR="${REMOTECLIENT_CARGO_TARGET_DIR:-$ROOT/target/remoteclient}"
    cargo build --locked --release --manifest-path "$SRC/Cargo.toml"
    cp "$CARGO_TARGET_DIR/release/robrowser-remoteclient$EXE" "$DEST"
fi
printf '%s\n' "$REF" > "$DEST.source-commit"
node - "$DEST" <<'JS'
const fs = require('node:fs');
const crypto = require('node:crypto');
const executable = process.argv[2];
const result = require('node:child_process').spawnSync(executable, ['--capabilities'], { encoding: 'utf8', timeout: 10000 });
if (result.error || result.status !== 0 || JSON.parse(result.stdout).managedProtocol !== 1) {
    throw new Error('Built RemoteClient does not support managed protocol 1');
}
fs.writeFileSync(executable + '.sha256', crypto.createHash('sha256').update(fs.readFileSync(executable)).digest('hex') + '\n');
JS
echo "Pinned RemoteClient $REF${TAG:+ ($TAG)} at $DEST"
