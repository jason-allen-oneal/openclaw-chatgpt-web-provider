/**
 * Hard limits advertised by the provider catalog.
 *
 * The browser UI does not expose the selected model's tokenizer to the
 * provider. Modern ChatGPT tokenizers are byte-oriented, so UTF-8 byte length
 * is a conservative upper bound on token count. It can reject a prompt earlier
 * than the real tokenizer would, but it cannot allow a request that is larger
 * than the declared context window.
 */
export const CHATGPT_WEB_CONTEXT_WINDOW = 32_768;
export const CHATGPT_WEB_MAX_TOKENS = 8_192;
export const CHATGPT_WEB_INPUT_TOKEN_BUDGET =
  CHATGPT_WEB_CONTEXT_WINDOW - CHATGPT_WEB_MAX_TOKENS;

export interface ChatGptWebTurnLimits {
  contextWindow: number;
  maxTokens: number;
}

export function resolveChatGptWebTurnLimits(
  contextWindow?: number,
  maxTokens?: number,
): ChatGptWebTurnLimits {
  const resolvedContextWindow = clampPositiveInteger(
    contextWindow,
    CHATGPT_WEB_CONTEXT_WINDOW,
    CHATGPT_WEB_CONTEXT_WINDOW,
  );
  const resolvedMaxTokens = Math.min(
    clampPositiveInteger(maxTokens, CHATGPT_WEB_MAX_TOKENS, CHATGPT_WEB_MAX_TOKENS),
    resolvedContextWindow,
  );
  return {
    contextWindow: resolvedContextWindow,
    maxTokens: resolvedMaxTokens,
  };
}

/** Return a safe upper bound for tokens in a string sent to a byte tokenizer. */
export function estimateTokenUpperBound(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function clampPositiveInteger(value: number | undefined, fallback: number, maximum: number): number {
  if (value === undefined || !Number.isSafeInteger(value) || value <= 0) return fallback;
  return Math.min(value, maximum);
}
