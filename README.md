# ChatGPT Web Backup Provider for OpenClaw 2026.7.1

Public source repository for an internal-use, browser-backed OpenClaw text
provider. At runtime it is a last-resort fallback for isolated agents, not a
replacement for the OpenAI API or the native Codex runtime. The package remains
marked private and is not intended for npm publication or general deployment.

Model reference:

```text
chatgpt-web/backup
```

## Frozen compatibility contract

- OpenClaw package, peer dependency, and plugin API: **exactly `2026.7.1`**.
- Playwright Core: **exactly `1.61.1`**.
- Later OpenClaw versions are unsupported until they pass the complete test and
  isolated-install matrix and the pins are deliberately changed.
- The runtime provider uses OpenClaw 2026.7.1's custom `createStreamFn` seam
  and the custom API ID `chatgpt-web`; it does not pretend to be an
  OpenAI-compatible HTTP API. The manifest catalog row uses
  `openai-completions` only as the built-in adapter identifier accepted by
  OpenClaw 2026.7.1's catalog validator; runtime model resolution switches to
  the provider-owned `chatgpt-web` stream hook.

## Transport contract

- Launch mode uses a fresh Chromium context and provider-owned page for each
  serialized turn. Cookies persist in the dedicated profile; Chromium itself
  exits after every turn.
- CDP mode connects only to an explicit loopback HTTP endpoint and owns only
  the pages it creates. The target browser and its first context must still be
  dedicated to this provider; loopback validation cannot prove profile
  ownership.
- Turns are strictly serialized. Cancellation closes the active owned page.
  Shutdown aborts active work, rejects queued work, drains the queue, and then
  closes the launch context or disposes the CDP connection.
- The complete OpenClaw context is sent as one ChatGPT user message. Responses
  are **buffered pseudo-streaming**: OpenClaw receives one text delta only after
  the DOM exposes a positive completion state.
- Each request includes a unique nonce and SHA-256 request marker. The complete
  context is represented once as a compact, one-to-one visual transport body:
  letters and digits remain literal, spaces/newlines use visible control
  symbols, ASCII punctuation uses its fullwidth counterpart, and original
  non-ASCII UTF-16 code units use bracketed hexadecimal tokens. The provider
  hashes that body and requires the next DOM user node to reproduce the same
  canonicalized envelope; only incidental DOM whitespace outside the visual
  body is normalized. It then accepts only the immediately following assistant
  response. The response must end with the exact nonce receipt, which is
  stripped before returning text. There is no second unhashed readable copy.
- `maxPromptChars` is enforced again on the finished transport envelope before
  any context is written into the browser composer.
- Text input/output only. There are no native tool calls, structured reasoning,
  authoritative token counts, or API-grade assurances about model identity.
- UI selectors are private configuration and may break whenever ChatGPT changes
  its DOM.

## Data and trust boundary

When this fallback runs, it sends the serialized OpenClaw system prompt,
conversation history, and prior tool-result text to ChatGPT. Tool-call arguments,
hidden reasoning blocks, and image bytes are omitted. The plugin refuses
inference until `acknowledgeDataEgress` is explicitly `true`.

This is a semantic and privacy downgrade:

- OpenClaw roles are flattened into one web user prompt. ChatGPT does not
  receive true system/user/tool role precedence.
- Returned browser text is untrusted model output and can carry indirect prompt
  injection into later replay.
- ChatGPT account, project, history, retention, deletion, training/data-control,
  and subscription policies apply independently of OpenClaw.
- A persistent browser profile contains account cookies and storage. Keep its
  directory private, dedicated, excluded from backups, and separate from every
  normal browser profile.
- The provider's origin checks are navigation guards, not a general network
  allowlist. The contained canary's OS/container firewall is the egress
  boundary; it blocks private, metadata, and reserved destinations while
  permitting the public ChatGPT web origin. CDP mode cannot prove the attached
  browser's profile ownership and therefore requires a provider-dedicated
  browser by policy.
