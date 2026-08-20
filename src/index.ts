import {
  definePluginEntry,
  type OpenClawPluginApi,
  type OpenClawPluginDefinition,
} from "openclaw/plugin-sdk/plugin-entry";
import { PlaywrightChatGptWebClient } from "./browser-client.js";
import {
  CHATGPT_WEB_AUTH_MARKER,
  CHATGPT_WEB_PROVIDER_ID,
  CHATGPT_WEB_THINKING_LEVELS,
  resolveChatGptWebConfig,
  type ChatGptWebModelConfig,
} from "./config.js";
import type { ModelThinkingLevel } from "openclaw/plugin-sdk/llm";
import {
  CHATGPT_WEB_CONTEXT_WINDOW,
  CHATGPT_WEB_MAX_TOKENS,
} from "./limits.js";
import { createChatGptWebStreamFn } from "./stream.js";

const CHATGPT_WEB_API = "chatgpt-web";
// OpenClaw 2026.7.1's catalog config accepts only built-in transport ids.
// Runtime model resolution replaces this metadata adapter with CHATGPT_WEB_API
// before the provider-owned stream hook runs.
const CHATGPT_WEB_CATALOG_API = "openai-completions";

const plugin: OpenClawPluginDefinition = definePluginEntry({
  id: CHATGPT_WEB_PROVIDER_ID,
  name: "ChatGPT Web Provider",
  description: "Native-headless and browser-backed ChatGPT provider for OpenClaw 2026.8.1",
  register(api: OpenClawPluginApi) {
    const config = resolveChatGptWebConfig(api.pluginConfig);
    const catalogModels = config.models.map(toCatalogModel);
    const browserClient = new PlaywrightChatGptWebClient(config, api.logger);

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
      label: "ChatGPT Web",
      docsPath: "/providers/chatgpt-web",
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
              client: browserClient,
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
        /serialized fallback prompt .* (?:configured maximum|input budget|context window)/i.test(
          errorMessage,
        ),
      classifyFailoverReason: ({ errorMessage }) =>
        classifyChatGptWebFailure(errorMessage),
    });

    api.registerModelCatalogProvider?.({
      provider: CHATGPT_WEB_PROVIDER_ID,
      kinds: ["text"],
      liveCatalog: async () => {
        return catalogModels.map((m) => ({
          kind: "text" as const,
          provider: CHATGPT_WEB_PROVIDER_ID,
          model: m.id,
          label: m.name,
          source: "configured" as const,
        }));
      },
    });

    api.registerCli?.(
      async ({ program }) => {
        const command = program
          .command("chatgpt-web")
          .description("Manage and authenticate the ChatGPT Web provider");

        command
          .command("login")
          .description("Launch a visible browser window to log in to ChatGPT")
          .action(async () => {
            console.log(`Launching interactive login with profile directory: ${config.profileDir}`);
            await browserClient.launchInteractiveLogin();
            console.log("Interactive login session closed.");
          });

        command
          .command("status")
          .description("Check if ChatGPT session is authenticated in the browser profile")
          .action(async () => {
            console.log("Checking ChatGPT Web authentication status...");
            const result = await browserClient.checkAuthStatus();
            if (result.authenticated) {
              console.log("✓ ChatGPT Web session is active and authenticated.");
            } else {
              console.log(`✗ ChatGPT Web is not ready: ${result.error ?? "Session not signed in"}`);
              console.log("Run 'openclaw chatgpt-web login' to sign in.");
            }
          });
      },
      {
        descriptors: [
          {
            name: "chatgpt-web",
            description: "Manage and authenticate the ChatGPT Web provider",
            hasSubcommands: true,
          },
        ],
      },
    );

    api.registerCommand?.({
      name: "chatgpt-web",
      description: "Check status or trigger ChatGPT Web login helper.",
      acceptsArgs: true,
      handler: async (ctx) => {
        const args = ctx.args?.trim();
        if (args === "status") {
          const result = await browserClient.checkAuthStatus();
          return {
            text: result.authenticated
              ? "ChatGPT Web session is active and authenticated."
              : `ChatGPT Web is not ready: ${result.error ?? "Session not signed in"}. Run 'openclaw chatgpt-web login' in terminal to log in.`,
          };
        }
        return {
          text: `ChatGPT Web provider is loaded. Available models: ${config.models.map((m) => m.id).join(", ")}. Run 'openclaw chatgpt-web login' to authenticate.`,
        };
      },
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
    contextWindow: modelConfig.contextWindow ?? CHATGPT_WEB_CONTEXT_WINDOW,
    maxTokens: modelConfig.maxTokens ?? CHATGPT_WEB_MAX_TOKENS,
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
