import type { Context, Message } from "openclaw/plugin-sdk/llm";

export function buildWebchatPrompt(context: Context): string {
  const sections: string[] = [
    "# OpenClaw fallback request",
    "",
    "You are being used as a browser-backed fallback transport for OpenClaw.",
    "Return only the assistant response to the active request.",
    "Do not claim to have executed tools: this transport cannot return native tool calls.",
  ];

  if (context.systemPrompt?.trim()) {
    sections.push("", "## System instructions", context.systemPrompt.trim());
  }

  sections.push("", "## Conversation");
  for (const message of context.messages) {
    sections.push("", `### ${labelForMessage(message)}`, renderMessage(message));
  }

  sections.push(
    "",
    "## Response instruction",
    "Answer the final user request above. Preserve any required output format.",
  );
  return sections.join("\n").trim();
}

function labelForMessage(message: Message): string {
  if (message.role === "toolResult") return `Tool result: ${message.toolName}`;
  return message.role === "assistant" ? "Assistant" : "User";
}

function renderMessage(message: Message): string {
  if (typeof message.content === "string") return message.content.trim() || "[empty message]";
  const parts: string[] = [];
  for (const part of message.content) {
    if (part.type === "text") {
      parts.push(part.text);
    } else if (part.type === "thinking") {
      parts.push(`[prior assistant reasoning omitted]`);
    } else if (part.type === "toolCall") {
      parts.push(`[tool call ${part.name}; arguments omitted by fallback privacy policy]`);
    } else if (part.type === "image") {
      parts.push(`[image omitted by text-only fallback transport: ${part.mimeType}]`);
    }
  }
  return parts.join("\n").trim() || "[empty message]";
}
