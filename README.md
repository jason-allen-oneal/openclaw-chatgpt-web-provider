# ChatGPT Web Backup Provider for OpenClaw 2026.7.1

This repository contains a browser-backed fallback provider for OpenClaw. It
uses a dedicated Chromium profile and the ChatGPT web application to answer a
text or native OpenClaw tool-call turn when the normal provider is unavailable.

Model reference:

```text
chatgpt-web/backup
```

This is a last-resort provider. It is not an OpenAI API client, an official
OpenAI integration, or a replacement for a supported model endpoint. The npm
package is marked private and is not intended for registry publication.

## Stop and read this first

Enabling this provider can send the following to a third-party ChatGPT account:

- the OpenClaw system prompt;
- conversation history;
- user and assistant text; and
- available tool names, descriptions, and JSON schemas;
- prior tool-call arguments; and
- prior tool-result text.

Hidden reasoning blocks and image bytes are omitted, but that does not make the
remaining context safe by default. Tool arguments can contain file paths,
message content, URLs, or other sensitive values. Do not use this with
credentials, client data, regulated data, private URLs, secrets, or workflows
where an unexpected data export would be unacceptable.

The provider requires an explicit `acknowledgeDataEgress: true` setting. That
setting is an acknowledgement, not a privacy guarantee and not an approval from
OpenAI.

## Terms of Use and account risk

This project automates the ChatGPT web interface through a browser. It is not
endorsed by OpenAI and may not be permitted by the current ChatGPT, OpenAI,
account, workspace, automation, or anti-abuse rules. OpenAI's terms and product
policies can change. Review the current terms yourself before using this
project:

