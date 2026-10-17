#!/usr/bin/env bash
# Enter scribblr's development environment (Node.js, and Chromium for the tests on Linux) via Nix.
#
#   ./shell.sh                  open an interactive shell
#   ./shell.sh -c <command…>    run a single command inside the environment, e.g.
#                               ./shell.sh -c npm run build
#                               ./shell.sh -c "npm test && npm run test:e2e"
#
# Commands run from the repository root. npm dependencies are installed automatically on first use.
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")"

if ! command -v nix >/dev/null 2>&1; then
  echo "shell.sh: Nix is not installed. See \"Install Nix\" in README.md." >&2
  exit 1
fi

nix_develop=(nix --extra-experimental-features "nix-command flakes" --option warn-dirty false develop)

usage() { echo "usage: ./shell.sh [-c <command…>]" >&2; exit 2; }

if [[ $# -eq 0 ]]; then
  exec "${nix_develop[@]}"
elif [[ "$1" == "-c" ]]; then
  shift
  [[ $# -gt 0 ]] || usage
  exec "${nix_develop[@]}" --command bash -c "$*"
else
  usage
fi
