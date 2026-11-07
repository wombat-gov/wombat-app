#!/usr/bin/env bash
# Generate the menu-bar icons from the WOMBAT face.
#
#   ./scripts/make-tray-icons.sh [source.png]
#
# Produces src/assets/tray.png / tray@2x.png (normal) and
# tray-alert.png / tray-alert@2x.png (red dot for "server unreachable").
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
APP_DIR="$(cd "$HERE/.." && pwd)"
SRC="${1:-$APP_DIR/../waf2p.github.io/images/wombat-face.png}"
OUT="$APP_DIR/src/assets"
CHROME="${CHROME_BIN:-/Applications/Google Chrome.app/Contents/MacOS/Google Chrome}"

if [[ ! -f "$SRC" ]]; then
  echo "source image not found: $SRC" >&2
  exit 1
fi

mkdir -p "$OUT"
sips -z 20 20 "$SRC" --out "$OUT/tray.png" >/dev/null
sips -z 40 40 "$SRC" --out "$OUT/tray@2x.png" >/dev/null

if [[ ! -x "$CHROME" ]]; then
  echo "Chrome not found; alert icon not generated" >&2
  exit 1
fi

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

cat > "$WORK/alert.html" <<HTML
<!doctype html>
<html><head><meta charset="utf-8">
<style>
  html, body { margin:0; width:80px; height:80px; background:transparent; }
  .face { position:absolute; left:2px; top:2px; width:64px; height:64px; }
  .dot {
    position:absolute; right:2px; bottom:2px; width:26px; height:26px;
    border-radius:50%; background:#ff453a; border:4px solid #fff; box-sizing:border-box;
    box-shadow:0 0 0 1px rgba(0,0,0,.25);
  }
</style></head>
<body><img class="face" src="file://$SRC"><span class="dot"></span></body></html>
HTML

"$CHROME" --headless=new --disable-gpu --no-first-run --no-default-browser-check \
  --disable-extensions --hide-scrollbars --force-device-scale-factor=1 \
  --window-size=80,80 --default-background-color=00000000 \
  --user-data-dir="$WORK/chrome" --screenshot="$WORK/alert.png" \
  "file://$WORK/alert.html" >/dev/null 2>&1

[[ -s "$WORK/alert.png" ]] || { echo "alert icon render failed" >&2; exit 1; }
sips -z 40 40 "$WORK/alert.png" --out "$OUT/tray-alert@2x.png" >/dev/null
sips -z 20 20 "$WORK/alert.png" --out "$OUT/tray-alert.png" >/dev/null

echo "wrote tray icons to $OUT"
