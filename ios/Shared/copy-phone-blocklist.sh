#!/bin/sh
set -eu

SOURCE="${VIGIL_PHONE_BLOCKLIST:-$SRCROOT/../../data/adult-blocklist.sdi}"
if [ ! -f "$SOURCE" ] && [ -n "${HOME:-}" ]; then
  SOURCE="$HOME/Library/Application Support/Vigil/adult-blocklist.sdi"
fi

DESTINATION="$TARGET_BUILD_DIR/$UNLOCALIZED_RESOURCES_FOLDER_PATH/adult-blocklist.sdi"
if [ -f "$SOURCE" ]; then
  cp "$SOURCE" "$DESTINATION"
elif [ "${CONFIGURATION:-}" = "Release" ]; then
  echo "error: adult-blocklist.sdi is required for Release builds; run npm run adult:blocklist:refresh first" >&2
  exit 1
else
  echo "warning: adult-blocklist.sdi is absent; Debug builds use the explicit-site fallback"
fi
