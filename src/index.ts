import {
  definePluginEntry,
  type OpenClawPluginApi,
  type OpenClawPluginDefinition,
} from "openclaw/plugin-sdk/plugin-entry";
import { ChatGptWebError, PlaywrightChatGptWebClient } from "./browser-client.js";
import {
  CHATGPT_WEB_AUTH_MARKER,
  CHATGPT_WEB_MODEL_ID,
  CHATGPT_WEB_PROVIDER_ID,
  resolveChatGptWebConfig,
} from "./config.js";
import { createChatGptWebStreamFn } from "./stream.js";

const MODEL = {
  id: CHATGPT_WEB_MODEL_ID,
  name: "ChatGPT Web (backup)",
  reasoning: false,
  input: ["text"] as ("text" | "image")[],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 32_768,
  maxTokens: 8_192,
};

const CHATGPT_WEB_API = "chatgpt-web";
// OpenClaw 2026.7.1's catalog config accepts only built-in transport ids.
// Runtime model resolution replaces this metadata adapter with CHATGPT_WEB_API
// before the provider-owned stream hook runs.
const CHATGPT_WEB_CATALOG_API = "openai-completions";

const plugin: OpenClawPluginDefinition = definePluginEntry({
  id: CHATGPT_WEB_PROVIDER_ID,
  name: "ChatGPT Web Backup Provider",
  description: "Native-headless ChatGPT fallback provider pinned to OpenClaw 2026.7.1",
  register(api: OpenClawPluginApi) {
    const config = resolveChatGptWebConfig(api.pluginConfig);
    const browserClient = new PlaywrightChatGptWebClient(config, api.logger);
    const client = config.acknowledgeDataEgress
      ? browserClient
      : {
          async ask(): Promise<string> {
            throw new ChatGptWebError(
              "auth",
              "ChatGPT web fallback is blocked until plugins.entries.chatgpt-web.config.acknowledgeDataEgress is true",
            );
          },
        };

    api.lifecycle.registerRuntimeLifecycle({
      id: "chatgpt-web-browser-lifecycle",
      description: "Close the provider-owned browser transport during host cleanup",
      cleanup: async () => {
        await browserClient.close();
      },
    });

    if (api.registrationMode === "full") {
      api.registerService({
        id: "chatgpt-web-browser",
        start: () => {},
        stop: async () => {
          await browserClient.close();
        },
      });
    }

    api.registerProvider({
      id: CHATGPT_WEB_PROVIDER_ID,
      label: "ChatGPT Web (backup)",
      auth: [],
      catalog: {
        order: "late",
        run: async () => ({
          provider: {
            api: CHATGPT_WEB_CATALOG_API,
            baseUrl: "chatgpt-web://local",
            apiKey: CHATGPT_WEB_AUTH_MARKER,
            models: [MODEL],
          },
        }),
      },
      staticCatalog: {
        order: "late",
        run: async () => ({
          provider: {
            api: CHATGPT_WEB_CATALOG_API,
            baseUrl: "chatgpt-web://local",
            models: [MODEL],
          },
        }),
      },
      resolveSyntheticAuth: () => ({
        apiKey: CHATGPT_WEB_AUTH_MARKER,
        source: "chatgpt-web dedicated local browser profile",
        mode: "api-key" as const,
      }),
      resolveDynamicModel: ({ provider, modelId }) =>
        provider === CHATGPT_WEB_PROVIDER_ID && modelId === CHATGPT_WEB_MODEL_ID
          ? {
              ...MODEL,
              provider,
              api: CHATGPT_WEB_API,
              baseUrl: "chatgpt-web://local",
            }
          : undefined,
      createStreamFn: ({ model }) =>
        model.provider === CHATGPT_WEB_PROVIDER_ID
          ? createChatGptWebStreamFn({
              client,
              maxPromptChars: config.maxPromptChars,
            })
          : undefined,
      buildReplayPolicy: () => ({
        dropThinkingBlocks: true,
      }),
      // Keep OpenClaw's live tool catalog intact. The browser model only
      // proposes a validated call; OpenClaw remains responsible for policy,
      // approval, and execution of the actual tool.
      normalizeToolSchemas: ({ tools }) => tools,
      resolveReasoningOutputMode: () => "native",
      matchesContextOverflowError: ({ errorMessage }) =>
        /serialized fallback prompt .* configured maximum/i.test(errorMessage),
      classifyFailoverReason: ({ errorMessage }) =>
        classifyChatGptWebFailure(errorMessage),
    });
  },
});

export default plugin;

function classifyChatGptWebFailure(errorMessage: string) {
  if (/\[chatgpt-web:auth\]/i.test(errorMessage)) return "auth" as const;
  if (/\[chatgpt-web:timeout\]/i.test(errorMessage)) return "timeout" as const;
  if (/\[chatgpt-web:empty_response\]/i.test(errorMessage)) return "empty_response" as const;
  if (/\[chatgpt-web:(browser|closed|integrity|navigation|profile)\]/i.test(errorMessage)) {
    return "server_error" as const;
  }
  return undefined;
}
