#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
umask 077

# Render assigns the HTTPS URL and listening port. Keep explicit overrides available
# for a custom domain; never derive the trusted browser origin from request headers.
export SENTINEL_PORT="${SENTINEL_PORT:-${PORT:-10000}}"
export SENTINEL_PUBLIC_ORIGIN="${SENTINEL_PUBLIC_ORIGIN:-${RENDER_EXTERNAL_URL:?Render must provide its public HTTPS URL}}"
export SENTINEL_DATA_DIR="${SENTINEL_DATA_DIR:-./data}"
mkdir -p "$SENTINEL_DATA_DIR"
chmod 700 "$SENTINEL_DATA_DIR"
exec node dist/server.js
