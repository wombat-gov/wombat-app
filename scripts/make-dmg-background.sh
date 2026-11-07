#!/usr/bin/env bash
# Generate the DMG installer background from the WOMBAT airfield artwork.
#
#   ./scripts/make-dmg-background.sh [source.png]
#
# Produces build/background.png (540x380) and build/background@2x.png
# (1080x760). dmg-builder combines the pair into a Retina TIFF.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
APP_DIR="$(cd "$HERE/.." && pwd)"
SRC="${1:-$APP_DIR/../wafpass-dashboard/public/flight-map-bg.png}"
OUT2X="$APP_DIR/build/background@2x.png"
OUT1X="$APP_DIR/build/background.png"
CHROME="${CHROME_BIN:-/Applications/Google Chrome.app/Contents/MacOS/Google Chrome}"

if [[ ! -f "$SRC" ]]; then
  echo "background source not found: $SRC" >&2
  exit 1
fi
if [[ ! -x "$CHROME" ]]; then
  echo "Google Chrome is required to render the DMG background (set CHROME_BIN)" >&2
  exit 1
fi

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
mkdir -p "$APP_DIR/build"

cat > "$WORK/dmg.html" <<HTML
<!doctype html>
<html><head><meta charset="utf-8">
<style>
  html, body { margin:0; width:1080px; height:760px; overflow:hidden; background:#050b12; }
  .bg { position:absolute; inset:0; }
  .bg img { width:100%; height:100%; object-fit:cover; object-position:50% 50%; display:block; }
  .shade {
    position:absolute; inset:0;
    background:
      radial-gradient(85% 75% at 50% 52%, rgba(3,9,16,0) 0%, rgba(3,9,16,.18) 62%, rgba(3,9,16,.58) 100%),
      linear-gradient(180deg, rgba(3,9,16,.62) 0%, rgba(3,9,16,.10) 30%, rgba(3,9,16,.12) 62%, rgba(3,9,16,.66) 100%);
  }
  .arrow { position:absolute; left:540px; top:440px; transform:translate(-50%,-50%); opacity:.8; }
  .hint {
    position:absolute; left:0; right:0; bottom:30px; text-align:center;
    color:rgba(255,255,255,.82);
    font:600 13px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    letter-spacing:.18em; text-transform:uppercase;
    text-shadow:0 1px 6px rgba(0,0,0,.7);
  }
</style></head>
<body>
  <div class="bg"><img src="file://$SRC"></div>
  <div class="shade"></div>
  <svg class="arrow" width="220" height="84" viewBox="0 0 220 84">
    <path d="M8 42 H168" stroke="rgba(255,255,255,.72)" stroke-width="4" stroke-dasharray="11 11" stroke-linecap="round" fill="none"/>
    <path d="M148 22 L184 42 L148 62" stroke="rgba(255,255,255,.72)" stroke-width="4" stroke-linecap="round" stroke-linejoin="round" fill="none"/>
  </svg>
  <div class="hint">Drag to Applications</div>
</body></html>
HTML

"$CHROME" --headless=new --disable-gpu --no-first-run --no-default-browser-check \
  --disable-extensions --hide-scrollbars --force-device-scale-factor=1 \
  --window-size=1080,760 --user-data-dir="$WORK/chrome" \
  --screenshot="$OUT2X" "file://$WORK/dmg.html" >/dev/null 2>&1

[[ -s "$OUT2X" ]] || { echo "background render failed" >&2; exit 1; }
sips -z 380 540 "$OUT2X" --out "$OUT1X" >/dev/null

echo "wrote $OUT2X and $OUT1X from $SRC"
