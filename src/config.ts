import path from "node:path";

export const CHATGPT_WEB_PROVIDER_ID = "chatgpt-web";
export const CHATGPT_WEB_MODEL_ID = "backup";
export const CHATGPT_WEB_AUTH_MARKER = "chatgpt-web-local";

export interface ChatGptWebSelectors {
  composer: string;
  send: string;
  assistant: string;
  responseContent: string;
  stop: string;
}

export interface ChatGptWebConfig {
  webchatUrl: string;
  mode: "launch" | "cdp";
  profileDir: string;
  cdpUrl: string;
  executablePath?: string;
  headless: boolean;
  acknowledgeDataEgress: boolean;
  maxPromptChars: number;
  readyTimeoutMs: number;
  responseTimeoutMs: number;
  stabilityWindowMs: number;
  selectors: ChatGptWebSelectors;
}

const DEFAULT_SELECTORS: ChatGptWebSelectors = {
  composer:
    'form[data-type="unified-composer"] #prompt-textarea[contenteditable="true"][role="textbox"], #prompt-textarea[contenteditable="true"][role="textbox"]',
  send:
    'form[data-type="unified-composer"] button[data-testid="send-button"], form[data-type="unified-composer"] button[aria-label="Send prompt"]',
  assistant: '[data-message-author-role="assistant"][data-message-id]',
  responseContent:
    '[data-message-content-part="final"], [data-message-content="final"], .markdown.prose, .markdown, .prose',
  stop:
    'form[data-type="unified-composer"] button[data-testid="stop-button"], form[data-type="unified-composer"] button[aria-label*="Stop"]',
};

const DEFAULT_CONFIG: ChatGptWebConfig = {
  webchatUrl: "https://chatgpt.com/",
  mode: "launch",
  profileDir: "~/.openclaw/state/chatgpt-web/profile",
  cdpUrl: "http://127.0.0.1:9222",
  headless: false,
  acknowledgeDataEgress: false,
  maxPromptChars: 100_000,
  readyTimeoutMs: 30_000,
  responseTimeoutMs: 180_000,
  stabilityWindowMs: 1_500,
  selectors: DEFAULT_SELECTORS,
};

export function resolveChatGptWebConfig(value: unknown): ChatGptWebConfig {
  const raw = asRecord(value);
  const selectors = asRecord(raw.selectors);
  const mode = raw.mode === "cdp" ? "cdp" : "launch";

  return {
    webchatUrl: readChatGptUrl(raw.webchatUrl),
    mode,
    profileDir: expandHome(readString(raw.profileDir, DEFAULT_CONFIG.profileDir)),
    cdpUrl: readLoopbackCdpUrl(raw.cdpUrl),
    ...(readOptionalString(raw.executablePath)
      ? { executablePath: expandHome(readOptionalString(raw.executablePath)!) }
      : {}),
    headless: readBoolean(raw.headless, DEFAULT_CONFIG.headless),
    acknowledgeDataEgress: readBoolean(
      raw.acknowledgeDataEgress,
      DEFAULT_CONFIG.acknowledgeDataEgress,
    ),
    maxPromptChars: readInteger(raw.maxPromptChars, DEFAULT_CONFIG.maxPromptChars, 1_000, 200_000),
    readyTimeoutMs: readInteger(
      raw.readyTimeoutMs,
      DEFAULT_CONFIG.readyTimeoutMs,
      1_000,
      300_000,
    ),
    responseTimeoutMs: readInteger(
      raw.responseTimeoutMs,
      DEFAULT_CONFIG.responseTimeoutMs,
      1_000,
      900_000,
    ),
    stabilityWindowMs: readInteger(
      raw.stabilityWindowMs,
      DEFAULT_CONFIG.stabilityWindowMs,
      250,
      30_000,
    ),
    selectors: {
      composer: readString(selectors.composer, DEFAULT_SELECTORS.composer),
      send: readString(selectors.send, DEFAULT_SELECTORS.send),
      assistant: readString(selectors.assistant, DEFAULT_SELECTORS.assistant),
      responseContent: readString(
        selectors.responseContent,
        DEFAULT_SELECTORS.responseContent,
      ),
      stop: readString(selectors.stop, DEFAULT_SELECTORS.stop),
    },
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function readString(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function readOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function readInteger(
  value: unknown,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  if (typeof value !== "number" || !Number.isInteger(value)) return fallback;
  if (value < minimum || value > maximum) {
    throw new Error(`Expected an integer between ${minimum} and ${maximum}`);
  }
  return value;
}

function readChatGptUrl(value: unknown): string {
  const candidate = readString(value, DEFAULT_CONFIG.webchatUrl);
  try {
    const url = new URL(candidate);
    if (
      url.protocol !== "https:" ||
      (url.hostname !== "chatgpt.com" && url.hostname !== "chat.openai.com")
    ) {
      throw new Error("unexpected origin");
    }
    return url.toString();
  } catch {
    throw new Error("webchatUrl must be an HTTPS URL on chatgpt.com or chat.openai.com");
  }
}

function readLoopbackCdpUrl(value: unknown): string {
  const candidate = readString(value, DEFAULT_CONFIG.cdpUrl);
  try {
    const url = new URL(candidate);
    const loopbackHosts = new Set(["127.0.0.1", "localhost", "[::1]"]);
    if (!loopbackHosts.has(url.hostname)) throw new Error("non-loopback host");
    return url.toString();
  } catch {
    throw new Error("cdpUrl must use a loopback host");
  }
}

function expandHome(value: string): string {
  if (value === "~") return process.env.HOME ?? value;
  if (value.startsWith("~/")) return path.join(process.env.HOME ?? "", value.slice(2));
  return path.resolve(value);
}
