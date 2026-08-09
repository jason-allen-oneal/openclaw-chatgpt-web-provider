import type { StreamFn } from "openclaw/plugin-sdk/agent-core";
import {
  createAssistantMessageEventStream,
  type AssistantMessage,
  type Usage,
} from "openclaw/plugin-sdk/llm";
import type { ChatGptWebClient } from "./browser-client.js";
import { buildWebchatPrompt } from "./prompt.js";

export function createChatGptWebStreamFn(params: {
  client: ChatGptWebClient;
  maxPromptChars: number;
}): StreamFn {
  return (model, context, options) => {
    const stream = createAssistantMessageEventStream();

    queueMicrotask(() => {
      void (async () => {
        try {
          const prompt = buildWebchatPrompt(context);
          if (prompt.length > params.maxPromptChars) {
            throw new Error(
              `Serialized fallback prompt is ${prompt.length} characters; configured maximum is ${params.maxPromptChars}`,
            );
          }
          const empty = buildMessage(model, "", "stop", estimateUsage(prompt, ""));
          stream.push({ type: "start", partial: empty });
          // This browser transport is intentionally buffered: it emits one text
          // delta only after the complete, positively terminated DOM response.
          const text = await params.client.ask(prompt, options?.signal);
          if (!text.trim()) {
            throw new Error("[chatgpt-web:empty_response] Browser transport returned no text");
          }
          const message = buildMessage(model, text, "stop", estimateUsage(prompt, text));
          const textStarted = buildMessage(
            model,
            "",
            "stop",
            estimateUsage(prompt, ""),
            undefined,
            true,
          );
          stream.push({ type: "text_start", contentIndex: 0, partial: textStarted });
          stream.push({ type: "text_delta", contentIndex: 0, delta: text });
          stream.push({
            type: "text_end",
            contentIndex: 0,
            content: text,
            partial: message,
          });
          stream.push({ type: "done", reason: "stop", message });
        } catch (error) {
          const aborted = options?.signal?.aborted === true;
          // OpenClaw 2026.7.1 retries error turns that contain no visible text.
          // A fixed, non-sensitive text block keeps browser failures single-shot
          // while the detailed typed error remains in errorMessage.
          const visibleError = aborted ? "" : "ChatGPT web transport failed.";
          const message = buildMessage(
            model,
            visibleError,
            aborted ? "aborted" : "error",
            aborted ? emptyUsage() : estimateUsage("", visibleError),
            renderError(error),
          );
          stream.push({
            type: "error",
            reason: aborted ? "aborted" : "error",
            error: message,
          });
        } finally {
          stream.end();
        }
      })();
    });

    return stream;
  };
}

function buildMessage(
  model: Parameters<StreamFn>[0],
  text: string,
  stopReason: AssistantMessage["stopReason"],
  usage: Usage,
  errorMessage?: string,
  includeEmptyTextBlock = false,
): AssistantMessage {
  return {
    role: "assistant",
    content: text || includeEmptyTextBlock ? [{ type: "text", text }] : [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage,
    stopReason,
    ...(errorMessage ? { errorMessage } : {}),
    timestamp: Date.now(),
  };
}

function estimateUsage(prompt: string, response: string): Usage {
  return buildUsage(Math.ceil(prompt.length / 4), Math.ceil(response.length / 4));
}

function emptyUsage(): Usage {
  return buildUsage(0, 0);
}

function buildUsage(input: number, output: number): Usage {
  return {
    input,
    output,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: input + output,
    cost: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      total: 0,
    },
  };
}

function renderError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
