#!/bin/sh
set -eu

exact_source="${VIGIL_PHONE_BLOCKLIST:-$SRCROOT/../../data/adult-blocklist.sdi}"
prefilter_source="${VIGIL_URL_FILTER_PREFILTER:-$SRCROOT/../../data/url-filter-prefilter.vuf}"
resources="${TARGET_BUILD_DIR}/${UNLOCALIZED_RESOURCES_FOLDER_PATH}"

if [ -f "$exact_source" ] && [ -f "$prefilter_source" ]; then
  install -m 0644 "$exact_source" "$resources/adult-blocklist.sdi"
  install -m 0644 "$prefilter_source" "$resources/url-filter-prefilter.vuf"
elif [ "${CONFIGURATION:-Debug}" = "Release" ]; then
  echo "error: matching adult-blocklist.sdi and url-filter-prefilter.vuf are required for URL Filter Release builds" >&2
  exit 1
else
  echo "warning: URL Filter artifacts are absent; the Debug provider will fail closed until matching artifacts are supplied"
fi
