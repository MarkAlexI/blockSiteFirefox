#!/usr/bin/env bash
# Pinned Developer Edition supports unsigned persistent add-ons in test profiles.
set -euo pipefail
test "$(uname -s)" = Darwin
: "${RUNNER_TEMP:?GitHub runner temporary directory is required}"
: "${GITHUB_ENV:?GitHub environment file is required}"

root="$RUNNER_TEMP/bd-firefox"
mountpoint="$RUNNER_TEMP/bd-firefox-image"
mkdir -p "$root" "$mountpoint"
curl --fail --location --retry 2 --connect-timeout 20 --max-time 180 \
  'https://archive.mozilla.org/pub/devedition/releases/158.0b2/mac/en-US/Firefox%20158.0b2.dmg' \
  -o "$root/firefox.dmg"
curl --fail --location --retry 2 --connect-timeout 20 --max-time 180 \
  'https://github.com/mozilla/geckodriver/releases/download/v0.37.1/geckodriver-v0.37.1-macos.tar.gz' \
  -o "$root/geckodriver.tar.gz"
# Mozilla's release SHA256SUMS and the geckodriver release asset digest.
# Both archives contain universal macOS binaries (arm64 and x86_64).
printf '%s  %s\n' \
  854cb4380a658164a0478ea8a5c89f4e2608b803a17ce14e1e9fca97c8fcbec5 "$root/firefox.dmg" \
  d02b3f7003f999caf90974a2ef5da0286c05d01cee19112c86846d759fdba4f5 "$root/geckodriver.tar.gz" \
  | shasum -a 256 --check

hdiutil attach -readonly -nobrowse -mountpoint "$mountpoint" "$root/firefox.dmg"
trap 'hdiutil detach "$mountpoint"' EXIT
ditto "$mountpoint/Firefox Developer Edition.app" "$root/Firefox Developer Edition.app"
hdiutil detach "$mountpoint"
trap - EXIT
tar -xzf "$root/geckodriver.tar.gz" -C "$root"

# The fixture uses openssl req -addext; macOS's system LibreSSL is insufficient.
openssl_prefix="$(brew --prefix openssl@3)"
if test ! -x "$openssl_prefix/bin/openssl"; then
  HOMEBREW_NO_AUTO_UPDATE=1 HOMEBREW_NO_INSTALL_CLEANUP=1 brew install openssl@3
fi
browser="$root/Firefox Developer Edition.app/Contents/MacOS/firefox"
test -x "$browser"
test -x "$root/geckodriver"
test -x "$openssl_prefix/bin/openssl"
printf '%s\n' "BD_FIREFOX_BINARY=$browser" "BD_GECKODRIVER=$root/geckodriver" \
  "BD_OPENSSL=$openssl_prefix/bin/openssl" >> "$GITHUB_ENV"
"$root/geckodriver" --version
"$openssl_prefix/bin/openssl" version
file "$browser" "$root/geckodriver"
