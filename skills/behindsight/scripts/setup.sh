#!/bin/sh
# One-time setup: Playwright + Chromium, and HTTP Archive's open-source Wappalyzer fork.
# Wappalyzer's own Puppeteer download is skipped; the collector points it at Playwright's Chromium.
set -e
cd "$(dirname "$0")/.."

npm install --no-fund --no-audit
npx playwright install chromium

if [ ! -d vendor/wappalyzer ]; then
  git clone --depth 1 https://github.com/HTTPArchive/wappalyzer.git vendor/wappalyzer
else
  git -C vendor/wappalyzer pull --ff-only
fi

(cd vendor/wappalyzer && PUPPETEER_SKIP_DOWNLOAD=true npm install --omit=dev --no-fund --no-audit --engine-strict=false)

# The fork crashes when a detection names a technology missing from its list; skip those instead.
DRIVER=vendor/wappalyzer/src/drivers/driver.js
if ! grep -q "behindsight-patch" "$DRIVER"; then
  sed -i.bak 's|technologies: resolved.map((resolved) => {|technologies: resolved.filter((r) => Wappalyzer.technologies.some(({ name }) => name === r.name)).map((resolved) => { // behindsight-patch|' "$DRIVER" && rm -f "$DRIVER.bak"
fi

echo "Setup complete."