- Automatic fallback can export context that the operator did not expect to
  leave OpenClaw. Enable it only for a specifically reviewed agent, never as a
  global default.

## Deterministic validation

```bash
npm install
npm test
npm run typecheck
npm run build
npm run pack:check
npm audit --omit=dev
```

`build` removes only this project's validated `dist/` path before emitting.
Tests remain source-only and are excluded from `dist/`. `pack:check` rebuilds,
runs `npm pack --dry-run --json`, requires `dist/index.js`, and rejects leaked
test artifacts.

## Internal installation (separate approval step)

Do not install this package into the live OpenClaw runtime during development.
After deterministic checks pass, build a local tarball and install it only into
an isolated OpenClaw **2026.7.1** config/state directory and port:

```bash
npm pack
export CHATGPT_WEB_CANARY_ROOT="$(mktemp -d /tmp/openclaw-chatgpt-web-canary.XXXXXX)"
install -d -m 700 "$CHATGPT_WEB_CANARY_ROOT/state"
printf '{"version":1,"agents":{}}\n' > "$CHATGPT_WEB_CANARY_ROOT/state/exec-approvals.json"
chmod 600 "$CHATGPT_WEB_CANARY_ROOT/state/exec-approvals.json"
env \
  OPENCLAW_STATE_DIR="$CHATGPT_WEB_CANARY_ROOT/state" \
  OPENCLAW_CONFIG_PATH="$CHATGPT_WEB_CANARY_ROOT/state/openclaw.json" \
  OPENCLAW_GATEWAY_PORT=19171 \
  ./node_modules/.bin/openclaw --profile chatgpt-web-canary \
  plugins install ./openclaw-chatgpt-web-provider-0.1.0.tgz
```

Use the repository-local CLI above: its OpenClaw 2026.7.1 build commit matches
the frozen source tag. Pre-creating the isolated approvals file avoids an exact
2026.7.1 migration path that otherwise probes and archives
`~/.openclaw/exec-approvals.json` even when `OPENCLAW_STATE_DIR` is set.

Inspect the isolated runtime with the same environment before starting a
gateway:

```bash
env \
  OPENCLAW_STATE_DIR="$CHATGPT_WEB_CANARY_ROOT/state" \
  OPENCLAW_CONFIG_PATH="$CHATGPT_WEB_CANARY_ROOT/state/openclaw.json" \
  OPENCLAW_GATEWAY_PORT=19171 \
  ./node_modules/.bin/openclaw --profile chatgpt-web-canary \
  plugins inspect chatgpt-web --runtime --json
```

Example plugin configuration for that isolated environment:

```json
{
  "plugins": {
    "entries": {
      "chatgpt-web": {
        "enabled": true,
        "config": {
          "webchatUrl": "https://chatgpt.com/",
          "mode": "launch",
          "profileDir": "/absolute/mktemp/canary-root/chromium-profile",
          "sandboxMode": "userns",
          "headless": true,
          "acknowledgeDataEgress": true
        }
      }
    }
  }
}
```

`headless: true` uses native Chromium `--headless=new`. The provider normalizes
the installed Chromium user agent, suppresses the webdriver automation bit, and
sets stable language/plugin surfaces because ChatGPT did not expose its composer
to an unmodified headless browser. Normal turns have no `DISPLAY`, no X server,
and no visible-window fallback.
`headless: false` is rejected during configuration validation.

## Native-headless contained browser

Build the internal canary image and verify its egress policy:

```bash
./scripts/contained-canary.sh build
test -n "$CHATGPT_WEB_CANARY_ROOT"
chmod 700 "$CHATGPT_WEB_CANARY_ROOT"
./scripts/contained-canary.sh firewall-check
```

The runner has no predictable default state path. It requires this explicit,
private, invoking-user-owned, non-symlink root before any read-write bind mount.

Normal runs deny all loopback, RFC1918, link-local, carrier-grade NAT,
documentation/reserved ranges, multicast, and cloud metadata. They permit public
HTTP/HTTPS plus explicit public DNS. The synthetic fallback-test-only `stub-run`
mode opens only loopback port 19172 for its local 429 stub; it is not an
operational provider mode.

