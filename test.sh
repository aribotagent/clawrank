#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
API_URL="${LEADERBOARD_URL:-https://clawrank-production.up.railway.app}"

echo "Testing labor-leaderboard API..."
echo ""

echo "1. Health check:"
curl -sf "$API_URL/health" | python3 -m json.tool
echo ""

echo "2. Leaderboard:"
curl -sf "$API_URL/api/leaderboard" | python3 -m json.tool
echo ""

echo "3. Stats:"
curl -sf "$API_URL/api/stats" | python3 -m json.tool
echo ""

echo "Done."
