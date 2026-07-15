#!/bin/sh
set -eu
SOURCE="${VIGIL_PHONE_BLOCKLIST:-$SRCROOT/../../data/adult-blocklist.sdi}"
if [ ! -f "$SOURCE" ] && [ -n "${HOME:-}" ]; then
  SOURCE="$HOME/Library/Application Support/Vigil/adult-blocklist.sdi"
fi
if [ -f "$SOURCE" ]; then
  cp "$SOURCE" "$TARGET_BUILD_DIR/$UNLOCALIZED_RESOURCES_FOLDER_PATH/adult-blocklist.sdi"
elif [ "${CONFIGURATION:-}" = "Release" ]; then
  echo "error: adult-blocklist.sdi is required for Release builds; refresh the adult blocklist first" >&2
  exit 1
else
  echo "warning: adult-blocklist.sdi is absent; Debug builds use the documented development fallback"
fi
