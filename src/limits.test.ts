import { describe, expect, it } from "vitest";
import {
  CHATGPT_WEB_CONTEXT_WINDOW,
  CHATGPT_WEB_INPUT_TOKEN_BUDGET,
  CHATGPT_WEB_MAX_TOKENS,
  estimateTokenUpperBound,
  resolveChatGptWebTurnLimits,
} from "./limits.js";

describe("ChatGPT web token limits", () => {
  it("reserves the advertised output budget inside the advertised context window", () => {
    expect(CHATGPT_WEB_CONTEXT_WINDOW).toBe(32_768);
    expect(CHATGPT_WEB_MAX_TOKENS).toBe(8_192);
    expect(CHATGPT_WEB_INPUT_TOKEN_BUDGET).toBe(24_576);
  });

  it("uses UTF-8 bytes as a conservative token upper bound", () => {
    expect(estimateTokenUpperBound("abc")).toBe(3);
    expect(estimateTokenUpperBound("é")).toBe(2);
    expect(estimateTokenUpperBound("😀")).toBe(4);
  });

  it("never permits limits above the provider catalog", () => {
    expect(resolveChatGptWebTurnLimits(100_000, 100_000)).toEqual({
      contextWindow: CHATGPT_WEB_CONTEXT_WINDOW,
      maxTokens: CHATGPT_WEB_MAX_TOKENS,
    });
    expect(resolveChatGptWebTurnLimits(16_384, 8_192)).toEqual({
      contextWindow: 16_384,
      maxTokens: 8_192,
    });
  });
});
