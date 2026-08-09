#!/usr/bin/env bash
set -euo pipefail

readonly repo_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
readonly image_name="openclaw-chatgpt-web-canary:2026.7.1"
readonly container_name="openclaw-chatgpt-web-canary"
readonly canary_root="${CHATGPT_WEB_CANARY_ROOT:-}"
readonly profile_dir="$canary_root/chromium-profile"
readonly state_dir="$canary_root/state"
readonly agents_root="$state_dir/agents"
readonly config_path="$state_dir/openclaw.json"
readonly agent_dir="$agents_root/main"
readonly workspace_dir="$canary_root/workspace"
readonly secret_dir="$canary_root/secrets"

usage() {
  echo "Usage: $0 build | firewall-check | login | shell | run | stub-run -- <command> [args...]" >&2
}

validate_private_directory() {
  local directory="$1"
  if [[ -L "$directory" || ! -d "$directory" ]]; then
    echo "Canary path must be a real directory, not a symlink: $directory" >&2
    exit 78
  fi
  if [[ "$(stat -c %u -- "$directory")" != "$(id -u)" ]]; then
    echo "Canary path is not owned by the invoking user: $directory" >&2
    exit 78
  fi
  if [[ "$(stat -c %a -- "$directory")" != "700" ]]; then
    echo "Canary path must have mode 0700: $directory" >&2
    exit 78
  fi
}

prepare_host_paths() {
  if [[ -z "$canary_root" ]]; then
    echo "Set CHATGPT_WEB_CANARY_ROOT to a fresh 'mktemp -d' directory with mode 0700" >&2
    exit 64
  fi
  validate_private_directory "$canary_root"
  local directory
  for directory in \
    "$profile_dir" \
    "$state_dir" \
    "$agents_root" \
    "$agent_dir" \
    "$workspace_dir" \
    "$secret_dir" \
    "$canary_root/npm-cache" \
    "$canary_root/tmp" \
    "$canary_root/xdg-config" \
    "$canary_root/xdg-cache" \
    "$canary_root/xdg-data"; do
    if [[ ! -e "$directory" ]]; then
      mkdir -m 0700 -- "$directory"
    fi
    validate_private_directory "$directory"
  done
}

container_run() {
  local display_mode="$1"
  shift
  prepare_host_paths
  if ! docker image inspect "$image_name" >/dev/null 2>&1; then
    echo "Missing $image_name; run '$0 build' first" >&2
    exit 69
  fi

  local display_args=(
    --env "CANARY_DISPLAY_MODE=$display_mode"
  )
  if [[ "$display_mode" == "visible" ]]; then
    display_args+=(
      --mount "type=bind,src=/tmp/.X11-unix,dst=/tmp/.X11-unix,readonly"
      --mount "type=bind,src=${XAUTHORITY:-/home/$(id -un)/.Xauthority},dst=/run/canary.Xauthority,readonly"
      --env "DISPLAY=${DISPLAY:?DISPLAY is required for the explicit login browser}"
      --env XAUTHORITY=/run/canary.Xauthority
    )
  elif [[ "$display_mode" == "native-stub" ]]; then
    display_args+=(--env CANARY_ALLOW_LOOPBACK_STUB=1)
  fi

  docker run --rm --init \
    --name "$container_name" \
    --cap-drop ALL \
    --cap-add NET_ADMIN \
    --cap-add SETUID \
    --cap-add SETGID \
    --cap-add CHOWN \
    --security-opt no-new-privileges:true \
    --pids-limit 512 \
    --memory 3g \
    --shm-size 1g \
    --dns 1.1.1.1 \
    --dns 1.0.0.1 \
    --mount "type=bind,src=$repo_dir,dst=$repo_dir,readonly" \
    --mount "type=bind,src=$canary_root,dst=$canary_root" \
    "${display_args[@]}" \
    --env "CANARY_UID=$(id -u)" \
    --env "CANARY_GID=$(id -g)" \
    --env LANG=C.UTF-8 \
    --env TERM="${TERM:-xterm-256color}" \
    --env OPENCLAW_STATE_DIR="$state_dir" \
    --env OPENCLAW_CONFIG_PATH="$config_path" \
    --env OPENCLAW_AGENT_DIR="$agent_dir" \
    --env OPENCLAW_WORKSPACE_DIR="$workspace_dir" \
    --env OPENCLAW_AUTH_PROFILE_SECRET_DIR="$secret_dir" \
    --env OPENCLAW_GATEWAY_PORT=19171 \
    --env OPENCLAW_SKIP_CHANNELS=1 \
    --env NPM_CONFIG_CACHE="$canary_root/npm-cache" \
    --env NPM_CONFIG_USERCONFIG="$canary_root/npmrc" \
    --env TMPDIR="$canary_root/tmp" \
    --env XDG_CONFIG_HOME="$canary_root/xdg-config" \
    --env XDG_CACHE_HOME="$canary_root/xdg-cache" \
    --env XDG_DATA_HOME="$canary_root/xdg-data" \
    --workdir "$repo_dir" \
    "$image_name" "$@"
}

command_name="${1:-}"
case "$command_name" in
  build)
    exec docker build --pull=false -f "$repo_dir/canary/Dockerfile" -t "$image_name" "$repo_dir"
    ;;
  firewall-check)
    container_run native "$repo_dir/scripts/verify-canary-firewall.sh"
    ;;
  login)
    container_run visible "$repo_dir/scripts/open-canary-login.sh" "$profile_dir"
    ;;
  shell)
    container_run native /bin/bash
    ;;
  run)
    shift
    if [ "${1:-}" = "--" ]; then shift; fi
    if [ "$#" -eq 0 ]; then usage; exit 64; fi
    container_run native "$@"
    ;;
  stub-run)
    shift
    if [ "${1:-}" = "--" ]; then shift; fi
    if [ "$#" -eq 0 ]; then usage; exit 64; fi
    container_run native-stub "$@"
    ;;
  *)
    usage
    exit 64
    ;;
esac
