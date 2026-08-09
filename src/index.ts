import {
  definePluginEntry,
  type OpenClawPluginApi,
  type OpenClawPluginDefinition,
} from "openclaw/plugin-sdk/plugin-entry";
import { ChatGptWebError, PlaywrightChatGptWebClient } from "./browser-client.js";
import {
  CHATGPT_WEB_AUTH_MARKER,
  CHATGPT_WEB_PROVIDER_ID,
  CHATGPT_WEB_THINKING_LEVELS,
  resolveChatGptWebConfig,
  type ChatGptWebModelConfig,
} from "./config.js";
import type { ModelThinkingLevel } from "openclaw/plugin-sdk/llm";
import { createChatGptWebStreamFn } from "./stream.js";

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
    const catalogModels = config.models.map(toCatalogModel);
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
            models: catalogModels,
          },
        }),
      },
      staticCatalog: {
        order: "late",
        run: async () => ({
          provider: {
            api: CHATGPT_WEB_CATALOG_API,
            baseUrl: "chatgpt-web://local",
            models: catalogModels,
          },
        }),
      },
      resolveSyntheticAuth: () => ({
        apiKey: CHATGPT_WEB_AUTH_MARKER,
        source: "chatgpt-web dedicated local browser profile",
        mode: "api-key" as const,
      }),
      resolveDynamicModel: ({ provider, modelId }) => {
        if (provider !== CHATGPT_WEB_PROVIDER_ID) return undefined;
        const modelConfig = config.models.find((candidate) => candidate.id === modelId);
        return modelConfig ? toRuntimeModel(modelConfig) : undefined;
      },
      createStreamFn: ({ model }) => {
        if (model.provider !== CHATGPT_WEB_PROVIDER_ID) return undefined;
        const modelConfig = config.models.find((candidate) => candidate.id === model.id);
        return modelConfig
          ? createChatGptWebStreamFn({
              client,
              modelConfig,
              maxPromptChars: config.maxPromptChars,
            })
          : undefined;
      },
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

function toCatalogModel(modelConfig: ChatGptWebModelConfig) {
  return {
    id: modelConfig.id,
    name: modelConfig.name,
    reasoning: modelConfig.reasoning,
    ...(modelConfig.reasoning
      ? { thinkingLevelMap: buildThinkingLevelMap(modelConfig) }
      : {}),
    input: ["text"] as ("text" | "image")[],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 32_768,
    maxTokens: 8_192,
  };
}

function buildThinkingLevelMap(modelConfig: ChatGptWebModelConfig) {
  const map: Partial<Record<ModelThinkingLevel, string | null>> = {};
  for (const level of CHATGPT_WEB_THINKING_LEVELS) {
    map[level] = level === "off" || modelConfig.reasoningOptions[level] ? level : null;
  }
  return map;
}

function toRuntimeModel(modelConfig: ChatGptWebModelConfig) {
  return {
    ...toCatalogModel(modelConfig),
    provider: CHATGPT_WEB_PROVIDER_ID,
    api: CHATGPT_WEB_API,
    baseUrl: "chatgpt-web://local",
  };
}

function classifyChatGptWebFailure(errorMessage: string) {
  if (/\[chatgpt-web:auth\]/i.test(errorMessage)) return "auth" as const;
  if (/\[chatgpt-web:timeout\]/i.test(errorMessage)) return "timeout" as const;
  if (/\[chatgpt-web:empty_response\]/i.test(errorMessage)) return "empty_response" as const;
  if (/\[chatgpt-web:(browser|closed|integrity|navigation|profile)\]/i.test(errorMessage)) {
    return "server_error" as const;
  }
  return undefined;
}
