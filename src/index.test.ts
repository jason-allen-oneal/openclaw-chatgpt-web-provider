import type {
  OpenClawPluginApi,
  OpenClawPluginService,
} from "openclaw/plugin-sdk/plugin-entry";
import type { StreamFn } from "openclaw/plugin-sdk/agent-core";
import type { Model } from "openclaw/plugin-sdk/llm";
import { describe, expect, it, vi } from "vitest";
import plugin from "./index.js";

type ProviderRegistration = {
  catalog?: { run(): Promise<{ provider: { api?: string; models?: Model[] } }> };
  staticCatalog?: { run(): Promise<{ provider: { api?: string; models?: Model[] } }> };
  resolveSyntheticAuth?(): { apiKey: string };
  resolveDynamicModel?(input: { provider: string; modelId: string }): Model | undefined;
  createStreamFn?(input: { model: Model }): StreamFn | undefined;
  normalizeToolSchemas?(input: { tools: unknown[] }): unknown[];
  matchesContextOverflowError?(input: { errorMessage: string }): boolean;
  classifyFailoverReason?(input: { errorMessage: string }): string | undefined;
};

function register(
  registrationMode: "discovery" | "full",
  extraConfig: Record<string, unknown> = {},
) {
  const providers: ProviderRegistration[] = [];
  const services: OpenClawPluginService[] = [];
  const modelCatalogs: unknown[] = [];
  const clis: unknown[] = [];
  const commands: unknown[] = [];
  const cleanups: Array<() => void | Promise<void>> = [];
  const api = {
    pluginConfig: extraConfig,
    registrationMode,
    logger: {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    },
    lifecycle: {
      registerRuntimeLifecycle: vi.fn((lifecycle: { cleanup?: () => void | Promise<void> }) => {
        if (lifecycle.cleanup) cleanups.push(lifecycle.cleanup);
      }),
    },
    registerProvider: vi.fn((provider: ProviderRegistration) => providers.push(provider)),
    registerService: vi.fn((service: OpenClawPluginService) => services.push(service)),
    registerModelCatalogProvider: vi.fn((catalog: unknown) => modelCatalogs.push(catalog)),
    registerCli: vi.fn((cli: unknown) => clis.push(cli)),
    registerCommand: vi.fn((command: unknown) => commands.push(command)),
  } as unknown as OpenClawPluginApi;

  plugin.register?.(api);
  return { api, provider: providers[0]!, services, modelCatalogs, clis, commands, cleanups };
}

describe("ChatGPT web provider registration", () => {
  it("registers exact custom API catalog and dynamic model identities", async () => {
    const { provider } = register("discovery");
    expect((await provider.catalog?.run())?.provider.api).toBe("openai-completions");
    expect((await provider.staticCatalog?.run())?.provider.api).toBe("openai-completions");
    expect((await provider.catalog?.run())?.provider.models).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "backup", contextWindow: 128_000, maxTokens: 16_384 }),
        expect.objectContaining({ id: "gpt-4o", contextWindow: 128_000, maxTokens: 16_384 }),
        expect.objectContaining({ id: "o3-mini", reasoning: true, maxTokens: 32_768 }),
        expect.objectContaining({ id: "gpt-5", reasoning: true, maxTokens: 32_768 }),
      ]),
    );
    expect(
      provider.resolveDynamicModel?.({ provider: "chatgpt-web", modelId: "backup" })?.api,
    ).toBe("chatgpt-web");
    expect(
      provider.resolveDynamicModel?.({ provider: "chatgpt-web", modelId: "backup" })?.reasoning,
    ).toBe(false);
    expect(provider.resolveSyntheticAuth?.().apiKey).toBe("chatgpt-web-local");
  });

  it("registers configured model ids and their reasoning capabilities", async () => {
    const { provider } = register("discovery", {
      models: [
        {
          id: "gpt-5",
          name: "ChatGPT Web GPT-5",
          webLabel: "GPT-5",
          reasoning: true,
          reasoningOptions: { off: "Auto", high: "Extended" },
        },
      ],
    });

    expect((await provider.catalog?.run())?.provider.models).toEqual([
      expect.objectContaining({
        id: "gpt-5",
        reasoning: true,
        thinkingLevelMap: expect.objectContaining({ off: "off", low: null, high: "high" }),
      }),
    ]);
    expect(
      provider.resolveDynamicModel?.({ provider: "chatgpt-web", modelId: "gpt-5" }),
    ).toMatchObject({ id: "gpt-5", reasoning: true, api: "chatgpt-web" });
  });

  it("preserves OpenClaw's live tool catalog for the agent loop", () => {
    const { provider } = register("discovery");
    const tools = [{ name: "read_file" }];
    expect(provider.normalizeToolSchemas?.({ tools })).toBe(tools);
  });

  it("classifies token-budget failures as context overflow", () => {
    const { provider } = register("discovery");
    expect(
      provider.matchesContextOverflowError?.({
        errorMessage:
          "[chatgpt-web:browser] Serialized fallback prompt transport is estimated at 25000 tokens; configured maximum input budget is 24576 tokens",
      }),
    ).toBe(true);
  });

  it("registers idempotent cleanup in discovery and a service in full mode", async () => {
    const discovery = register("discovery");
    expect(discovery.services).toHaveLength(0);
    expect(discovery.cleanups).toHaveLength(1);
    await discovery.cleanups[0]?.();
    await discovery.cleanups[0]?.();

    const full = register("full");
    expect(full.services).toHaveLength(1);
    await full.services[0]?.stop?.({} as never);
    await full.cleanups[0]?.();
  });

  it.each([
    ["[chatgpt-web:auth] signed out", "auth"],
    ["[chatgpt-web:timeout] completion missing", "timeout"],
    ["[chatgpt-web:empty_response] empty", "empty_response"],
    ["[chatgpt-web:integrity] wrong receipt", "server_error"],
    ["unrelated failure", undefined],
  ])("classifies typed provider failure %s", (message, reason) => {
    const { provider } = register("discovery");
    expect(provider.classifyFailoverReason?.({ errorMessage: message })).toBe(reason);
  });

  it("registers model catalog provider for control-plane discovery", async () => {
    const { modelCatalogs } = register("discovery");
    expect(modelCatalogs).toHaveLength(1);
    const catalog = modelCatalogs[0] as {
      provider: string;
      kinds: string[];
      liveCatalog: () => Promise<Array<{ model: string; kind: string }>>;
    };
    expect(catalog.provider).toBe("chatgpt-web");
    expect(catalog.kinds).toEqual(["text"]);
    const live = await catalog.liveCatalog();
    expect(live.map((m) => m.model)).toEqual(
      expect.arrayContaining(["backup", "auto", "gpt-4o", "o3-mini", "gpt-5"]),
    );
  });

  it("registers CLI command and chat command for auth and status", () => {
    const { clis, commands } = register("discovery");
    expect(clis).toHaveLength(1);
    expect(commands).toHaveLength(1);
    expect((commands[0] as { name: string }).name).toBe("chatgpt-web");
  });
});
