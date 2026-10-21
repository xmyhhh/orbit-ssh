#!/usr/bin/env bash
# Build Orbit SSH for macOS. Mirrors scripts/build-windows.ps1: it runs the
# frontend and Go checks first, then hands the packaging to the Wails CLI.
set -euo pipefail

platform='darwin/arm64'
output_name=''
sign_identity='-'
package_zip=0
wails_path=''
skip_frontend=0

usage() {
    cat <<'EOF'
Usage: scripts/build-macos.sh [options]

  --platform <target>    Wails build target (default: darwin/arm64).
                         Use darwin/universal for an Apple Silicon + Intel build.
  --output-name <name>   Executable name inside Contents/MacOS.
                         Defaults to the outputfilename in wails.json.
  --sign-identity <id>   codesign identity. Use "-" for an ad-hoc signature
                         (default: "-"). Pass "none" to skip signing entirely.
  --package              Also write a distributable zip and disk image to
                         output/release.
  --skip-frontend        Reuse the existing frontend/dist and wailsjs bindings.
  --wails-path <path>    Path to the wails CLI. Defaults to the CLI on PATH,
                         then the pinned version via "go run".
  -h, --help             Show this help.
EOF
}

while [ $# -gt 0 ]; do
    case "$1" in
        --platform) platform="$2"; shift 2 ;;
        --output-name) output_name="$2"; shift 2 ;;
        --sign-identity) sign_identity="$2"; shift 2 ;;
        --wails-path) wails_path="$2"; shift 2 ;;
        --package) package_zip=1; shift ;;
        --skip-frontend) skip_frontend=1; shift ;;
        -h|--help) usage; exit 0 ;;
        *) echo "Unknown option: $1" >&2; usage >&2; exit 1 ;;
    esac
done

if [ "$(uname -s)" != 'Darwin' ]; then
    echo 'Run this script on macOS.' >&2
    exit 1
fi
case "$platform" in
    darwin/arm64|darwin/amd64|darwin/universal) ;;
    *) echo "Unsupported platform: $platform" >&2; exit 1 ;;
esac
case "$output_name" in
    */*) echo 'Output name must not contain a path separator.' >&2; exit 1 ;;
esac

repo_path="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
wails_version='v2.11.0'

run() {
    echo "+ $*"
    "$@"
}

# Prefer an installed CLI, then fall back to the version pinned by the repo.
resolve_wails() {
    if [ -n "$wails_path" ]; then
        wails_path="$(cd "$(dirname "$wails_path")" && pwd)/$(basename "$wails_path")"
        return
    fi
    if command -v wails >/dev/null 2>&1; then
        wails_path="$(command -v wails)"
        return
    fi
    wails_path=''
}

run_wails() {
    resolve_wails
    if [ -n "$wails_path" ]; then
        run "$wails_path" "$@"
    else
        run go run "github.com/wailsapp/wails/v2/cmd/wails@$wails_version" "$@"
    fi
}

cd "$repo_path"

if [ "$skip_frontend" -eq 0 ]; then
    # The frontend imports the generated Wails bindings, but generating them
    # needs frontend/dist to exist for the Go embed. Seed it like Wails does.
    if [ ! -d "$repo_path/frontend/wailsjs" ]; then
        mkdir -p "$repo_path/frontend/dist"
        touch "$repo_path/frontend/dist/gitkeep"
        run_wails generate module
    fi
    pushd frontend >/dev/null
    if [ ! -d node_modules ]; then
        run npm ci --no-audit --no-fund
    fi
    run npm test
    run npm run build
    popd >/dev/null
fi

# Go embeds frontend/dist; finish the frontend build before the Go checks.
if [ ! -d "$repo_path/frontend/dist" ]; then
    echo 'frontend/dist is missing; run without --skip-frontend first.' >&2
    exit 1
fi
run go test ./...
run go test -tags androidtest ./...
run go vet ./...

build_args=(build -s -m -nosyncgomod -trimpath -platform "$platform" -nocolour)
if [ -n "$output_name" ]; then
    build_args+=(-o "$output_name")
fi
# Drop stale bundles so the one picked up below is always the fresh build.
mkdir -p "$repo_path/build/bin"
find "$repo_path/build/bin" -maxdepth 1 -name '*.app' -exec rm -rf {} +
run_wails "${build_args[@]}"

# Wails names the bundle after the project; a universal build appends the arch.
bin_dir="$repo_path/build/bin"
app_path="$(find "$bin_dir" -maxdepth 1 -name '*.app' -type d -print -quit)"
if [ -z "$app_path" ]; then
    echo "Build did not produce an .app bundle in $bin_dir" >&2
    exit 1
fi

if [ "$sign_identity" != 'none' ]; then
    # Sign the bundle so the Keychain and the notification centre see one
    # stable code identity across rebuilds. The same script signs the CI
    # artifacts, so a local build and a release build are signed alike.
    run "$repo_path/scripts/sign-macos.sh" "$app_path" --identity "$sign_identity"
fi

binary_path="$(find "$app_path/Contents/MacOS" -maxdepth 1 -type f -print -quit)"
if [ -z "$binary_path" ]; then
    echo "Build did not produce an executable inside $app_path" >&2
    exit 1
fi
ls -l "$binary_path"
shasum -a 256 "$binary_path"

if [ "$package_zip" -eq 1 ]; then
    version="$(sed -n 's/.*"productVersion"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' wails.json | head -1)"
    arch="$(printf '%s' "$platform" | sed 's#darwin/##')"
    release_dir="$repo_path/output/release"
    mkdir -p "$release_dir"
    zip_name="OrbitSSH-v${version}-macos-${arch}.zip"
    dmg_name="OrbitSSH-v${version}-macos-${arch}.dmg"
    # Copy LICENSE and README next to the app so the archive is self-describing.
    staging="$(mktemp -d)"
    trap 'rm -rf "$staging"' EXIT
    cp -R "$app_path" "$staging/"
    cp "$repo_path/LICENSE" "$staging/LICENSE.txt"
    cp "$repo_path/README.md" "$staging/README.txt"
    (cd "$staging" && zip -qry "$release_dir/$zip_name" .)
    shasum -a 256 "$release_dir/$zip_name"
    echo "Packaged $release_dir/$zip_name"
    # The disk image mirrors the CI artifact: the bundle, a symlink to
    # /Applications and the same notes, so the user drags the app into place.
    image="$(mktemp -d)"
    trap 'rm -rf "$staging" "$image"' EXIT
    cp -R "$app_path" "$image/"
    ln -s /Applications "$image/Applications"
    cp "$repo_path/LICENSE" "$image/LICENSE.txt"
    cp "$repo_path/build/darwin/README.txt" "$image/README.txt"
    hdiutil create -volname "Orbit SSH" -srcfolder "$image" -ov -format UDZO \
        "$release_dir/$dmg_name"
    shasum -a 256 "$release_dir/$dmg_name"
    echo "Packaged $release_dir/$dmg_name"
fi
