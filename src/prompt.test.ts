import { describe, expect, it } from "vitest";
import { buildWebchatPrompt } from "./prompt.js";

describe("buildWebchatPrompt", () => {
  it("serializes system, conversation, and tool results", () => {
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
    expect(prompt).toContain("cannot return native tool calls");
  });
});

