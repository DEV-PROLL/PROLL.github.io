#!/bin/zsh
set -euo pipefail

SCRIPT_DIR="${0:A:h}"
REPO_DIR="${SCRIPT_DIR}/../../.."

export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:${PATH:-}"
export NODE_ENV="production"

cd "${REPO_DIR}"

if [[ -f bridge/.env ]]; then
  set -a
  source bridge/.env
  set +a
fi

exec node bridge/dist/index.js
