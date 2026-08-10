import { describe, expect, it } from "vitest";
import { buildWebchatPrompt } from "./prompt.js";

describe("buildWebchatPrompt", () => {
  it("renders the selected web model and reasoning level as provider controls", () => {
    const prompt = buildWebchatPrompt(
      { messages: [{ role: "user", content: "Solve it.", timestamp: 1 }] },
      {
        model: {
          id: "gpt-5",
          name: "ChatGPT Web GPT-5",
          webLabel: "GPT-5",
        },
        reasoning: "high",
      },
    );

    expect(prompt).toContain("## Requested browser controls");
    expect(prompt).toContain("ChatGPT web model: GPT-5");
    expect(prompt).toContain("Requested reasoning effort: high");
    expect(prompt).toContain("Do not reveal hidden chain-of-thought");
  });

  it("serializes system, conversation, tool results, and the tool protocol", () => {
    const prompt = buildWebchatPrompt({
      systemPrompt: "Be exact.",
      messages: [
        { role: "user", content: "Inspect it.", timestamp: 1 },
        {
          role: "toolResult",
          toolCallId: "call-1",
          toolName: "read",
          content: [{ type: "text", text: "evidence" }],
          isError: false,
          timestamp: 2,
        },
      ],
    });
    expect(prompt).toContain("Be exact.");
    expect(prompt).toContain("### User\nInspect it.");
    expect(prompt).toContain("### Tool result: read\nevidence");
    expect(prompt).toContain("## Available OpenClaw tools");
    expect(prompt).toContain("No tools are available for this turn.");
    expect(prompt).toContain("Do not emit a tool-call marker because no tools are available.");
  });

  it("omits hidden reasoning, signatures, and image bytes while preserving tool arguments", () => {
    const prompt = buildWebchatPrompt({
      systemPrompt: "Synthetic only.",
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "visible" },
            { type: "image", mimeType: "image/png", data: "PRIVATE_IMAGE_BYTES" },
          ],
          timestamp: 1,
        },
        {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "PRIVATE_REASONING", thinkingSignature: "PRIVATE_SIG" },
            {
              type: "toolCall",
              id: "call-1",
              name: "dangerous_tool",
              arguments: { secret: "PRIVATE_ARGUMENT" },
              thoughtSignature: "PRIVATE_TOOL_SIG",
            },
          ],
          api: "chatgpt-web",
          provider: "chatgpt-web",
          model: "backup",
          usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 0,
            cost: {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              total: 0,
            },
          },
          stopReason: "toolUse",
          timestamp: 2,
        },
        {
          role: "toolResult",
          toolCallId: "call-1",
          toolName: "dangerous_tool",
          content: [{ type: "image", mimeType: "image/jpeg", data: "PRIVATE_TOOL_IMAGE" }],
          isError: false,
          timestamp: 3,
        },
      ],
    });

    expect(prompt).toContain("visible");
    expect(prompt).toContain('Arguments: {"secret":"PRIVATE_ARGUMENT"}');
    expect(prompt).toContain("image omitted by text-only fallback transport");
    expect(prompt).not.toMatch(/PRIVATE_(?:IMAGE_BYTES|REASONING|SIG|TOOL_SIG|TOOL_IMAGE)/);
  });

  it("serializes the live OpenClaw tool catalog and strict call format", () => {
    const prompt = buildWebchatPrompt({
      tools: [
        {
          name: "read_file",
          description: "Read one approved file.",
          parameters: {
            type: "object",
            properties: { path: { type: "string" } },
            required: ["path"],
            additionalProperties: false,
          },
        },
      ],
      messages: [{ role: "user", content: "Read the file.", timestamp: 1 }],
    });

    expect(prompt).toContain("### read_file\nRead one approved file.");
    expect(prompt).toContain('Parameters (JSON Schema): {"type":"object"');
    expect(prompt).toContain("OPENCLAW_TOOL_CALL");
    expect(prompt).toContain("OpenClaw will execute it");
  });

  it("renders empty and mixed messages explicitly", () => {
    const prompt = buildWebchatPrompt({
      messages: [
        { role: "user", content: [], timestamp: 1 },
        { role: "user", content: "", timestamp: 2 },
      ],
    });
    expect(prompt).toContain("[empty message]");
  });
});
