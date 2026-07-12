#!/bin/bash
set -euo pipefail

cd "$(dirname "$0")"

if [ -z "${_DEPLOY_REEXECED:-}" ]; then
    echo "→ Syncing deploy script + compose config..."
    git pull --ff-only
    export _DEPLOY_REEXECED=1
    exec "$0" "$@"
fi

SERVER_NAME="${SERVER_NAME:-einburgerungstest.sarmatt.online}"
COMPOSE="docker compose -f compose.yaml -f compose.prod.yaml"

if [ ! -f .env.local ]; then
    echo "✗ .env.local is missing. Copy .env.local.dist and fill it in." >&2
    exit 1
fi
if ! grep -qE '^QUIZ_SECRET=.+' .env.local; then
    echo "✗ QUIZ_SECRET is not set in .env.local — refusing to deploy." >&2
    exit 1
fi

echo "→ Pulling prebuilt image from GHCR..."
$COMPOSE pull

echo "→ Starting stack..."
$COMPOSE up -d --wait --remove-orphans

echo "→ Forcing fresh app container..."
$COMPOSE up -d --force-recreate --no-deps app

SMOKE_URL="https://${SERVER_NAME}/healthz"
echo "→ Smoke test: ${SMOKE_URL}"
smoke_ok=""
for attempt in $(seq 1 15); do
    code="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 15 "$SMOKE_URL" 2>/dev/null || true)"
    if [ -n "$code" ] && [ "$code" -ge 200 ] && [ "$code" -lt 400 ]; then
        smoke_ok=1; echo "  ✓ served HTTP ${code}"; break
    fi
    echo "  …attempt ${attempt}/15: got '${code:-no response}', retrying in 6s"
    sleep 6
done
if [ -z "$smoke_ok" ]; then
    echo "✗ Smoke test failed: ${SMOKE_URL} never returned 2xx/3xx." >&2
    echo "  Check: edge network exists and both stacks are attached; CADDY_EXTRA_CONFIG" >&2
    echo "  is set in mastobot's .env.local and its php container was recreated since;" >&2
    echo "  DNS points here." >&2
    $COMPOSE ps
    exit 1
fi

echo "→ Cleaning up old images..."
docker image prune -f

echo "→ Status:"
$COMPOSE ps

echo "✓ Deploy done!"
