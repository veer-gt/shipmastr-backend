#!/usr/bin/env bash
set -euo pipefail
set -f

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/deployment-governance.sh"

[[ "$#" -eq 0 ]] || {
  echo "SHIPMASTR_DEPLOYMENT_BLOCKED=ARGUMENTS_NOT_SUPPORTED" >&2
  exit 64
}

shipmastr_deployment_guard staging
export SHIPMASTR_GOVERNED_WRAPPER=1
exec /bin/bash "$SCRIPT_DIR/deploy-staging.implementation.sh"
