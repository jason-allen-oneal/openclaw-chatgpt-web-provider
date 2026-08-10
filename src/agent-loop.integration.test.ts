import type { AgentMessage, AgentTool } from "openclaw/plugin-sdk/agent-core";
import { runAgentLoop } from "openclaw/plugin-sdk/agent-core";
import type { Message, Model } from "openclaw/plugin-sdk/llm";
import { describe, expect, it, vi } from "vitest";
import type { ChatGptWebClient } from "./browser-client.js";
import { createChatGptWebStreamFn } from "./stream.js";

const model: Model = {
  id: "backup",
  name: "ChatGPT Web",
  api: "chatgpt-web",
  provider: "chatgpt-web",
  baseUrl: "chatgpt-web://local",
  reasoning: true,
  thinkingLevelMap: {
    off: null,
    minimal: "minimal",
    low: "low",
    medium: "medium",
    high: "high",
    xhigh: "xhigh",
    max: "max",
  },
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 32_768,
  maxTokens: 8_192,
};

describe("ChatGPT web provider at the OpenClaw agent-loop boundary", () => {
  it("executes a native tool call and sends its result into the next provider turn", async () => {
    let browserTurns = 0;
    let executedArguments: unknown;
    const ask = vi.fn(async (prompt: string, _signal?: AbortSignal, controls?: { reasoning?: string }) => {
      browserTurns += 1;
      expect(controls?.reasoning).toBe("high");
      expect(prompt).toContain("Requested reasoning effort: high");
      if (browserTurns === 1) {
        expect(prompt).toContain("### read_file");
        return 'OPENCLAW_TOOL_CALL {"name":"read_file","arguments":{"path":"README.md"}}';
      }
      expect(prompt).toContain("read_file");
      expect(prompt).toContain("fixture file contents");
      return "The fixture was read successfully.";
    });
    const client: ChatGptWebClient = { ask };
    const tool: AgentTool = {
      name: "read_file",
      label: "Read file",
      description: "Read one approved file.",
      parameters: {
        type: "object",
        properties: { path: { type: "string" } },
        required: ["path"],
        additionalProperties: false,
      },
      execute: async (_toolCallId, args) => {
        executedArguments = args;
        return {
          content: [{ type: "text", text: "fixture file contents" }],
          details: {},
        };
      },
    };
    let toolExecutionEnds = 0;

    const messages = await runAgentLoop(
      [],
      {
        systemPrompt: "Use available tools when needed.",
        messages: [
          { role: "user", content: "Read the fixture.", timestamp: Date.now() },
        ],
        tools: [tool],
      },
      {
        model,
        thinkingLevel: "high",
        reasoning: "high",
        convertToLlm: (current: AgentMessage[]): Message[] =>
          current as unknown as Message[],
        toolExecution: "sequential",
        getSteeringMessages: async () => [],
        getFollowUpMessages: async () => [],
      },
      async (event) => {
        if (event.type === "tool_execution_end") toolExecutionEnds += 1;
      },
      undefined,
      createChatGptWebStreamFn({
        client,
        modelConfig: {
          id: "backup",
          name: "ChatGPT Web (backup)",
          reasoning: true,
          reasoningOptions: { off: "Auto", high: "Extended" },
        },
        maxPromptChars: 100_000,
      }),
    );

    const finalMessage = messages.at(-1);
    expect(ask).toHaveBeenCalledTimes(2);
    expect(browserTurns).toBe(2);
    expect(executedArguments).toEqual({ path: "README.md" });
    expect(toolExecutionEnds).toBe(1);
    expect(finalMessage).toMatchObject({
      role: "assistant",
      stopReason: "stop",
      content: [{ type: "text", text: "The fixture was read successfully." }],
    });
  });
});
