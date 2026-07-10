#!/usr/bin/env bash
set -eu

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
tmp_dir=$(mktemp -d "${TMPDIR:-/tmp}/pitr-readonly-verifier.XXXXXX")
tmp_script="$tmp_dir/pitr-readonly-verify.mjs"

cleanup() {
  rm -rf "$tmp_dir"
}
trap cleanup EXIT HUP INT TERM

if base64 --help 2>&1 | grep -q -- '--decode'; then
  base64 < "$script_dir/pitr-readonly-verify.mjs" | base64 --decode > "$tmp_script"
else
  base64 < "$script_dir/pitr-readonly-verify.mjs" | base64 -D > "$tmp_script"
fi

if [ "${DRY_RUN:-0}" = "1" ]; then
  set -- --dry-run "$@"
fi

node "$tmp_script" "$@"