`scripts/run-fallback-canary.sh` refuses direct execution and is callable only
through the contained `stub-run` path, which supplies isolated state/config/
workspace paths and a unique session key.

One-time authentication is the only visible-browser action, and it occurs only
when the operator invokes it directly:

```bash
./scripts/contained-canary.sh login
```

Sign in, then close that Chromium window. Passwords, MFA values, and cookies are
never passed to OpenClaw. All subsequent `run` commands are native headless and
cannot pop up on the desktop:

```bash
./scripts/contained-canary.sh run -- \
  ./node_modules/.bin/openclaw --profile chatgpt-web-canary \
  agent --local --agent main --message 'synthetic canary' --json
```

For a ChatGPT Project, set `webchatUrl` to its exact project URL. Configured and
final navigation origins must remain exactly the same HTTPS ChatGPT origin.

CDP is an advanced recovery mode, not the first canary path:

```json
{
  "mode": "cdp",
  "cdpUrl": "http://127.0.0.1:9222",
  "acknowledgeDataEgress": true
}
```

Never point CDP at a personal browser or reuse its normal cookies, extensions,
password manager, tabs, or profile.

## Per-agent fallback placement

Do **not** place this model in `agents.defaults`. Add it last only on the one
explicitly reviewed agent:

```json
{
  "agents": {
    "list": [
      {
        "id": "isolated-fallback-canary",
        "model": {
          "primary": "openai/gpt-5.6-sol",
          "fallbacks": ["chatgpt-web/backup"]
        }
      }
    ]
  }
}
```

Keep it out of automated, high-volume, security-sensitive, client-data, and
credential-bearing workflows.

## Isolated canary protocol

1. Use launch mode in a disposable OS account or VM with a fresh `0700`
   profile and a throwaway ChatGPT account/project.
   Deny browser access to all loopback, RFC1918,
   link-local, carrier-grade NAT, and cloud-metadata destinations at the OS or
   container network boundary; browser request interception alone is not a
   substitute for network isolation.
2. Keep the model out of automatic fallbacks. Invoke `chatgpt-web/backup`
   directly for exactly one bounded turn.
3. Use a synthetic system prompt, history, tool result, and unique canary only.
   Do not include memories, credentials, client data, private URLs, or real tool
   output.
4. Verify the returned answer and receipt binding, confirm whether a chat was
   retained, and delete only a conversation whose user DOM contains the exact
   `OPENCLAW_REQUEST` marker.
5. Revert `acknowledgeDataEgress` after the canary. Automatic isolated fallback,
   fault, and soak testing are later gates.

On 2026-08-02, the contained native-headless path passed a synthetic direct turn
and a full isolated OpenClaw 2026.7.1 fallback turn. The failing primary received
exactly one request before `chatgpt-web/backup` returned the expected marker.
The disabled-egress configuration failed before Chromium launch. A native-
headless audit of all 28 visible recent conversations found no retained
`OPENCLAW_REQUEST` marker, so nothing was eligible for deletion. No live gateway,
live config, or globally installed OpenClaw package was changed.

These proofs validate the internal transport and its isolated fallback path;
they do not make browser automation API-equivalent or authorize live deployment.

On 2026-08-09, the hardened source state passed 57 unit tests, typecheck,
package inspection, production dependency audit, and the contained firewall
check. A fresh isolated OpenClaw 2026.7.1 install exposed
`chatgpt-web/backup` in model discovery, matched the built `dist/` artifact,
and blocked egress before browser acquisition when acknowledgement was false.
No live gateway, browser profile, or external ChatGPT turn was used for this
validation pass.

After stopping the foreground isolated gateway and reviewing evidence, verify
the exact temporary path and move it to trash with a literal reviewed target,
for example `gio trash -- /tmp/openclaw-chatgpt-web-canary.ABC123`. Never run gateway service
install/start/restart/stop commands for this disposable profile.
