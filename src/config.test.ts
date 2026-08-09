import { describe, expect, it } from "vitest";
import { resolveChatGptWebConfig } from "./config.js";

describe("resolveChatGptWebConfig", () => {
  it("uses a dedicated launch profile by default", () => {
    const config = resolveChatGptWebConfig(undefined);
    expect(config.mode).toBe("launch");
    expect(config.profileDir).toContain(".openclaw/chatgpt-web/profile");
    expect(config.webchatUrl).toBe("https://chatgpt.com/");
    expect(config.sandboxMode).toBe("default");
    expect(config.headless).toBe(true);
    expect(config.acknowledgeDataEgress).toBe(false);
  });

  it("accepts project and selector overrides", () => {
    const config = resolveChatGptWebConfig({
      webchatUrl: "https://chatgpt.com/g/example/project",
      mode: "cdp",
      sandboxMode: "userns",
      acknowledgeDataEgress: true,
      selectors: { composer: "[data-test=prompt]" },
    });
    expect(config.mode).toBe("cdp");
    expect(config.webchatUrl).toBe("https://chatgpt.com/g/example/project");
    expect(config.sandboxMode).toBe("userns");
    expect(config.selectors.composer).toBe("[data-test=prompt]");
    expect(config.acknowledgeDataEgress).toBe(true);
  });

  it("accepts explicit OpenClaw models and web picker labels", () => {
    const config = resolveChatGptWebConfig({
      models: [
        {
          id: "gpt-5",
          name: "ChatGPT Web GPT-5",
          webLabel: "GPT-5",
          reasoning: true,
          reasoningOptions: { off: "Auto", low: "Standard", high: "Extended" },
        },
      ],
      selectors: {
        modelPicker: "#model-picker",
        modelOption: "[role=option]",
        reasoningPicker: "#reasoning-picker",
        reasoningOption: "[role=menuitem]",
      },
    });

    expect(config.models).toEqual([
      {
        id: "gpt-5",
        name: "ChatGPT Web GPT-5",
        webLabel: "GPT-5",
        reasoning: true,
        reasoningOptions: { off: "Auto", low: "Standard", high: "Extended" },
      },
    ]);
    expect(config.selectors.modelPicker).toBe("#model-picker");
    expect(config.selectors.reasoningOption).toBe("[role=menuitem]");
  });

  it.each([
    { models: [] },
    { models: [{ id: "gpt/5" }] },
    { models: [{ id: "gpt-5" }, { id: "gpt-5" }] },
    { models: [{ id: "gpt-5", webLabel: "GPT-5", reasoning: false, reasoningOptions: { high: "Extended" } }] },
    { models: [{ id: "gpt-5", webLabel: "GPT-5", reasoning: true, reasoningOptions: { high: "Extended" } }] },
  ])("rejects invalid model controls: %j", (value) => {
    expect(() => resolveChatGptWebConfig(value)).toThrow(/models/);
  });

  it.each([
    "http://chatgpt.com/",
    "https://example.com/",
    "https://user@chatgpt.com/",
    "https://chatgpt.com:8443/",
  ])("rejects an unsafe webchat URL: %s", (webchatUrl) => {
    expect(() => resolveChatGptWebConfig({ webchatUrl })).toThrow(/webchatUrl/);
  });

  it.each([
    "https://127.0.0.1:9222/",
    "http://192.168.1.10:9222/",
    "http://user@127.0.0.1:9222/",
    "http://127.0.0.1/",
    "http://127.0.0.1:9222/json",
  ])("rejects an unsafe CDP URL: %s", (cdpUrl) => {
    expect(() => resolveChatGptWebConfig({ cdpUrl })).toThrow(/cdpUrl/);
  });

  it("accepts strict IPv4, IPv6, and localhost CDP endpoints", () => {
    expect(resolveChatGptWebConfig({ cdpUrl: "http://127.0.0.1:9222" }).cdpUrl).toBe(
      "http://127.0.0.1:9222/",
    );
    expect(resolveChatGptWebConfig({ cdpUrl: "http://[::1]:9222" }).cdpUrl).toBe(
      "http://[::1]:9222/",
    );
    expect(resolveChatGptWebConfig({ cdpUrl: "http://localhost:9222" }).cdpUrl).toBe(
      "http://localhost:9222/",
    );
  });

  it("rejects visible provider turns", () => {
    expect(() => resolveChatGptWebConfig({ headless: false })).toThrow(
      /headless must be true/,
    );
  });

  it("rejects numeric values outside their declared boundaries", () => {
    expect(() => resolveChatGptWebConfig({ maxPromptChars: 999 })).toThrow(
      /between 1000 and 60000/,
    );
    expect(() => resolveChatGptWebConfig({ responseTimeoutMs: 900_001 })).toThrow(
      /between 1000 and 900000/,
    );
  });
});
