#!/bin/sh
set -eu

repo_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
state_dir=${OPENCLAW_STATE_DIR:-}
config_path=${OPENCLAW_CONFIG_PATH:-}
workspace_dir=${OPENCLAW_WORKSPACE_DIR:-}
agent_dir=${OPENCLAW_AGENT_DIR:-}

if [ "${CANARY_DISPLAY_MODE:-}" != "native-stub" ] || [ "${CANARY_ALLOW_LOOPBACK_STUB:-}" != 1 ]; then
  echo "refusing fallback canary outside contained-canary.sh stub-run" >&2
  exit 78
fi
if [ -z "$state_dir" ] || [ -z "$config_path" ] || [ -z "$workspace_dir" ] || [ -z "$agent_dir" ]; then
  echo "contained isolated OpenClaw paths are required" >&2
  exit 78
fi
canary_root=$(dirname -- "$state_dir")
case "$config_path" in
  "$state_dir/openclaw.json") ;;
  *) echo "fallback canary config is outside the isolated state root" >&2; exit 78 ;;
esac
case "$workspace_dir" in
  "$canary_root"/*) ;;
  *) echo "fallback canary workspace is outside the isolated root" >&2; exit 78 ;;
esac
case "$agent_dir" in
  "$state_dir"/*) ;;
  *) echo "fallback canary agent state is outside the isolated state root" >&2; exit 78 ;;
esac

node "$repo_dir/scripts/failing-primary-stub.mjs" &
stub_pid=$!
trap 'kill "$stub_pid" 2>/dev/null || true; wait "$stub_pid" 2>/dev/null || true' EXIT HUP INT TERM

attempt=0
while [ "$attempt" -lt 30 ]; do
  if node --input-type=module --eval '
    try {
      const response = await fetch("http://127.0.0.1:19172/v1/models");
      process.exit(response.ok ? 0 : 1);
    } catch {
      process.exit(1);
    }
  '; then
    break
  fi
  attempt=$((attempt + 1))
  sleep 0.1
done
if [ "$attempt" -ge 30 ]; then
  echo "failing primary stub did not become ready" >&2
  exit 1
fi

session_suffix=$(node --input-type=module -e 'import { randomUUID } from "node:crypto"; process.stdout.write(randomUUID())')
"$repo_dir/node_modules/.bin/openclaw" \
  --profile chatgpt-web-canary \
  agent \
  --local \
  --agent main \
  --session-key "agent:main:chatgpt-web-fallback-$session_suffix" \
  --message 'Return exactly: CHATGPT_WEB_FALLBACK_OK' \
  --timeout 360 \
  --json
