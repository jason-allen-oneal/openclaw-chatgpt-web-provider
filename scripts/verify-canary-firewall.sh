#!/bin/sh
set -eu

if [ -n "${DISPLAY:-}" ]; then
  echo "containment failure: native-headless run inherited DISPLAY" >&2
  exit 1
fi
if ! grep -Eq '^NoNewPrivs:[[:space:]]+1$' /proc/self/status; then
  echo "containment failure: no_new_privs is not active" >&2
  exit 1
fi
if ! grep -Eq '^Cap(Eff|Bnd):[[:space:]]+0+$' /proc/self/status; then
  echo "containment failure: runtime capability set is not empty" >&2
  exit 1
fi
echo "blocked: display and runtime privileges"

loopback_listener_pid=""
cleanup_loopback_listener() {
  if [ -n "$loopback_listener_pid" ]; then
    kill "$loopback_listener_pid" 2>/dev/null || true
    wait "$loopback_listener_pid" 2>/dev/null || true
  fi
}
trap cleanup_loopback_listener EXIT HUP INT TERM

node --input-type=module -e '
  import http from "node:http";
  const server = http.createServer((_request, response) => response.end("loopback-listener"));
  server.listen(19173, "127.0.0.1");
  setInterval(() => {}, 60_000);
' &
loopback_listener_pid=$!
for attempt in 1 2 3 4 5 6 7 8 9 10; do
  if ss -ltn 2>/dev/null | grep -Eq '127\.0\.0\.1:19173[[:space:]]'; then
    break
  fi
  sleep 0.1
done
if ! ss -ltn 2>/dev/null | grep -Eq '127\.0\.0\.1:19173[[:space:]]'; then
  echo "firewall test failure: loopback listener did not become ready" >&2
  exit 1
fi

assert_blocked() {
  label="$1"
  url="$2"
  if node --input-type=module --eval '
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 3000);
    try {
      await fetch(process.argv[1], { signal: controller.signal });
      process.exit(0);
    } catch {
      process.exit(1);
    }
  ' "$url"; then
    echo "firewall failure: $label was reachable" >&2
    exit 1
  fi
  echo "blocked: $label"
}

assert_blocked "loopback" "http://127.0.0.1:19173/"
assert_blocked "RFC1918" "http://192.168.10.1/"
assert_blocked "link-local metadata" "http://169.254.169.254/"
assert_blocked "CGNAT" "http://100.64.0.1/"

node --input-type=module --eval '
  const response = await fetch("https://chatgpt.com/", { redirect: "manual" });
  if (response.status < 200 || response.status >= 500) {
    throw new Error(`unexpected public HTTPS status ${response.status}`);
  }
  console.log(`allowed: public HTTPS (${response.status})`);
'
