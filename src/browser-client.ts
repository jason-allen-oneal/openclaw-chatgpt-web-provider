import { createHash, randomUUID } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import {
  access,
  chmod,
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  stat,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import {
  chromium,
  type Browser,
  type BrowserContext,
  type Download,
  type Frame,
  type Locator,
  type Page,
} from "playwright-core";
import type { ChatGptWebConfig } from "./config.js";
import type { ChatGptWebModelConfig } from "./config.js";
import {
  estimateTokenUpperBound,
  resolveChatGptWebTurnLimits,
  type ChatGptWebTurnLimits,
} from "./limits.js";
import type { ModelThinkingLevel } from "openclaw/plugin-sdk/llm";

export interface BrowserClientLogger {
  debug?(message: string): void;
  info?(message: string): void;
  warn?(message: string): void;
  error?(message: string): void;
}

export type ChatGptWebStreamDelta =
  | { kind: "text"; text: string }
  | { kind: "thinking"; text: string };

export type ChatGptWebStreamHandler = (delta: ChatGptWebStreamDelta) => void;

export interface ChatGptWebClient {
  ask(
    prompt: string,
    signal?: AbortSignal,
    controls?: ChatGptWebTurnControls,
    onStreamDelta?: ChatGptWebStreamHandler,
  ): Promise<string>;
  launchInteractiveLogin?(): Promise<void>;
  checkAuthStatus?(): Promise<{ authenticated: boolean; error?: string }>;
}

export interface ChatGptWebTurnControls {
  model?: ChatGptWebModelConfig;
  reasoning?: ModelThinkingLevel;
  limits?: ChatGptWebTurnLimits;
}

export interface BrowserAutomation {
  connectOverCDP(endpoint: string): Promise<Browser>;
  launchPersistentContext(
    userDataDir: string,
    options: {
      executablePath: string;
      headless: boolean;
      acceptDownloads: false;
      ignoreDefaultArgs?: string[] | boolean;
      args?: string[];
      viewport?: { width: number; height: number };
      screen?: { width: number; height: number };
      locale?: string;
      userAgent?: string;
      extraHTTPHeaders?: Record<string, string>;
    },
  ): Promise<BrowserContext>;
}

export type ChatGptWebErrorCode =
  | "aborted"
  | "auth"
  | "browser"
  | "closed"
  | "empty_response"
  | "integrity"
  | "navigation"
  | "profile"
  | "timeout";

export class ChatGptWebError extends Error {
  readonly code: ChatGptWebErrorCode;

  constructor(code: ChatGptWebErrorCode, message: string, cause?: unknown) {
    super(`[chatgpt-web:${code}] ${message}`, cause === undefined ? undefined : { cause });
    this.name = "ChatGptWebError";
    this.code = code;
  }
}

const DEFAULT_AUTOMATION: BrowserAutomation = {
  connectOverCDP: (endpoint) => chromium.connectOverCDP(endpoint),
  launchPersistentContext: (userDataDir, options) =>
    chromium.launchPersistentContext(userDataDir, options),
};

const HEADLESS_VIEWPORT = { width: 1440, height: 1000 } as const;
const HEADLESS_COMPATIBILITY_INIT_SCRIPT = `
Object.defineProperty(Navigator.prototype, "webdriver", {
  configurable: true,
  get: () => undefined,
});
Object.defineProperty(Navigator.prototype, "languages", {
  configurable: true,
  get: () => ["en-US", "en"],
});
Object.defineProperty(Navigator.prototype, "plugins", {
  configurable: true,
  get: () => [1, 2, 3, 4, 5],
});
`;

export class PlaywrightChatGptWebClient implements ChatGptWebClient {
  readonly #config: ChatGptWebConfig;
  readonly #logger: BrowserClientLogger;
  readonly #automation: BrowserAutomation;
  readonly #nonceFactory: () => string;
  readonly #now: () => number;
  readonly #resolveExecutableVersion: (executablePath: string) => Promise<string>;
  #browser: Browser | undefined;
  #context: BrowserContext | undefined;
  #tail: Promise<void> = Promise.resolve();
  #activeAbort: AbortController | undefined;
  #closed = false;
  #closePromise?: Promise<void>;

  constructor(
    config: ChatGptWebConfig,
    logger: BrowserClientLogger = {},
    dependencies: {
      automation?: BrowserAutomation;
      nonceFactory?: () => string;
      now?: () => number;
      resolveExecutableVersion?: (executablePath: string) => Promise<string>;
    } = {},
  ) {
    this.#config = config;
    this.#logger = logger;
    this.#automation = dependencies.automation ?? DEFAULT_AUTOMATION;
    this.#nonceFactory = dependencies.nonceFactory ?? randomUUID;
    this.#now = dependencies.now ?? Date.now;
    this.#resolveExecutableVersion =
      dependencies.resolveExecutableVersion ?? resolveChromiumVersion;
  }

  async ask(
    prompt: string,
    signal?: AbortSignal,
    controls?: ChatGptWebTurnControls,
    onStreamDelta?: ChatGptWebStreamHandler,
  ): Promise<string> {
    return await this.#enqueue(async () => {
      this.#assertOpen();
      throwIfAborted(signal);

      const controller = new AbortController();
      const removeForwarder = forwardAbort(signal, controller);
      this.#activeAbort = controller;
      let page: Page | undefined;
      const stopOnAbort = () => {
        if (page) void this.#abortActiveTurn(page);
      };
      controller.signal.addEventListener("abort", stopOnAbort, { once: true });

      try {
        page = await this.#newPageWithRecovery(controller.signal);
        throwIfAborted(controller.signal);
        const boundary = installPageBoundaryGuards(page, this.#config.webchatUrl);
        try {
          return await Promise.race([
            this.#runTurn(page, prompt, controller.signal, controls, onStreamDelta),
            boundary.violation,
          ]);
        } finally {
          boundary.dispose();
        }
      } catch (error) {
        if (controller.signal.aborted) throw abortedError();
        if (error instanceof ChatGptWebError) throw error;
        throw new ChatGptWebError("browser", renderError(error), error);
      } finally {
        controller.signal.removeEventListener("abort", stopOnAbort);
        removeForwarder();
        await page?.close().catch(() => undefined);
        await this.#disposeCachedConnection();
        if (this.#activeAbort === controller) this.#activeAbort = undefined;
      }
    });
  }

  async launchInteractiveLogin(): Promise<void> {
    await launchInteractiveLogin(this.#config, this.#logger, this.#automation);
  }

  async checkAuthStatus(): Promise<{ authenticated: boolean; error?: string }> {
    return await checkAuthStatus(this.#config, this.#automation);
  }

  close(): Promise<void> {
    if (this.#closePromise) return this.#closePromise;
    this.#closed = true;
    this.#activeAbort?.abort();
    this.#closePromise = (async () => {
      await this.#tail;
      const context = this.#context;
      const browser = this.#browser;
      this.#context = undefined;
      this.#browser = undefined;
      if (this.#config.mode === "launch") {
        await context?.close().catch(() => undefined);
      } else {
        // For a CDP connection, Browser.close() disposes the Playwright connection.
        // Pages not created by this provider are never closed individually.
        await browser?.close().catch(() => undefined);
      }
    })();
    return this.#closePromise;
  }

  #enqueue<T>(operation: () => Promise<T>): Promise<T> {
    if (this.#closed) return Promise.reject(closedError());
    const run = this.#tail.then(async () => {
      this.#assertOpen();
      return await operation();
    });
    this.#tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  #assertOpen(): void {
    if (this.#closed) throw closedError();
  }

  async #getContext(signal: AbortSignal): Promise<BrowserContext> {
    if (this.#context) return this.#context;

    if (this.#config.mode === "cdp") {
      const browser = await this.#automation.connectOverCDP(this.#config.cdpUrl);
      if (signal.aborted || this.#closed) {
        await browser.close().catch(() => undefined);
        throw signal.aborted ? abortedError() : closedError();
      }
      const context = browser.contexts()[0];
      if (!context) {
        await browser.close().catch(() => undefined);
        throw new ChatGptWebError("browser", "No browser context is available over CDP");
      }
      this.#browser = browser;
      this.#context = context;
      browser.once("disconnected", () => {
        if (this.#browser === browser) this.#browser = undefined;
        if (this.#context === context) this.#context = undefined;
      });
      context.once("close", () => {
        if (this.#context === context) this.#context = undefined;
      });
      return context;
    }

    await prepareProfileDirectory(this.#config.profileDir);
    const executablePath =
      this.#config.executablePath ?? (await resolveChromiumExecutablePath());
    const headlessOptions = this.#config.headless
      ? buildNativeHeadlessOptions(await this.#resolveExecutableVersion(executablePath))
      : {};
    const args = [
      ...(this.#config.sandboxMode === "userns" ? ["--disable-setuid-sandbox"] : []),
      ...(this.#config.headless
        ? [
            "--headless=new",
            "--disable-blink-features=AutomationControlled",
            `--window-size=${HEADLESS_VIEWPORT.width},${HEADLESS_VIEWPORT.height}`,
          ]
        : []),
    ];
    const context = await this.#automation.launchPersistentContext(
      this.#config.profileDir,
      {
        executablePath,
        headless: this.#config.headless,
        acceptDownloads: false,
        ignoreDefaultArgs: ["--enable-automation"],
        ...(args.length > 0 ? { args } : {}),
        ...headlessOptions,
      },
    );
    try {
      if (this.#config.headless) {
        await context.addInitScript(HEADLESS_COMPATIBILITY_INIT_SCRIPT);
      }
    } catch (error) {
      await context.close().catch(() => undefined);
      throw new ChatGptWebError(
        "browser",
        "Failed to initialize native-headless browser compatibility",
        error,
      );
    }
    if (signal.aborted || this.#closed) {
      await context.close().catch(() => undefined);
      throw signal.aborted ? abortedError() : closedError();
    }
    this.#context = context;
    context.once("close", () => {
      if (this.#context === context) this.#context = undefined;
    });
    return context;
  }

  async #newPageWithRecovery(signal: AbortSignal): Promise<Page> {
    let lastError: unknown;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      throwIfAborted(signal);
      const context = await this.#getContext(signal);
      try {
        return await context.newPage();
      } catch (error) {
        lastError = error;
        await this.#disposeCachedConnection();
      }
    }
    throw new ChatGptWebError(
      "browser",
      `Unable to create a provider-owned browser page after reconnecting: ${renderError(lastError)}`,
      lastError,
    );
  }

  async #disposeCachedConnection(): Promise<void> {
    const context = this.#context;
    const browser = this.#browser;
    this.#context = undefined;
    this.#browser = undefined;
    if (this.#config.mode === "launch") {
      await context?.close().catch(() => undefined);
    } else {
      await browser?.close().catch(() => undefined);
    }
  }

  async #runTurn(
    page: Page,
    prompt: string,
    signal: AbortSignal,
    controls?: ChatGptWebTurnControls,
    onStreamDelta?: ChatGptWebStreamHandler,
  ): Promise<string> {
    const limits = resolveChatGptWebTurnLimits(
      controls?.limits?.contextWindow,
      controls?.limits?.maxTokens,
    );
    try {
      await page.goto(this.#config.webchatUrl, { waitUntil: "domcontentloaded" });
    } catch (error) {
      throw new ChatGptWebError("navigation", "Failed to open the configured ChatGPT page", error);
    }
    throwIfAborted(signal);
    assertExpectedOrigin(page.url(), this.#config.webchatUrl);

    const composer = page.locator(this.#config.selectors.composer).first();
    try {
      await composer.waitFor({ state: "visible", timeout: this.#config.readyTimeoutMs });
    } catch (error) {
      throw new ChatGptWebError(
        "auth",
        `ChatGPT is not ready in the dedicated browser profile. Sign in at ${this.#config.webchatUrl}, then restart OpenClaw.`,
        error,
      );
    }

    await applyBrowserControls(page, this.#config, controls, signal, this.#now);

    const beforeMessageCount = await page.locator(this.#config.selectors.message).count();
    const nonce = this.#nonceFactory();
    const encodedPrompt = encodeTransportContext(prompt);
    const canonicalPrompt = canonicalizeBoundContext(encodedPrompt);
    const requestDigest = createHash("sha256").update(canonicalPrompt).digest("hex");
    const requestMarker = `OPENCLAW_REQUEST:${nonce}:${requestDigest}`;
    const contextStart = `OPENCLAW_CONTEXT_BEGIN:${nonce}`;
    const contextEnd = `OPENCLAW_CONTEXT_END:${nonce}`;
    const receipt = `OPENCLAW_RECEIPT:${nonce}`;
    const boundPrompt = [
      requestMarker,
      "",
      "Read the single transport context below directly: letters and digits are literal; ␠ is space; ␊ is newline; fullwidth punctuation means its ASCII counterpart; ［uXXXX］ is an original UTF-16 code unit.",
      "",
      contextStart,
      encodedPrompt,
      contextEnd,
      "",
      `End your response with exactly ${receipt} on its own final line.`,
    ].join("\n");
    const boundPromptDigest = createHash("sha256")
      .update(canonicalizeTransportEnvelope(boundPrompt))
      .digest("hex");
    const estimatedInputTokens = estimateTokenUpperBound(boundPrompt);
    const inputTokenBudget = limits.contextWindow - limits.maxTokens;
    if (estimatedInputTokens > inputTokenBudget) {
      throw new ChatGptWebError(
        "browser",
        `Serialized fallback prompt transport is estimated at ${estimatedInputTokens} tokens; configured maximum input budget is ${inputTokenBudget} tokens for a ${limits.contextWindow}-token context window after reserving ${limits.maxTokens} output tokens`,
      );
    }
    if (boundPrompt.length > this.#config.maxPromptChars) {
      throw new ChatGptWebError(
        "browser",
        `Serialized fallback prompt transport has ${boundPrompt.length} characters, above the configured maximum of ${this.#config.maxPromptChars}`,
      );
    }

    // Recheck immediately before context leaves the process. A redirect must never
    // receive the serialized OpenClaw prompt merely because it preserved the DOM.
    assertExpectedOrigin(page.url(), this.#config.webchatUrl);
    await composer.fill(boundPrompt);
    await this.#submit(page, composer, signal);
    const submittedIndex = await this.#waitForSubmittedReceipt(
      page,
      beforeMessageCount,
      requestMarker,
      requestDigest,
      boundPromptDigest,
      contextStart,
      contextEnd,
      receipt,
      signal,
    );

    const response = await this.#waitForResponse(
      page,
      submittedIndex,
      signal,
      limits.maxTokens,
      onStreamDelta,
      receipt,
    );
    assertExpectedOrigin(page.url(), this.#config.webchatUrl);
    const rawText = await extractResponseText(response, this.#config.selectors.responseContent);
    assertExpectedOrigin(page.url(), this.#config.webchatUrl);
    assertResponseWithinBudget(rawText, limits.maxTokens);
    const text = stripExactReceipt(rawText, receipt);
    if (!text) {
      throw new ChatGptWebError("empty_response", "ChatGPT returned an empty browser response");
    }
    this.#logger.info?.(`ChatGPT web turn completed (${text.length} response characters)`);
    return text;
  }

  async #submit(page: Page, composer: Locator, signal: AbortSignal): Promise<void> {
    assertExpectedOrigin(page.url(), this.#config.webchatUrl);
    const deadline = this.#now() + this.#config.readyTimeoutMs;
    const send = page.locator(this.#config.selectors.send);
    while (this.#now() < deadline) {
      throwIfAborted(signal);
      assertExpectedOrigin(page.url(), this.#config.webchatUrl);
      const count = await send.count();
      for (let index = 0; index < count; index += 1) {
        const candidate = send.nth(index);
        if (
          (await candidate.isVisible().catch(() => false)) &&
          (await candidate.isEnabled().catch(() => false))
        ) {
          assertExpectedOrigin(page.url(), this.#config.webchatUrl);
          await candidate.click();
          return;
        }
      }
      await page.waitForTimeout(100);
    }
    assertExpectedOrigin(page.url(), this.#config.webchatUrl);
    await composer.press("Enter");
  }

  async #waitForSubmittedReceipt(
    page: Page,
    beforeMessageCount: number,
    requestMarker: string,
    requestDigest: string,
    boundPromptDigest: string,
    contextStart: string,
    contextEnd: string,
    receipt: string,
    signal: AbortSignal,
  ): Promise<number> {
    const deadline = this.#now() + this.#config.readyTimeoutMs;
    while (this.#now() < deadline) {
      throwIfAborted(signal);
      assertExpectedOrigin(page.url(), this.#config.webchatUrl);
      const messages = page.locator(this.#config.selectors.message);
      if ((await messages.count()) > beforeMessageCount) {
        const submitted = messages.nth(beforeMessageCount);
        const role = await submitted.getAttribute("data-message-author-role").catch(() => null);
        const text = await submitted.innerText().catch(() => "");
        const normalizedActual = normalizeDomText(text);
        const submittedDigest = createHash("sha256")
          .update(canonicalizeTransportEnvelope(text))
          .digest("hex");
        const renderedContext = extractBoundContext(text, contextStart, contextEnd);
        const renderedDigest = createHash("sha256")
          .update(canonicalizeBoundContext(renderedContext ?? ""))
          .digest("hex");
        if (
          role === "user" &&
          countOccurrences(normalizedActual, requestMarker) === 1 &&
          countOccurrences(normalizedActual, contextStart) === 1 &&
          countOccurrences(normalizedActual, contextEnd) === 1 &&
          countOccurrences(normalizedActual, receipt) === 1 &&
          renderedContext !== undefined &&
          renderedDigest === requestDigest &&
          submittedDigest === boundPromptDigest
        ) {
          return beforeMessageCount;
        }
        throw new ChatGptWebError(
          "integrity",
          [
            "The message after the pre-submit transcript is missing this OpenClaw request binding",
            `role=${role ?? "missing"}`,
            `actual=${fingerprint(normalizedActual)}`,
            `requestMarkers=${countOccurrences(normalizedActual, requestMarker)}`,
            `contextStarts=${countOccurrences(normalizedActual, contextStart)}`,
            `contextEnds=${countOccurrences(normalizedActual, contextEnd)}`,
            `receiptMarkers=${countOccurrences(normalizedActual, receipt)}`,
            `contextExtracted=${renderedContext === undefined ? 0 : 1}`,
            `contextDigest=${renderedDigest}`,
            `submittedDigest=${submittedDigest}`,
            `expectedEnvelopeDigest=${boundPromptDigest}`,
          ].join("; "),
        );
      }
      await page.waitForTimeout(100);
    }
    throw new ChatGptWebError(
      "integrity",
      "ChatGPT did not expose a matching submitted-turn receipt before the deadline",
    );
  }

  async #waitForResponse(
    page: Page,
    submittedIndex: number,
    signal: AbortSignal,
    maxOutputTokens: number,
    onStreamDelta?: ChatGptWebStreamHandler,
    receipt?: string,
  ): Promise<Locator> {
    const deadline = this.#now() + this.#config.responseTimeoutMs;
    let lastText = "";
    let emittedTextLength = 0;
    let emittedThinkingLength = 0;
    let stableSince = this.#now();
    let sawStop = false;

    while (this.#now() < deadline) {
      throwIfAborted(signal);
      assertExpectedOrigin(page.url(), this.#config.webchatUrl);
      const messages = page.locator(this.#config.selectors.message);
      const count = await messages.count();
      if (count <= submittedIndex + 1) {
        await page.waitForTimeout(200);
        continue;
      }

      const latest = messages.nth(submittedIndex + 1);
      const role = await latest.getAttribute("data-message-author-role").catch(() => null);
      if (role !== "assistant") {
        throw new ChatGptWebError(
          "integrity",
          "The message immediately following the bound user turn is not an assistant response",
        );
      }

      // Check for thinking / reasoning deltas
      if (onStreamDelta) {
        const thinkingText = await extractThinkingText(latest).catch(() => "");
        if (thinkingText && thinkingText.length > emittedThinkingLength) {
          const thinkingDelta = thinkingText.slice(emittedThinkingLength);
          if (thinkingDelta) {
            onStreamDelta({ kind: "thinking", text: thinkingDelta });
            emittedThinkingLength = thinkingText.length;
          }
        }
      }

      const text = await extractResponseText(
        latest,
        this.#config.selectors.responseContent,
      ).catch(() => "");
      if (estimateTokenUpperBound(text) > maxOutputTokens) {
        await page.locator(this.#config.selectors.stop).first().click().catch(() => undefined);
        throw new ChatGptWebError(
          "browser",
          `ChatGPT response is estimated at more than the configured maximum of ${maxOutputTokens} output tokens; generation was stopped`,
        );
      }
      const stopVisible = await page
        .locator(this.#config.selectors.stop)
        .first()
        .isVisible()
        .catch(() => false);
      const completionVisible = await latest
        .locator(this.#config.selectors.completion)
        .first()
        .isVisible()
        .catch(() => false);
      sawStop ||= stopVisible;

      if (text !== lastText) {
        if (onStreamDelta && text.length > emittedTextLength) {
          let visibleChunk = text.slice(emittedTextLength);
          if (receipt && visibleChunk.includes(receipt)) {
            visibleChunk = visibleChunk.slice(0, visibleChunk.indexOf(receipt));
          } else if (visibleChunk.includes("OPENCLAW_RECEIPT")) {
            visibleChunk = visibleChunk.slice(0, visibleChunk.indexOf("OPENCLAW_RECEIPT"));
          }
          if (visibleChunk) {
            onStreamDelta({ kind: "text", text: visibleChunk });
            emittedTextLength += visibleChunk.length;
          }
        }
        lastText = text;
        stableSince = this.#now();
      } else if (
        text &&
        !stopVisible &&
        (sawStop || completionVisible) &&
        this.#now() - stableSince >= this.#config.stabilityWindowMs
      ) {
        return latest;
      }
      await page.waitForTimeout(200);
    }

    await page.locator(this.#config.selectors.stop).first().click().catch(() => undefined);
    throw new ChatGptWebError(
      "timeout",
      "Timed out before ChatGPT exposed a positive completion signal for its browser response",
    );
  }

  async #abortActiveTurn(page: Page): Promise<void> {
    await page.locator(this.#config.selectors.stop).first().click().catch(() => undefined);
    await page.close().catch(() => undefined);
  }
}

async function applyBrowserControls(
  page: Page,
  config: ChatGptWebConfig,
  controls: ChatGptWebTurnControls | undefined,
  signal: AbortSignal,
  now: () => number,
): Promise<void> {
  const modelLabel = controls?.model?.webLabel;
  if (modelLabel) {
    await selectBrowserOption(page, config, signal, {
      picker: config.selectors.modelPicker,
      option: config.selectors.modelOption,
      pickerKey: "modelPicker",
      optionKey: "modelOption",
      label: modelLabel,
      description: "model",
      now,
    });
  }

  const reasoning = controls?.reasoning;
  const reasoningLabel =
    reasoning === undefined ? undefined : controls?.model?.reasoningOptions[reasoning];
  if (reasoningLabel) {
    await selectBrowserOption(page, config, signal, {
      picker: config.selectors.reasoningPicker,
      option: config.selectors.reasoningOption,
      pickerKey: "reasoningPicker",
      optionKey: "reasoningOption",
      label: reasoningLabel,
      description: `reasoning level ${reasoning}`,
      now,
    });
  }
}

async function selectBrowserOption(
  page: Page,
  config: ChatGptWebConfig,
  signal: AbortSignal,
  selection: {
    picker: string | undefined;
    option: string | undefined;
    pickerKey: "modelPicker" | "reasoningPicker";
    optionKey: "modelOption" | "reasoningOption";
    label: string;
    description: string;
    now: () => number;
  },
): Promise<void> {
  if (!selection.picker || !selection.option) {
    throw new ChatGptWebError(
      "browser",
      `A ChatGPT web ${selection.description} "${selection.label}" was requested, but both selectors.${selection.pickerKey} and selectors.${selection.optionKey} must be configured`,
    );
  }

  throwIfAborted(signal);
  assertExpectedOrigin(page.url(), config.webchatUrl);
  const picker = page.locator(selection.picker).first();
  try {
    await picker.waitFor({ state: "visible", timeout: config.readyTimeoutMs });
    assertExpectedOrigin(page.url(), config.webchatUrl);
    await picker.click();
  } catch (error) {
    if (error instanceof ChatGptWebError) throw error;
    throw new ChatGptWebError(
      "browser",
      `Configured ChatGPT web ${selection.description} picker was not usable`,
      error,
    );
  }

  const options = page.locator(selection.option);
  const deadline = selection.now() + config.readyTimeoutMs;
  const expected = normalizeOptionText(selection.label);
  while (selection.now() < deadline) {
    throwIfAborted(signal);
    assertExpectedOrigin(page.url(), config.webchatUrl);
    const count = await options.count();
    for (let index = 0; index < count; index += 1) {
      const candidate = options.nth(index);
      if (!(await candidate.isVisible().catch(() => false))) continue;
      const actual = normalizeOptionText(await candidate.innerText().catch(() => ""));
      if (actual !== expected) continue;
      assertExpectedOrigin(page.url(), config.webchatUrl);
      await candidate.click();
      assertExpectedOrigin(page.url(), config.webchatUrl);
      if (!(await isBrowserOptionCommitted(picker, candidate, expected))) {
        throw new ChatGptWebError(
          "integrity",
          `ChatGPT web ${selection.description} option "${selection.label}" did not report a committed selection`,
        );
      }
      return;
    }
    await page.waitForTimeout(100);
  }

  throw new ChatGptWebError(
    "browser",
    `Configured ChatGPT web ${selection.description} option "${selection.label}" was not found`,
  );
}

async function isBrowserOptionCommitted(
  picker: Locator,
  option: Locator,
  expected: string,
): Promise<boolean> {
  for (const attribute of ["aria-selected", "aria-checked", "data-state"]) {
    const value = (await option.getAttribute(attribute).catch(() => null))?.toLocaleLowerCase();
    if (value === "true" || value === "checked" || value === "selected" || value === "active") {
      return true;
    }
  }
  const pickerText = normalizeOptionText(await picker.innerText().catch(() => ""));
  return pickerText === expected || pickerText.includes(expected);
}

function normalizeOptionText(value: string): string {
  return value.replace(/\s+/g, " ").trim().toLocaleLowerCase();
}

function canonicalizeBoundContext(value: string): string {
  return value.replace(/\r\n/g, "\n").trim();
}

function canonicalizeTransportEnvelope(value: string): string {
  // Chromium may expose contenteditable line breaks with slightly different
  // whitespace around block nodes. The encoded context uses visible space and
  // newline symbols, so collapsing only the envelope's ordinary whitespace
  // cannot hide a context mutation or a textual prefix/suffix injection.
  return value.replace(/\r\n/g, "\n").replace(/\s+/g, " ").trim();
}

function encodeTransportContext(value: string): string {
  let encoded = "";
  const normalized = value.replace(/\r\n/g, "\n");
  for (let index = 0; index < normalized.length; index += 1) {
    const codeUnit = normalized.charCodeAt(index);
    if (
      (codeUnit >= 0x30 && codeUnit <= 0x39) ||
      (codeUnit >= 0x41 && codeUnit <= 0x5a) ||
      (codeUnit >= 0x61 && codeUnit <= 0x7a)
    ) {
      encoded += normalized[index];
      continue;
    }
    if (codeUnit === 0x20) {
      encoded += "␠";
      continue;
    }
    if (codeUnit === 0x0a) {
      encoded += "␊";
      continue;
    }
    if (codeUnit >= 0x21 && codeUnit <= 0x7e) {
      encoded += String.fromCharCode(codeUnit + 0xfee0);
      continue;
    }
    encoded += `［u${codeUnit.toString(16).padStart(4, "0")}］`;
  }
  return encoded;
}

function extractBoundContext(text: string, startMarker: string, endMarker: string): string | undefined {
  const start = text.indexOf(startMarker);
  if (start < 0) return undefined;
  const bodyStart = start + startMarker.length;
  const end = text.indexOf(endMarker, bodyStart);
  if (end < 0) return undefined;
  return text.slice(bodyStart, end);
}

function buildNativeHeadlessOptions(version: string): {
  viewport: { width: number; height: number };
  screen: { width: number; height: number };
  locale: string;
  userAgent: string;
  extraHTTPHeaders: Record<string, string>;
} {
  if (!/^\d+(?:\.\d+){3}$/.test(version)) {
    throw new ChatGptWebError("browser", `Unexpected Chromium version: ${version}`);
  }
  return {
    viewport: HEADLESS_VIEWPORT,
    screen: HEADLESS_VIEWPORT,
    locale: "en-US",
    userAgent:
      `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 ` +
      `(KHTML, like Gecko) Chrome/${version} Safari/537.36`,
    extraHTTPHeaders: { "Accept-Language": "en-US,en;q=0.9" },
  };
}

function resolveChromiumVersion(executablePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(executablePath, ["--version"], { timeout: 10_000 }, (error, stdout) => {
      if (error) {
        reject(
          new ChatGptWebError(
            "browser",
            `Failed to resolve the Chromium version from ${executablePath}`,
            error,
          ),
        );
        return;
      }
      const version = /([0-9]+(?:\.[0-9]+){3})/.exec(stdout)?.[1];
      if (!version) {
        reject(
          new ChatGptWebError(
            "browser",
            `Chromium at ${executablePath} returned an unrecognized version string`,
          ),
        );
        return;
      }
      resolve(version);
    });
  });
}

export async function prepareProfileDirectory(profileDir: string): Promise<void> {
  const resolved = path.resolve(profileDir);
  const markerPath = path.join(resolved, ".openclaw-chatgpt-web-profile");
  const userHome = path.resolve(homedir());
  const forbiddenRoots = [
    userHome,
    path.join(userHome, ".config"),
    path.join(userHome, ".config", "google-chrome"),
    path.join(userHome, ".config", "chromium"),
    path.join(userHome, ".config", "microsoft-edge"),
  ];
  if (
    resolved === path.parse(resolved).root ||
    forbiddenRoots.some(
      (root) => resolved === root || (root !== userHome && isWithin(resolved, root)),
    )
  ) {
    throw new ChatGptWebError(
      "profile",
      "profileDir must be a dedicated provider directory, not a home or normal browser profile path",
    );
  }

  await assertNoSymlinkComponents(resolved);
  const existed = await pathExists(resolved);
  await mkdir(resolved, { recursive: true, mode: 0o700 });
  const existingEntries = await readdir(resolved);
  if (existed && existingEntries.length > 0 && !existingEntries.includes(path.basename(markerPath))) {
    throw new ChatGptWebError(
      "profile",
      "profileDir is nonempty and does not carry this provider's ownership marker",
    );
  }
  if (existingEntries.includes(path.basename(markerPath))) {
    const markerDetails = await lstat(markerPath);
    if (markerDetails.isSymbolicLink()) {
      throw new ChatGptWebError("profile", "profileDir ownership marker must not be a symlink");
    }
    const marker = await readFile(markerPath, "utf8");
    if (marker !== PROFILE_MARKER_CONTENT) {
      throw new ChatGptWebError("profile", "profileDir ownership marker is invalid");
    }
  } else {
    await writeFile(markerPath, PROFILE_MARKER_CONTENT, { flag: "wx", mode: 0o600 });
  }
  await chmod(resolved, 0o700);
  const details = await stat(resolved);
  if (!details.isDirectory() || (details.mode & 0o077) !== 0) {
    throw new ChatGptWebError(
      "profile",
      "profileDir must be a private directory with permissions 0700",
    );
  }
  if (typeof process.getuid === "function" && details.uid !== process.getuid()) {
    throw new ChatGptWebError("profile", "profileDir must be owned by the current user");
  }
}

const PROFILE_MARKER_CONTENT = "openclaw-chatgpt-web-profile-v1\n";

function isWithin(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate);
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

async function assertNoSymlinkComponents(candidate: string): Promise<void> {
  let existing = candidate;
  for (;;) {
    try {
      const details = await lstat(existing);
      if (details.isSymbolicLink()) {
        throw new ChatGptWebError("profile", "profileDir must not contain symbolic links");
      }
      const canonical = await realpath(existing);
      if (canonical !== existing) {
        throw new ChatGptWebError("profile", "profileDir must not traverse symbolic links");
      }
      return;
    } catch (error) {
      if (error instanceof ChatGptWebError) throw error;
      if (!isMissingPathError(error)) {
        throw new ChatGptWebError("profile", "Unable to inspect profileDir", error);
      }
      const parent = path.dirname(existing);
      if (parent === existing) throw new ChatGptWebError("profile", "Unable to resolve profileDir");
      existing = parent;
    }
  }
}

function isMissingPathError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}

async function pathExists(candidate: string): Promise<boolean> {
  try {
    await lstat(candidate);
    return true;
  } catch (error) {
    if (isMissingPathError(error)) return false;
    throw error;
  }
}

function assertExpectedOrigin(actual: string, configured: string): void {
  let actualOrigin: string;
  try {
    actualOrigin = new URL(actual).origin;
  } catch (error) {
    throw new ChatGptWebError("navigation", "Browser navigated to an invalid URL", error);
  }
  const expectedOrigin = new URL(configured).origin;
  if (actualOrigin !== expectedOrigin) {
    throw new ChatGptWebError(
      "navigation",
      `Browser left the configured ChatGPT origin (${expectedOrigin}) before prompt submission`,
    );
  }
}

function stripExactReceipt(text: string, receipt: string): string {
  const normalized = text.replace(/\r\n/g, "\n").trimEnd();
  const suffix = `\n${receipt}`;
  if (!normalized.endsWith(suffix)) {
    throw new ChatGptWebError(
      "integrity",
      "ChatGPT response is missing the exact OpenClaw transport receipt",
    );
  }
  const body = normalized.slice(0, -suffix.length).trimEnd();
  if (body.includes(receipt)) {
    throw new ChatGptWebError(
      "integrity",
      "ChatGPT response contains the OpenClaw transport receipt outside its final line",
    );
  }
  return body;
}

function normalizeDomText(text: string): string {
  // contenteditable renders line breaks differently across Chromium and the
  // ChatGPT DOM; collapse only whitespace while preserving every text token.
  return text.replace(/\s+/g, " ").trim();
}

function fingerprint(value: string): string {
  const digest = createHash("sha256").update(value).digest("hex");
  return `${value.length}:${digest}`;
}

function countOccurrences(value: string, marker: string): number {
  let count = 0;
  let offset = 0;
  while (offset < value.length) {
    const found = value.indexOf(marker, offset);
    if (found < 0) break;
    count += 1;
    offset = found + marker.length;
  }
  return count;
}

async function extractResponseText(response: Locator, contentSelector: string): Promise<string> {
  return await response.evaluate(
    (root, selector) => {
      const candidates = Array.from(root.querySelectorAll<HTMLElement>(selector));
      const topLevel = candidates.filter(
        (candidate) =>
          !candidates.some((other) => other !== candidate && other.contains(candidate)),
      );
      const values = topLevel.map((candidate) => candidate.innerText.trim()).filter(Boolean);
      return (values.length > 0 ? values.join("\n\n") : (root as HTMLElement).innerText).trim();
    },
    contentSelector,
  );
}

async function resolveChromiumExecutablePath(): Promise<string> {
  const candidates = [
    "/opt/google/chrome/chrome",
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
  ];
  for (const candidate of candidates) {
    try {
      await access(candidate);
      return candidate;
    } catch {
      // Continue through known system browser locations.
    }
  }
  throw new ChatGptWebError(
    "browser",
    "No Chromium executable was found. Set plugins.entries.chatgpt-web.config.executablePath.",
  );
}

function forwardAbort(source: AbortSignal | undefined, target: AbortController): () => void {
  if (!source) return () => {};
  const abort = () => target.abort();
  source.addEventListener("abort", abort, { once: true });
  if (source.aborted) abort();
  return () => source.removeEventListener("abort", abort);
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortedError();
}

function abortedError(): ChatGptWebError {
  return new ChatGptWebError("aborted", "ChatGPT web request was aborted");
}

function closedError(): ChatGptWebError {
  return new ChatGptWebError("closed", "ChatGPT web browser client is closed");
}

function renderError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function assertResponseWithinBudget(text: string, maxOutputTokens: number): void {
  const estimatedOutputTokens = estimateTokenUpperBound(text);
  if (estimatedOutputTokens > maxOutputTokens) {
    throw new ChatGptWebError(
      "browser",
      `ChatGPT response is estimated at ${estimatedOutputTokens} tokens, above the configured maximum of ${maxOutputTokens} output tokens`,
    );
  }
}

function installPageBoundaryGuards(page: Page, expectedUrl: string): {
  violation: Promise<never>;
  dispose(): void;
} {
  let rejectViolation: (error: ChatGptWebError) => void = () => {};
  let violated = false;
  const violation = new Promise<never>((_resolve, reject) => {
    rejectViolation = reject;
  });
  const rejectOnce = (message: string) => {
    if (violated) return;
    violated = true;
    rejectViolation(new ChatGptWebError("integrity", message));
  };
  const onPopup = (popup: Page) => {
    void popup.close().catch(() => undefined);
    rejectOnce("ChatGPT opened an unexpected popup during a provider turn");
  };
  const onDownload = (download: Download) => {
    void download.cancel().catch(() => undefined);
    rejectOnce("ChatGPT initiated an unexpected download during a provider turn");
  };
  const onFrameNavigated = (frame: Frame) => {
    if (frame.parentFrame() !== null) return;
    try {
      assertExpectedOrigin(frame.url(), expectedUrl);
    } catch (error) {
      rejectOnce(renderError(error));
    }
  };
  page.on("popup", onPopup);
  page.on("download", onDownload);
  page.on("framenavigated", onFrameNavigated);
  return {
    violation,
    dispose: () => {
      page.off("popup", onPopup);
      page.off("download", onDownload);
      page.off("framenavigated", onFrameNavigated);
    },
  };
}

async function extractThinkingText(locator: Locator): Promise<string> {
  const thinkingLocator = locator.locator(
    '[data-message-content="thought"], [data-testid="thought-content"], .thought-content, [data-message-content-part="thought"], .reasoning-content',
  );
  const count = await thinkingLocator.count().catch(() => 0);
  if (count === 0) return "";
  const chunks: string[] = [];
  for (let i = 0; i < count; i++) {
    const text = await thinkingLocator.nth(i).innerText().catch(() => "");
    if (text) chunks.push(text);
  }
  return chunks.join("\n");
}

export async function launchInteractiveLogin(
  config: ChatGptWebConfig,
  logger: BrowserClientLogger = {},
  _automation: BrowserAutomation = DEFAULT_AUTOMATION,
): Promise<void> {
  await prepareProfileDirectory(config.profileDir);
  const executablePath =
    config.executablePath ?? (await resolveChromiumExecutablePath());
  logger.info?.(`Launching browser for ChatGPT login with profile at: ${config.profileDir}`);

  // Launch genuine Google Chrome as a standard desktop process without any automation flags.
  // This ensures Google OAuth ("This browser or app may not be secure") and Cloudflare Turnstile CAPTCHAs pass normally.
  const args = [
    `--user-data-dir=${config.profileDir}`,
    "--no-first-run",
    "--no-default-browser-check",
    config.webchatUrl,
  ];

  await new Promise<void>((resolve, reject) => {
    const child = spawn(executablePath, args, {
      stdio: "inherit",
    });
    child.on("error", (err) => reject(err));
    child.on("exit", () => resolve());
  });
}

export async function checkAuthStatus(
  config: ChatGptWebConfig,
  automation: BrowserAutomation = DEFAULT_AUTOMATION,
): Promise<{ authenticated: boolean; error?: string }> {
  try {
    await prepareProfileDirectory(config.profileDir);
    const executablePath =
      config.executablePath ?? (await resolveChromiumExecutablePath());
    const context = await automation.launchPersistentContext(config.profileDir, {
      executablePath,
      headless: true,
      acceptDownloads: false,
      ignoreDefaultArgs: ["--enable-automation"],
      args: [
        ...(config.sandboxMode === "userns" ? ["--disable-setuid-sandbox"] : []),
        "--headless=new",
        "--disable-blink-features=AutomationControlled",
      ],
    });

    try {
      const page = await context.newPage();
      await page.goto(config.webchatUrl, { waitUntil: "domcontentloaded", timeout: 20_000 });
      const composer = page.locator(config.selectors.composer).first();
      await composer.waitFor({ state: "visible", timeout: 15_000 });
      return { authenticated: true };
    } finally {
      await context.close().catch(() => undefined);
    }
  } catch (error) {
    return {
      authenticated: false,
      error: renderError(error),
    };
  }
}
