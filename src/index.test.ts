import type {
  OpenClawPluginApi,
  OpenClawPluginService,
} from "openclaw/plugin-sdk/plugin-entry";
import type { StreamFn } from "openclaw/plugin-sdk/agent-core";
import type { Model } from "openclaw/plugin-sdk/llm";
import { describe, expect, it, vi } from "vitest";
import plugin from "./index.js";

type ProviderRegistration = {
  catalog?: { run(): Promise<{ provider: { api?: string } }> };
  staticCatalog?: { run(): Promise<{ provider: { api?: string } }> };
  resolveSyntheticAuth?(): { apiKey: string };
  resolveDynamicModel?(input: { provider: string; modelId: string }): Model | undefined;
  createStreamFn?(input: { model: Model }): StreamFn | undefined;
  normalizeToolSchemas?(input: { tools: unknown[] }): unknown[];
  classifyFailoverReason?(input: { errorMessage: string }): string | undefined;
};

function register(registrationMode: "discovery" | "full", acknowledgeDataEgress = false) {
  const providers: ProviderRegistration[] = [];
  const services: OpenClawPluginService[] = [];
  const cleanups: Array<() => void | Promise<void>> = [];
  const api = {
    pluginConfig: { acknowledgeDataEgress },
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
  } as unknown as OpenClawPluginApi;

  plugin.register?.(api);
  return { api, provider: providers[0]!, services, cleanups };
}

const model: Model = {
  id: "backup",
  name: "ChatGPT Web",
  api: "chatgpt-web",
  provider: "chatgpt-web",
  baseUrl: "chatgpt-web://local",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 32_768,
  maxTokens: 8_192,
};

describe("ChatGPT web provider registration", () => {
  it("registers exact custom API catalog and dynamic model identities", async () => {
    const { provider } = register("discovery");
    expect((await provider.catalog?.run())?.provider.api).toBe("openai-completions");
    expect((await provider.staticCatalog?.run())?.provider.api).toBe("openai-completions");
    expect(
      provider.resolveDynamicModel?.({ provider: "chatgpt-web", modelId: "backup" })?.api,
    ).toBe("chatgpt-web");
    expect(provider.resolveSyntheticAuth?.().apiKey).toBe("chatgpt-web-local");
  });

  it("preserves OpenClaw's live tool catalog for the agent loop", () => {
    const { provider } = register("discovery");
    const tools = [{ name: "read_file" }];
    expect(provider.normalizeToolSchemas?.({ tools })).toBe(tools);
  });

  it("fails closed at inference without the explicit data-egress acknowledgement", async () => {
    const { provider } = register("discovery", false);
    const streamFn = provider.createStreamFn?.({ model });
    expect(streamFn).toBeTypeOf("function");
    const stream = await streamFn!(model, {
      messages: [{ role: "user", content: "synthetic", timestamp: 1 }],
    });
    for await (const _event of stream) {
      // Drain the buffered protocol.
    }
    const result = await stream.result();
    expect(result.stopReason).toBe("error");
    expect(result.errorMessage).toMatch(/acknowledgeDataEgress is true/);
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
});
