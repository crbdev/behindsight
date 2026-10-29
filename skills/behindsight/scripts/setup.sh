#!/bin/sh
# One-time setup: Playwright + Chromium, and HTTP Archive's open-source Wappalyzer fork.
# Wappalyzer's own Puppeteer download is skipped; the collector points it at Playwright's Chromium.
set -e
cd "$(dirname "$0")/.."

# Node 20 or later. Setup doesn't install Node itself.
if ! command -v node >/dev/null 2>&1; then
  echo "Behindsight needs Node.js 20 or later, and Node isn't installed."
  echo "Install it from https://nodejs.org (LTS), or with 'brew install node' on macOS, or with nvm: 'nvm install --lts'."
  exit 1
fi
NODE_MAJOR=$(node -p 'process.versions.node.split(".")[0]')
if [ "$NODE_MAJOR" -lt 20 ]; then
  echo "Behindsight needs Node.js 20 or later; this machine has $(node --version)."
  echo "Update from https://nodejs.org (LTS), or with 'brew upgrade node', or with nvm: 'nvm install --lts'."
  exit 1
fi

npm install --no-fund --no-audit
npx playwright install chromium

# The Wappalyzer fork adds detections often, so setup takes the latest version and checks it runs.
# If it doesn't (an upstream change, a newer Node requirement), setup falls back to a known-good commit.
WAPPALYZER_REPO=https://github.com/HTTPArchive/wappalyzer.git
WAPPALYZER_KNOWN_GOOD=494842ce363f3d2888bfe4ed0f9e81bacc2e8dc0
DRIVER=vendor/wappalyzer/src/drivers/driver.js

install_wappalyzer() {
  rm -rf vendor/wappalyzer
  mkdir -p vendor/wappalyzer
  git -C vendor/wappalyzer init -q
  git -C vendor/wappalyzer fetch -q --depth 1 "$WAPPALYZER_REPO" "$1" || return 1
  git -C vendor/wappalyzer checkout -q FETCH_HEAD || return 1
  # The fork may declare a newer Node than it needs; --engine-strict=false lets it install anyway.
  (cd vendor/wappalyzer && PUPPETEER_SKIP_DOWNLOAD=true npm install --omit=dev --no-fund --no-audit --engine-strict=false --loglevel=error) || return 1
  # The fork crashes when a detection names a technology missing from its list; skip those instead.
  if [ -f "$DRIVER" ] && ! grep -q "behindsight-patch" "$DRIVER"; then
    sed -i.bak 's|technologies: resolved.map((resolved) => {|technologies: resolved.filter((r) => Wappalyzer.technologies.some(({ name }) => name === r.name)).map((resolved) => { // behindsight-patch|' "$DRIVER" && rm -f "$DRIVER.bak"
  fi
}

wappalyzer_works() {
  CHROMIUM_BIN=$(node -e "import('playwright').then((m) => console.log(m.chromium.executablePath()))") \
    node vendor/wappalyzer/cli.js https://example.com -w 5000 2>/dev/null | grep -q '"technologies"'
}

if install_wappalyzer HEAD && wappalyzer_works; then
  echo "Wappalyzer: latest version ($(git -C vendor/wappalyzer rev-parse --short HEAD))."
else
  echo "The latest Wappalyzer didn't pass a test run; using the known-good version instead."
  install_wappalyzer "$WAPPALYZER_KNOWN_GOOD" || echo "Wappalyzer couldn't be installed. Collection still works without it, using the network capture only."
fi

echo "Setup complete."
