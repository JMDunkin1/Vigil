#!/bin/sh
set -eu
ROOT=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
plutil -lint "$ROOT/SentinelBrowser/Info.plist" "$ROOT/SentinelBrowser/SentinelBrowser.entitlements" "$ROOT/SentinelSafariExtension/Info.plist" "$ROOT/SentinelSafariExtension/SentinelSafariExtension.entitlements" >/dev/null
plutil -lint "$ROOT/SentinelBrowser.xcodeproj/project.pbxproj" >/dev/null
python3 -m json.tool "$ROOT/SentinelSafariExtension/Resources/manifest.json" >/dev/null
python3 -m json.tool "$ROOT/Deployment/managed-extension.json" >/dev/null
if command -v node >/dev/null 2>&1; then
  node --check "$ROOT/SentinelSafariExtension/Resources/ContentSafety.js"
  node --check "$ROOT/SentinelSafariExtension/Resources/content.js"
fi
if xcodebuild -version >/dev/null 2>&1; then
  xcodebuild -project "$ROOT/SentinelBrowser.xcodeproj" -scheme SentinelBrowser -destination 'generic/platform=iOS Simulator' -derivedDataPath /tmp/SentinelBrowserDerivedData CODE_SIGNING_ALLOWED=NO build
else
  echo "Static validation passed; full Xcode is not selected, so the iOS compile was skipped."
fi
