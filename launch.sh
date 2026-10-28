#!/usr/bin/env bash
# Launch WebSerial-CRTK with Docker Compose (nginx: static site + NTRIP proxy), logs in the foreground.
# Images are pulled to their latest version on each launch. Ctrl+C stops the containers.
# http://localhost is a secure context: Web Serial / Web Bluetooth + service worker OK
# Usage: ./launch.sh [port]
set -euo pipefail

PORT="${1:-8080}"
URL="http://localhost:${PORT}/index.html"

cd "$(dirname "$0")"

if ! command -v docker >/dev/null 2>&1 || ! docker compose version >/dev/null 2>&1; then
    echo "Docker Compose introuvable. Installez Docker Desktop (ou le plugin docker compose)." >&2
    exit 1
fi

if ! docker info >/dev/null 2>&1; then
    echo "Le démon Docker ne répond pas. Lancez Docker Desktop puis réessayez." >&2
    exit 1
fi

if lsof -iTCP:"${PORT}" -sTCP:LISTEN >/dev/null 2>&1; then
    echo "Le port ${PORT} est déjà utilisé. Essayez : ./launch.sh $((PORT + 1))" >&2
    exit 1
fi

echo "WebSerial-CRTK sur ${URL} (Ctrl+C pour arrêter)"

# Open the browser once the site answers
(
    for _ in $(seq 1 60); do
        curl -s -o /dev/null "${URL}" && break
        sleep 1
    done
    if command -v open >/dev/null 2>&1; then
        open "${URL}"
    elif command -v xdg-open >/dev/null 2>&1; then
        xdg-open "${URL}" >/dev/null 2>&1
    fi
) &

export PORT
exec docker compose up --pull always --remove-orphans web
