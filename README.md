# ChatGPT Web Backup Provider for OpenClaw

Experimental, browser-backed OpenClaw text provider. It is intentionally
designed as a last-resort fallback, not a replacement for the OpenAI API or the
native Codex runtime.

Model reference:

```text
chatgpt-web/backup
```

## Current contract

- Uses a dedicated persistent Chromium profile by default.
- Opens a fresh ChatGPT/project page for every request and serializes the full
  OpenClaw context into one prompt.
- Runs one browser request at a time.
- Supports text input and output only.
- Does not expose native tool calls, structured reasoning, authoritative token
  counts, or API-grade model identity.
- Reports estimated token counts and zero API cost. Subscription costs are
  outside OpenClaw telemetry.
- UI selectors can break when ChatGPT changes its DOM.

## Data boundary

When this fallback activates, it sends the complete serialized OpenClaw system
prompt, conversation history, and prior tool-result text to ChatGPT. Tool-call
arguments and hidden reasoning blocks are deliberately omitted. The plugin
refuses inference until `acknowledgeDataEgress` is explicitly set to `true`.
Review the remaining contexts that may reach this fallback before enabling it.

## Build

```bash
npm install
npm test
npm run typecheck
npm run build
npm run pack:check
```

## Local installation

After building:

```bash
npm pack
openclaw plugins install npm-pack:./openclaw-chatgpt-web-provider-0.1.0.tgz
```

Enable and configure the plugin in `openclaw.json`:

```json
{
  "plugins": {
    "entries": {
      "chatgpt-web": {
        "enabled": true,
        "config": {
          "webchatUrl": "https://chatgpt.com/",
          "mode": "launch",
          "profileDir": "~/.openclaw/state/chatgpt-web/profile",
          "headless": false,
          "acknowledgeDataEgress": true
        }
      }
    }
  }
}
```

For a ChatGPT Project, set `webchatUrl` to its project URL.

Restart OpenClaw, select `chatgpt-web/backup` temporarily, and sign in through
the dedicated Chrome window on first use. Do not point `profileDir` at your
normal browser profile.

For an already-running isolated Chromium instance, use CDP explicitly:

```json
{
  "mode": "cdp",
  "cdpUrl": "http://127.0.0.1:9222",
  "acknowledgeDataEgress": true
}
```

CDP is restricted to loopback and should target a browser launched solely for
this provider. Cancellation during CDP acquisition may close that dedicated
browser to avoid leaking an orphaned automation connection.

## Fallback placement

Keep a normal API/runtime model primary and add this model last:

```json
{
  "agents": {
    "defaults": {
      "model": {
        "primary": "openai/gpt-5.6-sol",
        "fallbacks": [
          "chatgpt-web/backup"
        ]
      }
    }
  }
}
```

Do not add it to automated high-volume workloads. ChatGPT Web is a consumer UI,
not a stable provider API.
