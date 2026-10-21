#!/usr/bin/env bash
# Sign the macOS app bundle that "wails build" produced.
#
# Wails does not sign the bundle and the Go linker only leaves an ad-hoc
# signature on the Mach-O binary. macOS treats such a bundle as broken: as
# soon as the file carries the quarantine attribute that Safari adds to every
# download, opening it fails with "Orbit SSH is damaged and can't be opened".
# Signing the bundle as a whole fixes that, and a Developer ID signature with
# a stapled notarization ticket removes the Gatekeeper prompt entirely.
set -euo pipefail

identity='-'
keychain=''
notarize=0
app_path=''

usage() {
    cat <<'EOF'
Usage: scripts/sign-macos.sh <app-bundle> [options]

  --identity <id>   codesign identity. "-" (default) signs ad-hoc, a
                    "Developer ID Application: ..." identity signs for real.
  --keychain <path> Keychain that holds the identity. Defaults to the
                    default keychain.
  --notarize        Also submit the bundle to the notary service and staple
                    the ticket. Needs APPLE_ID, APPLE_APP_SPECIFIC_PASSWORD
                    and APPLE_TEAM_ID in the environment.
  -h, --help        Show this help.
EOF
}

while [ $# -gt 0 ]; do
    case "$1" in
        --identity) identity="$2"; shift 2 ;;
        --keychain) keychain="$2"; shift 2 ;;
        --notarize) notarize=1; shift ;;
        -h|--help) usage; exit 0 ;;
        --) shift; break ;;
        -*) echo "Unknown option: $1" >&2; usage >&2; exit 1 ;;
        *) app_path="$1"; shift ;;
    esac
done

if [ -z "$app_path" ]; then
    echo 'Usage: scripts/sign-macos.sh <app-bundle> [options]' >&2
    exit 1
fi
if [ ! -d "$app_path" ]; then
    echo "Not an app bundle: $app_path" >&2
    exit 1
fi
if [ "$(uname -s)" != 'Darwin' ]; then
    echo 'Run this script on macOS.' >&2
    exit 1
fi

run() {
    echo "+ $*"
    "$@"
}

# The hardened runtime is required for notarization and keeps the keychain
# access of the app stable. An ad-hoc signature cannot carry a timestamp, so
# only a real identity gets one.
sign_args=(--force --options runtime --sign "$identity")
if [ "$identity" != '-' ]; then
    sign_args+=(--timestamp)
    if [ -n "$keychain" ]; then
        sign_args+=(--keychain "$keychain")
    fi
fi
run codesign "${sign_args[@]}" "$app_path"
run codesign --verify --deep --strict --verbose=2 "$app_path"

if [ "$notarize" -eq 1 ]; then
    for name in APPLE_ID APPLE_APP_SPECIFIC_PASSWORD APPLE_TEAM_ID; do
        if [ -z "${!name:-}" ]; then
            echo "Missing $name; cannot notarize." >&2
            exit 1
        fi
    done
    staging="$(mktemp -d)"
    trap 'rm -rf "$staging"' EXIT
    # The notary service takes an archive, so zip the bundle first.
    run ditto -c -k --sequesterRsrc --keepParent "$app_path" "$staging/OrbitSSH-notarize.zip"
    run xcrun notarytool submit "$staging/OrbitSSH-notarize.zip" \
        --apple-id "$APPLE_ID" \
        --password "$APPLE_APP_SPECIFIC_PASSWORD" \
        --team-id "$APPLE_TEAM_ID" \
        --wait
    # Stapling puts the ticket into the bundle, so the release zip carries it.
    run xcrun stapler staple "$app_path"
    run xcrun stapler validate "$app_path"
    run codesign --verify --deep --strict --verbose=2 "$app_path"
fi

run codesign -dv --verbose=2 "$app_path"
