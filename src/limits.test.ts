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
    expect(CHATGPT_WEB_CONTEXT_WINDOW).toBe(128_000);
    expect(CHATGPT_WEB_MAX_TOKENS).toBe(16_384);
    expect(CHATGPT_WEB_INPUT_TOKEN_BUDGET).toBe(111_616);
  });

  it("uses UTF-8 bytes as a conservative token upper bound", () => {
    expect(estimateTokenUpperBound("abc")).toBe(3);
    expect(estimateTokenUpperBound("é")).toBe(2);
    expect(estimateTokenUpperBound("😀")).toBe(4);
  });

  it("permits custom model limits within provider maximums", () => {
    expect(resolveChatGptWebTurnLimits(300_000, 50_000)).toEqual({
      contextWindow: 200_000,
      maxTokens: 32_768,
    });
    expect(resolveChatGptWebTurnLimits(64_000, 8_192)).toEqual({
      contextWindow: 64_000,
      maxTokens: 8_192,
    });
    expect(resolveChatGptWebTurnLimits()).toEqual({
      contextWindow: 128_000,
      maxTokens: 16_384,
    });
  });
});
