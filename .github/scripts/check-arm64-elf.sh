#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 1 ]]; then
  echo "Usage: check-arm64-elf.sh <file-description>" >&2
  exit 2
fi

file_description="$1"
if [[ ! "$file_description" =~ ^ELF\ 64-bit\ LSB.*ARM\ aarch64 ]]; then
  echo "Expected a 64-bit little-endian ARM aarch64 binary, got: $file_description" >&2
  exit 1
fi

printf 'Verified 64-bit little-endian ARM aarch64 ELF\n'
