#!/usr/bin/env bash
# Build the exact docker-slim revision the private account stdin contract expects,
# or fetch it when that revision is a release (scripts/pinned-release.sh).
# Source pinning lets an app PR consume an unmerged dependency PR reproducibly.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REF="$(tr -d '\r\n' < "$ROOT/config/DOCKER_SLIM_PIN")"
if [[ ! "$REF" =~ ^[0-9a-f]{40}$ ]]; then
    echo 'config/DOCKER_SLIM_PIN must contain one full commit SHA' >&2
    exit 1
fi
EXE=''
case "$(uname -s)" in MINGW*|MSYS*|CYGWIN*) EXE='.exe';; esac
DEST="${1:-$ROOT/bin/docker-slim$EXE}"
REPO=Flux159/nebula
. "$ROOT/scripts/pinned-release.sh"
case "$(pinned_host)" in
    macos/arm64) KIT=macos-aarch64 ;;
    linux/x86_64) KIT=linux-x86_64 ;;
    linux/aarch64) KIT=linux-aarch64 ;;
    windows/x86_64) KIT=windows-x86_64 ;;
    *) KIT='' ;;
esac
SRC="$(mktemp -d)"
trap 'rm -rf "$SRC"' EXIT
mkdir -p "$(dirname "$DEST")"
TAG="$(pinned_release_tag "$REPO" "$REF")"
# The slim CLIs archive, checked against the .sha256 published beside it.
fetch_release() {
    local asset="nebula-slim-clis-${TAG#v}-$KIT.tar.gz"
    pinned_release_fetch "$REPO" "$TAG" "$asset" "$SRC/$asset" &&
        pinned_release_fetch "$REPO" "$TAG" "$asset.sha256" "$SRC/$asset.sha256" &&
        node -e '
            const [file, sums] = process.argv.slice(1).map(f => require("node:fs").readFileSync(f));
            const actual = require("node:crypto").createHash("sha256").update(file).digest("hex");
            if (String(sums).split(/\s/)[0] !== actual) throw new Error("checksum mismatch");
        ' "$SRC/$asset" "$SRC/$asset.sha256" &&
        tar xzf "$SRC/$asset" -C "$SRC" &&
        cp "$SRC/${asset%.tar.gz}/docker-slim$EXE" "$DEST"
}
if [ -n "$TAG" ] && [ -n "$KIT" ] && fetch_release; then
    curl -fsSL --retry 3 -o "$DEST.LICENSE" "https://raw.githubusercontent.com/$REPO/$REF/LICENSE"
else
    git -C "$SRC" init -q
    git -C "$SRC" fetch --quiet --depth 1 "https://github.com/$REPO.git" "$REF"
    git -C "$SRC" checkout --quiet --detach FETCH_HEAD
    test "$(git -C "$SRC" rev-parse HEAD)" = "$REF"
    export CARGO_TARGET_DIR="${DOCKER_SLIM_CARGO_TARGET_DIR:-$ROOT/target/docker-slim}"
    cargo build --locked --release --manifest-path "$SRC/slim/Cargo.toml" -p docker-slim
    cp "$CARGO_TARGET_DIR/release/docker-slim$EXE" "$DEST"
    cp "$SRC/LICENSE" "$DEST.LICENSE"
fi
printf '%s\n' "$REF" > "$DEST.source-commit"
node - "$DEST" <<'JS'
const fs = require('node:fs');
const crypto = require('node:crypto');
const executable = process.argv[2];
const result = require('node:child_process').spawnSync(executable, ['capabilities'], { encoding: 'utf8', timeout: 10000 });
if (result.error || result.status !== 0 || !result.stdout.split(/\r?\n/).includes('exec-stdin-eof-v1')) {
    throw new Error('Built docker-slim does not support exec-stdin-eof-v1');
}
fs.writeFileSync(executable + '.sha256', crypto.createHash('sha256').update(fs.readFileSync(executable)).digest('hex') + '\n');
JS
echo "Pinned docker-slim $REF${TAG:+ ($TAG)} at $DEST"
