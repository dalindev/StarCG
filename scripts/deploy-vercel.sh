#!/usr/bin/env bash
# Deploy the static site to Dalin's PERSONAL Vercel scope (project: starcg-tools).
# Stages only the site files in a throwaway folder, so no .vercel link folder or dev-only file
# (proxy.py, worker.js, tests, scripts) ever lands in this repo or on the server.
#
#   scripts/deploy-vercel.sh          # production deploy
#   scripts/deploy-vercel.sh --preview
#
# First time only: vercel project add starcg-tools --scope dalin-huangs-projects
set -euo pipefail

SCOPE="dalin-huangs-projects"
PROJECT="starcg-tools"
SRC="$(cd "$(dirname "$0")/.." && pwd)"
STAGE="${STARCG_VERCEL_STAGE:-$HOME/.starcg-vercel-stage}"

mkdir -p "$STAGE"
rsync -a --delete \
  --exclude '.git' --exclude '.vercel' --exclude '.DS_Store' --exclude '__pycache__' \
  --exclude 'proxy.py' --exclude 'starcg_proxy_plus.py' --exclude 'worker.js' \
  --exclude 'scripts' --exclude 'test' --exclude '*.log' \
  "$SRC/" "$STAGE/"

# Home page = the marketplace (price checker). A static index.html would beat any rewrite for "/", so the upstream
# damage calculator is moved (in the stage only; the repo file is untouched) to its own file and stays reachable
# at /index.html (what the site menu links to) and /damage.
mv "$STAGE/index.html" "$STAGE/StarCG_DamageCalculator.html"
cat > "$STAGE/vercel.json" <<'JSON'
{
  "rewrites": [
    { "source": "/", "destination": "/StarCG_PriceChecker.html" },
    { "source": "/index.html", "destination": "/StarCG_DamageCalculator.html" },
    { "source": "/damage", "destination": "/StarCG_DamageCalculator.html" },
    { "source": "/afk", "destination": "/StarCG_AfkTracker.html" },
    { "source": "/price", "destination": "/StarCG_PriceChecker.html" }
  ]
}
JSON

# the password gate (see the header of that file); without SITE_PASSWORD on the project the site answers 503
cp "$SRC/scripts/vercel-middleware.mjs" "$STAGE/middleware.js"

cd "$STAGE"
if [ ! -f .vercel/project.json ]; then
  vercel link --yes --project "$PROJECT" --scope "$SCOPE"
fi

TARGET_ENV="production"; [ "${1:-}" = "--preview" ] && TARGET_ENV="preview"
if ! vercel env ls --scope "$SCOPE" 2>/dev/null | grep -E "^ *SITE_PASSWORD " | grep -qi "$TARGET_ENV"; then
  echo "SITE_PASSWORD is not set for $TARGET_ENV on project $PROJECT; the gate would answer 503 for everyone." >&2
  echo "Add it:  printf '%s' \"<password>\" | vercel env add SITE_PASSWORD $TARGET_ENV --sensitive --yes --scope $SCOPE" >&2
  exit 1
fi

if [ "${1:-}" = "--preview" ]; then
  vercel deploy --yes --scope "$SCOPE"
else
  vercel deploy --prod --yes --scope "$SCOPE"
fi
