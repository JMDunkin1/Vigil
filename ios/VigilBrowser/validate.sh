#!/bin/sh
set -eu
ROOT=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
plutil -lint "$ROOT/VigilBrowser/Info.plist" "$ROOT/VigilBrowser/PrivacyInfo.xcprivacy" "$ROOT/VigilBrowser/VigilBrowser.entitlements" "$ROOT/VigilSafariExtension/Info.plist" "$ROOT/VigilSafariExtension/VigilSafariExtension.entitlements" >/dev/null
plutil -lint "$ROOT/VigilBrowser.xcodeproj/project.pbxproj" >/dev/null
python3 -m json.tool "$ROOT/VigilSafariExtension/Resources/manifest.json" >/dev/null
python3 -m json.tool "$ROOT/Deployment/managed-extension.json" >/dev/null
if command -v node >/dev/null 2>&1; then
  node --check "$ROOT/VigilSafariExtension/Resources/ContentSafety.js"
  node --check "$ROOT/VigilSafariExtension/Resources/content.js"
  node --check "$ROOT/VigilSafariExtension/Resources/history-bridge.js"
fi
if xcodebuild -version >/dev/null 2>&1; then
  xcodebuild -project "$ROOT/VigilBrowser.xcodeproj" -scheme VigilBrowser -destination 'generic/platform=iOS Simulator' -derivedDataPath /tmp/VigilBrowserDerivedData CODE_SIGNING_ALLOWED=NO build
else
  echo "Static validation passed; full Xcode is not selected, so the iOS compile was skipped."
fi
