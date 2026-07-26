#!/usr/bin/env bash
set -euo pipefail
set -f

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BACKEND_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
source "$SCRIPT_DIR/deployment-governance.sh"

[[ "$#" -eq 1 ]] || {
  echo "Usage: $0 status|build" >&2
  exit 64
}

MODE="$1"
shipmastr_migration_build_guard "$MODE"

case "$MODE" in
  status)
    CONFIG="cloudbuild.migrate-status.yaml"
    ;;
  build)
    CONFIG="cloudbuild.migrate.yaml"
    ;;
  *)
    echo "SHIPMASTR_MIGRATION_BUILD_BLOCKED=MODE_NOT_ALLOWLISTED" >&2
    exit 64
    ;;
esac

cd "$BACKEND_DIR"
exec gcloud builds submit . \
  --project="$PROJECT_ID" \
  --config="$CONFIG"
