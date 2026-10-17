#!/bin/bash
# Builds Studio.app: a native Mac app (Swift + WebKit) that runs the local Studio server and shows the editor.
# Usage: npm run make-app            -> ~/Applications/Studio.app
set -e
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
NODE="$(command -v node)"
CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"   # only used to render the icon
APP="${1:-$HOME/Applications/Studio.app}"
rm -rf "$APP"; mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"

# self-contained copy of the code: apps started from the Dock can't read ~/Desktop (iCloud/privacy), so nothing may point there
mkdir -p "$APP/Contents/Resources/app/projects"
cp -R "$ROOT/server" "$ROOT/editor" "$ROOT/package.json" "$ROOT/node_modules" "$APP/Contents/Resources/app/"
cp -R "$ROOT/projects/default" "$APP/Contents/Resources/app/projects/default"   # demo for the first launch

cat > "$APP/Contents/Info.plist" <<PL
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleName</key><string>Studio</string>
<key>CFBundleDisplayName</key><string>Studio</string>
<key>CFBundleIdentifier</key><string>app.aistudio.studio</string>
<key>CFBundleExecutable</key><string>Studio</string>
<key>CFBundleIconFile</key><string>icon</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleShortVersionString</key><string>1.0</string>
<key>CFBundleVersion</key><string>1</string>
<key>LSMinimumSystemVersion</key><string>13.0</string>
<key>LSApplicationCategoryType</key><string>public.app-category.graphics-design</string>
<key>NSHighResolutionCapable</key><true/>
<key>NSHumanReadableCopyright</key><string>Local design canvas for you and Claude.</string>
<key>NSAppTransportSecurity</key><dict><key>NSAllowsLocalNetworking</key><true/><key>NSAllowsArbitraryLoadsInWebContent</key><true/></dict>
<key>StudioNode</key><string>$NODE</string>
</dict></plist>
PL

# native window (Swift + WebKit). Without the Swift compiler, fall back to a Chrome app window.
build_swift() {
  command -v swiftc >/dev/null || return 1
  swiftc -O -swift-version 5 "$@" "$ROOT/mac/Studio.swift" -o "$APP/Contents/MacOS/Studio" 2>"$ROOT/.swift-build.log" && return 0
  # some Command Line Tools ship SwiftBridging twice (module.modulemap + bridging.modulemap); hide the duplicate
  local BR="/Library/Developer/CommandLineTools/usr/include/swift/bridging.modulemap"
  if [ -f "$BR" ] && grep -q "redefinition of module 'SwiftBridging'" "$ROOT/.swift-build.log"; then
    local VT; VT="$(mktemp -d)"; : > "$VT/empty.modulemap"
    printf '{"version":0,"case-sensitive":"false","roots":[{"type":"directory","name":"%s","contents":[{"type":"file","name":"bridging.modulemap","external-contents":"%s"}]}]}' "$(dirname "$BR")" "$VT/empty.modulemap" > "$VT/overlay.yaml"
    swiftc -O -swift-version 5 -vfsoverlay "$VT/overlay.yaml" -Xcc -ivfsoverlay -Xcc "$VT/overlay.yaml" "$ROOT/mac/Studio.swift" -o "$APP/Contents/MacOS/Studio" 2>"$ROOT/.swift-build.log" && { rm -rf "$VT"; return 0; }
    rm -rf "$VT"
  fi
  return 1
}
if build_swift; then
  echo "Native app compiled"
  rm -f "$ROOT/.swift-build.log"
else
  echo "Swift build failed or swiftc missing (see .swift-build.log); using the Chrome launcher"
  CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
  [ -x "$CHROME" ] || { echo "Google Chrome not found in /Applications"; exit 1; }
  cat > "$APP/Contents/MacOS/Studio" <<LAUNCH
#!/bin/bash
ROOT="\$(cd "\$(dirname "\$0")/../Resources/app" && pwd)"
URL="http://127.0.0.1:\${STUDIO_PORT:-4777}"
DATA="\$HOME/Library/Application Support/Studio"
mkdir -p "\$DATA"
STARTED=""
if ! curl -sf "\$URL/api/ping" >/dev/null 2>&1; then
  "$NODE" "\$ROOT/server/server.js" >"\$DATA/server.log" 2>&1 &
  STARTED=\$!
  for i in \$(seq 1 50); do curl -sf "\$URL/api/ping" >/dev/null 2>&1 && break; sleep 0.2; done
fi
open -n -a "Google Chrome" --args --user-data-dir="\$DATA/chrome" --app="\$URL" --window-size=1500,950 --no-first-run --no-default-browser-check
sleep 4
while pgrep -f "user-data-dir=\$DATA/chrome" >/dev/null; do sleep 2; done
[ -n "\$STARTED" ] && kill "\$STARTED" 2>/dev/null
exit 0
LAUNCH
  chmod +x "$APP/Contents/MacOS/Studio"
fi

# icon: render an SVG with headless Chrome, then build an .icns
TMP="$(mktemp -d)"
cat > "$TMP/icon.html" <<'SV'
<body style="margin:0;background:transparent"><svg width="1024" height="1024" viewBox="0 0 1024 1024" xmlns="http://www.w3.org/2000/svg"><rect x="64" y="64" width="896" height="896" rx="200" fill="#161616"/><circle cx="512" cy="512" r="230" fill="#ff4f1f"/></svg></body>
SV
"$CHROME" --headless --disable-gpu --default-background-color=00000000 --hide-scrollbars --window-size=1024,1024 --screenshot="$TMP/icon.png" "file://$TMP/icon.html" >/dev/null 2>&1 || true
if [ -f "$TMP/icon.png" ]; then
  IS="$TMP/icon.iconset"; mkdir "$IS"
  for s in 16 32 128 256 512; do
    sips -z $s $s "$TMP/icon.png" --out "$IS/icon_${s}x${s}.png" >/dev/null
    sips -z $((s*2)) $((s*2)) "$TMP/icon.png" --out "$IS/icon_${s}x${s}@2x.png" >/dev/null
  done
  iconutil -c icns "$IS" -o "$APP/Contents/Resources/icon.icns" || true
fi
rm -rf "$TMP"
touch "$APP"
echo "Built $APP"
