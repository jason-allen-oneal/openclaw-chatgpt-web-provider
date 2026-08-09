import type { Model, Tool } from "openclaw/plugin-sdk/llm";
import { describe, expect, it, vi } from "vitest";
import type { ChatGptWebClient } from "./browser-client.js";
import { createChatGptWebStreamFn } from "./stream.js";

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

const readFileTool: Tool = {
  name: "read_file",
  description: "Read one approved file.",
  parameters: {
    type: "object",
    properties: { path: { type: "string" } },
    required: ["path"],
    additionalProperties: false,
  },
};

describe("createChatGptWebStreamFn", () => {
  it("converts a browser response into the OpenClaw stream protocol", async () => {
    const ask = vi.fn().mockResolvedValue("fallback answer");
    const client: ChatGptWebClient = { ask };
    const stream = await createChatGptWebStreamFn({ client, maxPromptChars: 100_000 })(
      model,
      { messages: [{ role: "user", content: "hello", timestamp: 1 }] },
    );
    const events = [];
    for await (const event of stream) events.push(event);
    const result = await stream.result();

    expect(ask).toHaveBeenCalledOnce();
    expect(events.map((event) => event.type)).toEqual([
      "start",
      "text_start",
      "text_delta",
      "text_end",
      "done",
    ]);
    expect(events[1]).toMatchObject({
      type: "text_start",
      partial: { content: [{ type: "text", text: "" }] },
    });
    expect(result.content).toEqual([{ type: "text", text: "fallback answer" }]);
  });

  it("emits a validated native OpenClaw tool call from the browser response", async () => {
    const ask = vi
      .fn()
      .mockResolvedValue(
        'OPENCLAW_TOOL_CALL {"name":"read_file","arguments":{"path":"README.md"}}',
      );
    const stream = await createChatGptWebStreamFn({
      client: { ask },
      maxPromptChars: 100_000,
    })(model, {
      tools: [readFileTool],
      messages: [{ role: "user", content: "Read the README.", timestamp: 1 }],
    });
    const events = [];
    for await (const event of stream) events.push(event);
    const result = await stream.result();

    expect(ask.mock.calls[0]?.[0]).toContain("### read_file");
    expect(events.map((event) => event.type)).toEqual([
      "start",
      "toolcall_start",
      "toolcall_delta",
      "toolcall_end",
      "done",
    ]);
    expect(result.stopReason).toBe("toolUse");
    expect(result.content).toEqual([
      expect.objectContaining({
        type: "toolCall",
        name: "read_file",
        arguments: { path: "README.md" },
      }),
    ]);
    expect(result.content[0]).toMatchObject({ id: expect.stringMatching(/^call_[a-f0-9]{24}$/) });
  });

  it("rejects unknown browser-requested tools before emitting a call", async () => {
    const stream = await createChatGptWebStreamFn({
      client: {
        ask: vi.fn().mockResolvedValue(
          'OPENCLAW_TOOL_CALL {"name":"delete_everything","arguments":{}}',
        ),
      },
      maxPromptChars: 100_000,
    })(model, {
      tools: [readFileTool],
      messages: [{ role: "user", content: "Do the task.", timestamp: 1 }],
    });
    const events = [];
    for await (const event of stream) events.push(event);
    const result = await stream.result();

    expect(events.map((event) => event.type)).toEqual(["start", "error"]);
    expect(result.errorMessage).toMatch(/Tool "delete_everything" not found/);
  });

  it("rejects tool arguments that fail the live OpenClaw schema", async () => {
    const stream = await createChatGptWebStreamFn({
      client: {
        ask: vi.fn().mockResolvedValue(
          'OPENCLAW_TOOL_CALL {"name":"read_file","arguments":{}}',
        ),
      },
      maxPromptChars: 100_000,
    })(model, {
      tools: [readFileTool],
      messages: [{ role: "user", content: "Do the task.", timestamp: 1 }],
    });
    for await (const _event of stream) {
      // Drain the protocol.
    }

    expect((await stream.result()).errorMessage).toMatch(
      /Validation failed for tool "read_file"/,
    );
  });

  it("rejects a tool marker surrounded by extra browser-model prose", async () => {
    const stream = await createChatGptWebStreamFn({
      client: {
        ask: vi.fn().mockResolvedValue(
          'OPENCLAW_TOOL_CALL {"name":"read_file","arguments":{"path":"README.md"}}\nI also completed the task.',
        ),
      },
      maxPromptChars: 100_000,
    })(model, {
      tools: [readFileTool],
      messages: [{ role: "user", content: "Do the task.", timestamp: 1 }],
    });
    const events = [];
    for await (const event of stream) events.push(event);

    expect(events.map((event) => event.type)).toEqual(["start", "error"]);
    expect((await stream.result()).errorMessage).toMatch(
      /Malformed OpenClaw tool call: expected one JSON object/,
    );
  });

  it("returns a protocol error when the browser request fails", async () => {
    const client: ChatGptWebClient = {
      ask: vi.fn().mockRejectedValue(new Error("browser unavailable")),
    };
    const stream = await createChatGptWebStreamFn({ client, maxPromptChars: 100_000 })(
      model,
      { messages: [{ role: "user", content: "hello", timestamp: 1 }] },
    );
    const events = [];
    for await (const event of stream) events.push(event);
    const result = await stream.result();

    expect(events.at(-1)?.type).toBe("error");
    expect(result.stopReason).toBe("error");
    expect(result.errorMessage).toBe("browser unavailable");
    expect(result.content).toEqual([
      { type: "text", text: "ChatGPT web transport failed." },
    ]);
    expect(result.usage.output).toBeGreaterThan(0);
  });

  it("rejects an oversized serialized prompt before calling the browser", async () => {
    const ask = vi.fn();
    const stream = await createChatGptWebStreamFn({
      client: { ask },
      maxPromptChars: 1_000,
    })(model, {
      messages: [{ role: "user", content: "x".repeat(2_000), timestamp: 1 }],
    });
    for await (const _event of stream) {
      // Drain the protocol.
    }
    expect((await stream.result()).errorMessage).toMatch(/configured maximum/);
    expect(ask).not.toHaveBeenCalled();
  });

  it("reports abort using the OpenClaw aborted stop reason", async () => {
    const controller = new AbortController();
    const client: ChatGptWebClient = {
      ask: vi.fn(async (_prompt, signal) => {
        controller.abort();
        if (signal?.aborted) throw new Error("request aborted");
        return "unreachable";
      }),
    };
    const stream = await createChatGptWebStreamFn({ client, maxPromptChars: 100_000 })(
      model,
      { messages: [{ role: "user", content: "hello", timestamp: 1 }] },
      { signal: controller.signal },
    );
    for await (const _event of stream) {
      // Drain the protocol.
    }
    expect((await stream.result()).stopReason).toBe("aborted");
  });

  it("rejects an empty response from any browser-client implementation", async () => {
    const stream = await createChatGptWebStreamFn({
      client: { ask: vi.fn().mockResolvedValue("  ") },
      maxPromptChars: 100_000,
    })(model, { messages: [{ role: "user", content: "hello", timestamp: 1 }] });
    for await (const _event of stream) {
      // Drain the protocol.
    }
    expect((await stream.result()).errorMessage).toMatch(/empty_response/);
  });
});
