# Sourced by build-remoteclient.sh and build-docker-slim.sh.
#
# When a pin is exactly a tagged release, that release already carries a
# binary its own CI built from the same commit, so fetching it is the same
# program without a minute-long release build on every runner. Anything else
# -- a dependency PR's commit, a host the release has no binary for -- still
# builds from source. A tag is matched by commit, never by name, so this can
# no more pick up "whichever release is latest" than the build could.

# The host as `<os>/<arch>`, with every Windows bash spelled the same way.
pinned_host() {
    case "$(uname -s)" in
        Darwin) echo "macos/$(uname -m)" ;;
        Linux) echo "linux/$(uname -m)" ;;
        MINGW*|MSYS*|CYGWIN*) echo "windows/$(uname -m)" ;;
        *) echo unknown ;;
    esac
}

# The tag on github.com/<owner/repo> whose commit is <sha>, or nothing.
pinned_release_tag() {
    git ls-remote --tags "https://github.com/$1.git" 'v*' 2>/dev/null |
        awk -v sha="$2" '$1 == sha { tag = $2; sub("^refs/tags/", "", tag); sub("\\^\\{\\}$", "", tag); print tag; exit }'
}

# Download one asset of release <tag> to <dest>; fails, rather than exits, on a
# miss so the caller can build instead.
pinned_release_fetch() {
    echo "Fetching $3 from $1 $2"
    curl -fsSL --retry 3 -o "$4" "https://github.com/$1/releases/download/$2/$3"
}
