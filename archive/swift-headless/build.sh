#!/bin/bash
# Builds Habitab.app (release) with the bundled `habitab` launcher.
#   ./build.sh            -> ./Habitab.app
#   ./build.sh --install  -> also copies it to ~/Applications and starts it
set -euo pipefail
cd "$(dirname "$0")"

swift build -c release --product HabitabApp
swift build -c release --product habitab

APP="Habitab.app"
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Helpers" "$APP/Contents/Resources"
cp .build/release/HabitabApp "$APP/Contents/MacOS/Habitab"
# Helpers/: on case-insensitive volumes "habitab" and "Habitab" collide in MacOS/.
cp .build/release/habitab "$APP/Contents/Helpers/habitab"

ICONSET=".build/Habitab.iconset"
if [ ! -f .build/Habitab.icns ] || [ Tools/make-icon.swift -nt .build/Habitab.icns ]; then
  rm -rf "$ICONSET"
  swift Tools/make-icon.swift "$ICONSET"
  iconutil -c icns "$ICONSET" -o .build/Habitab.icns
fi
cp .build/Habitab.icns "$APP/Contents/Resources/Habitab.icns"

VERSION="0.1.0"
cat > "$APP/Contents/Info.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>CFBundleDevelopmentRegion</key><string>de</string>
    <key>CFBundleExecutable</key><string>Habitab</string>
    <key>CFBundleIconFile</key><string>Habitab</string>
    <key>CFBundleIdentifier</key><string>dev.habitab.Habitab</string>
    <key>CFBundleInfoDictionaryVersion</key><string>6.0</string>
    <key>CFBundleName</key><string>Habitab</string>
    <key>CFBundleDisplayName</key><string>Habitab</string>
    <key>CFBundlePackageType</key><string>APPL</string>
    <key>CFBundleShortVersionString</key><string>${VERSION}</string>
    <key>CFBundleVersion</key><string>1</string>
    <key>LSMinimumSystemVersion</key><string>14.0</string>
    <key>LSApplicationCategoryType</key><string>public.app-category.developer-tools</string>
    <key>NSHighResolutionCapable</key><true/>
    <key>NSPrincipalClass</key><string>NSApplication</string>
    <key>NSAppTransportSecurity</key>
    <dict><key>NSAllowsLocalNetworking</key><true/></dict>
    <key>NSHumanReadableCopyright</key><string>Habitab – one home for your agent browsers</string>
</dict>
</plist>
EOF

codesign --force --sign - "$APP/Contents/Helpers/habitab"
codesign --force --sign - "$APP"
echo "Built $(pwd)/$APP"

if [ "${1:-}" = "--install" ]; then
  mkdir -p "$HOME/Applications"
  pkill -x Habitab 2>/dev/null || true
  rm -rf "$HOME/Applications/$APP"
  cp -R "$APP" "$HOME/Applications/$APP"
  open "$HOME/Applications/$APP"
  echo "Installed to ~/Applications/$APP"
fi