- [OpenAI Terms of Use](https://openai.com/policies/terms-of-use/)
- [OpenAI Privacy Policy](https://openai.com/policies/privacy-policy/)
- [ChatGPT help and policies](https://help.openai.com/)

Use can trigger rate limits, verification challenges, loss of access, account
suspension, account termination, or project/chat restrictions. Do not use an
account you cannot afford to lose. Do not automate signup, password entry, MFA,
CAPTCHA handling, or attempts to evade access controls. Confirm that your use
is allowed for the account, workspace, organization, and data involved. This
README is a technical warning, not legal advice or a compliance determination.

## Limitations

### It is browser automation, not an API

- It depends on the private DOM, selectors, behavior, and anti-automation
  controls of `chatgpt.com` or a configured ChatGPT Project.
- A ChatGPT UI change can break readiness detection, submission, response
  extraction, or receipt validation without a code change here.
- Responses are buffered pseudo-streams. OpenClaw receives text after the DOM
  reports a positive completion state, not token-by-token API streaming.
- Tool calls are supported through a strict text protocol layered over the
  browser UI. This is not the same as a provider-native ChatGPT API tool
  channel. Calls are buffered, one at a time, and schema-validated before
  OpenClaw receives them.
- There are no general structured outputs, authoritative usage counts,
  guaranteed model identity, or API-level availability guarantees. Model
  selection and reasoning controls are best-effort browser UI controls unless
  the configured picker selectors verify them; the web application can still
  change or ignore them.
- ChatGPT sign-in challenges, rate limits, outages, account restrictions,
  project changes, and network failures are external dependencies.

### The prompt contract is weaker than a real model API

- OpenClaw's system, user, assistant, and tool-result roles are flattened into
  one web user message. ChatGPT does not receive OpenClaw's original role
  precedence.
- Returned text is untrusted model output. It can contain prompt injection or
  incorrect instructions that affect later OpenClaw behavior.
- OpenClaw's live tool catalog is serialized into the browser prompt. ChatGPT
  can request one available tool with the exact `OPENCLAW_TOOL_CALL` format;
  this provider validates the name and arguments, emits OpenClaw's native
  `toolcall_*` events, and leaves policy, approval, and execution to OpenClaw.
- Tool definitions, prior tool-call arguments, and tool-result text can be
  included in the serialized context. The provider never executes a tool
  directly inside the browser adapter.
- Long contexts can exceed the configured transport limit or the practical
  limits of the ChatGPT composer. The provider rejects oversized envelopes.

### The browser session is a real account boundary

- A persistent profile contains cookies, local storage, and account state. Keep
  it private, dedicated, backed up only deliberately, and separate from normal
  browser profiles.
- Launch mode isolates the provider's Chromium profile and creates a fresh
  provider-owned page per turn. CDP mode cannot prove the attached browser's
  profile ownership. Use CDP only with a browser dedicated to this provider.
- The provider checks the configured ChatGPT origin and rejects unexpected
  top-level navigation, popups, downloads, and transcript mismatches. Those
  checks are not a complete browser sandbox or network allowlist.
- The browser may retain chats according to the account, project, history,
  retention, training, and data-control settings in effect on the account.

### Availability and operational scope

- The supported compatibility target is exactly OpenClaw `2026.7.1` and
  Playwright Core `1.61.1`. Later OpenClaw releases are unsupported until they
  pass a new compatibility review.
- Use this only as a deliberately reviewed, per-agent fallback. Do not put it
  in `agents.defaults` or use it for automated, high-volume, security-sensitive,
  client-data, or credential-bearing workflows.
- This project has no SLA. A successful canary does not establish production
  reliability or terms compliance.

## Transport and integrity controls

Each turn is serialized and sends one bounded transport envelope to the web
composer. The envelope contains a unique request marker, a nonce, and a visual
encoding for the serialized context. The provider verifies the submitted DOM
user message against the expected envelope and accepts only the immediately
following assistant response with the matching nonce receipt.

The provider also:

- fails closed until `acknowledgeDataEgress` is true;
- enforces `maxPromptChars` before filling the composer;
- cancels and closes the active provider-owned page;
- rejects unexpected top-level navigation, popups, and downloads; and
- uses typed failures for authentication, timeout, integrity, browser, and
  response errors so OpenClaw can classify fallback behavior.
- validates browser-requested tool names and arguments against the live
  OpenClaw tool catalog before emitting native tool-call events.

These controls protect the local transport boundary. They do not make the
ChatGPT website trustworthy, prevent public-web egress by themselves, or
override account policy.

## OpenClaw tool-call behavior

Tool support is part of the provider contract. For each turn, OpenClaw passes
the tools available to that agent and its active policy into the provider. The
provider renders their names, descriptions, and JSON schemas into the bounded
browser prompt. If ChatGPT needs one, it must return exactly one line such as:

```text
OPENCLAW_TOOL_CALL {"name":"read_file","arguments":{"path":"README.md"}}
```

The provider rejects malformed JSON, unknown tool names, invalid arguments, or
extra prose around the marker. Valid calls become OpenClaw `toolCall` content
and `toolcall_start`/`toolcall_delta`/`toolcall_end` events. OpenClaw then runs
the normal tool policy, approval, execution, and result loop. The browser
adapter has no direct file, shell, messaging, or other tool implementation.

The browser transport requests at most one tool per turn. That preserves the
provider's serialized full-context boundary; repeated tool use is handled by
OpenClaw calling the provider again with the tool result.

## Configuration

The minimum launch-mode configuration is:

```json
{
  "plugins": {
    "entries": {
      "chatgpt-web": {
        "enabled": true,
        "config": {
          "webchatUrl": "https://chatgpt.com/",
          "mode": "launch",
          "profileDir": "/absolute/path/to/chromium-profile",
          "sandboxMode": "userns",
          "headless": true,
          "acknowledgeDataEgress": true
        }
      }
    }
  }
}
```

Use the exact HTTPS URL for a ChatGPT Project when needed. The configured and
final navigation origins must match. `headless: false` is rejected. The only
visible-browser path is the explicit one-time login helper described below.

The provider's package, peer dependency, and plugin API are pinned to
`2026.7.1`. Its catalog metadata uses an OpenClaw 2026.7.1-compatible built-in
adapter identifier, while runtime resolution uses the provider-owned stream
hook. This is compatibility metadata, not an OpenAI-compatible HTTP endpoint.

## Model and reasoning selection

The default model reference remains:

```text
chatgpt-web/backup
```

The provider also honors OpenClaw model selection and normalized thinking
levels. Add an explicit model catalog to the plugin config when the ChatGPT web
account exposes more than the currently selected model:

```json
{
  "models": [
    {
      "id": "gpt-5",
      "name": "ChatGPT Web GPT-5",
      "webLabel": "GPT-5",
      "reasoning": true,
      "reasoningOptions": {
        "off": "Auto",
        "low": "Standard",
        "high": "Extended"
      }
    }
  ]
}
```

That exposes `chatgpt-web/gpt-5` to OpenClaw. `webLabel` is an exact visible
label for the ChatGPT web model picker, not an API model identifier. A custom
model id requires `webLabel`, and the provider selects it only when both
`selectors.modelPicker` and `selectors.modelOption` are configured to match the
current ChatGPT DOM. Only the special `backup` model may omit `webLabel`; it
means “use the model already selected in the web UI.” The provider does not
claim that the web application actually served the requested model.

OpenClaw's `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, and `max`
thinking levels can be enabled per model. Each enabled model must define an
exact `reasoningOptions` label for `off` and every level it advertises. A
`reasoningOptions` entry plus `selectors.reasoningPicker` and
`selectors.reasoningOption` selects the matching visible web control. An
unmapped level, missing picker selectors, missing option, or uncommitted click
fails before the prompt is submitted. The adapter returns final text only: it
does not expose or invent hidden chain-of-thought blocks. The default `backup`
model does not advertise reasoning until it is explicitly configured with
reviewed web labels and selectors.

Use the selected model in the normal OpenClaw model setting, for example
`chatgpt-web/gpt-5`, and use the normal OpenClaw thinking control such as
`/thinking high`. The browser selectors are deliberately not hard-coded because
ChatGPT's web DOM is an unstable private implementation detail. Determine and
review them against the account or Project before enabling a model or reasoning
picker mapping.

## Isolated canary

Do not begin with the live OpenClaw installation. Use a disposable OS account,
VM, or the contained runner in [`scripts/contained-canary.sh`](scripts/contained-canary.sh).
Use a throwaway ChatGPT account or Project and synthetic data only.

Build the contained image and test its network boundary:

```bash
./scripts/contained-canary.sh build
export CHATGPT_WEB_CANARY_ROOT="$(mktemp -d /tmp/openclaw-chatgpt-web-canary.XXXXXX)"
chmod 700 "$CHATGPT_WEB_CANARY_ROOT"
./scripts/contained-canary.sh firewall-check
```

Normal contained runs block loopback, RFC1918, link-local, cloud metadata,
CGNAT, reserved, documentation, and multicast destinations. Public HTTP/HTTPS
and explicit public DNS remain available for the ChatGPT web application. The
firewall is the egress boundary. Browser request interception alone is not a
substitute for it.

One-time authentication is manual and visible:

```bash
./scripts/contained-canary.sh login
```

After authentication, close the visible browser. Subsequent provider turns use
native headless Chromium:

```bash
./scripts/contained-canary.sh run -- \
  ./node_modules/.bin/openclaw --profile chatgpt-web-canary \
  agent --local --agent main --message 'synthetic canary' --json
```

The fallback helper refuses standalone execution. Synthetic fallback testing
must use the contained `stub-run` path, which supplies isolated state/config/
workspace paths and a unique session key.

For a real external canary, invoke exactly one bounded turn, inspect the
returned receipt-bound answer, audit retention, and then disable the provider.
Delete only a conversation whose user DOM contains the exact synthetic
`OPENCLAW_REQUEST` marker. External turns and account/chat deletion are
approval-sensitive actions.

## Fallback placement

Keep the provider out of global defaults. Add it last on one explicitly reviewed
agent only:

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

## Development and validation

The repository-local dependency set targets the frozen compatibility contract:

```bash
npm install
npm test
npm run typecheck
npm run build
npm run pack:check
npm audit --omit=dev
```

The current validation snapshot passed 78 tests, typecheck, build, package
inspection, production dependency audit, contained firewall checks, and an
isolated OpenClaw 2026.7.1 install. No external ChatGPT turn is implied by
those checks.

Do not install this package into a live OpenClaw runtime, edit live OpenClaw
configuration, or restart a live gateway as part of ordinary development.
