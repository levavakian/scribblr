#!/usr/bin/env bash
# From WSL: build the extension and copy it to a folder on the Windows side, where Windows Chrome
# can load it with "Load unpacked". Run it through the dev shell:
#
#   ./shell.sh -c "npm run install:windows"
#
# The folder defaults to %USERPROFILE%\scribblr-extension; set SCRIBBLR_WINDOWS_DIR (a WSL path such
# as /mnt/c/Users/me/scribblr-extension) to use another one.
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

if [[ -z "${SCRIBBLR_WINDOWS_DIR:-}" ]]; then
  if ! grep -qi microsoft /proc/version 2>/dev/null; then
    echo "install-windows: this isn't WSL. Set SCRIBBLR_WINDOWS_DIR to choose where to copy the build." >&2
    exit 1
  fi
  if ! command -v cmd.exe >/dev/null 2>&1; then
    echo "install-windows: can't run cmd.exe to find your Windows profile (WSL interop may be off)." >&2
    echo "Set SCRIBBLR_WINDOWS_DIR, e.g. SCRIBBLR_WINDOWS_DIR=/mnt/c/Users/<you>/scribblr-extension" >&2
    exit 1
  fi
  profile="$(cd /mnt/c 2>/dev/null && cmd.exe /c 'echo %USERPROFILE%' 2>/dev/null | tr -d '\r')"
  SCRIBBLR_WINDOWS_DIR="$(wslpath -u "$profile")/scribblr-extension"
fi

node scripts/build.mjs --out "$SCRIBBLR_WINDOWS_DIR"

echo
echo "Copied the extension to:"
echo "  $(wslpath -w "$SCRIBBLR_WINDOWS_DIR" 2>/dev/null || echo "$SCRIBBLR_WINDOWS_DIR")"
echo "In Chrome, open chrome://extensions, turn on Developer mode, click \"Load unpacked\" and pick that folder."
echo "After rebuilding, click the reload icon on Scribblr's card in chrome://extensions."
