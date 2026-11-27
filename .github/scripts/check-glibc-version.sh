#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 2 ]]; then
  echo "Usage: check-glibc-version.sh <binary> <readelf-command>" >&2
  exit 2
fi

binary="$1"
readelf_command="$2"
if [[ ! -f "$binary" ]]; then
  echo "Binary not found: $binary" >&2
  exit 2
fi

version_info="$("$readelf_command" --version-info "$binary")"
highest_glibc="$(
  printf '%s\n' "$version_info" \
    | sed -nE 's/.*Name: GLIBC_([0-9]+(\.[0-9]+)+).*/\1/p' \
    | sort -V \
    | tail -n1
)"
if [[ -z "$highest_glibc" ]]; then
  echo "No numeric GLIBC version requirements found in $binary" >&2
  exit 1
fi

if [[ "$(printf '%s\n' "$highest_glibc" 2.39 | sort -V | tail -n1)" != "2.39" ]]; then
  echo "GLIBC_$highest_glibc exceeds the supported maximum GLIBC_2.39 in $binary" >&2
  exit 1
fi

printf 'Highest GLIBC requirement for %s: GLIBC_%s\n' "$binary" "$highest_glibc"
