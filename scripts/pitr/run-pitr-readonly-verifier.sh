#!/usr/bin/env bash
set -eu -o pipefail

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
tmp_dir=$(mktemp -d "${TMPDIR:-/tmp}/pitr-readonly-verifier.XXXXXX")
tmp_script="$tmp_dir/pitr-readonly-verify.mjs"

cleanup() {
  rm -rf "$tmp_dir"
}
trap cleanup EXIT HUP INT TERM

bootstrap_failure() {
  printf '%s\n' '{"ok":false,"error":{"code":"WRAPPER_BOOTSTRAP_FAILED","message":"verifier bootstrap failed"}}'
  exit 2
}

[ -r "$script_dir/pitr-readonly-verify.mjs" ] || bootstrap_failure

if base64 --help 2>&1 | grep -q -- '--decode'; then
  base64 < "$script_dir/pitr-readonly-verify.mjs" | base64 --decode > "$tmp_script" || bootstrap_failure
else
  base64 < "$script_dir/pitr-readonly-verify.mjs" | base64 -D > "$tmp_script" || bootstrap_failure
fi

[ -s "$tmp_script" ] || bootstrap_failure

if [ "${DRY_RUN:-0}" = "1" ]; then
  set -- --dry-run "$@"
fi

node "$tmp_script" "$@"
