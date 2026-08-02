import { describe, expect, it } from "vitest";
import { resolveChatGptWebConfig } from "./config.js";

describe("resolveChatGptWebConfig", () => {
  it("uses a dedicated launch profile by default", () => {
    const config = resolveChatGptWebConfig(undefined);
    expect(config.mode).toBe("launch");
    expect(config.profileDir).toContain(".openclaw/state/chatgpt-web/profile");
    expect(config.webchatUrl).toBe("https://chatgpt.com/");
    expect(config.acknowledgeDataEgress).toBe(false);
  });

  it("accepts project and selector overrides", () => {
    const config = resolveChatGptWebConfig({
      webchatUrl: "https://chatgpt.com/g/example/project",
      mode: "cdp",
      acknowledgeDataEgress: true,
      selectors: { composer: "[data-test=prompt]" },
    });
    expect(config.mode).toBe("cdp");
    expect(config.webchatUrl).toBe("https://chatgpt.com/g/example/project");
    expect(config.selectors.composer).toBe("[data-test=prompt]");
    expect(config.acknowledgeDataEgress).toBe(true);
  });
});
