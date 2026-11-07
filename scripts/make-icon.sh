#!/usr/bin/env bash
# Generate build/icon.icns from the WOMBAT mascot.
#
#   ./scripts/make-icon.sh [source.png]
#
# Default source is the high-resolution waving mascot from the brand kit. The
# artwork is composed into an Apple-style rounded tile with headless Chrome,
# then sliced into every iconset size.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
APP_DIR="$(cd "$HERE/.." && pwd)"
MASCOT="${1:-$APP_DIR/../waf2p.github.io/images/brand/mascot/full/wombat-wave.png}"
OUT="$APP_DIR/build/icon.icns"
CHROME="${CHROME_BIN:-/Applications/Google Chrome.app/Contents/MacOS/Google Chrome}"

if [[ ! -f "$MASCOT" ]]; then
  echo "mascot not found: $MASCOT" >&2
  exit 1
fi

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
ICONSET="$WORK/icon.iconset"
MASTER="$WORK/icon-1024.png"
mkdir -p "$ICONSET" "$APP_DIR/build"

if [[ -x "$CHROME" ]]; then
  cat > "$WORK/icon.html" <<HTML
<!doctype html>
<html><head><meta charset="utf-8">
<style>
  html, body { margin:0; width:1024px; height:1024px; background:transparent; }
  .tile {
    position:absolute; left:100px; top:100px; width:824px; height:824px;
    border-radius:185px; overflow:hidden; background:#0d1c26;
    box-shadow: inset 0 0 0 2px rgba(255,255,255,.07);
  }
  .tile img {
    width:100%; height:100%; object-fit:cover; object-position:50% 20%;
    display:block;
  }
</style></head>
<body><div class="tile"><img src="file://$MASCOT"></div></body></html>
HTML
  "$CHROME" --headless=new --disable-gpu --no-first-run --no-default-browser-check \
    --disable-extensions --hide-scrollbars --force-device-scale-factor=1 \
    --window-size=1024,1024 --default-background-color=00000000 \
    --user-data-dir="$WORK/chrome" --screenshot="$MASTER" \
    "file://$WORK/icon.html" >/dev/null 2>&1 || true
fi

# Fallback: rasterise the vector avatar if Chrome is unavailable.
if [[ ! -s "$MASTER" ]]; then
  qlmanage -t -s 1024 -o "$WORK" \
    "$APP_DIR/../waf2p.github.io/images/brand/mascot/wombat-avatar.svg" >/dev/null 2>&1
  MASTER="$WORK/wombat-avatar.svg.png"
  [[ -s "$MASTER" ]] || { echo "could not render an icon master" >&2; exit 1; }
fi

resize() {
  sips -z "$1" "$1" "$MASTER" --out "$ICONSET/$2" >/dev/null
}

resize 16   icon_16x16.png
resize 32   icon_16x16@2x.png
resize 32   icon_32x32.png
resize 64   icon_32x32@2x.png
resize 128  icon_128x128.png
resize 256  icon_128x128@2x.png
resize 256  icon_256x256.png
resize 512  icon_256x256@2x.png
resize 512  icon_512x512.png
resize 1024 icon_512x512@2x.png

iconutil -c icns "$ICONSET" -o "$OUT"
cp "$MASTER" "$APP_DIR/build/icon.png"
if command -v node >/dev/null 2>&1; then
  node "$APP_DIR/scripts/make-win-icon.mjs"
fi
echo "wrote $OUT, build/icon.png and build/icon.ico from $MASCOT"
