import { definePluginEntry, type OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { PlaywrightChatGptWebClient } from "./browser-client.js";
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

export default definePluginEntry({
  id: CHATGPT_WEB_PROVIDER_ID,
  name: "ChatGPT Web Backup Provider",
  description: "Experimental browser-backed ChatGPT fallback provider",
  register(api: OpenClawPluginApi) {
    const config = resolveChatGptWebConfig(api.pluginConfig);
    const browserClient = new PlaywrightChatGptWebClient(config, api.logger);
    const client = config.acknowledgeDataEgress
      ? browserClient
      : {
          async ask(): Promise<string> {
            throw new Error(
              "ChatGPT web fallback is blocked until plugins.entries.chatgpt-web.config.acknowledgeDataEgress is true",
            );
          },
        };

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
            api: "openai-completions" as const,
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
            api: "openai-completions" as const,
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
              api: "openai-completions",
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
      normalizeToolSchemas: () => [],
      resolveReasoningOutputMode: () => "native",
      matchesContextOverflowError: ({ errorMessage }) =>
        /serialized fallback prompt .* configured maximum/i.test(errorMessage),
      classifyFailoverReason: ({ errorMessage }) =>
        /timed out|not ready|browser|chromium|target.*closed/i.test(errorMessage)
          ? "overloaded"
          : undefined,
    });
  },
});
