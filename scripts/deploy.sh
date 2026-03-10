#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT_DIR"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

log()  { echo -e "${GREEN}[deploy]${NC} $1"; }
warn() { echo -e "${YELLOW}[deploy]${NC} $1"; }
err()  { echo -e "${RED}[deploy]${NC} $1" >&2; }

# Check wrangler auth
if ! npx wrangler whoami &>/dev/null; then
  err "Not authenticated with Cloudflare. Run: npx wrangler login"
  exit 1
fi

log "Authenticated with Cloudflare ✓"

# Parse flags
SKIP_MIGRATIONS=false
API_ONLY=false
WEB_ONLY=false

for arg in "$@"; do
  case $arg in
    --skip-migrations) SKIP_MIGRATIONS=true ;;
    --api-only) API_ONLY=true ;;
    --web-only) WEB_ONLY=true ;;
    --help)
      echo "Usage: ./scripts/deploy.sh [--skip-migrations] [--api-only] [--web-only]"
      exit 0
      ;;
  esac
done

# Run D1 migrations (remote)
if [ "$SKIP_MIGRATIONS" = false ] && [ "$WEB_ONLY" = false ]; then
  log "Running D1 migrations (remote)..."
  npx wrangler d1 migrations apply agent-registry --remote
  log "Migrations applied ✓"
fi

# Deploy API to Workers
if [ "$WEB_ONLY" = false ]; then
  log "Deploying API to Cloudflare Workers..."
  npx wrangler deploy
  log "API deployed ✓"
fi

# Build and deploy frontend to Pages
if [ "$API_ONLY" = false ]; then
  log "Building frontend..."
  cd packages/web
  npm run build
  cd "$ROOT_DIR"

  log "Deploying frontend to Cloudflare Pages..."
  npx wrangler pages deploy packages/web/dist --project-name auth-ai-web
  log "Frontend deployed ✓"
fi

log "🚀 Deployment complete!"
