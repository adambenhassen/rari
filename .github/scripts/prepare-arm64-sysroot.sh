#!/usr/bin/env bash
set -euo pipefail

if [[ $# -lt 2 ]]; then
  echo "Usage: prepare-arm64-sysroot.sh <sysroot> <package.deb>..." >&2
  exit 2
fi

sysroot="$1"
shift
mkdir -p "$sysroot"

for package in "$@"; do
  package_name="$(dpkg-deb -f "$package" Package)"
  if [[ "$package_name" == libc6-dev ]]; then
    continue
  fi
  dpkg-deb --extract "$package" "$sysroot"
done

for linker_file in libc.so libm.so libc.a libm.a; do
  linker_path="$sysroot/usr/lib/aarch64-linux-gnu/$linker_file"
  if [[ -e "$linker_path" || -L "$linker_path" ]]; then
    echo "$linker_file must resolve from the cross compiler sysroot" >&2
    exit 1
  fi
done
