#!/bin/sh
set -eu

readonly profile_dir="${1:?profile directory is required}"

node --input-type=module --eval '
  const [{ prepareProfileDirectory }] = await Promise.all([
    import("./dist/browser-client.js"),
  ]);
  await prepareProfileDirectory(process.argv[1]);
' "$profile_dir"

exec /usr/bin/chromium \
  --user-data-dir="$profile_dir" \
  --disable-setuid-sandbox \
  --no-first-run \
  --disable-background-networking \
  --disable-component-update \
  --disable-default-apps \
  --disable-extensions \
  --disable-sync \
  https://chatgpt.com/
