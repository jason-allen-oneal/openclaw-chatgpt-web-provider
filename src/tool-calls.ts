import { randomUUID } from "node:crypto";
import {
  validateToolCall,
  type Tool,
  type ToolCall,
} from "openclaw/plugin-sdk/llm";

export const OPENCLAW_TOOL_CALL_PREFIX = "OPENCLAW_TOOL_CALL";

/**
 * Parse the browser transport's deliberately small tool-call protocol.
 *
 * The browser model is not trusted with OpenClaw's tool implementation. It
 * can name only a tool already present in the current OpenClaw context, and
 * the SDK validator applies that tool's real schema before the call is
 * returned to the agent loop.
 */
export function parseOpenClawToolCall(
  content: string,
  tools: readonly Tool[],
): ToolCall | undefined {
  const trimmed = content.trim();
  if (!trimmed.startsWith(OPENCLAW_TOOL_CALL_PREFIX)) return undefined;

  const json = trimmed.slice(OPENCLAW_TOOL_CALL_PREFIX.length).trim();
  if (!json.startsWith("{") || !json.endsWith("}")) {
    throw new Error("Malformed OpenClaw tool call: expected one JSON object.");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (error) {
    throw new Error(
      `Malformed OpenClaw tool call JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  if (!isRecord(parsed)) {
    throw new Error("Malformed OpenClaw tool call: payload must be an object.");
  }
  const keys = Object.keys(parsed);
  if (
    keys.length !== 2 ||
    !keys.includes("name") ||
    !keys.includes("arguments") ||
    typeof parsed.name !== "string" ||
    !isRecord(parsed.arguments)
  ) {
    throw new Error(
      'Malformed OpenClaw tool call: expected exactly {"name": string, "arguments": object}.',
    );
  }

  const toolCall: ToolCall = {
    type: "toolCall",
    id: createToolCallId(),
    name: parsed.name,
    arguments: parsed.arguments,
  };

  // Validate against the live OpenClaw tool catalog before emitting any
  // toolcall event. OpenClaw validates again at execution time; doing it here
  // prevents a malformed browser response from entering the agent transcript.
  const validatedArguments = validateToolCall([...tools], toolCall);
  if (!isRecord(validatedArguments)) {
    throw new Error(`Tool "${toolCall.name}" arguments did not validate to an object.`);
  }
  return { ...toolCall, arguments: validatedArguments };
}

function createToolCallId(): string {
  return `call_${randomUUID().replaceAll("-", "").slice(0, 24)}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
