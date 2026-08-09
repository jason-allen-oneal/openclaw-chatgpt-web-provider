import path from "node:path";
import { resolveStateDir } from "openclaw/plugin-sdk/state-paths";

export const CHATGPT_WEB_PROVIDER_ID = "chatgpt-web";
export const CHATGPT_WEB_MODEL_ID = "backup";
export const CHATGPT_WEB_AUTH_MARKER = "chatgpt-web-local";

export interface ChatGptWebSelectors {
  composer: string;
  send: string;
  message: string;
  assistant: string;
  user: string;
  responseContent: string;
  completion: string;
  stop: string;
}

export interface ChatGptWebConfig {
  webchatUrl: string;
  mode: "launch" | "cdp";
  profileDir: string;
  cdpUrl: string;
  executablePath?: string;
  sandboxMode: "default" | "userns";
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
  message: '[data-message-author-role][data-message-id]',
  assistant: '[data-message-author-role="assistant"][data-message-id]',
  user: '[data-message-author-role="user"][data-message-id]',
  responseContent:
    '[data-message-content-part="final"], [data-message-content="final"], .markdown.prose, .markdown, .prose',
  completion:
    '[data-message-content-part="final"], [data-message-content="final"]',
  stop:
    'form[data-type="unified-composer"] button[data-testid="stop-button"], form[data-type="unified-composer"] button[aria-label*="Stop"]',
};

const DEFAULT_CONFIG: ChatGptWebConfig = {
  webchatUrl: "https://chatgpt.com/",
  mode: "launch",
  profileDir: path.join(resolveStateDir(), "chatgpt-web", "profile"),
  cdpUrl: "http://127.0.0.1:9222",
  sandboxMode: "default",
  headless: true,
  acknowledgeDataEgress: false,
  maxPromptChars: 50_000,
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
    sandboxMode: raw.sandboxMode === "userns" ? "userns" : "default",
    headless: readHeadless(raw.headless),
    acknowledgeDataEgress: readBoolean(
      raw.acknowledgeDataEgress,
      DEFAULT_CONFIG.acknowledgeDataEgress,
    ),
    maxPromptChars: readInteger(raw.maxPromptChars, DEFAULT_CONFIG.maxPromptChars, 1_000, 60_000),
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
      message: readString(selectors.message, DEFAULT_SELECTORS.message),
      assistant: readString(selectors.assistant, DEFAULT_SELECTORS.assistant),
      user: readString(selectors.user, DEFAULT_SELECTORS.user),
      responseContent: readString(
        selectors.responseContent,
        DEFAULT_SELECTORS.responseContent,
      ),
      completion: readString(selectors.completion, DEFAULT_SELECTORS.completion),
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

function readHeadless(value: unknown): true {
  if (value === false) {
    throw new Error(
      "headless must be true; provider turns never launch a visible browser window",
    );
  }
  return true;
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
      (url.hostname !== "chatgpt.com" && url.hostname !== "chat.openai.com") ||
      url.username !== "" ||
      url.password !== "" ||
      url.port !== ""
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
    if (
      url.protocol !== "http:" ||
      !loopbackHosts.has(url.hostname) ||
      url.username !== "" ||
      url.password !== "" ||
      url.port === "" ||
      url.pathname !== "/" ||
      url.search !== "" ||
      url.hash !== ""
    ) {
      throw new Error("invalid CDP endpoint");
    }
    return url.toString();
  } catch {
    throw new Error(
      "cdpUrl must be an HTTP endpoint with an explicit port on 127.0.0.1, localhost, or [::1]",
    );
  }
}

function expandHome(value: string): string {
  if (value === "~") return process.env.HOME ?? value;
  if (value.startsWith("~/")) return path.join(process.env.HOME ?? "", value.slice(2));
  return path.resolve(value);
}
