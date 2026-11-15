#!/usr/bin/env bash
# Creates the career-cards serve service on Koyeb (local-starter mode).
#
# Free tier: 512 MB RAM, 0.1 vCPU, 1 service.
# Requires a credit card at signup ($29 pre-auth hold, cancelled immediately).
# Idle: scales to zero after 1 h with no inbound traffic.
# Sources verified 2026-11-15:
#   https://www.koyeb.com/docs/faqs/pricing
#   https://www.koyeb.com/docs/reference/instances
#   https://www.koyeb.com/docs/build-and-deploy/cli/reference
#
# Prerequisites:
#   - koyeb CLI installed and logged in (koyeb login)
#   - Secrets created with: koyeb secrets create <NAME>  (see DEPLOY.md § Koyeb)
#   - Env vars exported: JOBS_BOARD_ID, PROFILES_BOARD_ID, SYSTEM_BOARD_ID
#
# Usage:
#   source ~/.config/career-cards/koyeb.env
#   bash deploy/koyeb/create.sh
#
# For a fork, override the image:
#   IMAGE=ghcr.io/<you>/career-cards:main bash deploy/koyeb/create.sh

set -euo pipefail

APP="${KOYEB_APP:-career-cards-worker}"
IMAGE="${IMAGE:-ghcr.io/samartemberlin/career-cards:main}"
REGION="${KOYEB_REGION:-fra}"   # fra = Frankfurt; was = Washington DC

echo "app: $APP  image: $IMAGE  region: $REGION"

koyeb apps create "$APP" 2>/dev/null || echo "app $APP already exists, continuing"

# Public image — no registry secret needed.
# Secrets referenced via {{secret.NAME}} are looked up at deploy time.
# If the service creation fails with "unknown instance type", run
# `koyeb instance-types list` to find the free-tier type name and update
# the --instance-type flag below.
koyeb services create serve \
  --app "$APP" \
  --docker "$IMAGE" \
  --instance-type free \
  --regions "$REGION" \
  --ports 8080:http \
  --checks 8080:http:/healthz \
  --checks-grace-period 15 \
  --env "JOBS_BOARD_ID=${JOBS_BOARD_ID:?set JOBS_BOARD_ID}" \
  --env "PROFILES_BOARD_ID=${PROFILES_BOARD_ID:?set PROFILES_BOARD_ID}" \
  --env "SYSTEM_BOARD_ID=${SYSTEM_BOARD_ID:?set SYSTEM_BOARD_ID}" \
  --env "PUBLIC_URL=" \
  --env "TRELLO_KEY={{secret.TRELLO_KEY}}" \
  --env "TRELLO_TOKEN={{secret.TRELLO_TOKEN}}" \
  --env "TRELLO_APP_SECRET={{secret.TRELLO_APP_SECRET}}" \
  --env "TRIGGER_SECRET={{secret.TRIGGER_SECRET}}" \
  --env "GEMINI_API_KEY={{secret.GEMINI_API_KEY}}" \
  --env "OPENROUTER_API_KEY={{secret.OPENROUTER_API_KEY}}" \
  --env "GROQ_API_KEY={{secret.GROQ_API_KEY}}"
# Note: --wait is intentionally omitted. The service starts with an empty PUBLIC_URL,
# which causes it to crash immediately (PUBLIC_URL is required). Get the URL from
# https://app.koyeb.com, then fill it in step 2 below; the service starts successfully
# on the next deploy. This matches the Northflank "leave PUBLIC_URL empty for now" pattern.

echo ""
echo "Done. Next steps:"
echo "  1. Copy the service URL from https://app.koyeb.com"
echo "  2. koyeb services update serve --app $APP --env PUBLIC_URL=<URL>"
echo "     (The service will restart and start accepting traffic.)"
echo "  3. node tools/onboard.ts --url <URL> <onboard flags>"
echo "  4. Add SERVE_URL=<URL> as a GitHub repo VARIABLE (Settings → Variables → Actions)"
echo "     and TRIGGER_SECRET as a repo secret. This enables the nightly trigger workflow."
